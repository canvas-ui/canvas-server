import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { HOOK_EVENTS, HOOK_ACTIONS, generateHookSkeleton } from './meta.js';
import { isDisabledFile, enabledName, disabledName } from './naming.js';

describe('hook naming', () => {
    test('disable prefixes recognized', () => {
        assert.equal(isDisabledFile('example-youtube.js'), true);
        assert.equal(isDisabledFile('disabled-youtube.js'), true);
        assert.equal(isDisabledFile('_youtube.js'), true);
        assert.equal(isDisabledFile('youtube.js'), false);
    });

    test('enabledName strips one prefix, disabledName adds disabled-', () => {
        assert.equal(enabledName('example-youtube.js'), 'youtube.js');
        assert.equal(enabledName('disabled-youtube.js'), 'youtube.js');
        assert.equal(enabledName('_youtube.js'), 'youtube.js');
        assert.equal(enabledName('youtube.js'), 'youtube.js');
        assert.equal(disabledName('youtube.js'), 'disabled-youtube.js');
        assert.equal(disabledName('example-youtube.js'), 'example-youtube.js');
    });
});

describe('hook skeleton generator', () => {
    test('event catalog covers the document CRUD events', () => {
        const names = HOOK_EVENTS.map((e) => e.name);
        for (const required of ['document.inserted', 'document.updated', 'document.removed', 'tree.path.inserted']) {
            assert.ok(names.includes(required), `missing ${required}`);
        }
        assert.ok(HOOK_EVENTS.find((e) => e.name === 'document.inserted').document);
    });

    test('action catalog covers the advertised actions', () => {
        const ids = HOOK_ACTIONS.map((a) => a.id);
        for (const required of ['link', 'insert', 'move', 'agent', 'notify', 'script', 'emit']) {
            assert.ok(ids.includes(required), `missing ${required}`);
        }
    });

    test('generates a disabled skeleton with classify guard for document events', () => {
        const { path, content } = generateHookSkeleton({
            event: 'document.inserted',
            name: 'My Fancy Hook!',
            actions: ['link', 'agent'],
        });
        assert.equal(path, 'document.inserted/disabled-my-fancy-hook.js');
        assert.match(content, /const c = classify\(\)/);
        assert.match(content, /workspace\.link\(doc\.id/);
        assert.match(content, /await agent\(/);
        assert.match(content, /emitEvent: false/);
        assert.doesNotMatch(content, /await notify\(/);
    });

    test('script action pulls in its imports once', () => {
        const { content } = generateHookSkeleton({
            event: 'document.inserted',
            name: 'runner',
            actions: ['script', 'script'],
        });
        assert.equal(content.match(/import { spawn }/g).length, 1);
        assert.match(content, /spawn\('bash'/);
    });

    test('non-document events skip the classify guard', () => {
        const { content } = generateHookSkeleton({ event: 'tree.path.inserted', name: 'x', actions: [] });
        assert.doesNotMatch(content, /const c = classify\(\)/);
        assert.match(content, /does not carry a full document/);
    });

    test('unknown event or action throws', () => {
        assert.throws(() => generateHookSkeleton({ event: 'nope', name: 'x', actions: [] }), /Unknown event/);
        assert.throws(() => generateHookSkeleton({ event: 'document.inserted', name: 'x', actions: ['nope'] }), /Unknown action/);
    });

    test('generated content is valid JS', async () => {
        for (const actions of [['link'], ['insert', 'move', 'agent', 'notify', 'script', 'emit'], []]) {
            const { content } = generateHookSkeleton({ event: 'document.inserted', name: 't', actions });
            const url = `data:text/javascript;base64,${Buffer.from(content).toString('base64')}`;
            const mod = await import(url);
            assert.equal(typeof mod.default, 'function');
        }
    });
});
