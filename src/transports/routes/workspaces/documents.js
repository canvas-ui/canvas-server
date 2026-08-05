'use strict';

import ResponseObject from '../../ResponseObject.js';
import { parseDocumentId, parseDocumentIdArray } from '../../../utils/documentId.js';
import { stripDeviceFeatureTags } from '../../../utils/device-features.js';
import { parseByteRange } from '../../lib/http-range.js';
import { resolveContentType } from '../../lib/mime.js';
import { normalizeSchemaId } from '../../../core/workspace/lib/classifier.js';

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

// Short-lived, HttpOnly cookie that lets <video>/<audio> stream document bytes
// directly (they can't send an Authorization header). Minted by /content-ticket,
// accepted by /content. Scoped to the workspace's documents path, ~2 min TTL.
const MEDIA_COOKIE = 'cvs_media';
const MEDIA_TICKET_TTL = 3600; // seconds — covers a viewing session (seeks/resumes)

function readCookie(request, name) {
  const raw = request.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const val = part.slice(eq + 1).trim();
    try { return decodeURIComponent(val); } catch { return val; }
  }
  return null;
}

/**
 * Workspace document routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function workspaceDocumentRoutes(fastify, options) {
  // `device/*` is engine-owned: synapsd DERIVES presence from a document's
  // locations. Clients neither assert it nor have it injected on their behalf —
  // we only strip what they should not be sending. Everything else passes
  // through verbatim, including the whole optional `client/*` namespace
  // (client/app/firefox, client/device/os/*, …) which consumers populate, or
  // don't, entirely at their own discretion.
  function enforceClientTags(request, features = []) {
    return stripDeviceFeatureTags(features);
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

  // Generic document writes must not target the backends tree — its content
  // mirrors backend storage (populated by sync workers only).
  function rejectBackendsWrite(reply, workspace, selector) {
    if (!selector?.tree) return false;
    let isBackends = false;
    try {
      isBackends = workspace.getBackendsTree()?.id === workspace.getTree(selector.tree)?.id;
    } catch (_) {
      return false;
    }
    if (!isBackends) return false;
    const responseObject = new ResponseObject().badRequest('Backends tree is read-only');
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
      const responseObject = new ResponseObject().workspaceNotActive();
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
    // Document lists default to newest first; search results stay ranked.
    order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
    // Sort a listing by a named timeline (e.g. 'content' = EXIF capture date,
    // 'crud:created'/'crud:updated'); order applies to the timeline value.
    // Docs with no value on that timeline trail the sorted ones. List-only —
    // search results stay relevance-ranked.
    sortBy: { type: 'string' },
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
          // Optional cosine-distance floor for the dense side of vector/hybrid
          // search — drops weak (far) kNN hits before fusion. 0..2 (0 = identical).
          minDistance: { type: 'number' },
          maxDistance: { type: 'number' },
          // Calibration aid: attach raw (unfloored) image kNN cosine distances for
          // the query to the response (`.debug.imageDistances`), to pick a floor.
          debug: { type: 'boolean' },
          // 'workspace' drops the path bucket entirely → list every document in
          // the DB (synapsd default). 'path' (default) scopes to context/tree.
          scope: { type: 'string', enum: ['path', 'workspace'], default: 'path' },
          // When false, do NOT fold a canvas leaf's stored querySpec into the
          // read — the client is driving the filters itself (live canvas filter
          // preview via the toolbox). Default true = normal canvas behavior.
          applyCanvasSpec: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      // Whole-workspace scope = no path selector. Backend mirrors live in their
      // own tree (linkContextRoot:false), so root/context queries never see
      // them unless a user filed them somewhere.
      const { context: ctxSelector, directory: dirSelector } = request.query.scope === 'workspace'
        ? { context: null, directory: null }
        : resolveScopeSelectors(workspace, request.query, '/');

      // Collect the (possibly stacked) text queries. `q` may be a string or an
      // array (repeated param); `search` is a legacy single alias.
      const rawQ = request.query.q;
      const queries = (Array.isArray(rawQ) ? rawQ : (rawQ ? [rawQ] : []))
        .concat(request.query.search ? [request.query.search] : [])
        .filter((s) => typeof s === 'string' && s.trim().length > 0);
      const isSearch = queries.length > 0;

      const spec = {
        context: ctxSelector,
        // Directory membership is node-exact (docs tick only their leaf node),
        // so a folder listing stays exact but a search must scope to the whole
        // subtree — otherwise searching the backends/directory tree at an
        // ancestor folder matches nothing.
        directory: isSearch && dirSelector ? { ...dirSelector, recursive: true } : dirSelector,
        attributes: buildAttributes(request.query),
        filters: request.query.filters,
        limit: request.query.limit,
        offset: request.query.offset,
        page: request.query.page,
        order: request.query.order,
        sortBy: request.query.sortBy,
        // Client-driven canvas preview opts out of stored-querySpec folding.
        applyCanvasQuerySpec: request.query.applyCanvasSpec,
      };

      const { minDistance, maxDistance } = request.query;
      let documents;
      if (queries.length > 1) {
        // Stacked queries → stateless multi-query refinement (AND-narrow, last ranks).
        documents = await workspace.searchRefined(queries, spec, {
          limit: request.query.limit,
          offset: request.query.offset,
          mode: request.query.mode,
          minDistance,
          maxDistance,
          debug: request.query.debug,
        });
      } else if (queries.length === 1) {
        documents = await workspace.search({ query: queries[0], mode: request.query.mode, minDistance, maxDistance, debug: request.query.debug, ...spec });
      } else {
        documents = await workspace.list(spec);
      }

      if (documents.error) {
        fastify.log.error(`SynapsD error: ${documents.error}`);
        const responseObject = new ResponseObject().error(`Failed to ${isSearch ? 'search' : 'list'} documents due to a database error.`, documents.error);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(documents, isSearch ? 'Search results retrieved successfully' : 'Documents retrieved successfully', 200, documents.count, documents.totalCount);
      // Arrays lose non-index props in JSON — lift the calibration debug across.
      if (documents.debug) { responseObject.debug = documents.debug; }
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to list documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Compound search ───────────────────────────────────────────────────────
  // OR/AND of independent refinement chains ("lines"). JSON body (agent-friendly,
  // testable); the GET `?q=` stack stays for a single chain. Each line is an
  // ordered query chain (chained scoping: each query narrows the previous
  // survivors) with optional per-line filters; lines combine by set semantics
  // (`op`: 'or' = union, 'and' = intersection), ranked via per-line RRF fusion.
  // Response carries `.lines` (per-line match counts) so an empty AND
  // intersection is explainable in the UI.

  fastify.post('/search', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['lines'],
        additionalProperties: false,
        properties: {
          lines: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                queries: { type: 'array', items: { type: 'string' }, default: [] },
                filters: { type: 'array', items: { type: 'string' } },
                features: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          op: { type: 'string', enum: ['or', 'and'], default: 'or' },
          ...contextQueryProps,
          ...attributesQueryProps,
          ...filtersQueryProps,
          limit: { type: 'integer', default: 200 },
          offset: { type: 'integer' },
          mode: { type: 'string', enum: ['fts', 'vector', 'hybrid'] },
          minDistance: { type: 'number' },
          maxDistance: { type: 'number' },
          scope: { type: 'string', enum: ['path', 'workspace'], default: 'path' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const body = request.body;
      const { context: ctxSelector, directory: dirSelector } = body.scope === 'workspace'
        ? { context: null, directory: null }
        : resolveScopeSelectors(workspace, body, '/');

      const lines = (body.lines || [])
        .map((l) => ({
          queries: (l.queries || []).filter((s) => typeof s === 'string' && s.trim().length > 0),
          ...(l.filters ? { filters: l.filters } : {}),
          ...(l.features ? { features: l.features } : {}),
        }))
        .filter((l) => l.queries.length > 0 || l.filters || l.features);
      if (lines.length === 0) {
        const responseObject = new ResponseObject().badRequest('Compound search requires at least one non-empty line');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const spec = {
        context: ctxSelector,
        // Search must scope to the whole subtree (see GET handler).
        directory: dirSelector ? { ...dirSelector, recursive: true } : dirSelector,
        attributes: buildAttributes(body),
        filters: body.filters,
      };

      const documents = await workspace.searchCompound(lines, spec, {
        op: body.op,
        limit: body.limit,
        offset: body.offset,
        mode: body.mode,
        minDistance: body.minDistance,
        maxDistance: body.maxDistance,
      });

      if (documents.error) {
        fastify.log.error(`SynapsD error: ${documents.error}`);
        const responseObject = new ResponseObject().error('Failed to search documents due to a database error.', documents.error);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(documents, 'Search results retrieved successfully', 200, documents.count, documents.totalCount);
      // Arrays lose non-index props in JSON — lift per-line counts across.
      if (documents.lines) { responseObject.lines = documents.lines; }
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to search documents');
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
      if (insertTreeType === 'directory' && rejectBackendsWrite(reply, workspace, insertSelector)) return;
      const features = isTopLevelArray ? [] : (request.body.features || []);
      const enforcedFeatures = enforceClientTags(request, features);

      const treeSpec = {
        // Directory-only inserts: synapsd ticks the default context root
        // automatically unless the tree opts out (settings.linkContextRoot).
        context: insertTreeType === 'directory' ? null : insertSelector,
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
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const { context: ctxSel, directory: dirSel } = resolveScopeSelectors(workspace, request.query, '/');
      const attrs = buildAttributes(request.query) || {};
      // normalizeSchemaId maps short names onto the hierarchical ids (`email`
      // -> data/schema/message/email), which plain prefix-concat cannot.
      const allOf = [normalizeSchemaId(request.params.abstraction), ...(attrs.allOf || [])];

      const documents = await workspace.list({
        context: ctxSel,
        directory: dirSel,
        attributes: { ...attrs, allOf },
        filters: request.query.filters,
        limit: request.query.limit,
        offset: request.query.offset,
        page: request.query.page,
        order: request.query.order,
        sortBy: request.query.sortBy,
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
      if (updateTreeType === 'directory' && rejectBackendsWrite(reply, workspace, updateSelector)) return;
      const result = await workspace.putMany(itemsToUpdate, {
        context: updateTreeType === 'directory' ? null : updateSelector,
        directory: updateTreeType === 'directory' ? updateSelector : null,
        features: enforceClientTags(request, request.body.features || []),
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
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const { context: ctxSel, directory: dirSel } = resolveScopeSelectors(workspace, request.query, '/');

      const attributes = buildAttributes(request.query);
      const matches = await workspace.list({
        context: ctxSel,
        directory: dirSel,
        attributes,
        filters: request.query.filters,
        parse: false,
        limit: 0,
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
      querystring: {
        type: 'object',
        properties: {
          ...contextQueryProps,
          ...attributesQueryProps,
          // Filesystem-mount semantics: if this removes a document's LAST
          // placement, file it into the trash rather than leaving it reachable
          // only through the flat workspace-wide list. Used by WebDAV and
          // canvas-fuse; off by default so the plain API keeps detaching.
          trashIfOrphaned: { type: 'boolean' },
        },
      },
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
      const result = await workspace.unlinkMany(
        documentIds,
        isDirectory ? { directory: contextSelector, attributes } : { context: contextSelector, attributes },
        { trashIfOrphaned: request.query.trashIfOrphaned === true },
      );

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
  // Body: { documentIds: number[], urls?: string[], keepDocument?: boolean }
  //   urls omitted   → destroy all locations on each doc
  //   urls specified → destroy only those location URLs (must belong to the doc)
  //   keepDocument   → when the last location is wiped, keep the index entry
  //                    (locations: []) instead of cascading the doc deletion

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
          keepDocument: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const { documentIds: rawIds, urls = null, keepDocument = false } = request.body;
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
          const res = await workspace.destroyDocument(doc, { ...(urls ? { urls } : {}), keepDocument });
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

  // Content auth: the normal bearer chain, OR a short-lived media-ticket cookie
  // (see /content-ticket) so <video>/<audio> can stream directly — those can't
  // send an Authorization header. The cookie is signed, workspace-scoped and
  // ~2 min-lived; the workspace ACL still runs via getWorkspaceInstance.
  async function authenticateContent(request, reply) {
    if (request.headers.authorization) {
      try { await fastify.authenticate(request, reply); return; } catch { /* try the media ticket */ }
    }
    const token = readCookie(request, MEDIA_COOKIE);
    if (token) {
      try {
        const payload = fastify.jwt.verify(token);
        if (payload && payload.scope === 'media' && payload.ws === request.params.id && payload.sub) {
          request.user = { id: payload.sub };
          return;
        }
      } catch { /* fall through to 401 */ }
    }
    const r = new ResponseObject().unauthorized('Authentication required');
    return reply.code(r.statusCode).send(r.getResponse());
  }

  // ── Mint a media-streaming ticket cookie (authed by bearer) ──────────────
  fastify.post('/:docId/content-ticket', {
    onRequest: [fastify.authenticate],
    schema: { params: { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'string' } } } },
  }, async (request, reply) => {
    const workspace = await getWorkspaceInstance(request, reply);
    if (!workspace) return;
    const token = fastify.jwt.sign(
      { scope: 'media', ws: request.params.id, sub: request.user.id },
      { expiresIn: `${MEDIA_TICKET_TTL}s` },
    );
    // Scope the cookie to this workspace's documents subtree, derived from this
    // request's own path so it's independent of the API mount prefix.
    const urlPath = request.url.split('?')[0];
    const cut = urlPath.indexOf('/documents');
    const cookiePath = cut >= 0 ? urlPath.slice(0, cut + '/documents'.length) : '/';
    const cookie = [
      `${MEDIA_COOKIE}=${encodeURIComponent(token)}`,
      `Path=${cookiePath}`,
      `Max-Age=${MEDIA_TICKET_TTL}`,
      'HttpOnly',
      'SameSite=Strict',
      request.protocol === 'https' ? 'Secure' : null,
    ].filter(Boolean).join('; ');
    reply.header('Set-Cookie', cookie);
    const r = new ResponseObject().success({ ttl: MEDIA_TICKET_TTL }, 'Media ticket issued');
    return reply.code(r.statusCode).send(r.getResponse());
  });

  // ── Get document content (stream bytes from first reachable location) ──
  // Supports HTTP Range (206) for media seeking + resumable downloads.

  fastify.get('/:docId/content', {
    onRequest: [authenticateContent],
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

      // ?url= may only target this document's own bytes: its locations[] or an
      // embedded attachment (email). Anything else is an arbitrary-blob fetch
      // primitive across the workspace — reject it.
      const attachments = Array.isArray(doc.data?.attachments) ? doc.data.attachments : [];
      let attachment = null;
      if (request.query.url) {
        const ownUrls = new Set((doc.locations || []).map((l) => l?.url).filter(Boolean));
        attachment = attachments.find((a) => a?.url === request.query.url) || null;
        if (!ownUrls.has(request.query.url) && !attachment) {
          const r = new ResponseObject().forbidden('URL does not belong to this document');
          return reply.code(r.statusCode).send(r.getResponse());
        }
      }

      // Attachment bytes carry their own contentType/size/filename — the doc's
      // metadata describes the primary content (e.g. the raw .eml), not them.
      const size = attachment ? attachment.size : doc.metadata?.size;
      const total = Number.isFinite(size) ? Number(size) : null;

      // Range only for whole-document bytes with a known size; attachments are
      // served whole (their resolver doesn't window).
      const rangeable = !attachment && total != null;
      if (rangeable) reply.header('Accept-Ranges', 'bytes');

      const parsed = (rangeable && request.headers.range)
        ? parseByteRange(request.headers.range, total)
        : null;
      if (parsed === 'unsatisfiable') {
        reply.header('Content-Range', `bytes */${total}`);
        return reply.code(416).send();
      }

      const resolved = await workspace.resolveDocument(doc, { stream: true, url: request.query.url, range: parsed || undefined });
      if (!resolved) { const r = new ResponseObject().notFound('No reachable location'); return reply.code(r.statusCode).send(r.getResponse()); }

      const filename = attachment?.filename || locationFilename(resolved.url) || `document-${documentId}`;
      const mime = resolveContentType(attachment ? attachment.contentType : doc.metadata?.contentType, filename);
      reply.header('Content-Type', mime);
      if (request.query.download !== undefined) {
        reply.header('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
      }

      // Only answer 206 when the resolver actually served the window — a backend
      // that can't range falls back to a full 200 (no length mismatch).
      if (parsed && resolved.ranged) {
        reply.code(206);
        reply.header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${total}`);
        reply.header('Content-Length', parsed.end - parsed.start + 1);
      } else if (total != null) {
        reply.header('Content-Length', total);
      }
      return reply.send(resolved.stream || resolved.buffer);
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError('Failed to read document content');
      return reply.code(r.statusCode).send(r.getResponse());
    }
  });

  // ── Document thumbnail (on-demand, cached in the stored cache) ──────────────

  fastify.get('/:docId/thumbnail', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'string' } } },
      querystring: { type: 'object', properties: { size: { type: 'integer', minimum: 16, maximum: 2048, default: 256 } } },
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

      // Content-addressed ETag. The URL is keyed by doc id and ids are GC'd and
      // REUSED, so a plain max-age would let a browser serve the previous
      // document's thumbnail for a recycled id. no-cache forces revalidation —
      // a match is a cheap 304 (one LMDB doc read, no sharp/cacache touch).
      const checksum = Array.isArray(doc.checksumArray) ? doc.checksumArray[0] : null;
      const etag = checksum ? `"${checksum}:${request.query.size}"` : null;
      reply.header('Cache-Control', 'private, no-cache');
      if (etag) {
        reply.header('ETag', etag);
        if (request.headers['if-none-match'] === etag) { return reply.code(304).send(); }
      }

      const thumb = await workspace.getDocumentThumbnail(doc, request.query.size);
      if (!thumb) { const r = new ResponseObject().notFound('No thumbnail available for this document'); return reply.code(r.statusCode).send(r.getResponse()); }

      reply.header('Content-Type', thumb.mime);
      reply.header('Content-Length', thumb.buffer.length);
      return reply.send(thumb.buffer);
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError('Failed to build document thumbnail');
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

  // ── Document tree memberships (Synapses tab) ────────────────────────────
  // Which paths of which trees hold this document. `?tree=<nameOrId>` scopes to
  // one tree; default reports every tree in the workspace.

  fastify.get('/:docId/memberships', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'string' } } },
      querystring: { type: 'object', properties: { tree: { type: 'string' } } },
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

      const trees = request.query.tree
        ? [workspace.getTree(request.query.tree)]
        : await workspace.listTrees();
      const memberships = [];
      for (const tree of trees) {
        if (!tree) continue;
        const paths = await workspace.listDocumentTreeMemberships(documentId, tree.id).catch(() => []);
        memberships.push({ tree: tree.name, treeId: tree.id, type: tree.type, paths });
      }

      const r = new ResponseObject().found({ documentId, memberships }, 'Document tree memberships retrieved');
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError('Failed to list document tree memberships');
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
