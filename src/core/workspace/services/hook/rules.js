'use strict';

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { isDisabledFile } from './naming.js';

/**
 * Declarative hook rules (canvas.hook-rules/v1).
 *
 * Rules live next to JS hooks in `{WORKSPACE_ROOT}/git/hooks` as `rules.json`
 * plus `rules/*.json` (merged in filename sort order). An `example-`,
 * `disabled-` or `_` prefix deactivates a file (same convention as JS hooks);
 * a rule with `enabled: false` is skipped individually.
 *
 * Rule shape:
 *   { id, enabled?, description?, when: { event, schema?, path?, url?, from?,
 *     subject?, mime? }, then: [ { action, ... } ] }
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
    if (matcher.contains !== undefined && !classification.urlMatches(matcher.contains)) { return false; }
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

    if (!when.event || !asArray(when.event).includes(eventName)) { return false; }
    if (when.schema !== undefined && !asArray(when.schema).some((s) => c.isSchema(s))) { return false; }
    if (when.path !== undefined && !asArray(when.path).some((p) => c.inPath(p))) { return false; }
    if (when.url !== undefined && !asArray(when.url).some((u) => matchUrl(c, u))) { return false; }
    if (when.from !== undefined && !asArray(when.from).some((f) => matchText(c.from, f))) { return false; }
    if (when.subject !== undefined && !asArray(when.subject).some((s) => matchText(c.subject, s))) { return false; }
    if (when.mime !== undefined && !asArray(when.mime).some((m) => c.mimeMatches(m))) { return false; }

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

const ACTIONS = {
    // Link the document to tree paths, optionally with feature tags. Paths
    // default to the context tree; 'dir:/path' targets the directory tree.
    // emitEvent:false so the resulting membership change can't re-trigger rules.
    async link(action, { workspace, doc, logger }) {
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
            });
            logger.debug(`rule link: ${doc.id} -> ${target.tree}:${target.path}`);
        }
    },

    // Tag the document in place (on the paths it already landed in).
    async tag(action, { workspace, doc, payload, logger }) {
        if (!doc?.id) { return; }
        const tags = asArray(action.tags || []).filter(Boolean);
        if (!tags.length) { return; }
        // Re-link on the context path(s) the document already landed in.
        const paths = payload?.context?.paths ?? payload?.context?.path ?? '/';
        await workspace.link(doc.id, { context: paths, features: tags, emitEvent: false });
        logger.debug(`rule tag: ${doc.id} += ${tags.join(',')}`);
    },

    // Prompt an agent; optionally consume its reply via action.output:
    //   { note: { path, title? }, notify: true }
    // note  -> insert the reply as a note document at path ('dir:' prefix for
    //          the directory tree); title defaults to the rule description.
    // notify -> send the reply to the workspace owner.
    // NOTE: the inserted note emits a normal document.inserted — a rule that
    // matches its own note (schema note + same path + agent action) loops.
    async agent(action, { context, scope, logger }) {
        if (!action.slug || !action.prompt) { return; }
        const reply = await context.agent(action.slug, interpolate(action.prompt, scope), action.options || {});
        logger.debug(`rule agent(${action.slug}): ${reply ? String(reply).slice(0, 120) : 'no reply'}`);
        if (!reply) { return; }

        const output = action.output && typeof action.output === 'object' ? action.output : null;
        if (!output) { return; }

        if (output.note && typeof output.note === 'object' && output.note.path) {
            const target = parseLinkTarget(interpolate(String(output.note.path), scope));
            const title = interpolate(String(output.note.title || scope.rule?.description || `Agent reply (${action.slug})`), scope);
            const note = await context.insert(
                { schema: 'data/abstraction/note', data: { title, content: String(reply) } },
                target.tree === 'directory' ? { context: null, directory: target.path } : { context: target.path },
            );
            logger.debug(`rule agent(${action.slug}): reply saved as note ${note?.id ?? note} at ${target.tree}:${target.path}`);
        }
        if (output.notify) {
            await context.notify(String(reply), typeof output.notify === 'object' && output.notify.channel ? { channel: output.notify.channel } : {});
        }
    },

    async notify(action, { context, scope }) {
        if (!action.message) { return; }
        const options = action.channel ? { channel: action.channel } : {};
        await context.notify(interpolate(action.message, scope), options);
    },

    // Fire-and-forget script under the workspace git/ tree (same pattern as the
    // youtube seed hook). Paths resolving outside git/ are rejected.
    async script(action, { workspace, scope, logger }) {
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
        const child = spawn('bash', [scriptPath, ...args], { stdio: 'ignore', detached: true });
        child.on('error', (err) => logger.debug(`rule script: spawn failed: ${err.message}`));
        child.unref();
        logger.debug(`rule script: spawned ${action.path}`);
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
 * logged and swallowed (same policy as JS hook invocation) so one broken
 * action never blocks the rest of the rule or other rules.
 *
 * @param {Object} rule
 * @param {Object} context - hook context (from HookService#buildHookContext)
 * @param {Object} logger
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

    for (const action of rule.then) {
        const handler = ACTIONS[action?.action];
        if (!handler) {
            logger.debug(`rule ${rule.id || '?'}: unknown action "${action?.action}"`);
            continue;
        }
        try {
            await handler(action, { workspace, doc, payload, context, scope, logger });
        } catch (err) {
            logger.debug(`rule ${rule.id || '?'} action ${action.action} failed: ${err.message}`);
        }
    }
}
