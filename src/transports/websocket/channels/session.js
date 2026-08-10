'use strict';

import crypto from 'crypto';
import { createLogger } from '../../../utils/log.js';

const logger = createLogger('canvas-server:websocket:session');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A session pins operand bitmaps and a db subscription per connection, so the
// count is capped rather than left to the client.
const MAX_SESSIONS_PER_SOCKET = 8;
// Cues are cheap, but an unbounded list is a trivially remote-triggered
// resolve loop.
const MAX_CUES_PER_SESSION = 32;

const ALLOWED_OPTS = ['mode', 'emit', 'combinator', 'debounceMs', 'limit', 'offset'];

// Decoded bytes of an ephemeral query image (a camera frame). Matches the REST
// image-search route's ceiling.
const IMAGE_QUERY_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Query-session RPC over the existing socket.io transport.
 *
 * This is the ONE place canvas-server does request/response over the socket —
 * every other channel is push-only fan-out. It exists because a session is
 * connection-scoped mutable state: a stateless REST call cannot hold the
 * resolved operand bitmaps that make refinement cheap, and the whole point of
 * the container is that the candidate set outlives a single question.
 *
 * Client → server (all take a socket.io ack callback):
 *   session.open        { workspace, specs[], opts }   -> { sessionId, ids, count }
 *   session.set         { sessionId, label, spec }     -> { label, ids, count }
 *   session.patch       { sessionId, label, spec }     -> { label, ids, count }
 *   session.remove      { sessionId, label }           -> { label, ids, count }
 *   session.ids         { sessionId }                  -> { ids, count }
 *   session.materialize { sessionId, match, ...page }  -> { documents, ids, count, totalCount }
 *   session.close       { sessionId }                  -> { sessionId }
 *
 * Server → client:
 *   session.delta  { sessionId, ...QuerySession change payload }
 *
 * TWO STAGES, and most real queries use both:
 *
 *  1. Cues (session.open/set/patch/remove) are the CANDIDATE SET — bitmap
 *     algebra over paths, features, filters (incl. geo:near from a GPS fix) and
 *     literal id-sets (a camera frame's kNN survivors). Cached, AND-ed,
 *     precisely invalidated; this is what deltas are about, and count() answers
 *     "is there anything" without loading a single document.
 *  2. `match` (session.materialize) is the RANKING — free text, an image, or
 *     both fused — evaluated over the already-narrow candidate set. Relevance
 *     is a score, not a membership predicate: it has no bitmap key, so it
 *     cannot be invalidated and must not live in a cue. Keeping it here is what
 *     makes refinement cheap — the text pipeline runs once per READ, not once
 *     per camera frame.
 *
 * To NARROW by text rather than merely rank by it, materialize with the match,
 * then feed the resulting ids back as a cue (`session.set('text', { ids })`) —
 * the same id-set seam the lens uses. That is also the shape canvas-inferd
 * plugs into: it patches cues server-side and the client contract is unchanged.
 *
 * Delta materialization stays PULL: a delta carries ids only and the client
 * hydrates `added` through `GET /documents?ids=…`, so only genuinely new
 * documents are ever fetched.
 */
export default function registerSessionWebSocket(fastify, socket) {
  const { workspaceManager } = fastify;
  if (!workspaceManager) {
    logger.debug('⚠️  workspaceManager not present on fastify – skipping session WS setup');
    return;
  }

  const { user } = socket;
  // sessionId -> { session, workspace }
  const sessions = new Map();

  const ok = (ack, payload) => { if (typeof ack === 'function') ack({ status: 'success', payload }); };
  const fail = (ack, message, code = 'SESSION_ERROR') => {
    if (typeof ack === 'function') ack({ status: 'error', code, message });
  };

  // Resolve + authorize a workspace reference (id or name) for this socket.
  const resolveWorkspace = async (ref) => {
    if (!ref || typeof ref !== 'string') { throw new Error('workspace reference required'); }

    // Share-token sockets are clamped to their one workspace (same rule the
    // subscribe handler applies), and need read permission to open a view.
    const binding = socket.workspaceBinding;
    if (binding) {
      if (ref !== binding.workspaceId && ref !== binding.workspaceName) {
        throw new Error('Workspace token is not bound to this workspace');
      }
      if (!binding.permissions?.includes('read')) { throw new Error('Workspace token lacks read permission'); }
    }

    const workspaceId = UUID_RE.test(ref) ? ref : workspaceManager.resolveWorkspaceId(user.id, ref);
    if (!workspaceId) { throw new Error(`Workspace not found: ${ref}`); }
    const workspace = await workspaceManager.getWorkspaceOrThrow(workspaceId, user.id);
    if (!workspace) { throw new Error(`Workspace not found: ${ref}`); }
    return workspace;
  };

  const entryOrThrow = (sessionId) => {
    const entry = sessions.get(sessionId);
    if (!entry) { throw new Error(`No such session: ${sessionId}`); }
    return entry;
  };

  // Every mutating RPC answers with the session's current state, so a client
  // that mutates and a client that only listens converge on the same view
  // without an extra round trip.
  const stateOf = async (session) => ({ ids: session.ids(), count: await session.count() });

  const closeSession = (sessionId) => {
    const entry = sessions.get(sessionId);
    if (!entry) { return false; }
    sessions.delete(sessionId);
    try { entry.session.close(); } catch (err) { logger.debug(`Error closing session ${sessionId}: ${err.message}`); }
    return true;
  };

  socket.on('session.open', async (data = {}, ack) => {
    try {
      if (sessions.size >= MAX_SESSIONS_PER_SOCKET) {
        return fail(ack, `Session limit reached (${MAX_SESSIONS_PER_SOCKET} per connection)`, 'SESSION_LIMIT');
      }

      const workspace = await resolveWorkspace(data.workspace);
      const specs = Array.isArray(data.specs) ? data.specs : (data.specs ? [data.specs] : []);
      if (specs.length > MAX_CUES_PER_SESSION) {
        return fail(ack, `Too many cues (max ${MAX_CUES_PER_SESSION})`, 'SESSION_LIMIT');
      }

      // A client asking for a streaming transport wants a live view: relative
      // timeframes slide and coarse cues re-resolve. Frozen stays available
      // (agent working memory) but is not the default HERE, unlike in synapsd.
      const opts = pickOpts(data.opts);
      if (!opts.mode) { opts.mode = 'live'; }

      for (const entry of specs) { assertNoText(entry && typeof entry === 'object' && 'spec' in entry ? entry.spec : entry); }

      const session = await workspace.openSession(specs, opts);
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { session, workspace });

      session.on('change', (payload) => {
        // The session outliving its socket would be a leak; disconnect clears
        // the registry, but a change already in flight can still land here.
        if (!sessions.has(sessionId)) { return; }
        socket.emit('session.delta', { sessionId, workspaceId: workspace.id, ...payload });
      });

      logger.debug(`🔎 Opened session ${sessionId} on workspace ${workspace.id} for ${user.email}`);
      ok(ack, { sessionId, workspaceId: workspace.id, ...(await stateOf(session)) });
    } catch (err) {
      logger.debug(`❌ session.open failed for ${socket.id}: ${err.message}`);
      fail(ack, err.message, err.code);
    }
  });

  // set() vs patch(): set REPLACES a cue's spec and is the streaming verb (a
  // lens re-emitting its id-set every frame); patch() merges buckets and is the
  // interactive-refinement verb ("car" → add "red").
  for (const verb of ['set', 'patch']) {
    socket.on(`session.${verb}`, async (data = {}, ack) => {
      try {
        const { session } = entryOrThrow(data.sessionId);
        const label = data.label;
        if (!label) { throw new Error('label required'); }
        assertNoText(data.spec);
        if (verb === 'set' && session.size >= MAX_CUES_PER_SESSION && !session.labels().includes(String(label))) {
          return fail(ack, `Too many cues (max ${MAX_CUES_PER_SESSION})`, 'SESSION_LIMIT');
        }
        await session[verb](label, data.spec ?? {});
        ok(ack, { label, ...(await stateOf(session)) });
      } catch (err) {
        logger.debug(`❌ session.${verb} failed for ${socket.id}: ${err.message}`);
        fail(ack, err.message, err.code);
      }
    });
  }

  socket.on('session.remove', async (data = {}, ack) => {
    try {
      const { session } = entryOrThrow(data.sessionId);
      if (!data.label) { throw new Error('label required'); }
      await session.remove(data.label);
      ok(ack, { label: data.label, ...(await stateOf(session)) });
    } catch (err) {
      logger.debug(`❌ session.remove failed for ${socket.id}: ${err.message}`);
      fail(ack, err.message, err.code);
    }
  });

  // Resync after a missed delta (tab wake, dropped frame) without reopening.
  socket.on('session.ids', async (data = {}, ack) => {
    try {
      const { session } = entryOrThrow(data.sessionId);
      ok(ack, await stateOf(session));
    } catch (err) {
      fail(ack, err.message, err.code);
    }
  });

  /**
   * The "show me" step: rank the candidate set and hydrate one page.
   *
   * `match` is { text?, image?, similarTo?, minDistance?, maxDistance? }.
   * Omit it entirely and this is a plain bitmap slice — no Lance, no embedding,
   * the cheap path. Supply text and/or an image and the two fuse (RRF) over the
   * SAME candidate set the cues already narrowed.
   */
  socket.on('session.materialize', async (data = {}, ack) => {
    try {
      const { session, workspace } = entryOrThrow(data.sessionId);
      const match = await buildMatch(workspace, data.match);
      const page = await session.materialize(match, {
        limit: data.limit,
        offset: data.offset,
        ...(data.mode ? { mode: data.mode } : {}),
      });
      // `page` is an array carrying count/totalCount/error — spread it into a
      // plain payload so the ack survives JSON serialization intact.
      if (page?.error) { return fail(ack, page.error, 'SESSION_RANK_ERROR'); }
      const documents = [...(page || [])];
      ok(ack, {
        documents,
        ids: documents.map((doc) => doc?.id).filter((id) => id != null),
        count: page?.count ?? documents.length,
        totalCount: page?.totalCount ?? documents.length,
      });
    } catch (err) {
      logger.debug(`❌ session.materialize failed for ${socket.id}: ${err.message}`);
      fail(ack, err.message, err.code);
    }
  });

  socket.on('session.close', (data = {}, ack) => {
    const sessionId = data.sessionId;
    const closed = closeSession(sessionId);
    logger.debug(`🔎 session.close ${sessionId} (${closed ? 'closed' : 'unknown'})`);
    ok(ack, { sessionId, closed });
  });

  // Sessions are connection-scoped: no grace TTL in round 1. serialize() makes
  // park/rehydrate cheap if reconnect-with-state is ever wanted (PWA), but a
  // parked session needs a resume handshake the client does not have yet — and
  // holding operands for a socket that may never return is a pure leak.
  socket.on('disconnect', () => {
    if (sessions.size === 0) { return; }
    logger.debug(`🔎 Closing ${sessions.size} session(s) for disconnected socket ${socket.id}`);
    for (const sessionId of [...sessions.keys()]) { closeSession(sessionId); }
  });
}

/**
 * Cues are the candidate-set stage and carry no text. Rejecting loudly beats
 * dropping silently: a client that puts its search box into a cue would
 * otherwise see the term quietly do nothing.
 */
function assertNoText(spec) {
  if (!spec || typeof spec !== 'object') { return; }
  for (const key of ['query', 'search', 'q']) {
    if (spec[key] !== undefined && spec[key] !== null && spec[key] !== '') {
      throw new Error(`Cue specs carry no text (got '${key}'). Rank with session.materialize({ match: { text } }), and feed its ids back as a cue to narrow.`);
    }
  }
}

/** Decode the wire match ({ text, image, similarTo }) into a synapsd descriptor. */
async function buildMatch(workspace, match) {
  if (!match || typeof match !== 'object') {
    return typeof match === 'string' && match.trim() ? match.trim() : null;
  }

  let imageBytes = null;
  let contentType = match.contentType || null;
  if (match.image) {
    // Accepts raw base64 or a data: URI, exactly like the REST image search.
    let b64 = String(match.image);
    const dataUri = b64.match(/^data:([^;,]+);base64,(.*)$/s);
    if (dataUri) { contentType = contentType || dataUri[1]; b64 = dataUri[2]; }
    imageBytes = Buffer.from(b64, 'base64');
    if (imageBytes.length === 0) { throw new Error('match.image is not valid base64'); }
    if (imageBytes.length > IMAGE_QUERY_MAX_BYTES) {
      throw new Error(`query image exceeds ${IMAGE_QUERY_MAX_BYTES} bytes`);
    }
  }

  return await workspace.buildMatch({
    text: match.text ?? match.query ?? null,
    imageBytes,
    contentType,
    similarTo: match.similarTo ?? null,
    minDistance: match.minDistance,
    maxDistance: match.maxDistance,
  });
}

function pickOpts(opts) {
  const out = {};
  if (!opts || typeof opts !== 'object') { return out; }
  for (const key of ALLOWED_OPTS) {
    if (opts[key] !== undefined) { out[key] = opts[key]; }
  }
  return out;
}
