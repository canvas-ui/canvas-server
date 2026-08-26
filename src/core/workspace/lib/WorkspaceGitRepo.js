'use strict';

import path from 'path';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { spawn } from 'child_process';
import { createLogger } from '../../../utils/log.js';

const defaultLogger = createLogger('workspace-git-repo');

const COMMIT_IDENTITY = ['-c', 'user.name=canvas-server', '-c', 'user.email=noreply@canvas.local'];

function spawnPromise(command, args, options = {}) {
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

/**
 * WorkspaceGitRepo
 *
 * Wraps the per-workspace git repository living at WORKSPACE_ROOT/git: a bare
 * repo (`bare.git`) plus a work tree checked out alongside it. This is the only
 * place that shells out to git for a workspace; it carries no workspace
 * knowledge beyond the two paths, so callers stay decoupled from git mechanics.
 *
 * Layout:
 *   <gitDir>/            work tree (hooks/, scripts/, dotfiles/, ...)
 *   <barePath>           bare repo clients push to / clone from
 */
export class WorkspaceGitRepo {
    #barePath;
    #gitDir;
    #logger;

    constructor({ barePath, gitDir, logger } = {}) {
        if (!barePath || !gitDir) throw new Error('barePath and gitDir are required');
        this.#barePath = barePath;
        this.#gitDir = gitDir;
        this.#logger = logger || defaultLogger;
    }

    get barePath() { return this.#barePath; }
    get gitDir() { return this.#gitDir; }

    exists() {
        return existsSync(this.#barePath);
    }

    // True once the bare repo carries at least one ref (i.e. has been seeded).
    async hasCommits() {
        try {
            const { stdout } = await spawnPromise('git', ['show-ref'], { cwd: this.#barePath });
            return Boolean(stdout?.trim());
        } catch {
            return false;
        }
    }

    async initBare() {
        if (existsSync(this.#barePath)) return { created: false };
        await fsPromises.mkdir(this.#barePath, { recursive: true });
        await spawnPromise('git', ['init', '--bare', '--initial-branch=main'], { cwd: this.#barePath });
        return { created: true };
    }

    // Commit an already-populated work directory and push it to the bare repo as
    // the initial `main`. The caller owns what goes into `workDir`.
    async pushSeed(workDir, message) {
        await spawnPromise('git', ['init', '--initial-branch=main'], { cwd: workDir });
        await spawnPromise('git', ['add', '.'], { cwd: workDir });
        await spawnPromise('git', ['config', 'user.name', 'canvas-server'], { cwd: workDir });
        await spawnPromise('git', ['config', 'user.email', 'noreply@canvas.local'], { cwd: workDir });
        await spawnPromise('git', ['commit', '-m', message], { cwd: workDir });
        await spawnPromise('git', ['remote', 'add', 'origin', this.#barePath], { cwd: workDir });
        await spawnPromise('git', ['push', '-u', 'origin', 'main'], { cwd: workDir });
    }

    // Check out the given pathspecs from bare HEAD into the work tree. Each spec
    // is deployed independently so a repo missing one (older repos predate
    // scripts/) still deploys the others.
    async deploy(pathspecs = ['hooks/', 'scripts/']) {
        if (!existsSync(this.#barePath)) return;
        await fsPromises.mkdir(this.#gitDir, { recursive: true });
        for (const pathspec of pathspecs) {
            try {
                await spawnPromise('git', [...this.#repoArgs(), 'checkout', '-f', 'main', '--', pathspec]);
            } catch (err) {
                this.#logger.debug(`Deploy of ${pathspec} skipped: ${err.message}`);
            }
        }
    }

    // Stage the work-tree state of `pathspec` on top of bare HEAD and commit it.
    // Used to persist edits made directly in the work tree (e.g. webui hook
    // edits) back into the bare repo so they survive the next deploy and reach
    // clients on clone. No-op when the repo does not exist.
    async commitWorkTree(pathspec, message) {
        if (!existsSync(this.#barePath)) return { success: false, skipped: true };

        const pathspecs = Array.isArray(pathspec) ? pathspec : [pathspec];
        const repoArgs = this.#repoArgs();
        try {
            await spawnPromise('git', [...repoArgs, 'read-tree', 'HEAD']);
            await spawnPromise('git', [...repoArgs, 'add', '-A', '--', ...pathspecs]);

            // `diff --cached --quiet` exits non-zero when there are staged
            // changes; a zero exit means nothing to commit.
            try {
                await spawnPromise('git', [...repoArgs, 'diff', '--cached', '--quiet']);
                return { success: true, committed: false };
            } catch { /* staged changes present, fall through to commit */ }

            await spawnPromise('git', [...COMMIT_IDENTITY, ...repoArgs, 'commit', '-m', message]);
            return { success: true, committed: true };
        } catch (err) {
            this.#logger.debug(`commitWorkTree(${pathspec}) failed: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    async status() {
        const branches = [];
        let currentBranch = null;
        try {
            const refsHeadsPath = path.join(this.#barePath, 'refs', 'heads');
            if (existsSync(refsHeadsPath)) {
                for (const file of await fsPromises.readdir(refsHeadsPath)) {
                    if ((await fsPromises.stat(path.join(refsHeadsPath, file))).isFile()) {
                        branches.push(file);
                    }
                }
                currentBranch = branches.includes('main') ? 'main' : branches[0] || null;
            }
        } catch { /* no refs yet */ }
        return { branches, currentBranch };
    }

    // ── Smart-HTTP backend ──────────────────────────────────────────────────
    // Dispatch a git smart-HTTP request. `onReceivePack` runs after a successful
    // push so callers can redeploy hooks/scripts.
    async serveHttp(service, request, reply, { onReceivePack } = {}) {
        if (!existsSync(this.#barePath)) {
            // Typed so the transport can answer 404 with something actionable:
            // an uninitialized repo is a normal state (nobody has run init on
            // this workspace yet), not a server fault.
            const err = new Error('Repository not initialized');
            err.code = 'EGITNOREPO';
            throw err;
        }
        switch (service) {
            case 'info/refs':
                return this.#handleInfoRefs(request, reply);
            case 'git-upload-pack':
                return this.#handleUploadPack(request, reply);
            case 'git-receive-pack':
                return this.#handleReceivePack(request, reply, onReceivePack);
            default:
                throw new Error(`Unsupported Git service: ${service}`);
        }
    }

    #repoArgs() {
        return [`--git-dir=${this.#barePath}`, `--work-tree=${this.#gitDir}`];
    }

    #childEnv(request, extra = {}) {
        const env = { ...process.env, GIT_HTTP_EXPORT_ALL: '1', ...extra };
        const gitProtocol = request.headers['git-protocol'];
        if (gitProtocol) env.GIT_PROTOCOL = gitProtocol;
        return env;
    }

    async #handleInfoRefs(request, reply) {
        const service = request.query.service;
        if (!service || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
            return reply.code(400).send('Invalid service');
        }

        reply.type(`application/x-${service}-advertisement`)
            .header('cache-control', 'no-cache, max-age=0, must-revalidate');

        const serviceName = service.replace('git-', '');
        const gitProcess = spawn('git', [serviceName, '--stateless-rpc', '--advertise-refs', this.#barePath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: this.#childEnv(request),
        });

        return new Promise((resolve, reject) => {
            const chunks = [];
            let totalSize = 0;
            gitProcess.stdout.on('data', (chunk) => { chunks.push(chunk); totalSize += chunk.length; });
            gitProcess.stderr.on('data', (data) => this.#logger.debug(`Git ${serviceName}: ${data.toString().trim()}`));
            gitProcess.on('error', reject);
            gitProcess.on('close', (code) => {
                if (code !== 0) { reply.code(500).send('Git process failed'); resolve(); return; }
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

    #handleUploadPack(request, reply) {
        return this.#streamPack('upload-pack', request, reply);
    }

    async #handleReceivePack(request, reply, onReceivePack) {
        await this.#streamPack('receive-pack', request, reply);
        if (onReceivePack) {
            try { await onReceivePack(); }
            catch (err) { this.#logger.debug(`receive-pack post-hook failed: ${err.message}`); }
        }
    }

    // Shared stateless-rpc streaming for upload-pack / receive-pack.
    #streamPack(serviceName, request, reply) {
        reply.hijack();
        reply.raw.writeHead(200, {
            'Content-Type': `application/x-git-${serviceName}-result`,
            'Cache-Control': 'no-cache, max-age=0, must-revalidate',
        });

        const env = this.#childEnv(request, { SSH_ORIGINAL_COMMAND: serviceName });
        const gitProcess = spawn('git', [serviceName, '--stateless-rpc', this.#barePath], { stdio: ['pipe', 'pipe', 'pipe'], env });
        gitProcess.stdout.pipe(reply.raw, { end: false });
        gitProcess.stderr.on('data', (data) => this.#logger.debug(`Git ${serviceName}: ${data.toString().trim()}`));

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
                code !== 0 ? reject(new Error(`Git ${serviceName} failed with code ${code}`)) : resolve();
            });
        });
    }
}

export default WorkspaceGitRepo;
