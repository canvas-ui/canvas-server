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

    // Canvas-aware document listing handled by `GET /workspaces/:id/documents?context=<canvas-path>`.
    // Workspace.list/search composes the canvas's querySpec automatically, so a dedicated
    // /canvases/:id/documents alias is redundant.
}
