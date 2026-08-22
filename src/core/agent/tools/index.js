'use strict';

import path from 'path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

import { CanvasApiClient } from './client.js';
import {
    SCHEMA_HELP,
    extractSubtree,
    formatDocumentList,
    formatPaths,
    normalizePath,
    parseSince,
    documentDate,
    renderDocument,
    resolveSchema,
    treeToPaths,
} from './render.js';

/*
 * Canvas tools — the agent's interface to user data.
 *
 * Design (2026-08-22 rework):
 *  - Tools return TEXT the model can act on: trees as path lists, document
 *    lists as one summary line per document, documents rendered readable
 *    (emails as headers + body, notes as title + content, ...).
 *  - `canvas_context` is the orientation call: what am I bound to, which
 *    workspace/context/path, what sub-paths exist.
 *  - All tool paths are RELATIVE to the agent's bound base path; the server
 *    additionally clamps every request to the binding, so a confused or
 *    adversarial model cannot escape its scope.
 */

const DEFAULT_FIND_LIMIT = 20;
const MAX_FIND_LIMIT = 200;
const DEFAULT_GET_MAX_CHARS = 12000;

function toolResult(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: 'text', text }], details: undefined };
}

function toolError(error) {
    return toolResult(`Error: ${error.message}${error.statusCode ? ` (HTTP ${error.statusCode})` : ''}`);
}

// Join a model-supplied path under the binding base. Server clamps again.
export function scopedPath(basePath, requested) {
    const raw = String(requested ?? '/').trim() || '/';
    const joined = path.posix.normalize(path.posix.join(basePath || '/', raw.replace(/^\/+/, '')));
    return joined.startsWith('/') ? joined : `/${joined}`;
}

function clampLimit(value, fallback = DEFAULT_FIND_LIMIT) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.min(Math.floor(number), MAX_FIND_LIMIT);
}

/**
 * @param {Object} env - agent runtime env map (runtime-env.js)
 * @returns {Array} pi tool definitions
 */
export function createCanvasTools(env) {
    const client = new CanvasApiClient(env);
    const workspaceId = env.CANVAS_WORKSPACE;
    const workspaceName = env.CANVAS_WORKSPACE_NAME || workspaceId;
    const isGlobal = workspaceId === '*';
    const basePath = normalizePath(env.CANVAS_BASE_PATH || '/');
    const bindingType = env.CANVAS_BINDING_TYPE || (isGlobal ? 'global' : 'workspace');
    const contextId = env.CANVAS_CONTEXT_ID || null;
    const contextUrl = env.CANVAS_CONTEXT_URL || null;
    const documentsBase = (workspace) => `/workspaces/${workspace}/documents`;

    // Global bindings (CANVAS_WORKSPACE '*') address workspaces explicitly;
    // bound agents keep the implicit workspace and no extra parameter.
    const workspaceParams = isGlobal
        ? { workspace: Type.String({ description: 'Workspace id or name (required in global mode; list with canvas_workspaces)' }) }
        : {};
    const resolveWorkspace = (params) => {
        if (!isGlobal) return workspaceId;
        const workspace = String(params?.workspace || '').trim();
        if (!workspace) throw new Error('workspace is required in global mode (list with canvas_workspaces)');
        return workspace;
    };

    const scopeDescription = isGlobal
        ? 'global (all workspaces; pass "workspace" to every tool)'
        : `${bindingType} binding: workspace "${workspaceName}", path ${basePath}`;

    async function fetchScopePaths(workspace, relativePath = '/', depth, signal) {
        const result = await client.get(`/workspaces/${workspace}/tree`, { signal });
        const scopeRoot = isGlobal ? '/' : basePath;
        const root = extractSubtree(result.payload, scopedPath(scopeRoot, relativePath));
        if (!root) return null;
        return treeToPaths(root, { depth });
    }

    const canvasContext = defineTool({
        name: 'canvas_context',
        label: 'Canvas Context',
        description:
            'Describe your current canvas scope: binding type, workspace, context (if bound to one), '
            + 'the base path every other tool is relative to, the sub-paths under it and how many '
            + 'documents it holds. Call this first when the user refers to "the current context", '
            + '"here", "this workspace" or before navigating paths.',
        parameters: Type.Object({}),
        async execute(toolCallId, params, signal) {
            try {
                const lines = [`Scope: ${scopeDescription}`];
                if (isGlobal) {
                    lines.push('There is no single current context in global mode. Use canvas_workspaces to list '
                        + 'workspaces, then pass "workspace" to canvas_tree / canvas_find / canvas_get / canvas_insert.');
                    return toolResult(lines.join('\n'));
                }
                lines.push(`Workspace: ${workspaceName}${workspaceName !== workspaceId ? ` (${workspaceId})` : ''}`);
                if (bindingType === 'context') {
                    lines.push(`Context: ${contextUrl || contextId || '(unknown)'}${contextId && contextUrl ? `  (id ${contextId})` : ''}`);
                    lines.push('This binding follows the context live: if the user switches the context, your scope moves with it.');
                }
                lines.push(`Base path: ${basePath}  (all tool paths are relative to this; "/" means the scope root)`);

                const [paths, listing] = await Promise.all([
                    fetchScopePaths(workspaceId, '/', undefined, signal).catch((error) => ({ error })),
                    client.get(documentsBase(workspaceId), { signal, query: { context: basePath, limit: 1 } }).catch((error) => ({ error })),
                ]);
                if (listing?.error) {
                    lines.push(`Documents in scope: unavailable (${listing.error.message})`);
                } else {
                    const total = listing.totalCount ?? listing.count ?? 0;
                    lines.push(`Documents in scope (including sub-paths): ${total}`);
                }
                lines.push('');
                if (paths?.error) {
                    lines.push(`Sub-paths: unavailable (${paths.error.message})`);
                } else if (paths === null) {
                    lines.push('Sub-paths: base path not present in the workspace tree (yet)');
                } else {
                    lines.push(`Sub-paths (${paths.length}):`);
                    lines.push(formatPaths(paths));
                }
                return toolResult(lines.join('\n'));
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const canvasTree = defineTool({
        name: 'canvas_tree',
        label: 'Canvas Tree',
        description:
            'List the context tree under your scope as paths, one per line (like `find -type d`). '
            + 'Optional "path" narrows to a subtree and "depth" limits nesting. Use the returned paths '
            + 'as the "path" argument of canvas_find / canvas_insert.',
        parameters: Type.Object({
            path: Type.Optional(Type.String({ description: 'Subtree to list, relative to your scope (default "/")' })),
            depth: Type.Optional(Type.Number({ description: 'Max depth below the given path (default: unlimited)' })),
            ...workspaceParams,
        }),
        async execute(toolCallId, params, signal) {
            try {
                const workspace = resolveWorkspace(params);
                const relative = normalizePath(params.path || '/');
                const paths = await fetchScopePaths(workspace, relative, params.depth, signal);
                if (paths === null) return toolResult(`Path ${relative} does not exist in this scope.`);
                const shown = paths.map((entry) => ({
                    ...entry,
                    path: relative === '/' ? entry.path : `${relative}${entry.path}`,
                }));
                return toolResult(`${relative}\n${formatPaths(shown)}`);
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const canvasFind = defineTool({
        name: 'canvas_find',
        label: 'Canvas Find',
        description:
            'List or search documents in your scope. Returns one summary line per document, newest first, '
            + 'with the document id to pass to canvas_get. '
            + `Filter by "schema" (${SCHEMA_HELP}), narrow with "path" (relative to your scope), `
            + '"since" (ISO date or relative like "24h", "7d") and "query" (full-text / semantic search). '
            + 'Examples: new emails from the last day -> { "schema": "email", "since": "24h" }; '
            + 'invoices anywhere in scope -> { "query": "invoice" }; notes under /projects -> { "schema": "note", "path": "/projects" }.',
        parameters: Type.Object({
            query: Type.Optional(Type.String({ description: 'Full-text / semantic search query' })),
            schema: Type.Optional(Type.String({ description: `Document type: ${SCHEMA_HELP}` })),
            path: Type.Optional(Type.String({ description: 'Context path relative to your scope (default: whole scope)' })),
            since: Type.Optional(Type.String({ description: 'Only documents dated after this (ISO timestamp or relative: 30m, 24h, 7d, 2w)' })),
            features: Type.Optional(Type.Array(Type.String(), { description: 'Extra feature filters, e.g. feature/email/received, feature/email/attachment' })),
            limit: Type.Optional(Type.Number({ description: `Max results (default ${DEFAULT_FIND_LIMIT}, max ${MAX_FIND_LIMIT})` })),
            offset: Type.Optional(Type.Number({ description: 'Pagination offset' })),
            ...workspaceParams,
        }),
        async execute(toolCallId, params, signal) {
            try {
                const workspace = resolveWorkspace(params);
                const schema = params.schema ? resolveSchema(params.schema) : null;
                const since = params.since ? parseSince(params.since) : null;
                if (params.since && !since) throw new Error(`Cannot parse "since": ${params.since} (use ISO date or 30m/24h/7d/2w)`);
                const limit = clampLimit(params.limit);
                const allOf = [...(schema ? [schema] : []), ...(params.features || [])];
                const contextPath = scopedPath(isGlobal ? '/' : basePath, params.path);

                const result = await client.get(documentsBase(workspace), {
                    signal,
                    query: {
                        context: contextPath,
                        ...(params.query ? { q: params.query } : {}),
                        ...(allOf.length ? { allOf } : {}),
                        // Over-fetch when filtering client-side by date.
                        limit: since ? Math.min(MAX_FIND_LIMIT, limit * 5) : limit,
                        ...(params.offset ? { offset: params.offset } : {}),
                    },
                });
                let documents = Array.isArray(result.payload) ? result.payload : [];
                let totalCount = result.totalCount ?? result.count ?? documents.length;
                if (!params.query) {
                    // Listings come back in insertion order; the model asked for
                    // "newest" in content terms (email date, event start, ...).
                    documents = [...documents].sort((a, b) => new Date(documentDate(b) || 0) - new Date(documentDate(a) || 0));
                }
                if (since) {
                    documents = documents.filter((doc) => {
                        const when = new Date(documentDate(doc) || 0);
                        return when.getTime() >= since.getTime();
                    }).slice(0, limit);
                    totalCount = documents.length;
                }

                const scopeBits = [
                    `path ${normalizePath(params.path || '/')}`,
                    schema ? `schema ${schema}` : null,
                    params.query ? `query "${params.query}"` : null,
                    since ? `since ${since.toISOString()}` : null,
                ].filter(Boolean);
                return toolResult(formatDocumentList(documents, {
                    count: result.count,
                    totalCount,
                    scopeLine: scopeBits.join(', '),
                }));
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const canvasGet = defineTool({
        name: 'canvas_get',
        label: 'Canvas Get',
        description:
            'Read one document in full by id, rendered as text (an email as headers + body + attachment list, '
            + 'a note as title + content, ...). Set "raw": true for the untouched JSON document.',
        parameters: Type.Object({
            docId: Type.Number({ description: 'Document id (from canvas_find results)' }),
            raw: Type.Optional(Type.Boolean({ description: 'Return raw JSON instead of rendered text' })),
            maxChars: Type.Optional(Type.Number({ description: `Cap on rendered body length (default ${DEFAULT_GET_MAX_CHARS})` })),
            ...workspaceParams,
        }),
        async execute(toolCallId, params, signal) {
            try {
                const result = await client.get(`${documentsBase(resolveWorkspace(params))}/by-id/${params.docId}`, { signal });
                const document = result.payload ?? null;
                if (!document) return toolResult(`Document #${params.docId} not found in your scope.`);
                if (params.raw) return toolResult(document);
                const maxChars = Number.isFinite(Number(params.maxChars)) && Number(params.maxChars) > 0
                    ? Math.floor(Number(params.maxChars))
                    : DEFAULT_GET_MAX_CHARS;
                return toolResult(renderDocument(document, { maxChars }));
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const canvasInsert = defineTool({
        name: 'canvas_insert',
        label: 'Canvas Insert',
        description:
            'Insert a document into your scope. Provide "schema" (short name such as note, task, tab, link, '
            + 'event or a full data/schema/... id) and "data" (e.g. note: { title, content }; task: { title, '
            + 'description, status, dueDate }; tab/link: { url, title }) plus an optional path relative to your scope.',
        parameters: Type.Object({
            schema: Type.String({ description: `Document type: ${SCHEMA_HELP}` }),
            data: Type.Any({ description: 'Schema-specific document payload' }),
            path: Type.Optional(Type.String({ description: 'Context path relative to your scope (default: scope root)' })),
            ...workspaceParams,
        }),
        async execute(toolCallId, params, signal) {
            try {
                const workspace = resolveWorkspace(params);
                const schema = resolveSchema(params.schema);
                const contextPath = scopedPath(isGlobal ? '/' : basePath, params.path);
                const result = await client.post(documentsBase(workspace), {
                    signal,
                    body: {
                        documents: [{ schema, data: params.data }],
                        context: contextPath,
                    },
                });
                const payload = result.payload;
                const ids = Array.isArray(payload)
                    ? payload.map((entry) => (typeof entry === 'object' ? entry?.id : entry)).filter((id) => id !== undefined)
                    : [payload?.id].filter((id) => id !== undefined);
                return toolResult(`Inserted ${schema} at ${normalizePath(params.path || '/')}${ids.length ? ` (document id ${ids.join(', ')})` : ''}.`);
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const canvasNotify = defineTool({
        name: 'canvas_notify',
        label: 'Canvas Notify',
        description:
            'Send a notification message to your user over their configured channel '
            + '(WhatsApp, Slack, ...). Use for alerts and results the user asked to be '
            + 'notified about. You can only notify your own user.',
        parameters: Type.Object({
            message: Type.String({ description: 'Message text to deliver' }),
            channel: Type.Optional(Type.String({ description: 'Channel override (e.g. whatsapp, slack); defaults to the user\'s default channel' })),
        }),
        async execute(toolCallId, params, signal) {
            try {
                const result = await client.post('/messaging/notify', {
                    signal,
                    body: {
                        message: params.message,
                        ...(params.channel ? { channel: params.channel } : {}),
                    },
                });
                return toolResult(result.payload ?? { delivered: true });
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const canvasWorkspaces = defineTool({
        name: 'canvas_workspaces',
        label: 'Canvas Workspaces',
        description: 'List the workspaces you can access (global mode only), one per line. Use the name or id as the "workspace" parameter of the other canvas tools.',
        parameters: Type.Object({}),
        async execute(toolCallId, params, signal) {
            try {
                const result = await client.get('/workspaces', { signal });
                const workspaces = Array.isArray(result.payload) ? result.payload : [];
                if (!workspaces.length) return toolResult('No accessible workspaces.');
                const lines = workspaces.map((workspace) => {
                    const bits = [workspace.status, workspace.label && workspace.label !== workspace.name ? workspace.label : null, workspace.description].filter(Boolean);
                    return `${workspace.name}  (${workspace.id})${bits.length ? `  — ${bits.join(', ')}` : ''}`;
                });
                return toolResult(`${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
            } catch (error) {
                return toolError(error);
            }
        },
    });

    return [
        canvasContext,
        canvasTree,
        canvasFind,
        canvasGet,
        canvasInsert,
        canvasNotify,
        ...(isGlobal ? [canvasWorkspaces] : []),
    ];
}

export { extractSubtree } from './render.js';
