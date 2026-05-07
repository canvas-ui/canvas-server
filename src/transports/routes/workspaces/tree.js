'use strict';

import ResponseObject from '../../ResponseObject.js';

export default async function workspaceTreeRoutes(fastify) {
  async function getWorkspaceInstance(request, reply) {
    const identifier = request.params.id;
    const userId = request.user.id;
    const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const workspaceId = isWorkspaceId ? identifier : await fastify.workspaceManager.resolveWorkspaceId(userId, identifier);
    if (!workspaceId) {
      const responseObject = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }
    const workspace = await fastify.workspaceManager.getWorkspace(workspaceId, userId);
    if (!workspace) {
      const responseObject = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }
    return workspace;
  }

  async function getTreeInstance(request, reply, expectedType = null) {
    const workspace = await getWorkspaceInstance(request, reply);
    if (!workspace) { return null; }

    try {
      const tree = workspace.getTree(request.params.treeNameOrTreeId);
      if (expectedType && tree.type !== expectedType) {
        const responseObject = new ResponseObject().badRequest(`Tree "${tree.name}" is not a ${expectedType} tree`);
        reply.code(responseObject.statusCode).send(responseObject.getResponse());
        return null;
      }
      return { workspace, tree };
    } catch (error) {
      const responseObject = new ResponseObject().notFound(error.message || 'Tree not found');
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }
  }

  function pathFromSplat(request) {
    const splat = request.params['*'] || '';
    return `/${splat}`.replace(/\/+/g, '/');
  }

  function normalizeTreePath(path) {
    return `/${String(path || '').replace(/^\/+/, '')}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  }

  function parentPathOf(path) {
    const normalized = normalizeTreePath(path);
    if (normalized === '/') { return null; }
    return normalized.split('/').slice(0, -1).join('/') || '/';
  }

  function leafNameOf(path) {
    return normalizeTreePath(path).split('/').filter(Boolean).pop() || null;
  }

  function pathNodeView(tree, path) {
    const layer = typeof tree.getLayerForPath === 'function'
      ? tree.getLayerForPath(path)
      : null;
    if (layer) {
      return {
        ...(typeof layer.toJSON === 'function' ? layer.toJSON() : layer),
        treeId: tree.id,
        treeName: tree.name,
        path,
      };
    }
    if (typeof tree.getNodeIdsForPath === 'function') {
      const nodeIds = tree.getNodeIdsForPath(path);
      if (nodeIds.length > 0) {
        return {
          id: nodeIds[nodeIds.length - 1],
          type: tree.type,
          treeId: tree.id,
          treeName: tree.name,
          path,
        };
      }
    }
    return null;
  }

  async function insertTreePath(tree, path, body = {}) {
    if (tree.type === 'context') {
      return await tree.insertPath(path, {
        leafType: body.type || 'context',
        querySpec: body.querySpec,
        metadata: body.metadata,
      }, body.autoCreateLayers ?? true);
    }
    return await tree.insertPath(path, {
      leafType: body.type || 'directory',
      querySpec: body.querySpec,
      metadata: body.metadata,
    });
  }

  // DirectoryTree.movePath/copyPath expect targetPath = FULL destination path
  // (parent + final name). UI drag-drop sends targetPath = drop-target node
  // (the destination parent). If targetPath resolves to an existing directory
  // distinct from source, compose finalPath = `${target}/${sourceName}`.
  function resolveDirectoryTargetPath(tree, fromPath, targetPath) {
    const source = pathNodeView(tree, fromPath);
    if (!source?.id) { return { error: `Path not found: ${fromPath}` }; }
    const existingTarget = pathNodeView(tree, targetPath);
    if (existingTarget && existingTarget.id !== source.id) {
      const sourceName = leafNameOf(fromPath);
      const normalizedParent = normalizeTreePath(targetPath);
      const finalPath = normalizedParent === '/'
        ? `/${sourceName}`
        : `${normalizedParent}/${sourceName}`;
      return { finalPath };
    }
    return { finalPath: targetPath };
  }

  async function moveTreePath(tree, fromPath, targetPath, recursive = false) {
    if (tree.type !== 'context') {
      const resolved = resolveDirectoryTargetPath(tree, fromPath, targetPath);
      if (resolved.error) { return { data: null, count: 0, error: resolved.error }; }
      return await tree.movePath(fromPath, resolved.finalPath, recursive);
    }

    const source = pathNodeView(tree, fromPath);
    if (!source?.id) {
      return { data: null, count: 0, error: `Path not found: ${fromPath}` };
    }

    const existingTarget = pathNodeView(tree, targetPath);
    if (existingTarget && existingTarget.id !== source.id) {
      // Existing target means "move under this parent" for drag/drop callers.
      return await tree.movePath(fromPath, targetPath, recursive);
    }

    const targetName = leafNameOf(targetPath);
    const targetParentPath = parentPathOf(targetPath);
    if (!targetName || !targetParentPath) {
      return { data: null, count: 0, error: `Invalid target path: ${targetPath}` };
    }

    const sourceParentPath = parentPathOf(fromPath);
    if (targetParentPath !== sourceParentPath) {
      const moved = await tree.movePath(fromPath, targetParentPath, recursive);
      if (moved?.error) { return moved; }
    }

    if (targetName !== source.name) {
      const renamed = await tree.renameLayer(source.id, targetName);
      return {
        data: { pathFrom: fromPath, pathTo: targetPath, layerId: renamed.id, layerName: renamed.name },
        count: 1,
        error: null,
      };
    }

    return {
      data: { pathFrom: fromPath, pathTo: targetPath, layerId: source.id, layerName: source.name },
      count: 1,
      error: null,
    };
  }

  function resolveTargetTree(workspace, currentTree, nameOrId) {
    if (!nameOrId || nameOrId === currentTree.id || nameOrId === currentTree.name) {
      return currentTree;
    }
    const tree = workspace.getTree(nameOrId);
    if (!tree) { throw new Error(`Target tree not found: ${nameOrId}`); }
    return tree;
  }

  function treeSelectorFor(tree, path) {
    return tree.type === 'directory'
      ? { context: null, directory: { tree: tree.id, path } }
      : { context: { tree: tree.id, path }, directory: null };
  }

  function resolveCrossTreeTargetPath(targetTree, fromPath, targetPath) {
    const existingTarget = pathNodeView(targetTree, targetPath);
    if (!existingTarget) { return targetPath; }
    const sourceName = leafNameOf(fromPath);
    const normalizedParent = normalizeTreePath(targetPath);
    return normalizedParent === '/' ? `/${sourceName}` : `${normalizedParent}/${sourceName}`;
  }

  async function copyAcrossTrees(workspace, sourceTree, targetTree, fromPath, targetPath, recursive = false, move = false) {
    const finalTargetPath = resolveCrossTreeTargetPath(targetTree, fromPath, targetPath);
    const insertResult = await insertTreePath(targetTree, finalTargetPath, {});
    if (insertResult?.error) { return insertResult; }

    const docs = await workspace.list({
      ...treeSelectorFor(sourceTree, fromPath),
      limit: 0,
      parse: false,
    });
    if (docs.error) {
      return { data: null, count: 0, error: docs.error };
    }

    const documentIds = docs.map((doc) => doc?.id).filter((id) => typeof id === 'number');
    if (documentIds.length > 0) {
      const linked = await workspace.linkMany(documentIds, treeSelectorFor(targetTree, finalTargetPath));
      if (linked.failed?.length) {
        return { data: linked, count: linked.successful?.length || 0, error: 'Some documents could not be linked to the target tree' };
      }
      if (move) {
        const unlinked = await workspace.unlinkMany(documentIds, treeSelectorFor(sourceTree, fromPath), [], { recursive });
        if (unlinked.failed?.length) {
          return { data: unlinked, count: unlinked.successful?.length || 0, error: 'Copied, but some source memberships could not be removed' };
        }
      }
    }

    return {
      data: {
        pathFrom: fromPath,
        pathTo: finalTargetPath,
        sourceTree: sourceTree.name,
        targetTree: targetTree.name,
        documentIds,
      },
      count: documentIds.length,
      error: null,
    };
  }

  fastify.get('/', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply);
      if (!resolved) return;
      const responseObject = new ResponseObject().found(resolved.tree.buildJsonTree(), 'Workspace tree retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Get workspace tree error for ID ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError('Failed to get workspace tree');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.get('/path/*', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply);
      if (!resolved) return;
      const path = pathFromSplat(request);
      const node = pathNodeView(resolved.tree, path);
      if (!node) {
        const responseObject = new ResponseObject().notFound(`Path not found: ${path}`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      const responseObject = new ResponseObject().found(node, 'Tree path retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Get workspace path error for ID ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to get path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.put('/path/*', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          autoCreateLayers: { type: 'boolean' },
          querySpec: { type: 'object' },
          metadata: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply);
      if (!resolved) return;
      const path = pathFromSplat(request);
      const result = await insertTreePath(resolved.tree, path, request.body || {});
      if (result?.error) {
        const responseObject = new ResponseObject().badRequest(result.error);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      const responseObject = new ResponseObject().created(pathNodeView(resolved.tree, path) || result, 'Tree path saved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Save workspace path error for ID ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to save path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.patch('/path/*', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          targetTreeNameOrTreeId: { type: 'string' },
          name: { type: 'string' },
          recursive: { type: 'boolean', default: false },
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
      const resolved = await getTreeInstance(request, reply);
      if (!resolved) return;
      const path = pathFromSplat(request);
      const body = request.body || {};

      if (body.to || body.name) {
        const targetPath = body.to || `${path.split('/').slice(0, -1).join('/') || '/'}/${body.name}`;
        const targetTree = resolveTargetTree(resolved.workspace, resolved.tree, body.targetTreeNameOrTreeId);
        const result = targetTree.id === resolved.tree.id
          ? await moveTreePath(resolved.tree, path, targetPath, body.recursive)
          : await copyAcrossTrees(resolved.workspace, resolved.tree, targetTree, path, targetPath, body.recursive, true);
        const responseObject = result?.error
          ? new ResponseObject().badRequest(result.error)
          : new ResponseObject().success(result, 'Tree path moved successfully');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const node = pathNodeView(resolved.tree, path);
      if (!node?.id || typeof resolved.tree.updateLayer !== 'function') {
        const responseObject = new ResponseObject().badRequest(`Path cannot be updated: ${path}`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      const updated = await resolved.tree.updateLayer(node.id, body);
      const responseObject = new ResponseObject().success({
        ...(typeof updated.toJSON === 'function' ? updated.toJSON() : updated),
        treeId: resolved.tree.id,
        treeName: resolved.tree.name,
        path,
      }, 'Tree path updated successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Update workspace path error for ID ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to update path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.post('/path/*', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['to'],
        properties: {
          to: { type: 'string' },
          targetTreeNameOrTreeId: { type: 'string' },
          recursive: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply);
      if (!resolved) return;
      const fromPath = pathFromSplat(request);
      let toPath = request.body.to;
      const targetTree = resolveTargetTree(resolved.workspace, resolved.tree, request.body.targetTreeNameOrTreeId);
      if (targetTree.id !== resolved.tree.id) {
        const result = await copyAcrossTrees(resolved.workspace, resolved.tree, targetTree, fromPath, toPath, request.body.recursive, false);
        const responseObject = result?.error
          ? new ResponseObject().badRequest(result.error)
          : new ResponseObject().success(result, 'Tree path copied successfully');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      if (resolved.tree.type !== 'context') {
        const r = resolveDirectoryTargetPath(resolved.tree, fromPath, toPath);
        if (r.error) {
          const errResp = new ResponseObject().badRequest(r.error);
          return reply.code(errResp.statusCode).send(errResp.getResponse());
        }
        toPath = r.finalPath;
      }
      const result = await resolved.tree.copyPath(fromPath, toPath, request.body.recursive);
      const responseObject = new ResponseObject().success(result, 'Tree path copied successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Copy workspace path error for ID ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to copy path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.delete('/path/*', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          recursive: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply);
      if (!resolved) return;
      const path = pathFromSplat(request);
      const result = await resolved.tree.removePath(path, request.query.recursive);
      const responseObject = result?.error
        ? new ResponseObject().badRequest(result.error)
        : new ResponseObject().success(result, 'Tree path removed successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Remove workspace path error for ID ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to remove path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.get('/layers', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply, 'context');
      if (!resolved) return;
      const layers = await resolved.tree.listLayers();
      const responseObject = new ResponseObject().found(layers, 'Layers retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`List layers error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to list layers');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.get('/layers/:layerId', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply, 'context');
      if (!resolved) return;
      const layer = resolved.tree.getLayerById(request.params.layerId) || resolved.tree.getLayer(request.params.layerId);
      if (!layer) {
        const responseObject = new ResponseObject().notFound(`Layer not found: ${request.params.layerId}`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      const responseObject = new ResponseObject().found(layer, 'Layer retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Get layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to get layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.get('/layers/:layerId/documents', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 200 },
          offset: { type: 'integer' },
          page: { type: 'integer' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply, 'context');
      if (!resolved) return;
      const { workspace, tree } = resolved;
      const layer = tree.getLayerById(request.params.layerId) || tree.getLayer(request.params.layerId);
      if (!layer) {
        const responseObject = new ResponseObject().notFound(`Layer not found: ${request.params.layerId}`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      const bitmapKey = `context/${tree.id}/${layer.id}`;
      const documents = await workspace.list({
        attributes: { allOf: [bitmapKey] },
        limit: request.query.limit,
        offset: request.query.offset,
        page: request.query.page,
      });
      if (documents.error) {
        const responseObject = new ResponseObject().serverError('Failed to list layer documents');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      const responseObject = new ResponseObject().found(documents, 'Layer documents retrieved successfully', 200, documents.count, documents.totalCount);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Get layer documents error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to get layer documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.patch('/layers/:layerId', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply, 'context');
      if (!resolved) return;
      const layer = request.body.name
        ? await resolved.tree.renameLayer(request.params.layerId, request.body.name)
        : await resolved.tree.updateLayer(request.params.layerId, request.body);
      const responseObject = new ResponseObject().success(layer, 'Layer updated successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Update layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to update layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.post('/layers/:layerId/lock', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['lockBy'],
        properties: {
          lockBy: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply, 'context');
      if (!resolved) return;
      const result = await resolved.tree.lockLayer(request.params.layerId, request.body.lockBy);
      const responseObject = new ResponseObject().success(result, 'Layer locked successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Lock layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to lock layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.post('/layers/:layerId/unlock', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['lockBy'],
        properties: {
          lockBy: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply, 'context');
      if (!resolved) return;
      const result = await resolved.tree.unlockLayer(request.params.layerId, request.body.lockBy);
      if (result.isStillLocked) {
        const ids = result.lockedBy.join(', ');
        const responseObject = new ResponseObject().conflict(
          `Your lock was removed, but layer is still locked by: ${ids}`,
          { lockedBy: result.lockedBy },
        );
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      const responseObject = new ResponseObject().success(result, 'Layer unlocked successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Unlock layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to unlock layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.delete('/layers/:layerId', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply, 'context');
      if (!resolved) return;
      await resolved.tree.deleteLayer(request.params.layerId);
      const responseObject = new ResponseObject().deleted(true, 'Layer deleted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Delete layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to delete layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.post('/layers/merge', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['layerId', 'targetLayers'],
        properties: {
          layerId: { type: 'string' },
          targetLayers: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply, 'context');
      if (!resolved) return;
      const result = await resolved.tree.mergeLayer(request.body.layerId, request.body.targetLayers);
      const responseObject = result.error
        ? new ResponseObject().badRequest(result.error)
        : new ResponseObject().success(result, 'Layer merged successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Merge layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to merge layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.post('/layers/subtract', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['layerId', 'targetLayers'],
        properties: {
          layerId: { type: 'string' },
          targetLayers: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply, 'context');
      if (!resolved) return;
      const result = await resolved.tree.subtractLayer(request.body.layerId, request.body.targetLayers);
      const responseObject = result.error
        ? new ResponseObject().badRequest(result.error)
        : new ResponseObject().success(result, 'Layer subtracted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Subtract layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to subtract layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
