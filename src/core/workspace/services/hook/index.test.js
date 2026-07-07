import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EventEmitter from 'eventemitter2';
import HookService from './index.js';

function createWorkspace(id = 'workspace-1', rootPath = '/tmp/workspace') {
    const workspace = new EventEmitter({ wildcard: true, delimiter: '.', newListener: false });
    workspace.id = id;
    workspace.name = 'test-workspace';
    workspace.rootPath = rootPath;
    workspace.hooksPath = path.join(rootPath, 'git/hooks');
    workspace.isActive = false;
    return workspace;
}

describe('HookService', () => {
    test('deduplicates identical workspace events briefly', async () => {
        const workspace = createWorkspace();
        const calls = [];
        const service = new HookService({
            workspaceManager: { getWorkspace: async () => workspace },
            contextManager: {},
        });
        service.registerHook({
            id: 'test-hook',
            events: ['document.inserted'],
            run: async (eventName, payload) => calls.push({ eventName, payload }),
        });

        service.trackWorkspace(workspace);
        workspace.emit('document.inserted', { id: 42, source: 'db' });
        workspace.emit('document.inserted', { id: 42, source: 'db' });
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.equal(calls.length, 1);
    });

    test('does not dispatch hook-originated events back into hooks', async () => {
        const workspace = createWorkspace();
        const calls = [];
        const service = new HookService({
            workspaceManager: { getWorkspace: async () => workspace },
            contextManager: {},
        });
        service.registerHook({
            id: 'test-hook',
            events: ['document.inserted'],
            run: async (eventName, payload) => calls.push({ eventName, payload }),
        });

        service.trackWorkspace(workspace);
        workspace.emit('document.inserted', { id: 42, source: 'hook' });
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.equal(calls.length, 0);
    });
});

describe('HookService declarative rules', () => {
    let rootPath;
    let workspace;
    let service;
    let linkCalls;

    function writeRules(relPath, rules) {
        const filePath = path.join(workspace.hooksPath, relPath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({ rules }));
        return filePath;
    }

    const youtubeRule = {
        id: 'youtube-to-media',
        when: { event: 'document.inserted', schema: 'tab', url: { host: 'youtube.com' } },
        then: [{ action: 'link', paths: ['/media/youtube'], tags: ['custom/video'] }],
    };

    function emitYoutubeTab(id = 7) {
        workspace.emit('document.inserted', {
            id,
            document: { id, schema: 'data/abstraction/tab', data: { url: 'https://www.youtube.com/watch?v=abc' } },
            context: { paths: ['/inbox'] },
            source: 'db',
        });
    }

    beforeEach(() => {
        rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-service-'));
        workspace = createWorkspace('workspace-rules', rootPath);
        fs.mkdirSync(workspace.hooksPath, { recursive: true });
        linkCalls = [];
        workspace.getContextTreeSelector = (p) => ({ type: 'context', path: p });
        workspace.link = async (id, opts) => linkCalls.push({ id, opts });
        service = new HookService({
            workspaceManager: { getWorkspace: async () => workspace },
        });
        service.trackWorkspace(workspace);
    });

    afterEach(() => {
        service.untrackWorkspace(workspace.id);
        fs.rmSync(rootPath, { recursive: true, force: true });
    });

    test('matching rule in rules.json fires link with emitEvent:false', async () => {
        writeRules('rules.json', [youtubeRule]);
        emitYoutubeTab();
        await new Promise(resolve => setTimeout(resolve, 30));

        assert.equal(linkCalls.length, 1);
        assert.equal(linkCalls[0].id, 7);
        assert.deepEqual(linkCalls[0].opts.context, { type: 'context', path: '/media/youtube' });
        assert.deepEqual(linkCalls[0].opts.features, ['custom/video']);
        assert.equal(linkCalls[0].opts.emitEvent, false);
    });

    test('non-matching event/schema leaves rules idle', async () => {
        writeRules('rules.json', [youtubeRule]);
        workspace.emit('document.inserted', {
            id: 8,
            document: { id: 8, schema: 'data/abstraction/note', data: { title: 'n' } },
            source: 'db',
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 0);
    });

    test('hook-originated events never reach rules', async () => {
        writeRules('rules.json', [youtubeRule]);
        workspace.emit('document.inserted', {
            id: 9,
            document: { id: 9, schema: 'data/abstraction/tab', data: { url: 'https://youtube.com/watch?v=x' } },
            source: 'hook',
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 0);
    });

    test('underscore-prefixed rule files are ignored', async () => {
        writeRules('rules/_disabled.json', [youtubeRule]);
        emitYoutubeTab();
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 0);
    });

    test('editing rules.json hot-reloads (mtime cache refresh)', async () => {
        const filePath = writeRules('rules.json', [youtubeRule]);
        emitYoutubeTab(10);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 1);

        fs.writeFileSync(filePath, JSON.stringify({
            rules: [{ ...youtubeRule, then: [{ action: 'link', paths: ['/elsewhere'] }] }],
        }));
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(filePath, future, future);

        emitYoutubeTab(11);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 2);
        assert.deepEqual(linkCalls[1].opts.context, { type: 'context', path: '/elsewhere' });
    });

    test('hook context exposes classify()', async () => {
        const hookDir = path.join(workspace.hooksPath, 'document.inserted');
        fs.mkdirSync(hookDir, { recursive: true });
        const resultFile = path.join(rootPath, 'classify-result.json');
        fs.writeFileSync(path.join(hookDir, 'probe.js'), `
import fs from 'node:fs';
export default async function hook({ classify }) {
    const c = classify();
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
        isTab: c.isTab(), isYoutube: c.isYoutube(), inInbox: c.inPath('/inbox'),
    }));
}
`);
        emitYoutubeTab(12);
        await new Promise(resolve => setTimeout(resolve, 60));

        const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        assert.deepEqual(result, { isTab: true, isYoutube: true, inInbox: true });
    });
});
