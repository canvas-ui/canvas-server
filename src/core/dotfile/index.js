'use strict';

// Core dependencies
import path from 'path';
import os from 'os';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { spawn } from 'child_process';
import EventEmitter from 'eventemitter2';

// Logging
import logger, { createDebug } from '../../utils/log/index.js';
const debug = createDebug('dotfile-manager');

const DOTFILES_DIR = 'dotfiles.git';
const TEMPLATE_DIRNAME = 'files'; // relative to this module directory

async function spawnPromise(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
        let stdout = '';
        let stderr = '';
        if (child.stdout) child.stdout.on('data', (d) => (stdout += d.toString()));
        if (child.stderr) child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('close', (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
        });
        child.on('error', reject);
    });
}

function getModuleDir() {
    const url = new URL(import.meta.url);
    return path.dirname(url.pathname);
}

async function copyTemplateInto(targetDir) {
    const moduleDir = getModuleDir();
    const templateRoot = path.resolve(moduleDir, TEMPLATE_DIRNAME);
    // Ensure target exists
    await fsPromises.mkdir(targetDir, { recursive: true });
    // Copy .gitignore template (no backward compatibility)
    const gitignoreSrc = path.join(templateRoot, '.gitignore');
    if (existsSync(gitignoreSrc)) {
        const gitignoreDst = path.join(targetDir, '.gitignore');
        await fsPromises.copyFile(gitignoreSrc, gitignoreDst);
    }
    // Copy .dot directory (if present)
    const dotDirSrc = path.join(templateRoot, '.dot');
    if (existsSync(dotDirSrc)) {
        await fsPromises.cp(dotDirSrc, path.join(targetDir, '.dot'), { recursive: true, force: true });
    }
}

/**
 * DotfileManager - Manages workspace-based Git repositories for dotfiles
 */
class DotfileManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.workspaceManager = options.workspaceManager;
        if (!this.workspaceManager) {
            throw new Error('WorkspaceManager is required');
        }
        debug('DotfileManager initialized');
    }

    // Initialize method for compatibility with Server.js
    async initialize() {
        return this;
    }

    // Get repository path for workspace
    #getDotfilesRepoPath(workspace) {
        return path.join(workspace.rootPath, DOTFILES_DIR);
    }

    // Check if repository exists
    async hasRepository(userId, workspaceIdOrObject, requestingUserId) {
        // Handle workspace object vs ID
        let workspace;
        if (typeof workspaceIdOrObject === 'object' && workspaceIdOrObject.id) {
            workspace = workspaceIdOrObject;
        } else {
            workspace = await this.workspaceManager.getWorkspaceById(workspaceIdOrObject, requestingUserId);
            if (!workspace) {
                return false;
            }
        }
        const repoPath = this.#getDotfilesRepoPath(workspace);
        return existsSync(repoPath);
    }

    // Initialize Git repositories (bare and seed working repo)
    async initializeRepository(userId, workspaceIdOrObject, requestingUserId) {
        // Handle workspace object vs ID
        let workspace;
        if (typeof workspaceIdOrObject === 'object' && workspaceIdOrObject.id) {
            workspace = workspaceIdOrObject;
        } else {
            workspace = await this.workspaceManager.getWorkspaceById(workspaceIdOrObject, requestingUserId);
            if (!workspace) {
                throw new Error(`Workspace ${workspaceIdOrObject} not found or access denied`);
            }
        }
        const repoPath = this.#getDotfilesRepoPath(workspace);

        if (!existsSync(repoPath)) {
            await fsPromises.mkdir(repoPath, { recursive: true });
            // Initialize bare repository with native git
            await spawnPromise('git', ['init', '--bare', '--initial-branch=main'], { cwd: repoPath });
        } else {
            // If repository already exists and has any refs, treat as initialized and skip seeding
            let hasRefs = false;
            try {
                const { stdout } = await spawnPromise('git', ['show-ref'], { cwd: repoPath });
                if (stdout && stdout.trim().length > 0) hasRefs = true;
            } catch (err) {
                // show-ref exits non-zero for empty repos; keep hasRefs=false
            }
            if (hasRefs) {
                this.emit('repository.initialized', { userId, workspace: workspace.id, path: repoPath });
                return { success: true, message: 'Repository already initialized', path: repoPath };
            }
        }

        // Seed a working repository with template files and push to bare repo (only for empty repos)
        const tmpWorkDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'canvas-dotfiles-'));
        try {
            // Initialize a non-bare repo
            await spawnPromise('git', ['init', '--initial-branch=main'], { cwd: tmpWorkDir });

            // Materialize template files into working directory
            await copyTemplateInto(tmpWorkDir);

            // Ensure .dot/encrypted.index exists
            const encIndexPath = path.join(tmpWorkDir, '.dot', 'encrypted.index');
            await fsPromises.mkdir(path.dirname(encIndexPath), { recursive: true });
            if (!existsSync(encIndexPath)) {
                await fsPromises.writeFile(encIndexPath, '');
            }

            // Stage and commit
            await spawnPromise('git', ['add', '.'], { cwd: tmpWorkDir });
            // Configure identity unconditionally (simpler)
            await spawnPromise('git', ['config', 'user.name', 'canvas-server'], { cwd: tmpWorkDir });
            await spawnPromise('git', ['config', 'user.email', 'noreply@canvas.local'], { cwd: tmpWorkDir });
            await spawnPromise('git', ['commit', '-m', 'Initialize Canvas dotfiles repository'], { cwd: tmpWorkDir });

            // Add bare repo as remote and push
            await spawnPromise('git', ['remote', 'add', 'origin', repoPath], { cwd: tmpWorkDir });
            await spawnPromise('git', ['push', '-u', 'origin', 'main'], { cwd: tmpWorkDir });
        } finally {
            // Cleanup temp workdir
            try { await fsPromises.rm(tmpWorkDir, { recursive: true, force: true }); } catch (_) {}
        }

        this.emit('repository.initialized', { userId, workspace: workspace.id, path: repoPath });
        return { success: true, message: 'Repository initialized successfully', path: repoPath };
    }

    // Get repository status
    async getRepositoryStatus(userId, workspaceIdOrObject, requestingUserId) {
        // Handle workspace object vs ID
        let workspace;
        if (typeof workspaceIdOrObject === 'object' && workspaceIdOrObject.id) {
            workspace = workspaceIdOrObject;
        } else {
            workspace = await this.workspaceManager.getWorkspaceById(workspaceIdOrObject, requestingUserId);
            if (!workspace) {
                throw new Error(`Workspace ${workspaceIdOrObject} not found or access denied`);
            }
        }
        const repoPath = this.#getDotfilesRepoPath(workspace);

        if (!existsSync(repoPath)) {
            return { initialized: false, path: repoPath };
        }

        // Read branches from filesystem
        let branches = [];
        let currentBranch = null;

        try {
            const refsHeadsPath = path.join(repoPath, 'refs', 'heads');
            if (existsSync(refsHeadsPath)) {
                const refFiles = await fsPromises.readdir(refsHeadsPath);
                for (const file of refFiles) {
                    const filePath = path.join(refsHeadsPath, file);
                    const stats = await fsPromises.stat(filePath);
                    if (stats.isFile()) {
                        branches.push(file);
                    }
                }
                currentBranch = branches.includes('main') ? 'main' : branches[0];
            }
        } catch (error) {
            // Empty repository - no branches yet
        }

        return {
            initialized: true,
            path: repoPath,
            branches,
            currentBranch,
            bare: true
        };
    }

    // Handle Git HTTP backend operations
    async handleGitHttpBackend(userId, workspaceIdOrObject, requestingUserId, service, request, reply) {
        // Handle workspace object vs ID
        let workspace;
        if (typeof workspaceIdOrObject === 'object' && workspaceIdOrObject.id) {
            workspace = workspaceIdOrObject;
        } else {
            workspace = await this.workspaceManager.getWorkspaceById(workspaceIdOrObject, requestingUserId);
            if (!workspace) {
                throw new Error(`Workspace ${workspaceIdOrObject} not found or access denied`);
            }
        }
        const repoPath = this.#getDotfilesRepoPath(workspace);

        if (!existsSync(repoPath)) {
            throw new Error('Repository not initialized');
        }

        switch (service) {
            case 'info/refs':
                return this.#handleInfoRefs(repoPath, request, reply);
            case 'git-upload-pack':
                return this.#handleUploadPack(repoPath, request, reply);
            case 'git-receive-pack':
                return this.#handleReceivePack(repoPath, request, reply);
            default:
                throw new Error(`Unsupported Git service: ${service}`);
        }
    }

            // Handle info/refs requests
    async #handleInfoRefs(repoPath, request, reply) {
        const service = request.query.service;

        if (!service || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
            return reply.code(400).send('Invalid service');
        }

        // Set correct content type based on service
        const contentType = `application/x-${service}-advertisement`;
        reply
            .type(contentType)
            .header('cache-control', 'no-cache, max-age=0, must-revalidate');

        // Setup environment for git process
        const env = {
            ...process.env,
            'GIT_HTTP_EXPORT_ALL': '1'
        };

        // Handle Git-Protocol header if present
        const gitProtocol = request.headers['git-protocol'];
        if (gitProtocol) {
            env['GIT_PROTOCOL'] = gitProtocol;
        }

        const serviceName = service.replace('git-', '');
        const gitProcess = spawn('git', [serviceName, '--stateless-rpc', '--advertise-refs', repoPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: env
        });

        // Return a Promise that resolves when the git process completes
        return new Promise((resolve, reject) => {
            const chunks = [];
            let totalSize = 0;

            gitProcess.stdout.on('data', (chunk) => {
                chunks.push(chunk);
                totalSize += chunk.length;
            });

            gitProcess.stderr.on('data', (data) => {
                debug(`Git ${serviceName}: ${data.toString().trim()}`);
            });

            gitProcess.on('error', (error) => {
                debug(`Git ${serviceName} error: ${error.message}`);
                reject(error);
            });

            gitProcess.on('close', (code) => {
                if (code !== 0) {
                    reply.code(500).send('Git process failed');
                    resolve();
                    return;
                }

                // Combine output
                const refs = Buffer.concat(chunks, totalSize);

                // Build the complete response with service header
                const serviceHeader = `# service=${service}\n`;
                const headerLength = (serviceHeader.length + 4).toString(16).padStart(4, '0');

                // Create the final response
                const response = Buffer.concat([
                    Buffer.from(headerLength + serviceHeader),
                    Buffer.from('0000'),
                    refs
                ]);

                reply.send(response);
                resolve();
            });

            gitProcess.stdin.end();
        });
    }
                                                // Handle git-upload-pack requests
    async #handleUploadPack(repoPath, request, reply) {
        // Hijack the response to prevent Fastify from interfering with binary data
        reply.hijack();

        // Write headers directly to raw response
        reply.raw.writeHead(200, {
            'Content-Type': 'application/x-git-upload-pack-result',
            'Cache-Control': 'no-cache, max-age=0, must-revalidate'
        });

        // Setup environment for git process
        const env = {
            ...process.env,
            'GIT_HTTP_EXPORT_ALL': '1',
            'SSH_ORIGINAL_COMMAND': 'upload-pack'
        };

        // Handle Git-Protocol header if present
        const gitProtocol = request.headers['git-protocol'];
        if (gitProtocol) {
            env['GIT_PROTOCOL'] = gitProtocol;
        }

        const gitProcess = spawn('git', ['upload-pack', '--stateless-rpc', repoPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: env
        });

        // Pipe git stdout directly to the raw response
        gitProcess.stdout.pipe(reply.raw, { end: false });

        gitProcess.stderr.on('data', (data) => {
            debug(`Git upload-pack: ${data.toString().trim()}`);
        });

        // Handle request body
        if (request.body) {
            const bodyBuffer = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body);
            gitProcess.stdin.write(bodyBuffer);
            gitProcess.stdin.end();
        } else {
            request.raw.pipe(gitProcess.stdin);
        }

        // Wait for git process to complete
        return new Promise((resolve, reject) => {
            gitProcess.on('error', (error) => {
                debug(`Git upload-pack error: ${error.message}`);
                reply.raw.end();
                reject(error);
            });

            gitProcess.on('close', (code) => {
                reply.raw.end();

                if (code !== 0) {
                    reject(new Error(`Git upload-pack failed with code ${code}`));
                } else {
                    resolve();
                }
            });
        });
    }

                                // Handle git-receive-pack requests
    async #handleReceivePack(repoPath, request, reply) {
        // Hijack the response to prevent Fastify from interfering with binary data
        reply.hijack();

        // Write headers directly to raw response
        reply.raw.writeHead(200, {
            'Content-Type': 'application/x-git-receive-pack-result',
            'Cache-Control': 'no-cache, max-age=0, must-revalidate'
        });

        // Setup environment for git process
        const env = {
            ...process.env,
            'GIT_HTTP_EXPORT_ALL': '1',
            'SSH_ORIGINAL_COMMAND': 'receive-pack'
        };

        // Handle Git-Protocol header if present
        const gitProtocol = request.headers['git-protocol'];
        if (gitProtocol) {
            env['GIT_PROTOCOL'] = gitProtocol;
        }

        const gitProcess = spawn('git', ['receive-pack', '--stateless-rpc', repoPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: env
        });

        // Pipe git stdout directly to the raw response
        gitProcess.stdout.pipe(reply.raw, { end: false });

        gitProcess.stderr.on('data', (data) => {
            debug(`Git receive-pack: ${data.toString().trim()}`);
        });

        // Handle request body
        if (request.body) {
            const bodyBuffer = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body);
            gitProcess.stdin.write(bodyBuffer);
            gitProcess.stdin.end();
        } else {
            request.raw.pipe(gitProcess.stdin);
        }

        // Wait for git process to complete
        return new Promise((resolve, reject) => {
            gitProcess.on('error', (error) => {
                debug(`Git receive-pack error: ${error.message}`);
                reply.raw.end();
                reject(error);
            });

            gitProcess.on('close', (code) => {
                reply.raw.end();

                if (code !== 0) {
                    reject(new Error(`Git receive-pack failed with code ${code}`));
                } else {
                    resolve();
                }
            });
        });
    }
}

export default DotfileManager;

