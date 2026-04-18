'use strict';

import ResponseObject from '../../ResponseObject.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-Z]{26}$/;
const looksLikeId = (s) => typeof s === 'string'
    && (s.startsWith('layer/') || ULID_RE.test(s) || UUID_RE.test(s));

/**
 * Top-level /canvases convenience alias.
 *
 * Canvases live inside workspace trees, so the canonical CRUD lives under
 * /workspaces/:wid/canvases. These top-level routes are read-only shortcuts:
 * you give a canvas id (preferred) or name and the server walks the user's
 * accessible workspaces to find it. If a `?workspace=<idOrName>` hint is
 * provided, the lookup is constrained to that workspace.
 *
 * Name lookups can collide across workspaces — the first match wins. Pin
 * with `?workspace=` to disambiguate.
 */
export default async function topLevelCanvasRoutes(fastify) {

    function getTreesFor(workspace) {
        const trees = [];
        try {
            trees.push(workspace.getDefaultContextTree());
        } catch (_) { /* no default tree */ }
        return trees;
    }

    function findCanvasInTree(tree, idOrName) {
        let layer = null;
        if (looksLikeId(idOrName)) {
            try { layer = tree.getLayerById(idOrName); } catch (_) { layer = null; }
        }
        if (!layer) {
            try { layer = tree.getLayer(idOrName); } catch (_) { layer = null; }
        }
        if (!layer || layer.type !== 'canvas') { return null; }
        return layer;
    }

    async function resolveCanvas(request, reply) {
        const userId = request.user.id;
        const idOrName = request.params.canvasIdOrName;
        const workspaceHint = request.query?.workspace;

        const candidates = [];
        if (workspaceHint) {
            const workspaceId = UUID_RE.test(workspaceHint)
                ? workspaceHint
                : await fastify.workspaceManager.resolveWorkspaceId(userId, workspaceHint);
            if (!workspaceId) {
                const r = new ResponseObject().notFound(`Workspace not found: ${workspaceHint}`);
                reply.code(r.statusCode).send(r.getResponse());
                return null;
            }
            const ws = await fastify.workspaceManager.getWorkspace(workspaceId, userId);
            if (ws) { candidates.push(ws); }
        } else {
            const list = await fastify.workspaceManager.listWorkspaces(userId);
            for (const entry of list) {
                try {
                    const ws = await fastify.workspaceManager.getWorkspace(entry.id, userId);
                    if (ws) { candidates.push(ws); }
                } catch (_) { /* skip inaccessible */ }
            }
        }

        for (const workspace of candidates) {
            for (const tree of getTreesFor(workspace)) {
                const canvas = findCanvasInTree(tree, idOrName);
                if (canvas) { return { workspace, tree, canvas }; }
            }
        }

        const r = new ResponseObject().notFound(`Canvas not found: ${idOrName}`);
        reply.code(r.statusCode).send(r.getResponse());
        return null;
    }

    function composeFeatures(callerFeatures, canvasFeatures) {
        if (canvasFeatures === null || canvasFeatures === undefined) { return callerFeatures; }
        if (callerFeatures === null || callerFeatures === undefined) { return canvasFeatures; }
        const toBuckets = (f) => {
            if (Array.isArray(f)) { return { anyOf: [...f] }; }
            if (f && typeof f === 'object') {
                const out = {};
                if (Array.isArray(f.allOf))  { out.allOf  = [...f.allOf]; }
                if (Array.isArray(f.anyOf))  { out.anyOf  = [...f.anyOf]; }
                if (Array.isArray(f.noneOf)) { out.noneOf = [...f.noneOf]; }
                return out;
            }
            return {};
        };
        const a = toBuckets(callerFeatures);
        const b = toBuckets(canvasFeatures);
        const merged = {};
        for (const key of ['allOf', 'anyOf', 'noneOf']) {
            const left = a[key] || [];
            const right = b[key] || [];
            if (left.length || right.length) {
                merged[key] = [...new Set([...left, ...right])];
            }
        }
        return Object.keys(merged).length === 0 ? null : merged;
    }

    function composeFilters(callerFilters, canvasFilters) {
        const a = Array.isArray(callerFilters) ? callerFilters : [];
        const b = Array.isArray(canvasFilters) ? canvasFilters : [];
        if (!a.length && !b.length) { return callerFilters; }
        return [...new Set([...a, ...b])];
    }

    fastify.get('/:canvasIdOrName', {
        onRequest: [fastify.authenticate],
    }, async (request, reply) => {
        try {
            const resolved = await resolveCanvas(request, reply);
            if (!resolved) { return; }
            const { workspace, tree, canvas } = resolved;
            const view = {
                ...(typeof canvas.toJSON === 'function' ? canvas.toJSON() : canvas),
                workspaceId: workspace.id,
                workspaceName: workspace.name,
                treeId: tree.id,
                treeName: tree.name,
                path: tree.getPathByLayerId(canvas.id),
            };
            const r = new ResponseObject().found(view, 'Canvas retrieved successfully');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            fastify.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to get canvas');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.get('/:canvasIdOrName/documents', {
        onRequest: [fastify.authenticate],
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    workspace: { type: 'string' },
                    allOf: { type: 'array', items: { type: 'string' }, default: [] },
                    anyOf: { type: 'array', items: { type: 'string' }, default: [] },
                    noneOf: { type: 'array', items: { type: 'string' }, default: [] },
                    filters: { type: 'array', items: { type: 'string' } },
                    limit: { type: 'integer', default: 200 },
                    offset: { type: 'integer' },
                    page: { type: 'integer' },
                    q: { type: 'string' },
                    search: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const resolved = await resolveCanvas(request, reply);
            if (!resolved) { return; }
            const { workspace, tree, canvas } = resolved;

            const path = tree.getPathByLayerId(canvas.id);
            if (!path) {
                const r = new ResponseObject().notFound('Canvas is not attached to any tree path');
                return reply.code(r.statusCode).send(r.getResponse());
            }

            const { allOf = [], anyOf = [], noneOf = [], filters = [] } = request.query;
            const callerFeatures = (allOf.length || anyOf.length || noneOf.length)
                ? {
                    ...(allOf.length  ? { allOf }  : {}),
                    ...(anyOf.length  ? { anyOf }  : {}),
                    ...(noneOf.length ? { noneOf } : {}),
                }
                : null;

            const features = composeFeatures(callerFeatures, canvas.querySpec?.features ?? null);
            const composedFilters = composeFilters(filters, canvas.querySpec?.filters ?? []);

            const queryStr = request.query.q || request.query.search;
            const spec = {
                context: { tree: tree.id, path },
                features,
                filters: composedFilters,
                limit: request.query.limit,
                offset: request.query.offset,
                page: request.query.page,
            };
            const result = queryStr
                ? await workspace.search({ query: queryStr, ...spec })
                : await workspace.list(spec);

            if (result?.error) {
                const r = new ResponseObject().error(`Failed to ${queryStr ? 'search' : 'list'} canvas documents`, result.error);
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(result, 'Canvas documents retrieved successfully', 200, result?.count, result?.totalCount);
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            fastify.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to list canvas documents');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });
}
