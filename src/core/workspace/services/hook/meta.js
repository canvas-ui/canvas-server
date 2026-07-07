'use strict';

/**
 * Hook authoring metadata: the event catalog, the action catalog and the
 * skeleton generator behind `GET /workspaces/:id/hooks/meta` and
 * `POST /workspaces/:id/hooks/generate`. The webui create-hook wizard is a
 * thin client of these two endpoints.
 */

// ── Event catalog ────────────────────────────────────────────────────────────
// Canonical names come from synapsd (src/services/synapsd/src/utils/events.js),
// re-emitted on the workspace, plus workspace lifecycle events. `document`
// marks events whose payload carries the full parsed document (the ones
// classify() and declarative rules work best with).

export const HOOK_EVENTS = Object.freeze([
    // Document CRUD — the workhorses
    { name: 'document.inserted', document: true, description: 'A document was indexed/inserted', payload: '{ id, document, context, directory }' },
    { name: 'document.updated', document: true, description: 'A document was updated or re-linked', payload: '{ id, document, context, directory }' },
    { name: 'document.removed', document: false, description: 'A document was unlinked from paths', payload: '{ id | ids }' },
    { name: 'document.deleted', document: false, description: 'A document was hard-deleted', payload: '{ id | ids }' },
    { name: 'document.removed.batch', document: false, description: 'Bulk unlink (single event for the batch)', payload: '{ ids }' },
    { name: 'document.deleted.batch', document: false, description: 'Bulk delete (single event for the batch)', payload: '{ ids }' },
    { name: 'membership.changed', document: false, description: 'Low-level bitmap membership change (post-commit)', payload: '{ changes: [{ docId, op, keys }] }' },

    // Tree structure
    { name: 'tree.path.inserted', document: false, description: 'A tree path (folder) was created', payload: '{ path, treeId, treeName }' },
    { name: 'tree.path.moved', document: false, description: 'A tree path was moved', payload: '{ from, to, treeId }' },
    { name: 'tree.path.copied', document: false, description: 'A tree path was copied', payload: '{ from, to, treeId }' },
    { name: 'tree.path.removed', document: false, description: 'A tree path was removed', payload: '{ path, treeId }' },
    { name: 'tree.path.locked', document: false, description: 'A tree path was locked', payload: '{ path, treeId }' },
    { name: 'tree.path.unlocked', document: false, description: 'A tree path was unlocked', payload: '{ path, treeId }' },
    { name: 'tree.created', document: false, description: 'A tree was created', payload: '{ treeId, treeName, treeType }' },
    { name: 'tree.renamed', document: false, description: 'A tree was renamed', payload: '{ treeId, treeName }' },
    { name: 'tree.deleted', document: false, description: 'A tree was deleted', payload: '{ treeId }' },
    { name: 'tree.document.inserted', document: false, description: 'Document linked into a specific tree', payload: '{ documentId, treeId }' },
    { name: 'tree.document.removed', document: false, description: 'Document removed from a specific tree', payload: '{ documentId, treeId }' },

    // Workspace lifecycle & config
    { name: 'started', document: false, description: 'Workspace became active', payload: '{ workspaceId }' },
    { name: 'stopped', document: false, description: 'Workspace stopped', payload: '{ workspaceId }' },
    { name: 'status.changed', document: false, description: 'Workspace status transition', payload: '{ workspaceId, status }' },
    { name: 'dataBackends.changed', document: false, description: 'Workspace data backends re-configured', payload: '{ workspaceId }' },
    { name: 'services.changed', document: false, description: 'Workspace services toggled', payload: '{ workspaceId }' },
    { name: 'links.changed', document: false, description: 'Workspace public links changed', payload: '{ workspaceId }' },
]);

// ── Action catalog ───────────────────────────────────────────────────────────
// Each action contributes: context keys it needs destructured, and a code
// block dropped into the generated skeleton. Blocks are written to be
// runnable-but-harmless until the author edits the TODO lines.

export const HOOK_ACTIONS = Object.freeze([
    {
        id: 'link',
        label: 'Link to tree paths',
        description: 'Link the document to one or more context tree paths (optionally with feature tags)',
        needs: ['workspace'],
        snippet: [
            '    // Link the document to context tree paths.',
            "    const targetPaths = ['/to-sort']; // TODO: your paths",
            '    for (const targetPath of targetPaths) {',
            '        await workspace.link(doc.id, {',
            '            context: workspace.getContextTreeSelector(targetPath),',
            "            features: [], // TODO: optional tags, e.g. ['custom/tag/urgent']",
            '            emitEvent: false, // do not re-trigger hooks',
            '        });',
            '        logger.debug(`linked ${doc.id} -> ${targetPath}`);',
            '    }',
        ],
    },
    {
        id: 'insert',
        label: 'Insert a document',
        description: 'Create a new document (e.g. a note) linked to a context path',
        needs: ['insert'],
        snippet: [
            '    // Insert a new document. NOTE: inserted docs emit a regular',
            '    // document.inserted — make sure it cannot re-match this hook.',
            '    const note = await insert({',
            "        schema: 'data/abstraction/note',",
            "        data: { title: 'TODO title', content: 'TODO content' },",
            "    }, { context: payload?.context?.paths ?? payload?.context?.path ?? '/' });",
            '    logger.debug(`inserted note ${note?.id}`);',
        ],
    },
    {
        id: 'move',
        label: 'Move / remove from paths',
        description: 'Unlink the document from its current path (move = link elsewhere + unlink)',
        needs: ['remove'],
        snippet: [
            '    // Remove (unlink) the document from a path — pair with a link',
            '    // action above to implement a move.',
            "    await remove(doc.id, { context: '/to-sort' }); // TODO: source path",
            '    logger.debug(`unlinked ${doc.id} from /to-sort`);',
        ],
    },
    {
        id: 'agent',
        label: 'Trigger an agent',
        description: 'Prompt one of your agents (must be bound to this workspace); returns its text reply',
        needs: ['agent'],
        snippet: [
            '    // Prompt an agent. Vision-capable agents can inspect image docs',
            '    // via their canvas_* tools when given the document id.',
            "    const reply = await agent('assistant', // TODO: agent slug",
            '        `Document ${doc.id} (${doc.schema}) just landed. TODO: instructions.`,',
            '    );',
            "    if (!reply) { logger.debug('agent unavailable'); return; }",
            '    logger.debug(`agent replied: ${reply.slice(0, 120)}`);',
        ],
    },
    {
        id: 'notify',
        label: 'Send a notification',
        description: 'Message the workspace owner over a bound channel (Slack/WhatsApp/default)',
        needs: ['notify'],
        snippet: [
            '    // Notify the workspace owner (configure channels via',
            '    // PUT /rest/v2/messaging/bindings).',
            '    await notify(`[canvas] TODO message about doc ${doc.id}`);',
        ],
    },
    {
        id: 'script',
        label: 'Run a script',
        description: 'Spawn a bash script from git/scripts (fire-and-forget)',
        needs: ['workspace'],
        imports: [
            "import { spawn } from 'node:child_process';",
            "import { existsSync } from 'node:fs';",
            "import path from 'node:path';",
        ],
        snippet: [
            '    // Fire-and-forget a script from git/scripts.',
            "    const script = path.join(workspace.rootPath, 'git', 'scripts', 'my-script.sh'); // TODO",
            '    if (existsSync(script)) {',
            "        const child = spawn('bash', [script, String(doc.id)], { stdio: 'ignore', detached: true });",
            "        child.on('error', (err) => logger.debug(`spawn failed: ${err.message}`));",
            '        child.unref();',
            '    }',
        ],
    },
    {
        id: 'emit',
        label: 'Emit a custom event',
        description: "Re-emit a workspace event (stamped source:'hook', never re-dispatched)",
        needs: ['emit'],
        snippet: [
            '    // Emit a custom workspace event other systems can listen to.',
            "    await emit('custom.my-event', { documentId: doc.id }); // TODO: event name",
        ],
    },
]);

// ── Classifier surface (for the wizard's help panel) ─────────────────────────

export const CLASSIFIER_SURFACE = Object.freeze({
    predicates: [
        'isTab()', 'isEmail()', 'isFile()', 'isNote()', 'isTodo()', 'isMessage()', "isSchema('tab')",
        'isLink()', 'isYoutube()', 'isArxiv()', 'isImageUrl()', "hostMatches('youtube.com')", "urlMatches('substring'|RegExp)",
        'isText()', 'isImage()', 'isAudio()', 'isVideo()', 'isPdf()', 'isBlob()', "mimeMatches('image/*')",
        "inPath('/to-sort')",
    ],
    fields: ['url', 'parsedUrl', 'host', 'from', 'subject', 'mime', 'paths', 'schema', 'doc'],
});

// ── Skeleton generator ───────────────────────────────────────────────────────

const BASE_CONTEXT_KEYS = ['classify', 'payload', 'logger'];

/**
 * Generate an editable hook skeleton for an event + selected actions.
 * @param {Object} spec
 * @param {string} spec.event - event name (validated against HOOK_EVENTS)
 * @param {string} spec.name - hook basename without extension (e.g. 'my-hook')
 * @param {string[]} spec.actions - HOOK_ACTIONS ids, in execution order
 * @returns {{ path: string, content: string }}
 */
export function generateHookSkeleton({ event, name, actions = [] }) {
    const eventDef = HOOK_EVENTS.find((e) => e.name === event);
    if (!eventDef) { throw new Error(`Unknown event: ${event}`); }

    const safeName = String(name || 'my-hook')
        .toLowerCase()
        .replace(/\.js$/, '')
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'my-hook';

    const selected = actions.map((id) => {
        const action = HOOK_ACTIONS.find((a) => a.id === id);
        if (!action) { throw new Error(`Unknown action: ${id}`); }
        return action;
    });

    const contextKeys = [...new Set([...BASE_CONTEXT_KEYS, ...selected.flatMap((a) => a.needs)])];
    const imports = [...new Set(selected.flatMap((a) => a.imports || []))];

    const lines = [];
    if (imports.length) { lines.push(...imports, ''); }
    lines.push(
        `// ${safeName} — ${eventDef.description}.`,
        `// Event payload: ${eventDef.payload}`,
        '// Context API: see hooks/README.md and hooks/example-api-reference.js.',
        '',
        `export default async function hook({ ${contextKeys.join(', ')} }) {`,
    );

    if (eventDef.document) {
        lines.push(
            '    const c = classify();',
            '    const doc = payload?.document;',
            '    if (!doc?.id) { return; }',
            '',
            '    // TODO: narrow the match. Examples:',
            "    //   if (!c.isTab() || !c.isYoutube()) { return; }",
            "    //   if (!c.isEmail() || c.from !== 'boss@corp.com') { return; }",
            "    //   if (!c.isFile() || !c.mimeMatches('image/*') || !c.inPath('/to-sort')) { return; }",
        );
    } else {
        lines.push(
            '    // NOTE: this event does not carry a full document; use payload',
            '    // fields directly (see the payload shape above), or fetch docs',
            '    // by id via get(id).',
            '    const doc = payload?.document ?? null; // usually null for this event',
            '    if (doc) { /* classify(doc) works on fetched documents too */ }',
            `    logger.debug(\`${safeName}: ${event} fired\`, payload);`,
        );
    }

    for (const action of selected) {
        lines.push('', ...action.snippet);
    }

    lines.push('}', '');

    // Created disabled so the unedited TODO skeleton can't fire on live
    // events; the author edits it, then enables (strips the prefix).
    return {
        path: `${event}/disabled-${safeName}.js`,
        content: lines.join('\n'),
    };
}
