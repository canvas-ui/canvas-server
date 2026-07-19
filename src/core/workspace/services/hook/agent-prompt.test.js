import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHookAgentPrompt } from './agent-prompt.js';

describe('buildHookAgentPrompt', () => {
    test('wraps the task with event, doc summary and reply expectations', () => {
        const prompt = buildHookAgentPrompt({
            workspaceName: 'universe',
            eventName: 'document.inserted',
            payload: {
                document: {
                    id: 42,
                    schema: 'data/abstraction/email',
                    data: { subject: 'DC migration window', from: { address: 'boss@corp.tld', name: 'Boss' } },
                    metadata: { contentType: 'message/rfc822' },
                },
                directory: { path: '/imap/a@b.c/inbox' },
                context: null,
            },
            prompt: 'Summarize this email in two sentences.',
        });
        assert.ok(prompt.startsWith('[Canvas workspace automation]'));
        assert.ok(prompt.includes('Event: "document.inserted" in workspace "universe"'));
        assert.ok(prompt.includes('- id: 42'));
        assert.ok(prompt.includes('- type: data/abstraction/email'));
        assert.ok(prompt.includes('- title: DC migration window'));
        assert.ok(prompt.includes('- from: boss@corp.tld'));
        assert.ok(prompt.includes('- filed under: /imap/a@b.c/inbox'));
        assert.ok(prompt.includes('Task from the hook author:\nSummarize this email in two sentences.'));
        assert.ok(prompt.includes('Reply with the final result only'));
    });

    test('degrades gracefully without a document and clips long fields', () => {
        const noDoc = buildHookAgentPrompt({
            workspaceName: 'ws', eventName: 'tree.path.inserted',
            payload: { path: '/x' }, prompt: 'do something',
        });
        assert.ok(!noDoc.includes('Document:'));
        assert.ok(noDoc.includes('do something'));

        const long = buildHookAgentPrompt({
            workspaceName: 'ws', eventName: 'document.inserted',
            payload: { document: { id: 1, schema: 's', data: { title: 'x'.repeat(1000) } } },
            prompt: 'p',
        });
        const titleLine = long.split('\n').find((l) => l.startsWith('- title:'));
        assert.ok(titleLine.length < 350);
        assert.ok(titleLine.endsWith('…'));
    });
});
