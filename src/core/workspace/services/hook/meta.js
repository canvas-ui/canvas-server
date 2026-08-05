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
    { name: 'document.inserted', document: true, description: 'A document was indexed/inserted. Batch inserts (imap sync, browser-extension sync) fan out here too: one dispatch per document, full doc loaded, batch:true set.', payload: '{ id, document, context, directory, batch?, batchCount? }' },
    { name: 'document.updated', document: true, description: 'A document was updated or re-linked. Batch updates fan out here per document (batch:true set).', payload: '{ id, document, context, directory, batch?, batchCount? }' },
    { name: 'document.inserted.batch', document: false, description: 'A batch of documents was inserted in one go (imap sync, browser-extension sync). Fires once per batch — use for whole-batch logic (e.g. one agent call for N docs). Per-document logic belongs in document.inserted, which fans out automatically.', payload: '{ ids, count, context, directory }' },
    { name: 'document.updated.batch', document: false, description: 'A batch of documents was updated in one go (once per batch; per-document logic fans out via document.updated)', payload: '{ ids, count, context, directory }' },
    { name: 'document.linked', document: true, description: 'A document was linked into tree path(s). Carries the full document (unlike the membership-only document.updated a link also emits), so rules can match on content — e.g. "email linked under /projects/x → triage agent".', payload: '{ id, document, memberships: { context, directory, features } }' },
    { name: 'document.unlinked', document: true, description: 'A document was removed from tree path(s) but still exists in the index. Carries the full document.', payload: '{ id, document, contextArray, directoryArray, featureArray }' },
    { name: 'document.removed', document: false, description: 'A document was unlinked from paths (id-only compat event; prefer document.unlinked for automation)', payload: '{ id | ids }' },
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
            "            features: [], // TODO: optional tags, e.g. ['tag/urgent']",
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
            "        schema: 'data/schema/note',",
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
        'isTab()', 'isEmail()', 'isFile()', 'isNote()', 'isTodo()', 'isMessage()', 'isEvent()', "isSchema('tab')",
        'isLink()', 'isYoutube()', 'isArxiv()', 'isImageUrl()', "hostMatches('youtube.com')", "urlMatches('substring'|RegExp)",
        'isText()', 'isImage()', 'isAudio()', 'isVideo()', 'isPdf()', 'isBlob()', "mimeMatches('image/*')",
        "sentTo('invoice@corp.tld')", "hasAttachment('application/pdf'?)",
        "inPath('/to-sort')",
    ],
    fields: ['url', 'parsedUrl', 'host', 'from', 'to', 'subject', 'attachments', 'mime', 'paths', 'schema', 'doc'],
});

// Hook context API — every key available on the `ctx` object a hook receives.
// Served via GET /workspaces/:id/hooks/meta for the in-UI reference docs.
export const HOOK_CONTEXT_API = Object.freeze([
    { name: 'payload', signature: 'ctx.payload', description: 'The event payload. document.* events carry the full document (batch inserts fan out per document with batch:true + batchCount).' },
    { name: 'payloads', signature: 'ctx.payloads', description: 'All payloads of a debounced burst (export const debounce = ms). Without debounce it is [payload].' },
    { name: 'classify', signature: 'ctx.classify(target?)', description: 'Classify the event document (default) or another payload/raw doc. Returns predicates like isEmail()/isYoutube()/isPdf()/inPath() plus fields url/host/from/subject/mime/paths. Never throws.' },
    { name: 'logger', signature: 'ctx.logger.debug|info|warn|error(msg)', description: 'Server logger. Output lands in the canvas-server log (debug level is hidden unless the server runs with debug logging).' },
    { name: 'propose', signature: "await ctx.propose(actions, { title?, summary?, editable?, ttl? })", description: "Queue rule-action object(s) (e.g. { action: 'link', paths: [...] }) for human review instead of executing them. Proposals appear in the workspace's Pending actions screen; approval executes them through the normal action pipeline with the triggering event's provenance. `editable` lists JSON paths (e.g. 'actions.0.data.body') the reviewer may amend before approving; `ttl` ('24h', '15m' or ms) expires undecided proposals. Declarative rules get the same behavior with \"approval\": true on the rule (hold the whole then-block) or on a single action." },
    { name: 'notify', signature: "await ctx.notify(message, { channel? })", description: "Send a message to the workspace owner via the messaging service. Uses the user's bound channel (slack, whatsapp, webhook — an outbound URL binding compatible with Slack/Teams incoming webhooks — …) or their default; with nothing bound it delivers in-app ('canvas' channel): a toast in the web UI plus the toolbox notifications area. Silently no-ops if messaging is unavailable." },
    { name: 'agent', signature: "await ctx.agent(slug, prompt, { raw? })", description: 'Prompt an agent by slug (auto-starts it) and return its text reply. The prompt is automatically wrapped in a standard envelope (event, document summary, reply expectations) so the agent knows it is talking to an automation — pass { raw: true } to send your prompt verbatim. Agents only get canvas_* tools if previously bound via PUT /agents/:id/access.' },
    { name: 'insert', signature: 'await ctx.insert(document, { context?, directory?, features? })', description: "Insert a document. The resulting document.inserted carries origin:'hook' (causedBy + depth stamped automatically), so it only reaches hooks/rules that opted into cascading (export const cascade = true / \"cascade\": true) and never past the cascade depth ceiling — self-triggering loops are cut off by construction." },
    { name: 'update', signature: 'await ctx.update(id, document, options?)', description: 'Update a document in place (same id).' },
    { name: 'remove', signature: 'await ctx.remove(id, { context?, directory? })', description: 'Unlink a document from paths (index entry survives).' },
    { name: 'deleteDocument', signature: 'await ctx.deleteDocument(id)', description: 'Hard-delete a document from the index. Bytes on storage backends (blobs, files, mail on the server) are NOT touched.' },
    { name: 'destroy', signature: 'await ctx.destroy(idOrDoc)', description: 'Destroy a document everywhere: delete its bytes on every deletable location (stored:// blob, workspace file, imap EXPUNGE — read-only locations degrade to a reference drop), then purge it from the index. Irreversible.' },
    { name: 'get', signature: 'await ctx.get(id)', description: 'Fetch one document by id (parsed).' },
    { name: 'list', signature: 'await ctx.list(spec)', description: 'List documents ({ context, features, limit, order… }).' },
    { name: 'find', signature: "await ctx.find({ query, … })", description: 'Full-text / hybrid search.' },
    { name: 'link', signature: "await ctx.link(id, ['/path', …])", description: 'Link a document into one or more context paths (loop-safe: rules use emitEvent:false internally).' },
    { name: 'emit', signature: "await ctx.emit(name, payload)", description: "Emit a custom workspace event, stamped source:'hook' so it never re-triggers hooks." },
    { name: 'event', signature: 'ctx.event', description: '{ name, workspaceId, payload, timestamp } envelope. The payload additionally carries provenance: eventId (unique per emit), origin (user|hook|rule|agent|…), causedBy (parent eventId) and depth (automation cascade depth).' },
    { name: 'cascade', signature: 'export const cascade = true', description: 'Module-level opt-in: by default a hook never receives events caused by automation (origin ≠ user — e.g. documents another hook/rule inserted). Export cascade = true to receive them; a hard depth ceiling (hooks.maxDepth, default 2) still terminates any chain.' },
    { name: 'workspace / db / tree', signature: 'ctx.workspace, ctx.db, ctx.tree', description: 'Escape hatches: the Workspace instance, active synapsd db and default context tree (db/tree are null while the workspace is inactive).' },
]);

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
