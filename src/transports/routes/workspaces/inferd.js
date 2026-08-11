'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';
import { redactConfig } from 'canvas-inferd/src/config.js';
import { checkConfigEndpoints } from 'canvas-inferd/src/endpoint-guard.js';

/**
 * Workspace inference configuration — `/workspaces/:id/inferd`.
 *
 * This is the PRIMARY surface for choosing embedding backends. The config lives
 * in the workspace's own workspace.json (`services.inferd`), so it travels with
 * the workspace: stop it, tar it, move it to another host or run it standalone
 * under canvas-edge, and it still embeds the way its vectors were built. Server
 * and per-user config are defaults a workspace inherits until it sets its own.
 *
 * The intended flow, which the model-keyed tables make non-destructive:
 *   1. PUT /config      switch this workspace to a new model/backend. Applied
 *                       LIVE — vector spaces are lazily-built handles, not
 *                       something pinned at startup, so no restart is needed.
 *   2. POST /reindex    fill the new space, optionally scoped to `ctx://…` or
 *                       `dir://…` so a model can be tried on one project first
 *   3. (unhappy path)   PUT /config back — the previous model's vectors AND its
 *                       "already embedded" ledger are untouched, so reverting is
 *                       instant and costs no re-embedding at all
 *   4. DELETE …/vector-tables/:table  reclaim the superseded model when done
 */
export default async function workspaceInferdRoutes(fastify, _options) {

    // Opt-in rate limits. The plugin itself is registered once at the server
    // root with `global: false` (see transports/index.js); routes opt in by
    // declaring `config.rateLimit`.
    const writeLimit = {
        rateLimit: {
            max: Number(process.env.CANVAS_INFERD_CONFIG_RATE_MAX) || 30,
            timeWindow: '1 minute',
        },
    };
    // A reindex can enqueue every document in the workspace; repeated calls
    // during a drain are pure waste.
    const reindexLimit = {
        rateLimit: {
            max: Number(process.env.CANVAS_INFERD_REINDEX_RATE_MAX) || 10,
            timeWindow: '1 minute',
        },
    };

    const inferd = () => fastify.workspaceManager?.inferd || null;

    const guard = (request, reply) => {
        const workspace = request.workspace;
        if (!workspace) {
            const r = new ResponseObject().notFound('Workspace not found');
            reply.code(r.statusCode).send(r.getResponse());
            return null;
        }
        if (!inferd()) {
            const r = new ResponseObject().badRequest('Inference service is disabled (CANVAS_INFERD_ENABLED=false)');
            reply.code(r.statusCode).send(r.getResponse());
            return null;
        }
        return workspace;
    };

    // Carry forward secrets the client was never shown (GET redacts them), so a
    // UI round-trip cannot blank an API key it could not read.
    const preserveSecrets = (incoming, stored) => {
        const out = { ...incoming, providers: { ...(incoming.providers || {}) } };
        for (const [id, spec] of Object.entries(out.providers)) {
            const old = stored?.providers?.[id];
            if (!old) { continue; }
            if (spec.apiKey === undefined && old.apiKey !== undefined) { out.providers[id] = { ...spec, apiKey: old.apiKey }; }
            if (out.providers[id].headers === undefined && old.headers !== undefined) {
                out.providers[id] = { ...out.providers[id], headers: old.headers };
            }
        }
        return out;
    };

    fastify.get('/config', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        const workspace = guard(request, reply);
        if (!workspace) { return; }
        try {
            const ctx = await inferd().contextForWorkspace(workspace.id);
            const r = new ResponseObject().found({
                // This workspace's own overrides (what is written to workspace.json).
                workspace: redactConfig(workspace.inferdConfig),
                // What it actually embeds with once the layers resolve.
                effective: redactConfig(ctx.config),
                // What it would fall back to, so the UI can mark fields "inherited".
                inherited: redactConfig(inferd().serverConfig || {}),
                // Where the vectors live now — the table names a revert switches between.
                spaces: await inferd().spaceConfigsForWorkspace(workspace.id, {
                    userId: workspace.owner, config: workspace.inferdConfig,
                }),
                ...(ctx.invalid ? { invalid: ctx.invalid } : {}),
            });
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            request.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to read embedding config');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    // Live queue state for THIS workspace — pending/draining/paused. Cheap
    // in-memory readout; the Embedding settings tab polls it for its status
    // strip (the heavyweight per-table stats stay on the db-stats endpoint).
    fastify.get('/status', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        const workspace = guard(request, reply);
        if (!workspace) { return; }
        const r = new ResponseObject().found({
            queue: inferd().workspaceStatus(workspace.id),
            summarize: workspace.imageSummaryStatus,
        });
        return reply.code(r.statusCode).send(r.getResponse());
    });

    // Caption images into metadata.summary (BLIP/local ONNX by default). Async;
    // poll GET /status → summarize for progress.
    fastify.post('/summarize/images', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        config: reindexLimit,
        schema: {
            body: {
                type: 'object',
                properties: {
                    force: { type: 'boolean' },
                },
                additionalProperties: false,
            },
        },
    }, async (request, reply) => {
        const workspace = guard(request, reply);
        if (!workspace) { return; }
        if (!workspace.isActive) {
            const r = new ResponseObject().workspaceNotActive();
            return reply.code(r.statusCode).send(r.getResponse());
        }
        try {
            const result = await workspace.startImageSummaries({
                force: request.body?.force === true,
            });
            if (!result.started) {
                const r = new ResponseObject().badRequest(result.error || 'Could not start image summaries');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(result.status,
                `Image summaries started (${result.status.total} candidate(s))`);
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            request.log.error(error);
            const r = new ResponseObject().badRequest(error.message || 'Failed to start image summaries');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.put('/config', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        config: writeLimit,
    }, async (request, reply) => {
        const workspace = guard(request, reply);
        if (!workspace) { return; }
        const body = request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            const r = new ResponseObject().badRequest('Embedding config must be a JSON object');
            return reply.code(r.statusCode).send(r.getResponse());
        }
        try {
            const next = preserveSecrets(body, workspace.inferdConfig);

            // Validate as it will actually be used — layered over the workspace's
            // inherited defaults — before anything is written.
            let resolved;
            try { resolved = inferd().validate(next); }
            catch (e) {
                const r = new ResponseObject().badRequest(e.message);
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const problems = await checkConfigEndpoints(resolved, { allowHosts: inferd().serverConfig?.allowHosts || [] });
            if (problems.length > 0) {
                const r = new ResponseObject().badRequest(`Rejected embedding endpoint — ${problems.join('; ')}`);
                return reply.code(r.statusCode).send(r.getResponse());
            }

            const before = await inferd().spaceConfigsForWorkspace(workspace.id, {
                userId: workspace.owner, config: workspace.inferdConfig,
            });
            workspace.setInferdConfig(next);
            inferd().invalidateWorkspace(workspace.id, next);
            const after = await inferd().spaceConfigsForWorkspace(workspace.id, {
                userId: workspace.owner, config: next,
            });

            // A changed model means a DIFFERENT Lance table, empty until refilled.
            // Say which spaces moved so the UI can prompt for a reindex rather
            // than letting dense search quietly go thin.
            const moved = Object.keys(after).filter((sp) => before[sp]?.model !== after[sp]?.model || before[sp]?.dim !== after[sp]?.dim);

            // Apply live. Vector spaces are lazily-built handles, not something
            // pinned at startup, so a model switch does not need a restart —
            // just quiesced writes, which applyInferdSpaces takes care of.
            let swap = null;
            if (moved.length > 0 && workspace.isActive) {
                swap = await workspace.applyInferdSpaces();
            }

            const r = new ResponseObject().updated({
                workspace: redactConfig(next),
                effective: redactConfig(resolved),
                spaces: after,
                movedSpaces: moved,
                // Which Lance table each space now points at.
                tables: swap?.tables || null,
                applied: swap ? swap.applied !== false : true,
            }, moved.length > 0
                ? `Embedding config saved — ${moved.join(', ')} now targets a new model and is live; reindex to fill it`
                : 'Embedding config saved');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            request.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to save embedding config');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    // Fill the current model's space. `scope` restricts it to a subtree so a new
    // model can be evaluated on one project before committing the workspace.
    fastify.post('/reindex', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        config: reindexLimit,
        schema: {
            body: {
                type: 'object',
                properties: {
                    space: { type: 'string' },
                    reindex: { type: 'boolean' },
                    scope: { type: 'string' },
                },
                additionalProperties: false,
            },
        },
    }, async (request, reply) => {
        const workspace = guard(request, reply);
        if (!workspace) { return; }
        if (!workspace.isActive) {
            const r = new ResponseObject().workspaceNotActive();
            return reply.code(r.statusCode).send(r.getResponse());
        }
        try {
            const { space = null, reindex = false, scope = null } = request.body || {};
            const result = await inferd().reconcile(workspace.id, { space, reindex, scope });
            if (result?.error) {
                const r = new ResponseObject().badRequest(result.error);
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(result,
                `Embedding reconcile: ${result.enqueued} doc(s) enqueued${scope ? ` under ${scope}` : ''} (draining off-thread)`);
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            request.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to reindex embeddings');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    // Superseded-model housekeeping, scoped to this workspace. The live table is
    // refused — reverting to it must stay possible until it is explicitly dropped.
    fastify.get('/vector-tables', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        const workspace = guard(request, reply);
        if (!workspace) { return; }
        try {
            const r = new ResponseObject().found(await workspace.listVectorTables());
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            request.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to list vector tables');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.delete('/vector-tables/:table', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        config: writeLimit,
    }, async (request, reply) => {
        const workspace = guard(request, reply);
        if (!workspace) { return; }
        try {
            const result = await workspace.dropVectorTable(request.params.table);
            if (!result?.dropped) {
                const r = new ResponseObject().badRequest(result?.error || 'Failed to drop vector table');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(result, `Dropped superseded vector table '${result.name}'`);
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            request.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to drop vector table');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });
}
