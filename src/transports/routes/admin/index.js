'use strict';

import ResponseObject from '../../ResponseObject.js';
import { validateUser } from '../../auth/strategies.js';
import { readRecentLogs, subscribeToLogs } from '../../../utils/log.js';

/**
 * Admin routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function adminRoutes(fastify, options) {

  const parseLogFilters = (query = {}) => ({
    tail: query.tail,
    level: typeof query.level === 'string' ? query.level : undefined,
    module: typeof query.module === 'string' ? query.module : undefined,
  });

  // Workspace params accept either a UUID or a user-scoped workspace name.
  const isUUID = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

  /** Resolve `:workspaceId` to a started workspace, or null. */
  // Resolves the workspace and requires it to be running. Answers for itself —
  // 404 when there is no such workspace, the canonical WORKSPACE_NOT_ACTIVE
  // when it is merely stopped — and returns null once it has replied.
  const resolveActiveWorkspace = async (request, reply) => {
    const identifier = request.params.workspaceId;
    const workspaceId = isUUID(identifier)
      ? identifier
      : fastify.workspaceManager.resolveWorkspaceId(request.user.id, identifier);
    const ws = workspaceId ? await fastify.workspaceManager.getWorkspace(workspaceId, request.user.id) : null;
    if (!ws) {
      const response = new ResponseObject().notFound('Workspace not found');
      reply.code(response.statusCode).send(response.getResponse());
      return null;
    }
    if (!ws.isActive) {
      const response = new ResponseObject().workspaceNotActive();
      reply.code(response.statusCode).send(response.getResponse());
      return null;
    }
    return ws;
  };

  /**
   * Middleware to check if user is admin
   */
  const requireAdmin = async (request, reply) => {
    if (!validateUser(request.user, ['id', 'email'])) {
      const response = new ResponseObject().unauthorized('Valid authentication required');
      return reply.code(response.statusCode).send(response.getResponse());
    }

    try {
      const user = await fastify.users.get(request.user.id);
      if (user.userType !== 'admin') {
        const response = new ResponseObject().forbidden('Admin access required');
        return reply.code(response.statusCode).send(response.getResponse());
      }
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to verify admin privileges');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  };

  fastify.get('/logs', {
    onRequest: [fastify.authenticate, requireAdmin]
  }, async (request, reply) => {
    try {
      const filters = parseLogFilters(request.query);
      const logs = await readRecentLogs(filters);
      const response = new ResponseObject().success({ logs });
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error({ err: error }, 'Failed to read server logs');
      const response = new ResponseObject().serverError('Failed to read server logs');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.get('/logs/stream', {
    onRequest: [fastify.authenticate, requireAdmin]
  }, async (request, reply) => {
    const filters = parseLogFilters(request.query);

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const writeEvent = (type, payload) => {
      if (reply.raw.destroyed) {
        return;
      }

      if (type) {
        reply.raw.write(`event: ${type}\n`);
      }

      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    writeEvent('ready', { ok: true });

    const unsubscribe = subscribeToLogs((entry) => {
      writeEvent('log', entry);
    }, filters);

    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) {
        reply.raw.write(': keepalive\n\n');
      }
    }, 15000);

    const closeStream = () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.off('close', closeStream);
      reply.raw.off('error', closeStream);

      if (!reply.raw.destroyed) {
        reply.raw.end();
      }
    };

    reply.raw.on('close', closeStream);
    reply.raw.on('error', closeStream);
  });

  // User Management Routes

  // List all users (admin only)
  fastify.get('/users', {
    onRequest: [fastify.authenticate, requireAdmin]
  }, async (request, reply) => {
    try {
      const { status, userType } = request.query;
      const users = await fastify.users.list({ status, userType });
      const sanitized = (users || []).map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        userType: u.userType,
        status: u.status,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      }));

      const response = new ResponseObject().found(sanitized, 'Users retrieved successfully', 200, sanitized.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list users');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Create user (admin only)
  fastify.post('/users', {
    onRequest: [fastify.authenticate, requireAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'email'],
        properties: {
          name: {
            type: 'string',
            minLength: 3,
            maxLength: 39,
            pattern: '^[a-z0-9_-]+$',
            description: 'Username (3-39 chars, lowercase letters, numbers, underscores, hyphens only)'
          },
          email: { type: 'string', format: 'email' },
          // Policy is enforced by authService; keep schema permissive
          password: { type: 'string', minLength: 1 },
          userType: { type: 'string', enum: ['user', 'admin'], default: 'user' },
          status: { type: 'string', enum: ['active', 'inactive', 'pending', 'deleted'], default: 'active' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { name, email, password, userType = 'user', status = 'active' } = request.body;

      // Validate password BEFORE creating the user to avoid orphaned accounts + home dirs
      if (typeof password === 'string' && password.trim()) {
        await fastify.authService.validatePasswordComplexity(password);
      }

      // Create user
      const user = await fastify.users.create({
        name,
        email,
        userType,
        status
      });

      // Set password if provided
      if (typeof password === 'string' && password.trim()) {
        try {
          await fastify.authService.setPassword(user.id, password);
        } catch (e) {
          // Best-effort rollback so the account doesn't exist without credentials
          try { await fastify.users.delete(user.id); } catch (_) {}
          throw e;
        }
      }

      const response = new ResponseObject().created({
        id: user.id,
        name: user.name,
        email: user.email,
        userType: user.userType,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }, 'User created successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const statusCode = error?.code === 'ERR_PASSWORD_COMPLEXITY' ? 400 : 500;
      const response = statusCode === 400
        ? new ResponseObject().badRequest(error.message || 'Password does not meet complexity requirements', error?.details)
        : new ResponseObject().serverError(error.message || 'Failed to create user');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get user by ID (admin only)
  fastify.get('/users/:userId', {
    onRequest: [fastify.authenticate, requireAdmin],
    schema: {
      params: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const user = await fastify.users.get(request.params.userId);

      const response = new ResponseObject().found({
        id: user.id,
        name: user.name,
        email: user.email,
        userType: user.userType,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }, 'User retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().notFound('User not found');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Update user (admin only)
  fastify.put('/users/:userId', {
    onRequest: [fastify.authenticate, requireAdmin],
    schema: {
      params: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 3,
            maxLength: 39,
            pattern: '^[a-z0-9_-]+$'
          },
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          userType: { type: 'string', enum: ['user', 'admin'] },
          status: { type: 'string', enum: ['active', 'inactive', 'pending', 'deleted'] }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { userId } = request.params;
      const { password, ...updates } = request.body || {};

      // Ensure user exists (and avoid persisting password in user index)
      let user = await fastify.users.get(userId);

      if (Object.keys(updates).length) {
        user = await fastify.users.update(userId, updates);
      }

      if (typeof password === 'string' && password.trim()) {
        await fastify.authService.setPassword(userId, password);
      }

      const response = new ResponseObject().success({
        id: user.id,
        name: user.name,
        email: user.email,
        userType: user.userType,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }, 'User updated successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const statusCode = error?.code === 'ERR_PASSWORD_COMPLEXITY' ? 400 : 500;
      const response = statusCode === 400
        ? new ResponseObject().badRequest(error.message || 'Password does not meet complexity requirements', error?.details)
        : new ResponseObject().serverError(error.message || 'Failed to update user');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Delete user (admin only)
  fastify.delete('/users/:userId', {
    onRequest: [fastify.authenticate, requireAdmin],
    schema: {
      params: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      // Prevent admin from deleting themselves
      if (request.params.userId === request.user.id) {
        const response = new ResponseObject().badRequest('Cannot delete your own account');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      await fastify.users.delete(request.params.userId);

      const response = new ResponseObject().success(true, 'User deleted successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to delete user');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Database Maintenance Routes

  // Reindex CRUD timelines (created/updated intervals) for a workspace.
  // NOTE: the old reindex-features route called a synapsd method removed in the
  // 2026-04 cleanup (permanent 500) — replaced by this timelines op.
  // Per-workspace DB maintenance (reindex/optimize) is NOT admin-gated: access
  // is scoped to workspaces the caller owns via getWorkspace(id, user.id), so a
  // non-admin can only ever run these on their own workspaces. (Server-wide
  // controls below — inferd pause/resume, logs, users — stay requireAdmin.)
  fastify.post('/workspaces/:workspaceId/reindex-timelines', {
    onRequest: [fastify.authenticate],
    schema: { params: { type: 'object', required: ['workspaceId'], properties: { workspaceId: { type: 'string' } } } }
  }, async (request, reply) => {
    try {
      const identifier = request.params.workspaceId;
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
      const workspaceId = isUUID ? identifier : fastify.workspaceManager.resolveWorkspaceId(request.user.id, identifier);
      const ws = workspaceId ? await fastify.workspaceManager.getWorkspace(workspaceId, request.user.id) : null;
      if (!ws) {
        const response = new ResponseObject().notFound('Workspace not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      if (!ws.isActive) {
        const response = new ResponseObject().workspaceNotActive();
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const result = await ws.db.reindexCrudTimelines();
      const response = new ResponseObject().success(result, `Timelines reindexed: ${result.created} created, ${result.updated} updated (${result.scanned} scanned)`);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to reindex timelines');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Rebuild per-MIME-type presence bitmaps (data/mime/*) from stored documents.
  // Backfills a corpus indexed before mime bitmaps existed (e.g. blobs/files).
  // Synchronous, in-process, idempotent.
  fastify.post('/workspaces/:workspaceId/reindex-mime', {
    onRequest: [fastify.authenticate],
    schema: { params: { type: 'object', required: ['workspaceId'], properties: { workspaceId: { type: 'string' } } } }
  }, async (request, reply) => {
    try {
      const identifier = request.params.workspaceId;
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
      const workspaceId = isUUID ? identifier : fastify.workspaceManager.resolveWorkspaceId(request.user.id, identifier);
      const ws = workspaceId ? await fastify.workspaceManager.getWorkspace(workspaceId, request.user.id) : null;
      if (!ws) {
        const response = new ResponseObject().notFound('Workspace not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      if (!ws.isActive) {
        const response = new ResponseObject().workspaceNotActive();
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const result = await ws.db.reindexMimeBitmaps();
      const response = new ResponseObject().success(result, `MIME bitmaps rebuilt: ${result.ticked}/${result.scanned} docs across ${result.keys} type(s)`);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to reindex mime bitmaps');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Full-text (Lance/BM25) reindex: backfill every document not yet in the FTS
  // index — needed for corpora indexed before FTS existed or left in start()'s
  // un-indexed tail. Idempotent (skips already-indexed). Runs in-process, so no
  // LMDB lock conflict with the live server. FTS-only; dense vectors are separate.
  fastify.post('/workspaces/:workspaceId/reindex-search', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['workspaceId'], properties: { workspaceId: { type: 'string' } } },
      // ?rebuild=true wipes the FTS table + coverage bitmap first — use when the
      // index drifted (bitmap claims docs indexed but rows are missing).
      querystring: { type: 'object', properties: { rebuild: { type: 'boolean', default: false } } },
    }
  }, async (request, reply) => {
    try {
      const identifier = request.params.workspaceId;
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
      const workspaceId = isUUID ? identifier : fastify.workspaceManager.resolveWorkspaceId(request.user.id, identifier);
      const ws = workspaceId ? await fastify.workspaceManager.getWorkspace(workspaceId, request.user.id) : null;
      if (!ws) {
        const response = new ResponseObject().notFound('Workspace not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      if (!ws.isActive) {
        const response = new ResponseObject().workspaceNotActive();
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const result = await ws.db.reindexSearchIndex({ rebuild: request.query.rebuild === true });
      const response = new ResponseObject().success(result, `FTS reindex complete: ${result.indexed} newly indexed (${result.alreadyIndexed}/${result.totalDocs} total)`);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to reindex FTS');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Embedding reconcile/reindex: ask the inferd service to drain this workspace's
  // unembedded gap (docs matching a space's candidate schemas but with no vectors
  // yet — a durable synapsd bitmap ledger). ASYNC + idempotent. `reindex:true`
  // wipes each space first for a full re-embed. Embedding runs off-thread in the
  // inferd service; this only enqueues.
  fastify.post('/workspaces/:workspaceId/reindex-embeddings', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['workspaceId'], properties: { workspaceId: { type: 'string' } } },
      body: {
        type: 'object',
        properties: { space: { type: 'string' }, reindex: { type: 'boolean' } },
        additionalProperties: false,
      },
    }
  }, async (request, reply) => {
    try {
      const identifier = request.params.workspaceId;
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
      const workspaceId = isUUID ? identifier : fastify.workspaceManager.resolveWorkspaceId(request.user.id, identifier);
      const ws = workspaceId ? await fastify.workspaceManager.getWorkspace(workspaceId, request.user.id) : null;
      if (!ws) {
        const response = new ResponseObject().notFound('Workspace not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      if (!ws.isActive) {
        const response = new ResponseObject().workspaceNotActive();
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const inferd = fastify.workspaceManager.inferd;
      if (!inferd) {
        const response = new ResponseObject().badRequest('Inference service is disabled (CANVAS_INFERD_ENABLED=false)');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const { space = null, reindex = false } = request.body || {};
      const result = await inferd.reconcile(workspaceId, { space, reindex });
      if (result?.error) {
        const response = new ResponseObject().badRequest(result.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      // A reindex re-embeds every doc (delete + re-add), churning the vector
      // tables. Compact + prune old versions once the queue drains — fire and
      // forget so the request returns immediately (embedding is async anyway).
      if (reindex) {
        // Scoped to this workspace's queue — waiting on every workspace would
        // delay the compaction behind unrelated backlogs.
        inferd.drained(workspaceId)
          .then(() => ws.db.optimizeVectors(space || null))
          .then(() => fastify.log.info(`reindex-embeddings: vector index compacted for ${identifier}${space ? ` (${space})` : ''}`))
          .catch((e) => fastify.log.warn(`reindex-embeddings: post-drain optimize failed for ${identifier}: ${e.message}`));
      }
      const response = new ResponseObject().success(result, `Embedding reconcile: ${result.enqueued} doc(s) enqueued (draining off-thread)`);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to reconcile embeddings');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Superseded-model housekeeping. Each embedding space is keyed by its model:
  // change the model and the new vectors land in their OWN table with their own
  // ledger, leaving the previous model's table intact (which is what makes
  // switching back free rather than a full re-embed). GET lists them, DELETE
  // reclaims one. The live table for a space is refused — re-embedding it is
  // what reindex-embeddings?reindex=true is for.
  fastify.get('/workspaces/:workspaceId/vector-tables', {
    onRequest: [fastify.authenticate],
    schema: { params: { type: 'object', required: ['workspaceId'], properties: { workspaceId: { type: 'string' } } } },
  }, async (request, reply) => {
    try {
      const ws = await resolveActiveWorkspace(request, reply);
      if (!ws) { return; }
      const result = await ws.listVectorTables();
      const response = new ResponseObject().success(result);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to list vector tables');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.delete('/workspaces/:workspaceId/vector-tables/:table', {
    onRequest: [fastify.authenticate, requireAdmin],
    schema: {
      params: {
        type: 'object',
        required: ['workspaceId', 'table'],
        properties: { workspaceId: { type: 'string' }, table: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    try {
      const ws = await resolveActiveWorkspace(request, reply);
      if (!ws) { return; }
      const result = await ws.dropVectorTable(request.params.table);
      if (!result?.dropped) {
        const response = new ResponseObject().badRequest(result?.error || 'Failed to drop vector table');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().success(result, `Dropped superseded vector table '${result.name}'`);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to drop vector table');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Inferd queue control. Queues are per-workspace; these endpoints act on all
  // of them (`?workspaceId=` narrows to one). Pause holds the backlog after the
  // in-flight batch (enqueues keep accumulating, nothing is lost); resume drains
  // it. Runtime state only — a restart clears the pause and reconcile re-drives
  // anything missed. The escape hatch for CPU-bound bulk ingests.
  const inferdControl = (action) => async (request, reply) => {
    try {
      const inferd = fastify.workspaceManager.inferd;
      if (!inferd) {
        const response = new ResponseObject().badRequest('Inference service is disabled (CANVAS_INFERD_ENABLED=false)');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const identifier = request.query?.workspaceId || null;
      const wsId = identifier
        ? (isUUID(identifier) ? identifier : fastify.workspaceManager.resolveWorkspaceId(request.user.id, identifier))
        : null;
      const payload = action === 'status' ? await inferd.status() : inferd[action](wsId);
      const response = new ResponseObject().success(payload);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || `Failed to ${action} inferd`);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  };
  const inferdControlSchema = {
    querystring: { type: 'object', properties: { workspaceId: { type: 'string' } } },
  };
  fastify.get('/inferd/status', { onRequest: [fastify.authenticate, requireAdmin] }, inferdControl('status'));
  fastify.post('/inferd/pause', { onRequest: [fastify.authenticate, requireAdmin], schema: inferdControlSchema }, inferdControl('pause'));
  fastify.post('/inferd/resume', { onRequest: [fastify.authenticate, requireAdmin], schema: inferdControlSchema }, inferdControl('resume'));

  // Compact + prune Lance tables and (re)build ANN indexes. `space`:
  //   'fts'          → the full-text (BM25) table
  //   'text'|'image' → that dense-vector table
  //   omitted        → every table. Synchronous, in-process; safe on the live
  // server (no lock conflict). Idempotent.
  fastify.post('/workspaces/:workspaceId/optimize', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['workspaceId'], properties: { workspaceId: { type: 'string' } } },
      body: { type: 'object', properties: { space: { type: 'string' } }, additionalProperties: false },
    }
  }, async (request, reply) => {
    try {
      const identifier = request.params.workspaceId;
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
      const workspaceId = isUUID ? identifier : fastify.workspaceManager.resolveWorkspaceId(request.user.id, identifier);
      const ws = workspaceId ? await fastify.workspaceManager.getWorkspace(workspaceId, request.user.id) : null;
      if (!ws) {
        const response = new ResponseObject().notFound('Workspace not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      if (!ws.isActive) {
        const response = new ResponseObject().workspaceNotActive();
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const { space = null } = request.body || {};
      const result = {};
      if (!space || space === 'fts') { result.fts = await ws.db.optimizeLance(); }
      if (!space) { result.vectors = await ws.db.optimizeVectors(); }
      else if (space === 'text' || space === 'image') { result.vectors = await ws.db.optimizeVectors(space); }
      const response = new ResponseObject().success(result, `Optimize complete${space ? ` (${space})` : ''}`);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to optimize indexes');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Workspace Management Routes

  // List all workspaces (admin only)
  fastify.get('/workspaces', {
    onRequest: [fastify.authenticate, requireAdmin]
  }, async (request, reply) => {
    try {
      // Get all users first
      const users = await fastify.users.list();
      let allWorkspaces = [];

      // Get workspaces for each user
      for (const user of users) {
        try {
          const userWorkspaces = await fastify.workspaceManager.listUserWorkspaces(user.id);
          // Add owner info to each workspace
          const workspacesWithOwner = userWorkspaces.map(ws => ({
            ...ws,
            ownerName: user.name,
            ownerEmail: user.email
          }));
          allWorkspaces = allWorkspaces.concat(workspacesWithOwner);
        } catch (error) {
          // Skip users that have workspace access issues
          fastify.log.warn(`Failed to get workspaces for user ${user.id}: ${error.message}`);
        }
      }

      const response = new ResponseObject().found(allWorkspaces, 'All workspaces retrieved successfully', 200, allWorkspaces.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list all workspaces');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Create workspace for user (admin only)
  fastify.post('/workspaces', {
    onRequest: [fastify.authenticate, requireAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['userId', 'name'],
        properties: {
          userId: { type: 'string' },
          name: { type: 'string' },
          label: { type: 'string' },
          description: { type: 'string' },
          color: { type: 'string', pattern: '^#[0-9A-Fa-f]{3,6}$' },
          icon: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          homeScreen: { type: 'object' },
          links: { type: 'object' },
          type: { type: 'string', enum: ['workspace', 'universe'] },
          metadata: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { userId, name, label, description, color, icon, homeScreen, links, type = 'workspace', metadata } = request.body;

      // Verify the user exists
      await fastify.users.get(userId);

      const workspace = await fastify.workspaceManager.createWorkspace(
        name,
        userId,
        {
          owner: userId,
          type,
          label: label || name,
          description: description || '',
          color,
          icon,
          homeScreen,
          links,
          metadata
        }
      );

      const response = new ResponseObject().created(workspace, 'Workspace created successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to create workspace');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Delete workspace (admin only)
  fastify.delete('/workspaces/:workspaceId', {
    onRequest: [fastify.authenticate, requireAdmin],
    schema: {
      params: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      // Find workspace in index to get owner info
      const allWorkspaces = await fastify.workspaceManager.listWorkspaces();
      const workspaceEntry = allWorkspaces.find(ws => ws.id === request.params.workspaceId);
      if (!workspaceEntry) {
        const response = new ResponseObject().notFound('Workspace not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Delete the workspace
      await fastify.workspaceManager.removeWorkspace(workspaceEntry.id, workspaceEntry.owner, true);

      const response = new ResponseObject().success(true, 'Workspace deleted successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to delete workspace');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
