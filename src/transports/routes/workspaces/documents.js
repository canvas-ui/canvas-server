'use strict';

import ResponseObject from '../../ResponseObject.js';
import { parseDocumentId, parseDocumentIdArray } from '../../../utils/documentId.js';
import { stripDeviceFeatureTags } from '../../../utils/device-features.js';
import { parseByteRange } from '../../lib/http-range.js';
import { resolveContentType } from '../../lib/mime.js';
import { normalizeSchemaId } from '../../../core/workspace/lib/classifier.js';
import { PREDICATES } from 'canvas-synapsd/src/indexes/edges/predicates.js';
import { localDocumentIds, PLACEMENT_BUDGET, stampPlacement, treeOf } from '../../lib/placement.js';

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
export default async function workspaceDocumentRoutes(fastify, _options) {
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
            void isBackends;
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

  // Graph-adjacency constraint, one hop from a known document. Repeatable
  // (?rel=mentions:12&rel=!replies-to:34), same sigil trio as features:
  //
  //   mentions:12        anyOf  — documents 12 mentions
  //   +mentions:12       allOf
  //   !mentions:12       noneOf
  //   mentions:12:in     the incoming axis — documents that mention 12
  //
  // DIRECTION IS AN AXIS, never a predicate name (synapsd indexes/edges/
  // predicates.js) — hence the trailing `:in`/`:out` rather than an inverse
  // spelling. Shape errors throw here so a malformed token is a 400, not a
  // silently-wider result set.
  const relQueryProps = {
    rel: { type: 'array', items: { type: 'string' }, default: [] },
  };

  const REL_SIGILS = { '+': 'allOf', '!': 'noneOf' };

  function parseRelTokens(tokens = []) {
    const parsed = [];
    for (const raw of tokens) {
      const token = String(raw).trim();
      if (!token) continue;
      const op = REL_SIGILS[token[0]] || 'anyOf';
      const body = REL_SIGILS[token[0]] ? token.slice(1) : token;
      const [p, of, dir = 'out'] = body.split(':');
      if (!p || !of) {
        throw new Error(`rel token "${token}" must be "<predicate>:<documentId>[:in|:out]"`);
      }
      // Checked here so an unknown (or inverse-style) predicate is a 400 rather
      // than a 500 thrown from deep inside the query resolver.
      if (!Object.hasOwn(PREDICATES, p)) {
        throw new Error(`rel token "${token}" uses an unknown predicate. Allowed: ${Object.keys(PREDICATES).join(', ')}`);
      }
      if (dir !== 'in' && dir !== 'out') {
        throw new Error(`rel token "${token}" direction must be 'in' or 'out'`);
      }
      parsed.push({ op, p, of: parseDocumentId(of, `rel token "${token}" document id`), dir });
    }
    return parsed;
  }

  // ── Inline relation grammar in q ──────────────────────────────────────────
  // `@<predicate>:<value>[:in|:out]` inside a text query, negated with a
  // leading `!`. The value is a document id (`42` / `#42`) or an identity
  // name (`jane`, `"Jane Doe"` — quoted for spaces), resolved against
  // data/schema/identity documents by FTS; several matches union into ONE
  // rel operand (multi-id `of`), AND-ed with the rest of the query.
  //
  // DEFAULT DIRECTION IS THE SUBJECT READING: `@authored-by:jane` means
  // "documents that declare authored-by → jane", which on the engine axis is
  // `in` (scan jane's incoming edges). Every predicate reads naturally this
  // way (document-as-subject convention, indexes/edges/predicates.js) — the
  // raw `?rel=` parameter's anchor-outward default is id-plumbing for the
  // object card, not a grammar for humans. Append `:out` for the mirror
  // ("documents jane points at"). Unknown predicates are NOT stripped — the
  // token stays ordinary search text, so an email address or handle in a
  // query never 400s.
  const INLINE_REL_RE = /(^|\s)(!?)@([a-z][a-z-]*):("[^"]*"|[^\s"]+?)(:(in|out))?(?=\s|$)/g;

  function parseInlineRelQuery(query) {
    const tokens = [];
    const text = String(query).replace(INLINE_REL_RE, (match, lead, bang, p, value, _dirGroup, dir) => {
      if (!Object.hasOwn(PREDICATES, p)) { return match; }
      if (value.startsWith('"')) { value = value.slice(1, -1); }
      if (!value) { return lead; }
      tokens.push({ negated: bang === '!', p, value, dir: dir === 'out' ? 'out' : 'in' });
      return lead;
    }).trim();
    return { text, tokens };
  }

  // A token value → anchor document ids. Numeric (with optional `#`) is used
  // as-is; anything else resolves by FTS over identity documents, whole
  // workspace (an identity is rarely filed in the current context).
  async function resolveRelAnchors(workspace, value) {
    const bare = value.startsWith('#') ? value.slice(1) : value;
    if (/^\d+$/.test(bare)) { return [parseInt(bare, 10)]; }
    const matches = await workspace.search({
      query: value,
      mode: 'fts',
      context: null,
      directory: null,
      attributes: { allOf: ['data/schema/identity'] },
      idsOnly: true,
      limit: 8,
      applyCanvasQuerySpec: false,
    });
    return Array.isArray(matches) ? matches.filter((id) => Number.isInteger(id)) : [];
  }

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
          ...relQueryProps,
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
          // How many raw image distances to attach when debug is on. The top-25
          // neighbours of any query cluster tightly, so calibrating a relevance
          // floor needs a deeper window than the default.
          debugLimit: { type: 'integer', minimum: 1, maximum: 500 },
          // 'workspace' drops the path bucket entirely → list every document in
          // the DB (synapsd default). 'path' (default) scopes to context/tree.
          scope: { type: 'string', enum: ['path', 'workspace'], default: 'path' },
          // Literal id-set constraint (may repeat: ?ids=1&ids=2) — ANDs into the
          // structured scope. The external-producer seam: a lens/camera refine
          // sends its kNN survivors here. NO default — [] means "match nothing"
          // in synapsd, so absent must stay absent.
          ids: { type: 'array', items: { type: 'integer', minimum: 1 } },
          // Return document ids instead of documents — the cheap read a client
          // uses to check whether a cached result set is still current.
          idsOnly: { type: 'boolean', default: false },
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
      if (!workspace) return reply;

      // Whole-workspace scope = no path selector. Backend mirrors live in their
      // own tree (linkContextRoot:false), so root/context queries never see
      // them unless a user filed them somewhere.
      const { context: ctxSelector, directory: dirSelector } = request.query.scope === 'workspace'
        ? { context: null, directory: null }
        : resolveScopeSelectors(workspace, request.query, '/');

      // Collect the (possibly stacked) text queries. `q` may be a string or an
      // array (repeated param); `search` is a legacy single alias.
      const rawQ = request.query.q;
      const rawQueries = (Array.isArray(rawQ) ? rawQ : (rawQ ? [rawQ] : []))
        .concat(request.query.search ? [request.query.search] : [])
        .filter((s) => typeof s === 'string' && s.trim().length > 0);

      // A malformed rel token is a caller bug, like an unknown filter — 400 it
      // instead of letting the generic catch report a 500.
      let relFilters;
      try { relFilters = parseRelTokens(request.query.rel); }
      catch (e) { const r = new ResponseObject().badRequest(e.message); return reply.code(r.statusCode).send(r.getResponse()); }

      // Inline `@predicate:value` tokens: strip them from the text, resolve
      // values to anchor ids, fold into the rel filters. A POSITIVE token that
      // resolves to no identity short-circuits to an empty result — running
      // without the constraint would silently widen. A NEGATED one that
      // resolves to nothing excludes nothing, so it is simply dropped.
      const queries = [];
      for (const q of rawQueries) {
        const { text, tokens } = parseInlineRelQuery(q);
        if (text) { queries.push(text); }
        for (const token of tokens) {
          const anchors = await resolveRelAnchors(workspace, token.value);
          if (anchors.length === 0) {
            if (token.negated) { continue; }
            const r = new ResponseObject().found([], `No identity matched "${token.value}" for @${token.p}`, 200, 0, 0);
            return reply.code(r.statusCode).send(r.getResponse());
          }
          relFilters.push({ op: token.negated ? 'noneOf' : 'allOf', p: token.p, of: anchors, dir: token.dir });
        }
      }
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
        ...(relFilters.length ? { rel: relFilters } : {}),
        ...(request.query.ids?.length ? { ids: request.query.ids } : {}),
        limit: request.query.limit,
        offset: request.query.offset,
        page: request.query.page,
        order: request.query.order,
        sortBy: request.query.sortBy,
        idsOnly: request.query.idsOnly,
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
          debugLimit: request.query.debugLimit,
        });
      } else if (queries.length === 1) {
        documents = await workspace.search({ query: queries[0], mode: request.query.mode, minDistance, maxDistance, debug: request.query.debug, debugLimit: request.query.debugLimit, ...spec });
      } else {
        documents = await workspace.list(spec);
      }

      if (documents.error) {
        fastify.log.error(`SynapsD error: ${documents.error}`);
        const responseObject = new ResponseObject().error(`Failed to ${isSearch ? 'search' : 'list'} documents due to a database error.`, documents.error);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Which of these are FILED at the listed path, as opposed to showing
      // through from below it (a context path lists its whole subtree). A
      // client rendering documents as files needs it to decide which of two
      // same-named documents is "the" one here — see transports/lib/placement.
      const payload = (isSearch || request.query.idsOnly || !ctxSelector)
        ? documents
        : stampPlacement(documents, await localDocumentIds(
          (not) => workspace.list({ ...spec, paths: { not }, idsOnly: true, limit: PLACEMENT_BUDGET, offset: 0, page: undefined }),
          treeOf(workspace, ctxSelector),
          ctxSelector.path,
        ));

      const responseObject = new ResponseObject().found(payload, isSearch ? 'Search results retrieved successfully' : 'Documents retrieved successfully', 200, documents.count, documents.totalCount);
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
          // Literal id-set constraint (see GET /). ANDed into the shared scope.
          ids: { type: 'array', items: { type: 'integer', minimum: 1 } },
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
      if (!workspace) return reply;

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
        ...(body.ids?.length ? { ids: body.ids } : {}),
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

  // ── Search by image ──────────────────────────────────────────────────────
  // kNN over the joint image space. Two query sources: `image` (base64 or data
  // URI — an EPHEMERAL query image: camera frame, upload; embedded via inferd,
  // never stored or indexed) or `similarTo` (an indexed document id — its
  // stored vector is reused, no bytes on the wire). Composes with the usual
  // structured scope, so a 2 FPS camera loop arrives pre-filtered by the
  // active context path. Results are best-first in kNN order; `debug` attaches
  // per-hit cosine distances for floor calibration.

  const IMAGE_QUERY_MAX_BYTES = 32 * 1024 * 1024; // decoded; matches bodyLimit ballpark

  fastify.post('/search/image', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image: { type: 'string' },        // base64 or data:image/...;base64,
          contentType: { type: 'string' },
          similarTo: { type: 'integer', minimum: 1 },
          // Optional text: switches to fused mode — the image becomes a vector
          // leg RRF-merged with the full text pipeline, so notes surface too.
          q: { type: 'string' },
          ...contextQueryProps,
          ...attributesQueryProps,
          ...filtersQueryProps,
          limit: { type: 'integer', default: 25 },
          offset: { type: 'integer' },
          minDistance: { type: 'number' },
          maxDistance: { type: 'number' },
          debug: { type: 'boolean', default: false },
          idsOnly: { type: 'boolean', default: false },
          scope: { type: 'string', enum: ['path', 'workspace'], default: 'workspace' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      const body = request.body;
      if (!body.image && !body.similarTo) {
        const responseObject = new ResponseObject().badRequest('Image search requires `image` (base64) or `similarTo` (document id)');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      let imageBytes = null;
      let contentType = body.contentType || null;
      if (body.image) {
        let b64 = body.image;
        const dataUri = b64.match(/^data:([^;,]+);base64,(.*)$/s);
        if (dataUri) { contentType = contentType || dataUri[1]; b64 = dataUri[2]; }
        try { imageBytes = Buffer.from(b64, 'base64'); } catch { imageBytes = null; }
        if (!imageBytes || imageBytes.length === 0) {
          const responseObject = new ResponseObject().badRequest('`image` is not valid base64');
          return reply.code(responseObject.statusCode).send(responseObject.getResponse());
        }
        if (imageBytes.length > IMAGE_QUERY_MAX_BYTES) {
          const responseObject = new ResponseObject().badRequest(`query image exceeds ${IMAGE_QUERY_MAX_BYTES} bytes`);
          return reply.code(responseObject.statusCode).send(responseObject.getResponse());
        }
      }

      // Default scope is the whole workspace: photos usually live in backend
      // mirrors, not under the current context path. 'path' opts back in.
      const { context: ctxSelector, directory: dirSelector } = body.scope === 'workspace'
        ? { context: null, directory: null }
        : resolveScopeSelectors(workspace, body, '/');

      const documents = await workspace.searchByImage({
        imageBytes,
        contentType,
        similarTo: body.similarTo ?? null,
        text: body.q ?? null,
        spec: {
          context: ctxSelector,
          directory: dirSelector ? { ...dirSelector, recursive: true } : dirSelector,
          attributes: buildAttributes(body),
          filters: body.filters,
        },
        limit: body.limit,
        offset: body.offset,
        minDistance: body.minDistance,
        maxDistance: body.maxDistance,
        debug: body.debug,
        idsOnly: body.idsOnly,
      });

      if (documents.error) {
        fastify.log.error(`SynapsD error: ${documents.error}`);
        const responseObject = new ResponseObject().error('Failed to search by image.', documents.error);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(documents, 'Image search results retrieved successfully', 200, documents.count, documents.totalCount);
      if (documents.debug) { responseObject.debug = documents.debug; }
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to search by image');
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
      if (!workspace) return reply;

      const isTopLevelArray = Array.isArray(request.body);
      const { treeType: insertTreeType, selector: insertSelector } = resolveInsertTarget(workspace, request.body, isTopLevelArray);
      if (insertTreeType === 'directory' && rejectBackendsWrite(reply, workspace, insertSelector)) return reply;
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
      if (!workspace) return reply;
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
      if (!workspace) return reply;
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
      if (!workspace) return reply;

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
      if (updateTreeType === 'directory' && rejectBackendsWrite(reply, workspace, updateSelector)) return reply;
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
      if (!workspace) return reply;
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
      if (!workspace) return reply;
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
      if (!workspace) return reply;
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

  // ── Backend transfer (copy / move / delete-from-backend) ────────────────
  //
  // Batch counterpart of the per-object backends route: addressed by document
  // id, because that is what a UI selection holds. Each document's own source
  // location is resolved server-side, so external mounts (device file:// URLs)
  // work without the client knowing the address grammar.
  //
  // Body: { documentIds: number[], to: string[], mode?: 'copy'|'move'|'delete',
  //         keepDocument?: boolean }
  //   copy   → each document gains a location on every target backend
  //   move   → exactly one target; source released only once the copy is durable
  //   delete → bytes removed from the target backends only (other copies stay)
  //
  // Per-document outcomes: one document already living on the target must not
  // fail the rest of the batch, so the response carries successful[] + failed[].
  fastify.post('/transfer', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['documentIds', 'to'],
        properties: {
          documentIds: {
            type: 'array',
            items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            minItems: 1,
          },
          to: { type: 'array', items: { type: 'string' }, minItems: 1 },
          mode: { type: 'string', enum: ['copy', 'move', 'delete'], default: 'copy' },
          keepDocument: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      const { documentIds: rawIds, to, mode = 'copy', keepDocument = false } = request.body;
      let documentIds;
      try {
        documentIds = parseDocumentIdArray(rawIds, 'Document ID array');
      } catch (e) {
        const r = new ResponseObject().badRequest(e.message);
        return reply.code(r.statusCode).send(r.getResponse());
      }

      let results;
      try {
        results = await workspace.transferDocumentsToBackends(documentIds, { to, mode, keepDocument });
      } catch (e) {
        // Request-level refusals (unknown/read-only backend, multi-target move)
        // are the caller's mistake, not a server fault.
        const r = new ResponseObject().badRequest(e.message);
        return reply.code(r.statusCode).send(r.getResponse());
      }

      const verb = mode === 'delete' ? 'Deleted from backend' : `${mode === 'move' ? 'Moved' : 'Copied'} to backend`;
      const r = new ResponseObject().success(results, `${verb}: ${results.successful.length} document(s)`);
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError('Failed to transfer documents');
      return reply.code(r.statusCode).send(r.getResponse());
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
      if (!workspace) return reply;

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
      if (!workspace) return reply;

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
    if (!workspace) return reply;
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
      if (!workspace) return reply;

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

      // Content-addressed ETag for whole-document bytes (same reasoning as the
      // thumbnail route: ids are recycled, so no-cache + revalidate). Remote
      // workspace forwarders and browsers both revalidate against it.
      const checksum = !attachment && Array.isArray(doc.checksumArray) ? doc.checksumArray[0] : null;
      const etag = checksum ? `"${checksum}"` : null;
      if (etag && !parsed && request.headers['if-none-match'] === etag) {
        reply.header('ETag', etag);
        return reply.code(304).send();
      }

      const resolved = await workspace.resolveDocument(doc, { stream: true, url: request.query.url, range: parsed || undefined });
      if (!resolved) { const r = new ResponseObject().notFound('No reachable location'); return reply.code(r.statusCode).send(r.getResponse()); }
      if (etag) {
        reply.header('ETag', etag);
        reply.header('Cache-Control', 'private, no-cache');
      }

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
      if (!workspace) return reply;

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
      if (!workspace) return reply;

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
      if (!workspace) return reply;

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

  // ── Document relations (typed doc<->doc edges) ──────────────────────────
  // The synapsd edge plane, surfaced for the object card's Synapses tab and the
  // "Link to…" relation picker. Direction is an AXIS, not a predicate name:
  // `outgoing` is this document as subject, `incoming` is it as object.

  const RELATION_PREDICATES = Object.keys(PREDICATES);

  // Body shared by POST/DELETE: which edge, and on which axis.
  const relationBodySchema = {
    type: 'object',
    required: ['p', 'to'],
    properties: {
      p: { type: 'string', enum: RELATION_PREDICATES },
      to: {
        anyOf: [
          { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer' }] }, minItems: 1 },
          { type: 'string' },
          { type: 'integer' },
        ],
      },
      // 'out' (default): :docId --p--> to. 'in': to --p--> :docId.
      dir: { type: 'string', enum: ['in', 'out'], default: 'out' },
    },
  };

  // Resolve the far side of each edge to a document, so a client can render a
  // relation list without an N+1 round trip. Capped: a hub document can have
  // thousands of incoming edges and this is a detail-panel read.
  const RELATION_RESOLVE_CAP = 200;

  async function resolveRelationTargets(workspace, entries, key) {
    const resolved = [];
    for (const entry of entries.slice(0, RELATION_RESOLVE_CAP)) {
      const otherId = entry[key];
      const document = await workspace.get(otherId).catch(() => null);
      resolved.push({ ...entry, document: document ?? null });
    }
    // Beyond the cap the edge is still reported, just without its document.
    for (const entry of entries.slice(RELATION_RESOLVE_CAP)) {
      resolved.push({ ...entry, document: null });
    }
    return resolved;
  }

  fastify.get('/:docId/relations', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          // Skip the per-edge document read when the caller only wants the shape
          // of the graph (ids + predicates).
          resolve: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      let documentId;
      try { documentId = parseDocumentId(request.params.docId, 'Document ID parameter'); }
      catch (e) { const r = new ResponseObject().badRequest(e.message); return reply.code(r.statusCode).send(r.getResponse()); }

      const doc = await workspace.get(documentId);
      if (!doc) { const r = new ResponseObject().notFound('Document not found'); return reply.code(r.statusCode).send(r.getResponse()); }

      const { outgoing, incoming } = workspace.listDocumentRelations(documentId);
      const payload = {
        documentId,
        predicates: RELATION_PREDICATES,
        outgoing: request.query.resolve === false ? outgoing : await resolveRelationTargets(workspace, outgoing, 'to'),
        incoming: request.query.resolve === false ? incoming : await resolveRelationTargets(workspace, incoming, 'from'),
      };

      const r = new ResponseObject().found(payload, 'Document relations retrieved');
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError('Failed to list document relations');
      return reply.code(r.statusCode).send(r.getResponse());
    }
  });

  fastify.post('/:docId/relations', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'string' } } },
      body: relationBodySchema,
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      let documentId; let targets;
      try {
        documentId = parseDocumentId(request.params.docId, 'Document ID parameter');
        targets = parseDocumentIdArray(request.body.to, 'Relation target document ID');
      } catch (e) { const r = new ResponseObject().badRequest(e.message); return reply.code(r.statusCode).send(r.getResponse()); }

      const doc = await workspace.get(documentId);
      if (!doc) { const r = new ResponseObject().notFound('Document not found'); return reply.code(r.statusCode).send(r.getResponse()); }

      // A relation to a document that does not exist would be invisible anyway
      // (query-time candidate intersection drops it), so reject it up front
      // rather than storing a promise the graph cannot keep.
      const missing = [];
      for (const target of targets) {
        if (!(await workspace.get(target).catch(() => null))) missing.push(target);
      }
      if (missing.length) {
        const r = new ResponseObject().badRequest(`Relation target document(s) not found: ${missing.join(', ')}`);
        return reply.code(r.statusCode).send(r.getResponse());
      }

      // Write-through: the relation lands in the SUBJECT document's own
      // data.relations (for dir:'in' the subject is the far side), and synapsd
      // derives the edge from the row — so an L3 rebuild reconstructs it.
      const incoming = request.body.dir === 'in';
      for (const target of targets) {
        if (incoming) await workspace.assertRelation(target, request.body.p, documentId);
        else await workspace.assertRelation(documentId, request.body.p, target);
      }

      const r = new ResponseObject().success({ documentId, p: request.body.p, to: targets, dir: incoming ? 'in' : 'out' }, 'Relations created');
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      // Predicate errors from synapsd are caller mistakes, not server faults.
      const message = String(error?.message || '');
      const r = /predicate/i.test(message)
        ? new ResponseObject().badRequest(message)
        : new ResponseObject().serverError('Failed to create document relations');
      return reply.code(r.statusCode).send(r.getResponse());
    }
  });

  fastify.delete('/:docId/relations', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'string' } } },
      body: relationBodySchema,
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      let documentId; let targets;
      try {
        documentId = parseDocumentId(request.params.docId, 'Document ID parameter');
        targets = parseDocumentIdArray(request.body.to, 'Relation target document ID');
      } catch (e) { const r = new ResponseObject().badRequest(e.message); return reply.code(r.statusCode).send(r.getResponse()); }

      // No existence check on the far side here: retracting a relation whose
      // TARGET was deleted must keep working (the subject row still declares
      // it). A deleted SUBJECT returns false — its edges died with it.
      const incoming = request.body.dir === 'in';
      let removed = 0;
      for (const target of targets) {
        const ok = incoming
          ? await workspace.retractRelation(target, request.body.p, documentId)
          : await workspace.retractRelation(documentId, request.body.p, target);
        if (ok) removed += 1;
      }

      const r = new ResponseObject().success({ documentId, p: request.body.p, to: targets, dir: incoming ? 'in' : 'out', removed }, 'Relations removed');
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const message = String(error?.message || '');
      const r = /predicate/i.test(message)
        ? new ResponseObject().badRequest(message)
        : new ResponseObject().serverError('Failed to remove document relations');
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
      if (!workspace) return reply;
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
      if (!workspace) return reply;

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
