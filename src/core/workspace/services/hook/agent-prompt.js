'use strict';

/**
 * Standard envelope for agent prompts fired from hooks/rules.
 *
 * A hook author's prompt ("Summarize: {{doc.data.subject}}") arrives at the
 * agent with zero context — a small secretary model has no idea who is
 * talking, what happened, or what shape of answer is expected. This wraps the
 * author's task with: what invoked it (automation, not a human), the event,
 * a compact document summary, and reply expectations (final result only —
 * the reply is consumed programmatically).
 *
 * Used by the hook context's agent() helper (rules' agent action goes through
 * the same helper). Opt out per call with agent(slug, prompt, { raw: true }).
 */

const MAX_FIELD = 300;

function clip(value) {
    const s = String(value ?? '');
    return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
}

function pathStrings(value) {
    if (value == null) { return []; }
    const raw = typeof value === 'object' && !Array.isArray(value)
        ? (value.paths ?? value.path ?? [])
        : value;
    return (Array.isArray(raw) ? raw : [raw]).filter((p) => typeof p === 'string' && p);
}

export function buildHookAgentPrompt({ workspaceName, eventName, payload, prompt }) {
    const doc = payload?.document || null;
    const lines = [
        '[Canvas workspace automation]',
        `You are invoked automatically by a workspace hook — there is no human in this conversation and nobody can answer questions. Event: "${eventName}" in workspace "${workspaceName}".`,
    ];

    if (doc) {
        lines.push('', 'Document:');
        if (doc.id != null) { lines.push(`- id: ${doc.id}`); }
        if (doc.schema) { lines.push(`- type: ${doc.schema}`); }
        const title = doc.data?.title || doc.data?.subject || doc.data?.filename;
        if (title) { lines.push(`- title: ${clip(title)}`); }
        const from = doc.data?.from;
        if (from) {
            lines.push(`- from: ${clip(typeof from === 'object' ? (from.address || JSON.stringify(from)) : from)}`);
        }
        if (doc.data?.url) { lines.push(`- url: ${clip(doc.data.url)}`); }
        const mime = doc.metadata?.contentType;
        if (mime) { lines.push(`- mime: ${mime}`); }
        const paths = [...pathStrings(payload?.context), ...pathStrings(payload?.directory)];
        if (paths.length) { lines.push(`- filed under: ${paths.join(', ')}`); }
    }

    lines.push(
        '',
        'Task from the hook author:',
        String(prompt ?? ''),
        '',
        'Reply with the final result only — plain text or markdown, no questions, no preamble, no sign-off. Your reply is consumed programmatically by the hook (it may be saved as a note, sent as a notification, or parsed).',
    );
    return lines.join('\n');
}

export default buildHookAgentPrompt;
