'use strict';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { isDisabledFile } from './naming.js';
import { WORKSPACE_DIRECTORIES } from '../../lib/constants.js';

/**
 * Declarative hook rules (canvas.hook-rules/v1).
 *
 * Rules live next to JS hooks in `{WORKSPACE_ROOT}/git/hooks` as `rules.json`
 * plus `rules/*.json` (merged in filename sort order). An `example-`,
 * `disabled-` or `_` prefix deactivates a file (same convention as JS hooks);
 * a rule with `enabled: false` is skipped individually.
 *
 * Rule shape:
 *   { id, enabled?, description?, cascade?, approval?, editable?, ttl?,
 *     when: { event, schema?, path?, url?, from?, to?, subject?, mime?,
 *     attachment? }, then: [ { action, ..., approval? } ] }
 *
 * `approval: true` (rule-level: hold the whole `then` block; action-level:
 * hold that action only) diverts execution into the pending-actions review
 * queue — see pending-actions.js. `editable` lists JSON paths the reviewer
 * may amend; `ttl` expires undecided proposals.
 *
 * `when` keys AND together; a key's value may be an array (any-of / OR).
 * Every matching rule fires — there is no first-match-wins, which keeps the
 * format trivially composable for a UI rule builder.
 */

// ── Loading ──────────────────────────────────────────────────────────────────

export function resolveRuleFiles(hooksRoot) {
    const files = [];

    const singleFile = path.join(hooksRoot, 'rules.json');
    try {
        if (fs.statSync(singleFile).isFile()) { files.push(singleFile); }
    } catch { /* absent */ }

    const rulesDir = path.join(hooksRoot, 'rules');
    try {
        const entries = fs.readdirSync(rulesDir, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith('.json') && !isDisabledFile(e.name))
            .map((e) => path.join(rulesDir, e.name))
            .sort();
        files.push(...entries);
    } catch { /* no rules directory */ }

    return files;
}

// Mtime-keyed cache (same pattern as HookService#loadHookRun): an edited file
// is re-parsed, an unchanged one is parsed once. Malformed JSON yields [].
export function loadRuleFile(filePath, cache, logger = null) {
    let stat;
    try {
        stat = fs.statSync(filePath);
        if (!stat.isFile()) { return []; }
    } catch {
        return [];
    }

    const cached = cache?.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) { return cached.rules; }

    let rules = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const list = Array.isArray(parsed) ? parsed : parsed?.rules;
        if (Array.isArray(list)) {
            rules = list.filter((r) => r && typeof r === 'object' && r.when && Array.isArray(r.then));
        } else {
            logger?.debug(`Rule file ${filePath} has no rules array, ignoring`);
        }
    } catch (err) {
        logger?.debug(`Error parsing rule file ${filePath}: ${err.message}`);
    }

    cache?.set(filePath, { mtimeMs: stat.mtimeMs, rules });
    return rules;
}

// ── Matching ─────────────────────────────────────────────────────────────────

function asArray(value) {
    return Array.isArray(value) ? value : [value];
}

// String matcher: plain string = case-insensitive substring (the semantics the
// email-linker seed established); object = { equals, contains, startsWith, regex }.
function matchText(actual, matcher) {
    if (actual == null) { return false; }
    const value = String(actual).toLowerCase();
    if (typeof matcher === 'string') { return value.includes(matcher.toLowerCase()); }
    if (!matcher || typeof matcher !== 'object') { return false; }
    if (matcher.equals !== undefined && value !== String(matcher.equals).toLowerCase()) { return false; }
    if (matcher.contains !== undefined && !value.includes(String(matcher.contains).toLowerCase())) { return false; }
    if (matcher.startsWith !== undefined && !value.startsWith(String(matcher.startsWith).toLowerCase())) { return false; }
    if (matcher.regex !== undefined && !safeRegex(matcher.regex)?.test(String(actual))) { return false; }
    return true;
}

function matchUrl(classification, matcher) {
    if (typeof matcher === 'string') { return classification.urlMatches(matcher); }
    if (!matcher || typeof matcher !== 'object') { return false; }
    if (matcher.host !== undefined && !asArray(matcher.host).some((h) => classification.hostMatches(h))) { return false; }
    if (matcher.prefix !== undefined && !(classification.url || '').toLowerCase().startsWith(String(matcher.prefix).toLowerCase())) { return false; }
    if (matcher.contains !== undefined && !asArray(matcher.contains).some((c) => classification.urlMatches(c))) { return false; }
    if (matcher.regex !== undefined && !classification.urlMatches(safeRegex(matcher.regex))) { return false; }
    return true;
}

function safeRegex(pattern) {
    try {
        return new RegExp(pattern, 'i');
    } catch {
        return null;
    }
}

// One check per `when` key. Shared by matchRule (dispatch) and explainRule
// (the explain endpoint's matcher-by-matcher breakdown).
const WHEN_CHECKS = {
    event: (c, matcher, eventName) => Boolean(matcher) && asArray(matcher).includes(eventName),
    schema: (c, matcher) => asArray(matcher).some((s) => c.isSchema(s)),
    path: (c, matcher) => asArray(matcher).some((p) => c.inPath(p)),
    url: (c, matcher) => asArray(matcher).some((u) => matchUrl(c, u)),
    from: (c, matcher) => asArray(matcher).some((f) => matchText(c.from, f)),
    // Any To/Cc recipient matches (substring or {equals|contains|startsWith|regex}).
    to: (c, matcher) => asArray(matcher).some((m) => c.to.some((addr) => matchText(addr, m))),
    subject: (c, matcher) => asArray(matcher).some((s) => matchText(c.subject, s)),
    mime: (c, matcher) => asArray(matcher).some((m) => c.mimeMatches(m)),
    // `attachment: true` = has any attachment; string/array = attachment mime
    // pattern(s) (`application/pdf`, `image/*`, `*`); object = { mime?, filename? }.
    attachment: (c, matcher) => {
        if (matcher === true) { return c.hasAttachment(); }
        if (typeof matcher === 'string' || Array.isArray(matcher)) {
            return asArray(matcher).some((m) => c.hasAttachment(m));
        }
        if (!matcher || typeof matcher !== 'object') { return false; }
        const mimeOk = matcher.mime === undefined || asArray(matcher.mime).some((m) => c.hasAttachment(m));
        const nameOk = matcher.filename === undefined
            || c.attachments.some((att) => asArray(matcher.filename).some((f) => matchText(att?.filename, f)));
        return mimeOk && nameOk;
    },
};

/**
 * Matcher-by-matcher evaluation of one rule — "why (didn't) my rule fire".
 * Unlike matchRule it does not short-circuit, so every check is reported.
 * @param {Object} rule
 * @param {string} eventName
 * @param {Classification} c - classification of the document
 * @returns {{ matched: boolean, enabled: boolean, checks: Array<{key, expected, matched}> }}
 */
export function explainRule(rule, eventName, c) {
    const enabled = rule.enabled !== false;
    const when = rule.when && typeof rule.when === 'object' ? rule.when : {};
    const checks = [];

    for (const [key, check] of Object.entries(WHEN_CHECKS)) {
        if (key !== 'event' && when[key] === undefined) { continue; }
        checks.push({ key, expected: when[key] ?? null, matched: check(c, when[key], eventName) });
    }
    // Unknown when-keys can never be satisfied — surface them instead of
    // silently ignoring what the engine would reject.
    for (const key of Object.keys(when)) {
        if (!(key in WHEN_CHECKS)) { checks.push({ key, expected: when[key], matched: false, unknown: true }); }
    }

    return { matched: enabled && checks.length > 0 && checks.every((chk) => chk.matched), enabled, checks };
}

/**
 * @param {Object} rule
 * @param {string} eventName
 * @param {Classification} c - classification of the event's document
 * @returns {boolean}
 */
export function matchRule(rule, eventName, c) {
    if (rule.enabled === false) { return false; }
    const when = rule.when;
    if (!when || typeof when !== 'object') { return false; }

    if (!WHEN_CHECKS.event(c, when.event, eventName)) { return false; }
    for (const key of ['schema', 'path', 'url', 'from', 'to', 'subject', 'mime', 'attachment']) {
        if (when[key] !== undefined && !WHEN_CHECKS[key](c, when[key])) { return false; }
    }

    return true;
}

// ── Actions ──────────────────────────────────────────────────────────────────

// Minimal `{{path.to.value}}` interpolation over the action scope. Missing
// paths resolve to an empty string; objects/arrays (e.g. {{doc.locations}})
// are JSON-serialized so they survive into agent prompts intact. Kept
// deliberately dumb so a UI rule builder can round-trip the JSON.
export function interpolate(template, scope) {
    if (typeof template !== 'string') { return template; }
    return template.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_, keyPath) => {
        const value = keyPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), scope);
        if (value == null) { return ''; }
        if (typeof value === 'object') {
            try { return JSON.stringify(value); } catch { return String(value); }
        }
        return String(value);
    });
}

// A link target is a context-tree path by default; 'ctx:/a/b' is explicit and
// 'dir:/a/b' targets the directory tree instead.
function parseLinkTarget(raw) {
    const value = String(raw || '');
    if (value.startsWith('dir:')) { return { tree: 'directory', path: value.slice(4) || '/' }; }
    if (value.startsWith('ctx:')) { return { tree: 'context', path: value.slice(4) || '/' }; }
    return { tree: 'context', path: value };
}

// Shared output pipeline for actions that produce text (agent reply, script
// stdout). `output` supports, in any combination:
//   note:   { path, title? }  -> insert the text as a note document at path
//   file:   { path, backend?: 'home'|'data', append?, insert? }
//           backend 'home' (default) writes {WORKSPACE_ROOT}/home/<path>
//           (append: true appends); backend 'data' persists to the
//           workspace:data blob store. `insert: '/a/b'` additionally indexes
//           the result as a File document at that tree path.
//   notify: true | { channel } -> send the text to the workspace owner
// Paths accept 'dir:' / 'ctx:' prefixes and {{...}} templates.
async function handleActionOutput(text, output, { context, scope, workspace, logger, label }) {
    if (!text || !output || typeof output !== 'object') { return; }

    if (output.note && typeof output.note === 'object' && output.note.path) {
        const target = parseLinkTarget(interpolate(String(output.note.path), scope));
        const title = interpolate(String(output.note.title || scope.rule?.description || `Automation output (${label})`), scope);
        const note = await context.insert(
            { schema: 'data/schema/note', data: { title, content: String(text) } },
            target.tree === 'directory' ? { context: null, directory: target.path } : { context: target.path },
        );
        logger.debug(`rule ${label}: output saved as note ${note?.id ?? note} at ${target.tree}:${target.path}`);
    }

    if (output.file && typeof output.file === 'object' && output.file.path) {
        await writeOutputFile(String(text), output.file, { context, scope, workspace, logger, label });
    }

    if (output.notify) {
        await context.notify(String(text), typeof output.notify === 'object' && output.notify.channel ? { channel: output.notify.channel } : {});
    }
}

async function writeOutputFile(text, fileSpec, { context, scope, workspace, logger, label }) {
    const backend = fileSpec.backend === 'data' ? 'data' : 'home';
    const relPath = interpolate(String(fileSpec.path), scope).replace(/^\/+/, '');
    if (!relPath) { return; }

    let location = null; // { url, checksum, size }
    if (backend === 'data') {
        const buffer = Buffer.from(fileSpec.append ? `${text}\n` : text, 'utf8');
        const persisted = await workspace.persistBlob(buffer);
        location = { url: persisted.url, checksum: persisted.checksum, size: persisted.size };
        logger.debug(`rule ${label}: output persisted to ${persisted.url}`);
    } else {
        const homeRoot = path.resolve(workspace.homePath);
        const filePath = path.resolve(homeRoot, relPath);
        if (filePath !== homeRoot && !filePath.startsWith(`${homeRoot}${path.sep}`)) {
            logger.debug(`rule ${label}: refusing output file outside home/: ${fileSpec.path}`);
            return;
        }
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        if (fileSpec.append) { await fs.promises.appendFile(filePath, `${text}\n`, 'utf8'); }
        else { await fs.promises.writeFile(filePath, text, 'utf8'); }
        const bytes = await fs.promises.readFile(filePath);
        location = {
            url: `file://{WORKSPACE_ROOT}/home/${relPath.split(path.sep).join('/')}`,
            checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
        };
        logger.debug(`rule ${label}: output written to home/${relPath}`);
    }

    if (fileSpec.insert) {
        const target = parseLinkTarget(interpolate(String(fileSpec.insert), scope));
        const doc = {
            schema: 'data/schema/file',
            checksumArray: location.checksum ? [`sha256/${location.checksum}`] : [],
            locations: [{ url: location.url }],
            metadata: { contentType: 'text/plain', size: location.size, filename: path.posix.basename(relPath.split(path.sep).join('/')) },
            data: {},
        };
        const inserted = await context.insert(
            doc,
            target.tree === 'directory' ? { context: null, directory: target.path } : { context: target.path },
        );
        logger.debug(`rule ${label}: output file indexed as ${inserted?.id ?? inserted} at ${target.tree}:${target.path}`);
    }
}

const ACTIONS = {
    // Link the document to tree paths, optionally with feature tags. Paths
    // default to the context tree; 'dir:/path' targets the directory tree.
    // emitEvent:false so the resulting membership change can't re-trigger rules.
    async link(action, { workspace, doc, logger, provenance }) {
        if (!doc?.id) { return; }
        for (const rawPath of asArray(action.paths || action.path || []).filter(Boolean)) {
            const target = parseLinkTarget(rawPath);
            const selector = target.tree === 'directory'
                ? { directory: target.path }
                : { context: workspace.getContextTreeSelector(target.path) };
            await workspace.link(doc.id, {
                ...selector,
                features: action.tags || [],
                emitEvent: false,
                provenance,
            });
            logger.debug(`rule link: ${doc.id} -> ${target.tree}:${target.path}`);
        }
    },

    // Tag the document in place (on the paths it already landed in).
    async tag(action, { workspace, doc, payload, logger, provenance }) {
        if (!doc?.id) { return; }
        const tags = asArray(action.tags || []).filter(Boolean);
        if (!tags.length) { return; }
        // Re-link on the context path(s) the document already landed in.
        const paths = payload?.context?.paths ?? payload?.context?.path ?? '/';
        await workspace.link(doc.id, { context: paths, features: tags, emitEvent: false, provenance });
        logger.debug(`rule tag: ${doc.id} += ${tags.join(',')}`);
    },

    // Remove the document from tree path(s) — the inverse of `link`. The doc
    // stays in the index and on its other paths.
    async unlink(action, { workspace, doc, logger, provenance }) {
        if (!doc?.id) { return; }
        for (const rawPath of asArray(action.paths || action.path || []).filter(Boolean)) {
            const target = parseLinkTarget(rawPath);
            const selector = target.tree === 'directory'
                ? { directory: target.path }
                : { context: workspace.getContextTreeSelector(target.path) };
            // The resulting document.removed / document.unlinked events carry
            // origin:'rule' + depth, so cascade defaults keep them from
            // re-triggering non-opted-in automation.
            await workspace.unlink(doc.id, selector, { provenance });
            logger.debug(`rule unlink: ${doc.id} -x- ${target.tree}:${target.path}`);
        }
    },

    // Purge the document from the index (all paths, all bitmaps). Bytes on
    // storage backends (blobs, files, mail on the server) are NOT touched.
    async delete(action, { workspace, doc, logger, provenance }) {
        if (!doc?.id) { return; }
        await workspace.delete(doc.id, { provenance });
        logger.debug(`rule delete: ${doc.id} purged from index`);
    },

    // Destroy the document everywhere: delete its bytes on every location the
    // backend can delete (stored:// blob, workspace file rm, imap EXPUNGE —
    // read-only locations degrade to a reference drop), then purge it from the
    // index. Irreversible.
    async destroy(action, { workspace, doc, logger, provenance }) {
        if (!doc?.id) { return; }
        const res = await workspace.destroyDocument(doc);
        if (!res?.docDeleted) { await workspace.delete(doc.id, { provenance }).catch(() => {}); }
        logger.debug(`rule destroy: ${doc.id} (${res?.deleted?.length || 0} locations deleted, ${res?.droppedRefs?.length || 0} refs dropped)`);
    },

    // Prompt an agent; optionally consume its reply via action.output
    // (see handleActionOutput: note / file / notify).
    // The inserted note/file emits document.inserted with origin:'rule', so it
    // only reaches rules/hooks that opted in with cascade:true (and never past
    // the maxDepth ceiling) — a rule matching its own output no longer loops.
    async agent(action, { context, scope, workspace, logger }) {
        if (!action.slug || !action.prompt) { return; }
        const reply = await context.agent(action.slug, interpolate(action.prompt, scope), action.options || {});
        logger.debug(`rule agent(${action.slug}): ${reply ? String(reply).slice(0, 120) : 'no reply'}`);
        if (!reply) { return; }
        await handleActionOutput(String(reply), action.output, { context, scope, workspace, logger, label: `agent(${action.slug})` });
    },

    async notify(action, { context, scope }) {
        if (!action.message) { return; }
        const options = action.channel ? { channel: action.channel } : {};
        await context.notify(interpolate(action.message, scope), options);
    },

    // Script under the workspace git/ tree (same pattern as the youtube seed
    // hook). Paths resolving outside git/ are rejected.
    //
    // Hardened execution contract:
    //   env    — sanitized to PATH/HOME/LANG + CANVAS_EVENT, CANVAS_EVENT_ID,
    //            CANVAS_WORKSPACE, CANVAS_WORK_DIR. Server secrets/config never
    //            leak into workspace-synced scripts.
    //   stdin  — the full JSON event envelope ({ event, eventId, payload,
    //            workspace, rule }); argv (action.args) stays available for
    //            scripts that predate the envelope.
    //   cwd    — {WORKSPACE_ROOT}/var/tmp/<ruleId>/<eventId> (CANVAS_WORK_DIR),
    //            created per run; removed after a clean captured run.
    //   output — without `output` the script is fire-and-forget (detached);
    //            with `output` stdout is captured (default 60s timeout,
    //            `timeout` ms overrides up to 600s; 256 KiB cap) and fed
    //            through the same pipeline as agent replies (note/file/notify).
    async script(action, { context, workspace, scope, logger }) {
        if (!action.path) { return; }
        const gitRoot = path.resolve(workspace.rootPath, 'git');
        const scriptPath = path.resolve(gitRoot, String(action.path));
        if (scriptPath !== gitRoot && !scriptPath.startsWith(`${gitRoot}${path.sep}`)) {
            logger.debug(`rule script: refusing path outside git/: ${action.path}`);
            return;
        }
        if (!fs.existsSync(scriptPath)) {
            logger.debug(`rule script: ${action.path} missing, skipping`);
            return;
        }
        const args = asArray(action.args || []).map((a) => interpolate(String(a), scope));

        const eventId = scope.payload?.eventId || crypto.randomUUID();
        const handlerId = String(scope.rule?.id || 'rule').replace(/[^a-zA-Z0-9._-]+/g, '-');
        const workDir = path.join(workspace.rootPath, WORKSPACE_DIRECTORIES.varTmp, handlerId, eventId);
        try { fs.mkdirSync(workDir, { recursive: true }); }
        catch (err) { logger.warn(`rule script: work dir creation failed: ${err.message}`); return; }

        const env = {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
            CANVAS_EVENT: String(scope.event || ''),
            CANVAS_EVENT_ID: eventId,
            CANVAS_WORKSPACE: String(workspace.id || ''),
            CANVAS_WORK_DIR: workDir,
        };
        const envelope = JSON.stringify({
            event: scope.event,
            eventId,
            payload: scope.payload ?? null,
            workspace: { id: workspace.id, name: workspace.name },
            rule: scope.rule ?? null,
        });
        const writeStdin = (child) => {
            try { child.stdin.write(envelope); child.stdin.end(); }
            catch (err) { logger.debug(`rule script: stdin write failed: ${err.message}`); }
        };

        if (!action.output || typeof action.output !== 'object') {
            const child = spawn('bash', [scriptPath, ...args], {
                stdio: ['pipe', 'ignore', 'ignore'], detached: true, cwd: workDir, env,
            });
            child.on('error', (err) => logger.debug(`rule script: spawn failed: ${err.message}`));
            writeStdin(child);
            child.unref();
            logger.debug(`rule script: spawned ${action.path} (workdir ${workDir})`);
            return;
        }

        const timeoutMs = Math.min(Math.max(1000, Number(action.timeout) || 60_000), 600_000);
        const stdout = await new Promise((resolve) => {
            // detached → own process group, so the timeout can kill the whole
            // tree: killing only bash leaves its children holding the stdout
            // pipe open and 'close' never fires until they exit.
            const child = spawn('bash', [scriptPath, ...args], {
                stdio: ['pipe', 'pipe', 'ignore'], cwd: workDir, env, detached: true,
            });
            const chunks = [];
            let size = 0;
            const timer = setTimeout(() => {
                logger.warn(`rule script: ${action.path} timed out after ${timeoutMs}ms, killing`);
                try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
            }, timeoutMs);
            writeStdin(child);
            child.stdout.on('data', (chunk) => {
                if (size >= 256 * 1024) { return; }
                size += chunk.length;
                chunks.push(chunk);
            });
            child.on('error', (err) => {
                clearTimeout(timer);
                logger.debug(`rule script: spawn failed: ${err.message}`);
                resolve(null);
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                if (code !== 0) { logger.warn(`rule script: ${action.path} exited ${code}`); }
                else { fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {}); }
                resolve(Buffer.concat(chunks).toString('utf8').trim());
            });
        });
        if (!stdout) { return; }
        await handleActionOutput(stdout, action.output, { context, scope, workspace, logger, label: `script(${action.path})` });
    },

    // Re-emit a workspace event (context.emit stamps source:'hook').
    async emit(action, { context, scope }) {
        if (!action.event) { return; }
        await context.emit(action.event, {
            ...(action.payload && typeof action.payload === 'object' ? action.payload : {}),
            documentId: scope.doc?.id ?? null,
        });
    },
};

/**
 * Execute a matched rule's `then` actions sequentially. Action errors are
 * logged (warn) and swallowed so one broken action never blocks the rest of
 * the rule or other rules; the per-action outcome is returned for the run log.
 *
 * @param {Object} rule
 * @param {Object} context - hook context (from HookService#buildHookContext)
 * @param {Object} logger
 * @returns {Promise<Array<{ action: string, status: 'ok'|'error'|'skipped', error?: string }>>}
 */
export async function executeRuleActions(rule, context, logger) {
    const { workspace, payload, eventName } = context;
    const doc = payload?.document || null;
    const scope = {
        doc,
        payload,
        event: eventName,
        workspace: { id: workspace.id, name: workspace.name },
        rule: { id: rule.id, description: rule.description },
    };
    // Writes this rule makes are automation caused by the triggering event.
    // Actions routed through the hook context (agent output, script output,
    // notify) inherit the same stamp from the context's own helpers.
    const provenance = {
        origin: 'rule',
        causedBy: payload?.eventId ?? null,
        depth: (Number.isInteger(payload?.depth) ? payload.depth : 0) + 1,
    };

    const results = [];
    for (const action of rule.then) {
        const handler = ACTIONS[action?.action];
        if (!handler) {
            logger.warn(`rule ${rule.id || '?'}: unknown action "${action?.action}"`);
            results.push({ action: String(action?.action ?? '?'), status: 'skipped', error: 'unknown action' });
            continue;
        }
        try {
            await handler(action, { workspace, doc, payload, context, scope, logger, provenance });
            results.push({ action: action.action, status: 'ok' });
        } catch (err) {
            logger.warn(`rule ${rule.id || '?'} action ${action.action} failed: ${err.message}`);
            results.push({ action: action.action, status: 'error', error: err.message });
        }
    }
    return results;
}
