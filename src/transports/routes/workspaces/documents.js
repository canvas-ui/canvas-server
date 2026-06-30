'use strict';

import ResponseObject from '../../ResponseObject.js';
import { parseDocumentId, parseDocumentIdArray } from '../../../utils/documentId.js';
import { mergeDeviceFeatureTags } from '../../../utils/device-features.js';
import {
  DIRECTORY_TREE_NAME,
  INCOMING_ROOT_CONTEXT,
  isIncomingContextSpec,
  shouldExcludeIncoming,
} from '../../../utils/incoming-documents.js';

// Human filename for a location URL: basename of the key after scheme://backend/.
function locationFilename(url) {
  if (!url) return null;
  const afterScheme = String(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slash = afterScheme.indexOf('/');
  const key = slash >= 0 ? afterScheme.slice(slash + 1) : afterScheme;
  const base = key.split('/').filter(Boolean).pop();
  if (!base) return null;
  try { return decodeURIComponent(base); } catch { return base; }
}

/**
 * Workspace document routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function workspaceDocumentRoutes(fastify, options) {
  function enforceClientTags(request, features = []) {
    return mergeDeviceFeatureTags(features, request.client);
  }

  function resolveContextSelector(workspace, source = {}, fallbackPath = '/') {
    const path = source?.context ?? fallbackPath;
    if (!path) { return null; }
    const treeNameOrId = source?.treeNameOrTreeId ?? null;
    const treeType = source?.treeType ?? null;

    if (treeType === 'directory') {
      return workspace.getDirectoryTreeSelector(path, treeNameOrId);
    }
    if (!treeType && treeNameOrId) {
      // Fallback: detect type from the tree itself. Only swallow "not found" so
      // an unknown tree still produces a clean error from getContextTreeSelector;
      // any other error (and the directory selector build itself) must propagate.
      let detectedType = null;
      try {
        detectedType = workspace.getTree(treeNameOrId)?.type ?? null;
      } catch (err) {
        if (!/not found/i.test(err?.message || '')) throw err;
      }
      if (detectedType === 'directory') {
        return workspace.getDirectoryTreeSelector(path, treeNameOrId);
      }
    }
    return workspace.getContextTreeSelector(path, treeNameOrId);
  }

  // Read scoping mirrors write scoping: a directory tree must land in spec.directory
  // (→ dir: path grammar), NOT spec.context (→ ctx:), otherwise list/search query
  // the wrong tree and return nothing. Returns { context, directory } with exactly
  // one populated. Defaults to context.
  function resolveScopeSelectors(workspace, source = {}, fallbackPath = '/') {
    const path = source?.context ?? fallbackPath;
    const treeNameOrId = source?.treeNameOrTreeId ?? null;
    const treeType = source?.treeType ?? null;

    let isDirectory = treeType === 'directory';
    if (!treeType && treeNameOrId) {
      try {
        isDirectory = workspace.getTree(treeNameOrId)?.type === 'directory';
      } catch (err) {
        if (!/not found/i.test(err?.message || '')) throw err;
      }
    }

    return isDirectory
      ? { context: null, directory: workspace.getDirectoryTreeSelector(path, treeNameOrId) }
      : { context: workspace.getContextTreeSelector(path, treeNameOrId), directory: null };
  }

  function buildReadOptions(contextSelector, includeIncoming, options = {}) {
    if (!shouldExcludeIncoming(contextSelector?.path, includeIncoming)) {
      return options;
    }
    return { ...options, excludeTree: { tree: DIRECTORY_TREE_NAME, path: INCOMING_ROOT_CONTEXT } };
  }

  function sendLinkResult(reply, result) {
    if (!result || !Array.isArray(result.failed)) {
      return null;
    }

    const failedCount = result.failed.length;
    const successCount = result.successful?.length || 0;
    if (failedCount === 0) {
      return null;
    }

    const message = successCount > 0
      ? `Inserted ${successCount} document(s), ${failedCount} failed`
      : 'Failed to insert documents';
    const responseObject = new ResponseObject().badRequest(message, result);
    return reply.code(responseObject.statusCode).send(responseObject.getResponse());
  }

  // selector.path may be a single path or an array of paths (multi-path insert).
  const anyIncoming = (path) => Array.isArray(path) ? path.some(isIncomingContextSpec) : isIncomingContextSpec(path);

  function rejectIncomingWrite(reply, workspace, selector) {
    if (!selector || !anyIncoming(selector.path)) return false;
    try {
      if (selector.tree && workspace.getTree(selector.tree)?.type !== 'directory') return false;
    } catch (_) {
      return false;
    }
    const responseObject = new ResponseObject().badRequest('Incoming directory tree is read-only');
    reply.code(responseObject.statusCode).send(responseObject.getResponse());
    return true;
  }

  function resolveInsertTarget(workspace, body, isTopLevelArray) {
    if (isTopLevelArray) {
      return { treeType: 'context', selector: workspace.getContextTreeSelector('/') };
    }
    if (body?.context || body?.treeNameOrTreeId) {
      const path = body?.context ?? '/';
      const treeNameOrId = body?.treeNameOrTreeId ?? null;
      const treeType = body?.treeType ?? null;

      if (treeType === 'directory') {
        return { treeType: 'directory', selector: workspace.getDirectoryTreeSelector(path, treeNameOrId) };
      }
      if (!treeType && treeNameOrId) {
        // Only swallow "not found" (let the context path emit a clean error for
        // unknown trees); rethrow anything else instead of masking it.
        let detectedType = null;
        try {
          detectedType = workspace.getTree(treeNameOrId)?.type ?? null;
        } catch (err) {
          if (!/not found/i.test(err?.message || '')) throw err;
        }
        if (detectedType === 'directory') {
          return { treeType: 'directory', selector: workspace.getDirectoryTreeSelector(path, treeNameOrId) };
        }
      }
      return { treeType: 'context', selector: workspace.getContextTreeSelector(path, treeNameOrId) };
    }
    if (body?.documents || body?.documentIds) {
      return { treeType: 'context', selector: workspace.getContextTreeSelector('/') };
    }
    return { treeType: 'context', selector: null };
  }

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

    if (!workspace.isActive) {
      const responseObject = new ResponseObject().badRequest('Workspace is not active. Start the workspace first.');
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }

    return workspace;
  }

  function buildAttributes(query) {
    const { allOf, noneOf, anyOf } = query;
    if (!allOf?.length && !noneOf?.length && !anyOf?.length) return undefined;
    const attrs = {};
    if (allOf?.length) attrs.allOf = allOf;
    if (noneOf?.length) attrs.noneOf = noneOf;
    if (anyOf?.length) attrs.anyOf = anyOf;
    return attrs;
  }

  // ── Shared querystring schema fragments ──────────────────────────────────

  const contextQueryProps = {
    treeNameOrTreeId: { type: 'string' },
    treeType: { type: 'string', enum: ['context', 'directory'] },
    context: { type: 'string', default: '/' },
  };

  const arrayOfStrings = { type: 'array', items: { type: 'string' }, default: [] };

  const attributesQueryProps = {
    allOf: arrayOfStrings,
    noneOf: arrayOfStrings,
    anyOf: arrayOfStrings,
  };

  const filtersQueryProps = {
    filters: { type: 'array', items: { type: 'string' }, default: [] },
  };

  const paginationQueryProps = {
    limit: { type: 'integer', default: 200 },
    offset: { type: 'integer' },
    page: { type: 'integer' },
  };

  // ── List documents ──────────────────────────────────────────────────────

  fastify.get('/', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          ...contextQueryProps,
          ...attributesQueryProps,
          ...filtersQueryProps,
          ...paginationQueryProps,
          // q may repeat (?q=car&q=red): a stack of text queries that AND-narrow
          // each other (stateless refinement). Single q == ordinary search.
          q: { type: ['string', 'array'], items: { type: 'string' } },
          search: { type: 'string' },
          mode: { type: 'string', enum: ['fts', 'vector', 'hybrid'] },
          includeIncoming: { type: 'boolean', default: false },
          // 'workspace' drops the path bucket entirely → list every document in
          // the DB (synapsd default). 'path' (default) scopes to context/tree.
          scope: { type: 'string', enum: ['path', 'workspace'], default: 'path' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      // Whole-workspace scope = no path selector. Null selector still excludes
      // the /.incoming staging tree by default (buildReadOptions), opt in via includeIncoming.
      const { context: ctxSelector, directory: dirSelector } = request.query.scope === 'workspace'
        ? { context: null, directory: null }
        : resolveScopeSelectors(workspace, request.query, '/');
      const activeSelector = dirSelector || ctxSelector;

      // Collect the (possibly stacked) text queries. `q` may be a string or an
      // array (repeated param); `search` is a legacy single alias.
      const rawQ = request.query.q;
      const queries = (Array.isArray(rawQ) ? rawQ : (rawQ ? [rawQ] : []))
        .concat(request.query.search ? [request.query.search] : [])
        .filter((s) => typeof s === 'string' && s.trim().length > 0);
      const isSearch = queries.length > 0;

      const spec = {
        context: ctxSelector,
        directory: dirSelector,
        attributes: buildAttributes(request.query),
        filters: request.query.filters,
        ...buildReadOptions(activeSelector, request.query.includeIncoming, {
          limit: request.query.limit,
          offset: request.query.offset,
          page: request.query.page,
        }),
      };

      let documents;
      if (queries.length > 1) {
        // Stacked queries → stateless multi-query refinement (AND-narrow, last ranks).
        documents = await workspace.searchRefined(queries, spec, {
          limit: request.query.limit,
          offset: request.query.offset,
          mode: request.query.mode,
        });
      } else if (queries.length === 1) {
        documents = await workspace.search({ query: queries[0], mode: request.query.mode, ...spec });
      } else {
        documents = await workspace.list(spec);
      }

      if (documents.error) {
        fastify.log.error(`SynapsD error: ${documents.error}`);
        const responseObject = new ResponseObject().error(`Failed to ${isSearch ? 'search' : 'list'} documents due to a database error.`, documents.error);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(documents, isSearch ? 'Search results retrieved successfully' : 'Documents retrieved successfully', 200, documents.count, documents.totalCount);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to list documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Insert documents ────────────────────────────────────────────────────

  fastify.post('/', {
    onRequest: [fastify.authenticateClient],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        oneOf: [
          {
            type: 'object',
            properties: {
              treeNameOrTreeId: { type: 'string' },
              treeType: { type: 'string', enum: ['context', 'directory'] },
              // A single path, or an array of paths to insert the same docs into
              // multiple tree paths in ONE op (one embed, all memberships). Use a
              // type union (not oneOf) — Fastify array-coercion makes a string
              // satisfy both oneOf branches → ambiguous → 400.
              context: { type: ['string', 'array'], items: { type: 'string' } },
              features: { type: 'array', items: { type: 'string' } },
              documents: { oneOf: [{ type: 'object' }, { type: 'array' }] },
              documentIds: {
                anyOf: [
                  { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] }, minItems: 1 },
                  { type: 'string' },
                  { type: 'number' },
                ],
              },
            },
            anyOf: [{ required: ['documents'] }, { required: ['documentIds'] }],
          },
          {
            type: 'array',
            items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            minItems: 1,
          },
        ],
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const isTopLevelArray = Array.isArray(request.body);
      const { treeType: insertTreeType, selector: insertSelector } = resolveInsertTarget(workspace, request.body, isTopLevelArray);
      if (insertTreeType === 'directory' && rejectIncomingWrite(reply, workspace, insertSelector)) return;
      const features = isTopLevelArray ? [] : (request.body.features || []);
      const enforcedFeatures = enforceClientTags(request, features);

      const treeSpec = {
        context: insertTreeType === 'directory'
          ? (anyIncoming(insertSelector?.path) ? null : workspace.getContextTreeSelector('/'))
          : insertSelector,
        directory: insertTreeType === 'directory' ? insertSelector : null,
        features: enforcedFeatures,
      };

      let documents;
      if (isTopLevelArray) {
        documents = await workspace.linkMany(request.body, treeSpec);
      } else if (request.body.documentIds) {
        const ids = Array.isArray(request.body.documentIds) ? request.body.documentIds : [request.body.documentIds];
        documents = await workspace.linkMany(ids, treeSpec);
      } else if (request.body.documents) {
        const docs = Array.isArray(request.body.documents) ? request.body.documents : [request.body.documents];
        documents = await workspace.putMany(docs, treeSpec);
      } else {
        const responseObject = new ResponseObject().badRequest('Body must include either "documents" or "documentIds", or be an array of IDs');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const linkErrorResponse = sendLinkResult(reply, documents);
      if (linkErrorResponse) return linkErrorResponse;

      const responseObject = new ResponseObject().created(documents, 'Documents inserted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to insert documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Get document by ID (by-id route) ────────────────────────────────────

  fastify.get('/by-id/:docId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'number' } } },
      querystring: {
        type: 'object',
        properties: { ...contextQueryProps, ...attributesQueryProps },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const { context: ctxSel, directory: dirSel } = resolveScopeSelectors(workspace, request.query, '/');

      const document = await workspace.get(request.params.docId);
      if (!document) {
        const responseObject = new ResponseObject().notFound(`Document with ID ${request.params.docId} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const matchesScope = await workspace.has(document.id, {
        context: ctxSel,
        directory: dirSel,
        attributes: buildAttributes(request.query),
      });
      if (!matchesScope) {
        const responseObject = new ResponseObject().notFound(`Document with ID ${request.params.docId} not found in the selected tree/path scope`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(document, 'Document retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get document');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Get documents by abstraction ────────────────────────────────────────

  fastify.get('/by-abstraction/:abstraction', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'abstraction'], properties: { id: { type: 'string' }, abstraction: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          ...contextQueryProps,
          ...attributesQueryProps,
          ...filtersQueryProps,
          ...paginationQueryProps,
          includeIncoming: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const { context: ctxSel, directory: dirSel } = resolveScopeSelectors(workspace, request.query, '/');
      const activeSelector = dirSel || ctxSel;
      const attrs = buildAttributes(request.query) || {};
      const allOf = [`data/abstraction/${request.params.abstraction}`, ...(attrs.allOf || [])];

      const documents = await workspace.list({
        context: ctxSel,
        directory: dirSel,
        attributes: { ...attrs, allOf },
        filters: request.query.filters,
        ...buildReadOptions(activeSelector, request.query.includeIncoming, {
          limit: request.query.limit,
          offset: request.query.offset,
          page: request.query.page,
        }),
      });

      if (documents.error) {
        fastify.log.error(`SynapsD error in findDocuments (by-abstraction): ${documents.error}`);
        const responseObject = new ResponseObject().error('Failed to list documents by abstraction due to a database error.', documents.error);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(documents, 'Documents retrieved successfully', 200, documents.count, documents.totalCount);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Update documents ────────────────────────────────────────────────────

  fastify.put('/', {
    onRequest: [fastify.authenticateClient],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          treeNameOrTreeId: { type: 'string' },
          treeType: { type: 'string', enum: ['context', 'directory'] },
          context: { type: 'string', default: '/' },
          features: { type: 'array', items: { type: 'string' }, default: [] },
          documents: { type: 'array' },
          documentIds: {
            anyOf: [
              { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] }, minItems: 1 },
              { type: 'string' },
              { type: 'number' },
            ],
          },
        },
        anyOf: [{ required: ['documents'] }, { required: ['documentIds'] }],
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      let itemsToUpdate;
      if (request.body.documents) {
        itemsToUpdate = Array.isArray(request.body.documents) ? request.body.documents : [request.body.documents];
      } else if (request.body.documentIds) {
        itemsToUpdate = Array.isArray(request.body.documentIds) ? request.body.documentIds : [request.body.documentIds];
      } else {
        const responseObject = new ResponseObject().badRequest('Body must include either "documents" or "documentIds"');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const { treeType: updateTreeType, selector: updateSelector } = resolveInsertTarget(workspace, request.body, false);
      if (updateTreeType === 'directory' && rejectIncomingWrite(reply, workspace, updateSelector)) return;
      const result = await workspace.putMany(itemsToUpdate, {
        context: updateTreeType === 'directory' ? null : updateSelector,
        directory: updateTreeType === 'directory' ? updateSelector : null,
        features: request.body.features || [],
      });
      if (!result) {
        const responseObject = new ResponseObject().badRequest('Failed to update documents');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(result, 'Documents updated successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to update documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Delete documents ────────────────────────────────────────────────────

  fastify.delete('/', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: { type: 'object', properties: { ...contextQueryProps, ...attributesQueryProps } },
      body: {
        type: 'array',
        items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        minItems: 1,
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      // Note: NO rejectIncomingWrite here. Deleting a document from the index is
      // removal, not a write INTO the incoming tree — and we allow purging
      // backend-ingested incoming docs (it's the lightweight sibling of Destroy,
      // which is likewise unguarded). Insert/update stay guarded; delete is by id.
      const rawIds = Array.isArray(request.body) ? request.body : [request.body];
      let documentIds;
      try {
        documentIds = parseDocumentIdArray(rawIds, 'Document ID array');
      } catch (e) {
        const responseObject = new ResponseObject().badRequest(e.message);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const result = await workspace.deleteMany(documentIds);

      if (result?.failed?.length) {
        fastify.log.warn({
          workspace: request.params.id,
          userId: request.user?.id,
          op: 'workspace.documents.delete',
          requested: documentIds.length,
          successful: result.successful?.length || 0,
          failed: result.failed?.length || 0,
          failedSamples: (result.failed || []).slice(0, 5),
        }, 'Workspace document delete had failures');
      }

      const message = (result?.successful?.length || 0) > 0
        ? 'Documents deleted successfully'
        : 'No documents deleted (not found or already deleted)';

      const responseObject = new ResponseObject().deleted(result, message, 200, result?.count ?? documentIds.length);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to delete documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Purge documents ─────────────────────────────────────────────────────

  fastify.delete('/purge', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          ...contextQueryProps,
          ...attributesQueryProps,
          ...filtersQueryProps,
          includeIncoming: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const { context: ctxSel, directory: dirSel } = resolveScopeSelectors(workspace, request.query, '/');
      const activeSelector = dirSel || ctxSel;

      const attributes = buildAttributes(request.query);
      const matches = await workspace.list({
        context: ctxSel,
        directory: dirSel,
        attributes,
        filters: request.query.filters,
        ...buildReadOptions(activeSelector, request.query.includeIncoming, { parse: false, limit: 0 }),
      });

      if (matches.error) {
        fastify.log.error(`SynapsD error in purge: ${matches.error}`);
        const responseObject = new ResponseObject().error('Failed to purge documents due to a database error.', matches.error);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const documentIds = matches.map(d => Number(d?.id)).filter(id => Number.isInteger(id) && id > 0);

      if (documentIds.length === 0) {
        const responseObject = new ResponseObject().success({ requested: 0, deleted: 0, result: { successful: [], failed: [], count: 0 } }, 'No matching documents to purge');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Purge is scoped (we listed ids at this tree+path), so emit ONE tree-scoped
      // batch event instead of N db-level per-doc events — drives cross-client
      // auto-close + UI refresh without an event storm. deleteMany stays silent.
      const result = await workspace.deleteMany(documentIds, { emitEvent: false });
      const purgedIds = (result?.successful || []).map((entry) => entry.id).filter((id) => Number.isInteger(id));
      if (purgedIds.length > 0) {
        workspace.emitTreeDocumentEvent('tree.document.deleted.batch', {
          context: ctxSel,
          directory: dirSel,
          documentIds: purgedIds,
        });
      }

      const responseObject = new ResponseObject().deleted({ requested: documentIds.length, deleted: result?.successful?.length || 0, result }, 'Documents purged successfully', 200, result?.successful?.length || 0);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to purge documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Remove documents (unlink from tree) ─────────────────────────────────

  fastify.delete('/remove', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: { type: 'object', properties: { ...contextQueryProps, ...attributesQueryProps } },
      body: {
        type: 'array',
        items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        minItems: 1,
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const contextSelector = resolveContextSelector(workspace, request.query, '/');

      const rawIds = Array.isArray(request.body) ? request.body : [request.body];
      let documentIds;
      try {
        documentIds = parseDocumentIdArray(rawIds, 'Document ID array');
      } catch (e) {
        const responseObject = new ResponseObject().badRequest(e.message);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const attributes = buildAttributes(request.query);
      // unlinkMany takes context/directory selectors under distinct keys.
      // resolveContextSelector already returns the right selector for the tree
      // type; route it to the matching key so a directory selector isn't
      // normalized as a context tree (which throws → 500).
      let isDirectory = request.query.treeType === 'directory';
      if (!request.query.treeType && request.query.treeNameOrTreeId) {
        try { isDirectory = workspace.getTree(request.query.treeNameOrTreeId)?.type === 'directory'; }
        catch (_) { isDirectory = false; }
      }
      const result = await workspace.unlinkMany(documentIds, isDirectory
        ? { directory: contextSelector, attributes }
        : { context: contextSelector, attributes });

      if (result?.failed?.length) {
        fastify.log.warn({
          workspace: request.params.id,
          userId: request.user?.id,
          op: 'workspace.documents.remove',
          context: contextSelector,
          requested: documentIds.length,
          successful: result.successful?.length || 0,
          failed: result.failed?.length || 0,
          failedSamples: (result.failed || []).slice(0, 5),
        }, 'Workspace document remove had failures');
      }

      const message = (result?.successful?.length || 0) > 0
        ? 'Documents removed successfully'
        : 'No documents removed (not found or already removed)';

      const responseObject = new ResponseObject().deleted(result, message, 200, result?.count ?? documentIds.length);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to remove documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Destroy documents (storage-level wipe via Stored) ───────────────────
  //
  // Removes blobs through Stored.deleteByUrl for every targeted location
  // (RW backends only; read-only locations are reference-dropped). When the
  // document has no remaining locations the index entry is cascaded as well.
  //
  // Body: { documentIds: number[], urls?: string[] }
  //   urls omitted   → destroy all locations on each doc
  //   urls specified → destroy only those location URLs (must belong to the doc)

  fastify.delete('/destroy', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['documentIds'],
        properties: {
          documentIds: {
            type: 'array',
            items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            minItems: 1,
          },
          urls: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const { documentIds: rawIds, urls = null } = request.body;
      let documentIds;
      try {
        documentIds = parseDocumentIdArray(rawIds, 'Document ID array');
      } catch (e) {
        const r = new ResponseObject().badRequest(e.message);
        return reply.code(r.statusCode).send(r.getResponse());
      }

      const results = { successful: [], failed: [] };
      for (const id of documentIds) {
        try {
          const doc = await workspace.get(id);
          if (!doc) { results.failed.push({ id, reason: 'not found' }); continue; }
          const res = await workspace.destroyDocument(doc, urls ? { urls } : {});
          results.successful.push({ id, ...res });
        } catch (err) {
          results.failed.push({ id, reason: err.message });
        }
      }

      const r = new ResponseObject().success(results, `Destroyed ${results.successful.length} document(s)`);
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError('Failed to destroy documents');
      return reply.code(r.statusCode).send(r.getResponse());
    }
  });

  // ── Get document by ID (direct route) ───────────────────────────────────

  fastify.get('/:docId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'string' } } },
      querystring: { type: 'object', properties: { ...contextQueryProps, ...attributesQueryProps } },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      let documentId;
      try {
        documentId = parseDocumentId(request.params.docId, 'Document ID parameter');
      } catch (error) {
        const responseObject = new ResponseObject().badRequest(error.message);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const document = await workspace.get(documentId);
      if (!document) {
        const responseObject = new ResponseObject().notFound(`Document with ID ${request.params.docId} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(document, 'Document retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get document');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Get document content (stream bytes from first reachable location) ──

  fastify.get('/:docId/content', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'string' } } },
      querystring: { type: 'object', properties: { download: { type: 'string' }, url: { type: 'string' } } },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      let documentId;
      try { documentId = parseDocumentId(request.params.docId, 'Document ID parameter'); }
      catch (e) { const r = new ResponseObject().badRequest(e.message); return reply.code(r.statusCode).send(r.getResponse()); }

      const doc = await workspace.get(documentId);
      if (!doc) { const r = new ResponseObject().notFound('Document not found'); return reply.code(r.statusCode).send(r.getResponse()); }

      const resolved = await workspace.resolveDocument(doc, { stream: true, url: request.query.url });
      if (!resolved) { const r = new ResponseObject().notFound('No reachable location'); return reply.code(r.statusCode).send(r.getResponse()); }

      const mime = doc.metadata?.contentType || 'application/octet-stream';
      const filename = locationFilename(resolved.url) || `document-${documentId}`;
      reply.header('Content-Type', mime);
      if (Number.isFinite(doc.metadata?.size)) reply.header('Content-Length', doc.metadata.size);
      if (request.query.download !== undefined) {
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      }
      return reply.send(resolved.stream || resolved.buffer);
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError('Failed to read document content');
      return reply.code(r.statusCode).send(r.getResponse());
    }
  });

  // ── Describe document locations (Destroy picker) ────────────────────────

  fastify.get('/:docId/locations', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'string' } } },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      let documentId;
      try { documentId = parseDocumentId(request.params.docId, 'Document ID parameter'); }
      catch (e) { const r = new ResponseObject().badRequest(e.message); return reply.code(r.statusCode).send(r.getResponse()); }

      const doc = await workspace.get(documentId);
      if (!doc) { const r = new ResponseObject().notFound('Document not found'); return reply.code(r.statusCode).send(r.getResponse()); }

      const locations = await workspace.describeDocumentLocations(doc);
      const r = new ResponseObject().found(locations, 'Document locations described');
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError('Failed to describe document locations');
      return reply.code(r.statusCode).send(r.getResponse());
    }
  });

  // ── Get document by hash ────────────────────────────────────────────────

  fastify.get('/by-hash/:algo/:hash', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'algo', 'hash'], properties: { id: { type: 'string' }, algo: { type: 'string' }, hash: { type: 'string' } } },
      querystring: { type: 'object', properties: { ...contextQueryProps, ...attributesQueryProps } },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const { context: ctxSel, directory: dirSel } = resolveScopeSelectors(workspace, request.query, '/');

      const checksumString = `${request.params.algo}/${request.params.hash}`;
      const document = await workspace.getByChecksumString(checksumString);
      if (!document) {
        const responseObject = new ResponseObject().notFound(`Document with checksum ${checksumString} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const matchesScope = await workspace.hasByChecksumString(checksumString, {
        context: ctxSel,
        directory: dirSel,
        attributes: buildAttributes(request.query),
      });
      if (!matchesScope) {
        const responseObject = new ResponseObject().notFound(`Document with checksum ${checksumString} not found in the selected tree/path scope`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(document, 'Document retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get document by hash');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Clear workspace database (DEVELOPMENT ONLY) ─────────────────────────

  fastify.delete('/clear-database', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (request, reply) => {
    if (process.env.NODE_ENV !== 'development') {
      const responseObject = new ResponseObject().forbidden('Database clear operation only available in development mode');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }

    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      if (!workspace.isActive) {
        fastify.log.info(`Workspace ${request.params.id} is not active, attempting to start...`);
        try {
          await workspace.start();
          fastify.log.info(`Workspace ${request.params.id} started successfully`);
        } catch (startError) {
          fastify.log.error(`Failed to start workspace ${request.params.id}: ${startError.message}`);
          const responseObject = new ResponseObject().serverError(`Failed to start workspace: ${startError.message}`);
          return reply.code(responseObject.statusCode).send(responseObject.getResponse());
        }
      }

      const result = workspace.clearDatabaseSync();
      const responseObject = new ResponseObject().success(result, 'Workspace database cleared successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to clear workspace database');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
