'use strict';

import path from 'path';
import os from 'os';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { spawn } from 'child_process';
import EventEmitter from 'eventemitter2';
import { createLogger } from '../../../../utils/log.js';
import { WORKSPACE_DIRECTORIES, WORKSPACE_GIT_BARE_DIR } from '../../lib/constants.js';

const logger = createLogger('dotfile-manager');
const TEMPLATE_DIRNAME = 'files';

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
    return path.dirname(new URL(import.meta.url).pathname);
}

async function copyTemplateInto(targetDir) {
    const templateRoot = path.resolve(getModuleDir(), TEMPLATE_DIRNAME);
    await fsPromises.mkdir(targetDir, { recursive: true });
    const gitignoreSrc = path.join(templateRoot, '.gitignore');
    if (existsSync(gitignoreSrc)) {
        await fsPromises.copyFile(gitignoreSrc, path.join(targetDir, '.gitignore'));
    }
    const dotDirSrc = path.join(templateRoot, '.dot');
    if (existsSync(dotDirSrc)) {
        await fsPromises.cp(dotDirSrc, path.join(targetDir, '.dot'), { recursive: true, force: true });
    }
}

class DotfileManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.workspaceManager = options.workspaceManager;
        if (!this.workspaceManager) {
            throw new Error('WorkspaceManager is required');
        }
        logger.debug('DotfileManager initialized');
    }

    async initialize() {
        return this;
    }

    #getGitDir(workspace) {
        return path.join(workspace.rootPath, WORKSPACE_DIRECTORIES.git);
    }

    #getBareRepoPath(workspace) {
        return path.join(this.#getGitDir(workspace), WORKSPACE_GIT_BARE_DIR);
    }

    async #resolveWorkspace(workspaceIdOrObject, requestingUserId) {
        if (typeof workspaceIdOrObject === 'object' && workspaceIdOrObject.id) {
            return workspaceIdOrObject;
        }
        const workspace = await this.workspaceManager.getWorkspace(workspaceIdOrObject, requestingUserId);
        if (!workspace) {
            throw new Error(`Workspace ${workspaceIdOrObject} not found or access denied`);
        }
        return workspace;
    }

    async hasRepository(userId, workspaceIdOrObject, requestingUserId) {
        const workspace = await this.#resolveWorkspace(workspaceIdOrObject, requestingUserId);
        return existsSync(this.#getBareRepoPath(workspace));
    }

    async enable(workspace, userId) {
        if (!workspace?.id) throw new Error('Invalid workspace');

        const repoPath = this.#getBareRepoPath(workspace);
        const hasRepo = existsSync(repoPath);

        if (!hasRepo) {
            await this.initializeRepository(userId, workspace, userId);
        }

        this.emit('dotfiles.enabled', { workspaceId: workspace.id, path: repoPath });
        logger.debug(`Git service enabled for workspace ${workspace.id}`);
        return { success: true, path: repoPath, initialized: !hasRepo };
    }

    async disable(workspace) {
        if (!workspace?.id) return { success: true };
        this.emit('dotfiles.disabled', { workspaceId: workspace.id });
        return { success: true };
    }

    isEnabled(workspace) {
        if (!workspace?.rootPath) return false;
        return existsSync(this.#getBareRepoPath(workspace));
    }

    async initializeRepository(userId, workspaceIdOrObject, requestingUserId) {
        const workspace = await this.#resolveWorkspace(workspaceIdOrObject, requestingUserId);
        const repoPath = this.#getBareRepoPath(workspace);
        const gitDir = this.#getGitDir(workspace);

        await fsPromises.mkdir(workspace.hooksPath, { recursive: true });

        if (!existsSync(repoPath)) {
            await fsPromises.mkdir(repoPath, { recursive: true });
            await spawnPromise('git', ['init', '--bare', '--initial-branch=main'], { cwd: repoPath });
        } else {
            try {
                const { stdout } = await spawnPromise('git', ['show-ref'], { cwd: repoPath });
                if (stdout?.trim()) {
                    this.emit('repository.initialized', { userId, workspace: workspace.id, path: repoPath });
                    return { success: true, message: 'Repository already initialized', path: repoPath };
                }
            } catch (_) {}
        }

        const tmpWorkDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'canvas-git-'));
        try {
            await spawnPromise('git', ['init', '--initial-branch=main'], { cwd: tmpWorkDir });

            const dotfilesDir = path.join(tmpWorkDir, 'dotfiles');
            await copyTemplateInto(dotfilesDir);

            const encIndexPath = path.join(dotfilesDir, '.dot', 'encrypted.index');
            await fsPromises.mkdir(path.dirname(encIndexPath), { recursive: true });
            if (!existsSync(encIndexPath)) {
                await fsPromises.writeFile(encIndexPath, '');
            }

            const hooksSeedDir = path.join(tmpWorkDir, 'hooks');
            await fsPromises.mkdir(hooksSeedDir, { recursive: true });
            await fsPromises.writeFile(path.join(hooksSeedDir, 'README.md'),
                '# Workspace hooks\n\nEvent hooks are root-level `*.js` files named after workspace events (e.g. `document.inserted.js`).\nOptional shared code lives under `lib/`.\n');
            await fsPromises.writeFile(path.join(hooksSeedDir, 'example.document.inserted.js'),
                `export default async function run({ eventName, payload, logger }) {\n  logger.debug(\`example hook: \${eventName} id=\${payload?.id}\`);\n}\n`);

            await spawnPromise('git', ['add', '.'], { cwd: tmpWorkDir });
            await spawnPromise('git', ['config', 'user.name', 'canvas-server'], { cwd: tmpWorkDir });
            await spawnPromise('git', ['config', 'user.email', 'noreply@canvas.local'], { cwd: tmpWorkDir });
            await spawnPromise('git', ['commit', '-m', 'Initialize Canvas workspace git repository'], { cwd: tmpWorkDir });
            await spawnPromise('git', ['remote', 'add', 'origin', repoPath], { cwd: tmpWorkDir });
            await spawnPromise('git', ['push', '-u', 'origin', 'main'], { cwd: tmpWorkDir });
        } finally {
            try { await fsPromises.rm(tmpWorkDir, { recursive: true, force: true }); } catch (_) {}
        }

        await this.#deployHooks(workspace);
        this.emit('repository.initialized', { userId, workspace: workspace.id, path: repoPath });
        return { success: true, message: 'Repository initialized successfully', path: repoPath };
    }

    async #deployHooks(workspace) {
        const barePath = this.#getBareRepoPath(workspace);
        const gitDir = this.#getGitDir(workspace);
        const hooksDir = workspace.hooksPath;

        if (!existsSync(barePath)) return;

        await fsPromises.mkdir(hooksDir, { recursive: true });
        try {
            await spawnPromise('git', [
                `--git-dir=${barePath}`,
                `--work-tree=${gitDir}`,
                'checkout', '-f', 'main', '--', 'hooks/',
            ]);
        } catch (err) {
            logger.debug(`Hook deploy skipped for ${workspace.id}: ${err.message}`);
        }
    }

    async getRepositoryStatus(userId, workspaceIdOrObject, requestingUserId) {
        const workspace = await this.#resolveWorkspace(workspaceIdOrObject, requestingUserId);
        const repoPath = this.#getBareRepoPath(workspace);

        if (!existsSync(repoPath)) {
            return { initialized: false, path: repoPath };
        }

        let branches = [];
        let currentBranch = null;
        try {
            const refsHeadsPath = path.join(repoPath, 'refs', 'heads');
            if (existsSync(refsHeadsPath)) {
                const refFiles = await fsPromises.readdir(refsHeadsPath);
                for (const file of refFiles) {
                    const filePath = path.join(refsHeadsPath, file);
                    if ((await fsPromises.stat(filePath)).isFile()) {
                        branches.push(file);
                    }
                }
                currentBranch = branches.includes('main') ? 'main' : branches[0];
            }
        } catch (_) {}

        return { initialized: true, path: repoPath, branches, currentBranch, bare: true };
    }

    async handleGitHttpBackend(userId, workspaceIdOrObject, requestingUserId, service, request, reply) {
        const workspace = await this.#resolveWorkspace(workspaceIdOrObject, requestingUserId);
        const repoPath = this.#getBareRepoPath(workspace);

        if (!existsSync(repoPath)) {
            throw new Error('Repository not initialized');
        }

        switch (service) {
            case 'info/refs':
                return this.#handleInfoRefs(repoPath, request, reply);
            case 'git-upload-pack':
                return this.#handleUploadPack(repoPath, request, reply);
            case 'git-receive-pack':
                return this.#handleReceivePack(workspace, repoPath, request, reply);
            default:
                throw new Error(`Unsupported Git service: ${service}`);
        }
    }

    async #handleInfoRefs(repoPath, request, reply) {
        const service = request.query.service;
        if (!service || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
            return reply.code(400).send('Invalid service');
        }

        const contentType = `application/x-${service}-advertisement`;
        reply.type(contentType).header('cache-control', 'no-cache, max-age=0, must-revalidate');

        const env = { ...process.env, GIT_HTTP_EXPORT_ALL: '1' };
        const gitProtocol = request.headers['git-protocol'];
        if (gitProtocol) env.GIT_PROTOCOL = gitProtocol;

        const serviceName = service.replace('git-', '');
        const gitProcess = spawn('git', [serviceName, '--stateless-rpc', '--advertise-refs', repoPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        });

        return new Promise((resolve, reject) => {
            const chunks = [];
            let totalSize = 0;

            gitProcess.stdout.on('data', (chunk) => {
                chunks.push(chunk);
                totalSize += chunk.length;
            });
            gitProcess.stderr.on('data', (data) => {
                logger.debug(`Git ${serviceName}: ${data.toString().trim()}`);
            });
            gitProcess.on('error', reject);
            gitProcess.on('close', (code) => {
                if (code !== 0) {
                    reply.code(500).send('Git process failed');
                    resolve();
                    return;
                }
                const refs = Buffer.concat(chunks, totalSize);
                const serviceHeader = `# service=${service}\n`;
                const headerLength = (serviceHeader.length + 4).toString(16).padStart(4, '0');
                reply.send(Buffer.concat([
                    Buffer.from(headerLength + serviceHeader),
                    Buffer.from('0000'),
                    refs,
                ]));
                resolve();
            });
            gitProcess.stdin.end();
        });
    }

    async #handleUploadPack(repoPath, request, reply) {
        reply.hijack();
        reply.raw.writeHead(200, {
            'Content-Type': 'application/x-git-upload-pack-result',
            'Cache-Control': 'no-cache, max-age=0, must-revalidate',
        });

        const env = { ...process.env, GIT_HTTP_EXPORT_ALL: '1', SSH_ORIGINAL_COMMAND: 'upload-pack' };
        const gitProtocol = request.headers['git-protocol'];
        if (gitProtocol) env.GIT_PROTOCOL = gitProtocol;

        const gitProcess = spawn('git', ['upload-pack', '--stateless-rpc', repoPath], { stdio: ['pipe', 'pipe', 'pipe'], env });
        gitProcess.stdout.pipe(reply.raw, { end: false });
        gitProcess.stderr.on('data', (data) => logger.debug(`Git upload-pack: ${data.toString().trim()}`));

        if (request.body) {
            gitProcess.stdin.write(Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body));
            gitProcess.stdin.end();
        } else {
            request.raw.pipe(gitProcess.stdin);
        }

        return new Promise((resolve, reject) => {
            gitProcess.on('error', (error) => { reply.raw.end(); reject(error); });
            gitProcess.on('close', (code) => {
                reply.raw.end();
                code !== 0 ? reject(new Error(`Git upload-pack failed with code ${code}`)) : resolve();
            });
        });
    }

    async #handleReceivePack(workspace, repoPath, request, reply) {
        reply.hijack();
        reply.raw.writeHead(200, {
            'Content-Type': 'application/x-git-receive-pack-result',
            'Cache-Control': 'no-cache, max-age=0, must-revalidate',
        });

        const env = { ...process.env, GIT_HTTP_EXPORT_ALL: '1', SSH_ORIGINAL_COMMAND: 'receive-pack' };
        const gitProtocol = request.headers['git-protocol'];
        if (gitProtocol) env.GIT_PROTOCOL = gitProtocol;

        const gitProcess = spawn('git', ['receive-pack', '--stateless-rpc', repoPath], { stdio: ['pipe', 'pipe', 'pipe'], env });
        gitProcess.stdout.pipe(reply.raw, { end: false });
        gitProcess.stderr.on('data', (data) => logger.debug(`Git receive-pack: ${data.toString().trim()}`));

        if (request.body) {
            gitProcess.stdin.write(Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body));
            gitProcess.stdin.end();
        } else {
            request.raw.pipe(gitProcess.stdin);
        }

        return new Promise((resolve, reject) => {
            gitProcess.on('error', (error) => { reply.raw.end(); reject(error); });
            gitProcess.on('close', async (code) => {
                reply.raw.end();
                if (code !== 0) {
                    reject(new Error(`Git receive-pack failed with code ${code}`));
                    return;
                }
                try { await this.#deployHooks(workspace); } catch (err) {
                    logger.debug(`Hook deploy after push failed for ${workspace.id}: ${err.message}`);
                }
                resolve();
            });
        });
    }
}

export default DotfileManager;
