'use strict';

import path from 'path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

import { CanvasApiClient } from './client.js';

/*
 * Canvas tools — the agent's interface to user data.
 *
 * All tool paths are RELATIVE to the agent's bound base path; the server
 * additionally clamps every request to the binding, so a confused or
 * adversarial model cannot escape its scope. Tools return compact JSON as
 * text content for the model.
 */

function toolResult(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: 'text', text }], details: undefined };
}

function toolError(error) {
    return toolResult(`Error: ${error.message}${error.statusCode ? ` (HTTP ${error.statusCode})` : ''}`);
}

// Join a model-supplied path under the binding base. Server clamps again.
function scopedPath(basePath, requested) {
    const raw = String(requested ?? '/').trim() || '/';
    const joined = path.posix.normalize(path.posix.join(basePath || '/', raw.replace(/^\/+/, '')));
    return joined.startsWith('/') ? joined : `/${joined}`;
}

// Compact projection so document lists don't flood the model context.
function projectDocument(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    return {
        id: doc.id,
        schema: doc.schema,
        createdAt: doc.createdAt || doc.created_at,
        updatedAt: doc.updatedAt || doc.updated_at,
        data: doc.data,
    };
}

/**
 * @param {Object} env - agent runtime env map (runtime-env.js)
 * @returns {Array} pi tool definitions
 */
export function createCanvasTools(env) {
    const client = new CanvasApiClient(env);
    const workspaceId = env.CANVAS_WORKSPACE;
    const isGlobal = workspaceId === '*';
    const basePath = env.CANVAS_BASE_PATH || '/';
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

    const canvasFind = defineTool({
        name: 'canvas_find',
        label: 'Canvas Find',
        description:
            'Search or list documents in your bound canvas workspace scope. '
            + 'Use "query" for full-text/semantic search (e.g. "invoices from acme"), '
            + '"schema" to filter by document type (e.g. data/schema/message/email, data/schema/note, data/schema/tab), '
            + 'and "path" (relative to your scope) to narrow to a subtree. '
            + 'Returns newest-first compact documents. Example: latest emails -> { "schema": "data/schema/message/email", "limit": 10 }.',
        parameters: Type.Object({
            query: Type.Optional(Type.String({ description: 'Full-text / semantic search query' })),
            schema: Type.Optional(Type.String({ description: 'Document schema filter, e.g. data/schema/message/email' })),
            path: Type.Optional(Type.String({ description: 'Context path relative to your scope (default: whole scope)' })),
            limit: Type.Optional(Type.Number({ description: 'Max results (default 20)' })),
            offset: Type.Optional(Type.Number({ description: 'Pagination offset' })),
            ...workspaceParams,
        }),
        async execute(toolCallId, params, signal) {
            try {
                const result = await client.get(documentsBase(resolveWorkspace(params)), {
                    signal,
                    query: {
                        context: scopedPath(basePath, params.path),
                        ...(params.query ? { q: params.query } : {}),
                        ...(params.schema ? { allOf: [params.schema] } : {}),
                        limit: params.limit || 20,
                        ...(params.offset ? { offset: params.offset } : {}),
                    },
                });
                const documents = Array.isArray(result.payload) ? result.payload : [];
                return toolResult({
                    count: result.count ?? documents.length,
                    totalCount: result.totalCount ?? null,
                    documents: documents.map(projectDocument),
                });
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const canvasGet = defineTool({
        name: 'canvas_get',
        label: 'Canvas Get',
        description: 'Fetch a single canvas document by its numeric id (full data, no projection).',
        parameters: Type.Object({
            docId: Type.Number({ description: 'Document id (from canvas_find results)' }),
            ...workspaceParams,
        }),
        async execute(toolCallId, params, signal) {
            try {
                const result = await client.get(`${documentsBase(resolveWorkspace(params))}/by-id/${params.docId}`, { signal });
                return toolResult(result.payload ?? null);
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const canvasInsert = defineTool({
        name: 'canvas_insert',
        label: 'Canvas Insert',
        description:
            'Insert a document into your bound canvas scope. Provide the document as '
            + '{ schema, data } (e.g. schema "data/schema/note" with data.title/data.content) '
            + 'and an optional path relative to your scope.',
        parameters: Type.Object({
            document: Type.Object(
                {
                    schema: Type.String({ description: 'Document schema, e.g. data/schema/note' }),
                    data: Type.Any({ description: 'Schema-specific document payload' }),
                },
                { description: 'Document to insert' },
            ),
            path: Type.Optional(Type.String({ description: 'Context path relative to your scope' })),
            ...workspaceParams,
        }),
        async execute(toolCallId, params, signal) {
            try {
                const result = await client.post(documentsBase(resolveWorkspace(params)), {
                    signal,
                    body: {
                        documents: [params.document],
                        context: scopedPath(basePath, params.path),
                    },
                });
                return toolResult(result.payload ?? { status: 'created' });
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const canvasTree = defineTool({
        name: 'canvas_tree',
        label: 'Canvas Tree',
        description: 'Show the workspace context tree under your bound scope (folder structure of the workspace).',
        parameters: Type.Object({ ...workspaceParams }),
        async execute(toolCallId, params, signal) {
            try {
                const result = await client.get(`/workspaces/${resolveWorkspace(params)}/tree`, { signal });
                return toolResult(extractSubtree(result.payload, isGlobal ? '/' : basePath));
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
        description: 'List the workspaces you can access (global mode only). Use the returned id or name as the workspace parameter of the other canvas tools.',
        parameters: Type.Object({}),
        async execute(toolCallId, params, signal) {
            try {
                const result = await client.get('/workspaces', { signal });
                const workspaces = Array.isArray(result.payload) ? result.payload : [];
                return toolResult(workspaces.map((workspace) => ({
                    id: workspace.id,
                    name: workspace.name,
                    label: workspace.label,
                    description: workspace.description,
                    status: workspace.status,
                })));
            } catch (error) {
                return toolError(error);
            }
        },
    });

    return [canvasFind, canvasGet, canvasInsert, canvasTree, canvasNotify, ...(isGlobal ? [canvasWorkspaces] : [])];
}

// Present only the subtree under basePath; '/' returns the whole tree.
export function extractSubtree(tree, basePath) {
    if (!tree || basePath === '/' || !basePath) return tree ?? null;

    const segments = basePath.split('/').filter(Boolean);
    let node = tree;
    for (const segment of segments) {
        const children = node?.children || [];
        node = children.find((child) => child?.name === segment || child?.label === segment);
        if (!node) return null;
    }
    return node;
}
