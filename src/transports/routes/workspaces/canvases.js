'use strict';

import ResponseObject from '../../ResponseObject.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-Z]{26}$/;

const looksLikeId = (s) => typeof s === 'string'
    && (s.startsWith('layer/') || ULID_RE.test(s) || UUID_RE.test(s));

/**
 * Workspace-scoped canvas routes. Mounted under /:id/canvases by index.js.
 *
 * A canvas is just a tree layer of `type: 'canvas'`, so all operations route
 * through the existing LayerIndex via ContextTree. The routes do not introduce
 * a new persistence model — they only expose canvas-specific affordances
 * (path-based create, querySpec/metadata updates, "list documents through
 * this canvas's spec").
 */
export default async function workspaceCanvasRoutes(fastify) {

    async function getWorkspace(request, reply) {
        const identifier = request.params.id;
        const userId = request.user.id;
        const workspaceId = UUID_RE.test(identifier)
            ? identifier
            : await fastify.workspaceManager.resolveWorkspaceId(userId, identifier);
        if (!workspaceId) {
            const r = new ResponseObject().notFound(`Workspace not found: ${identifier}`);
            reply.code(r.statusCode).send(r.getResponse());
            return null;
        }
        const workspace = await fastify.workspaceManager.getWorkspace(workspaceId, userId);
        if (!workspace) {
            const r = new ResponseObject().notFound(`Workspace not found: ${identifier}`);
            reply.code(r.statusCode).send(r.getResponse());
            return null;
        }
        return workspace;
    }

    function getTree(workspace, treeNameOrId) {
        return treeNameOrId
            ? workspace.getContextTree(treeNameOrId)
            : workspace.getDefaultContextTree();
    }

    function findCanvas(tree, idOrName) {
        if (!tree || !idOrName) { return null; }
        let layer = null;
        if (looksLikeId(idOrName)) {
            try { layer = tree.getLayerById(idOrName); } catch (_) { layer = null; }
        }
        if (!layer) {
            try { layer = tree.getLayer(idOrName, { type: 'canvas' }); } catch (_) { layer = null; }
        }
        if (!layer || layer.type !== 'canvas') { return null; }
        return layer;
    }

    function canvasView(tree, canvas) {
        const path = tree.getPathByLayerId(canvas.id);
        return {
            ...(typeof canvas.toJSON === 'function' ? canvas.toJSON() : canvas),
            treeId: tree.id,
            treeName: tree.name,
            path,
        };
    }

    // List canvases in a workspace tree
    fastify.get('/', {
        onRequest: [fastify.authenticate],
        schema: {
            querystring: {
                type: 'object',
                properties: { tree: { type: 'string' } },
            },
        },
    }, async (request, reply) => {
        try {
            const workspace = await getWorkspace(request, reply);
            if (!workspace) { return; }
            const tree = getTree(workspace, request.query.tree);
            const canvases = await tree.listLayers({ type: 'canvas' });
            const view = canvases.map((c) => canvasView(tree, c));
            const r = new ResponseObject().found(view, 'Canvases retrieved successfully', 200, view.length);
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            fastify.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to list canvases');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    // Create a canvas at a tree path. Intermediate context layers auto-created.
    fastify.post('/', {
        onRequest: [fastify.authenticate],
        schema: {
            body: {
                type: 'object',
                required: ['path'],
                properties: {
                    path: { type: 'string' },
                    tree: { type: 'string' },
                    querySpec: { type: 'object' },
                    metadata: { type: 'object' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const workspace = await getWorkspace(request, reply);
            if (!workspace) { return; }
            const tree = getTree(workspace, request.body.tree);

            const insertResult = await tree.insertPath(request.body.path, {
                leafType: 'canvas',
                querySpec: request.body.querySpec,
                metadata: request.body.metadata,
            });
            if (insertResult.error) {
                const r = new ResponseObject().badRequest(insertResult.error);
                return reply.code(r.statusCode).send(r.getResponse());
            }

            const leaf = tree.getLayerForPath(request.body.path);
            if (!leaf || leaf.type !== 'canvas') {
                const r = new ResponseObject().serverError('Canvas creation succeeded but layer could not be resolved');
                return reply.code(r.statusCode).send(r.getResponse());
            }

            const r = new ResponseObject().created(canvasView(tree, leaf), 'Canvas created successfully');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            fastify.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to create canvas');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    // Get a single canvas by id or name
    fastify.get('/:canvasIdOrName', {
        onRequest: [fastify.authenticate],
        schema: {
            querystring: { type: 'object', properties: { tree: { type: 'string' } } },
        },
    }, async (request, reply) => {
        try {
            const workspace = await getWorkspace(request, reply);
            if (!workspace) { return; }
            const tree = getTree(workspace, request.query.tree);
            const canvas = findCanvas(tree, request.params.canvasIdOrName);
            if (!canvas) {
                const r = new ResponseObject().notFound(`Canvas not found: ${request.params.canvasIdOrName}`);
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().found(canvasView(tree, canvas), 'Canvas retrieved successfully');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            fastify.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to get canvas');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    // Update canvas (querySpec / metadata / label / description / color).
    // querySpec replaces wholesale — callers should read-modify-write.
    fastify.patch('/:canvasIdOrName', {
        onRequest: [fastify.authenticate],
        schema: {
            querystring: { type: 'object', properties: { tree: { type: 'string' } } },
            body: {
                type: 'object',
                properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                    color: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    querySpec: { type: 'object' },
                    metadata: { type: 'object' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const workspace = await getWorkspace(request, reply);
            if (!workspace) { return; }
            const tree = getTree(workspace, request.query.tree);
            const canvas = findCanvas(tree, request.params.canvasIdOrName);
            if (!canvas) {
                const r = new ResponseObject().notFound(`Canvas not found: ${request.params.canvasIdOrName}`);
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const updated = await tree.updateLayer(canvas.id, request.body);
            const r = new ResponseObject().success(canvasView(tree, updated), 'Canvas updated successfully');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            fastify.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to update canvas');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    // Delete a canvas — frees its bitmap; documents linked at the path
    // remain in LMDB but become unreachable through this canvas.
    fastify.delete('/:canvasIdOrName', {
        onRequest: [fastify.authenticate],
        schema: {
            querystring: { type: 'object', properties: { tree: { type: 'string' } } },
        },
    }, async (request, reply) => {
        try {
            const workspace = await getWorkspace(request, reply);
            if (!workspace) { return; }
            const tree = getTree(workspace, request.query.tree);
            const canvas = findCanvas(tree, request.params.canvasIdOrName);
            if (!canvas) {
                const r = new ResponseObject().notFound(`Canvas not found: ${request.params.canvasIdOrName}`);
                return reply.code(r.statusCode).send(r.getResponse());
            }
            await tree.deleteLayer(canvas.id);
            const r = new ResponseObject().deleted(true, 'Canvas deleted successfully');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            fastify.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to delete canvas');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    // Note: canvas-aware document listing is handled by the standard
    // `GET /workspaces/:id/documents?context=<canvas-path>` endpoint.
    // `Workspace.list/search` detects a canvas leaf and AND-composes its
    // querySpec server-side, so a dedicated `/canvases/:id/documents`
    // endpoint is redundant.
}
