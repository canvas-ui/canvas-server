import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DotfileManager from './index.js';

describe('DotfileManager seed backfill', () => {
    let rootPath;
    let workspace;
    let manager;

    beforeEach(() => {
        rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dotfile-backfill-'));
        workspace = {
            id: 'ws-backfill',
            rootPath,
            hooksPath: path.join(rootPath, 'git', 'hooks'),
        };
        manager = new DotfileManager({
            workspaceManager: { getWorkspace: async () => workspace },
        });
    });

    afterEach(() => {
        fs.rmSync(rootPath, { recursive: true, force: true });
    });

    test('copies missing seed files into the work tree (no git repo needed)', async () => {
        const { added } = await manager.backfillSeed(workspace);
        assert.ok(added.length > 0);
        assert.ok(fs.existsSync(path.join(rootPath, 'git', 'hooks', 'example-api-reference.js')));
        assert.ok(fs.existsSync(path.join(rootPath, 'git', 'hooks', 'example-rules.json')));
        assert.ok(fs.existsSync(path.join(rootPath, 'git', 'hooks', 'document.inserted', 'example-youtube-downloader.js')));
        const script = path.join(rootPath, 'git', 'scripts', 'fetch-url.sh');
        assert.ok(fs.existsSync(script));
        assert.ok(fs.statSync(script).mode & 0o100, 'script is executable');
    });

    test('runs once per workspace per process', async () => {
        const first = await manager.backfillSeed(workspace);
        assert.ok(first.added.length > 0);
        const second = await manager.backfillSeed(workspace);
        assert.equal(second.added.length, 0);
    });

    test('never overwrites and respects enabled/disabled name equivalence', async () => {
        const hookDir = path.join(rootPath, 'git', 'hooks', 'document.inserted');
        fs.mkdirSync(hookDir, { recursive: true });
        // User enabled (renamed) this example earlier — backfill must not re-add it.
        fs.writeFileSync(path.join(hookDir, 'youtube-downloader.js'), '// user version');
        // User has a disabled copy of another one.
        fs.writeFileSync(path.join(hookDir, 'disabled-email-linker.js'), '// user version');

        const { added } = await manager.backfillSeed(workspace);
        assert.ok(!added.some((p) => p.includes('youtube-downloader')));
        assert.ok(!added.some((p) => p.includes('email-linker')));
        assert.ok(!fs.existsSync(path.join(hookDir, 'example-youtube-downloader.js')));
        assert.equal(fs.readFileSync(path.join(hookDir, 'youtube-downloader.js'), 'utf8'), '// user version');
        // Others still arrive.
        assert.ok(fs.existsSync(path.join(hookDir, 'example-arxiv-summarizer.js')));
    });

    test('refreshes a stale hooks/README.md in place (docs only, hooks untouched)', async () => {
        const hooksDir = path.join(rootPath, 'git', 'hooks');
        fs.mkdirSync(path.join(hooksDir, 'document.inserted'), { recursive: true });
        fs.writeFileSync(path.join(hooksDir, 'README.md'), '# old docs\n');
        fs.writeFileSync(path.join(hooksDir, 'document.inserted', 'youtube-downloader.js'), '// user version');

        const { added } = await manager.backfillSeed(workspace);

        // README replaced with the shipped copy…
        assert.ok(added.includes(path.join('hooks', 'README.md')));
        const readme = fs.readFileSync(path.join(hooksDir, 'README.md'), 'utf8');
        assert.ok(readme.includes('Execution model'), 'shipped README content present');
        // …while user hooks are never overwritten.
        assert.equal(
            fs.readFileSync(path.join(hooksDir, 'document.inserted', 'youtube-downloader.js'), 'utf8'),
            '// user version',
        );
    });

    test('README refresh is a no-op when content already matches', async () => {
        await manager.backfillSeed(workspace);
        // New manager instance to reset the once-per-process guard.
        const manager2 = new DotfileManager({ workspaceManager: { getWorkspace: async () => workspace } });
        const { added } = await manager2.backfillSeed(workspace);
        assert.ok(!added.includes(path.join('hooks', 'README.md')));
    });
});
