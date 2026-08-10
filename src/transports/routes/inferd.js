'use strict';

import fs from 'fs/promises';
import path from 'path';
import ResponseObject from '../ResponseObject.js';
import { redactConfig } from 'canvas-inferd/src/config.js';
import { checkConfigEndpoints, checkEndpoint, endpointFor } from 'canvas-inferd/src/endpoint-guard.js';
import { env } from '../../env.js';

/**
 * Embedding configuration routes.
 *
 * Workspaces are created per user, so the embedding backend is a per-user
 * setting: `/config` always acts on the authenticated caller. An admin can set
 * a server-wide default per modality via `/defaults`, which every user inherits
 * until they override it — resolution is built-in ← server default ← user.
 *
 * Two things are enforced here rather than deeper down, because this is the only
 * place untrusted input enters:
 *
 *   - Endpoint guard. A user's `baseUrl` is fetched BY THE SERVER, so it is an
 *     SSRF primitive. checkConfigEndpoints refuses link-local / metadata
 *     targets. Loopback and private ranges stay allowed on purpose (Ollama's
 *     default is 127.0.0.1:11434), so the guard alone is not enough, which is
 *     why the second rule exists.
 *   - Response redaction. Provider error bodies are logged server-side and
 *     never returned to a non-admin. That snippet is the read channel that
 *     would turn a reachable-but-blocked host into an information leak; without
 *     it the guard is decorative.
 *
 * API keys are write-only throughout: a GET reports `apiKeySet: true`, never the
 * value, and a PUT that omits a key for an existing provider keeps the stored one.
 */

const CONFIG_NAME = 'inferd';

// 1×1 PNG — the smallest real image every provider path can decode. Used by
// POST /test with modality:'image' so "Test connection" exercises the image
// pipeline instead of only round-tripping a text embed.
const TEST_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

export default async function inferdRoutes(fastify, options) {

    // Rate limits. The plugin is registered once at the server root
    // (transports/index.js) with `global: false`, which is what keeps it off
    // everything that does not opt in — the paths that legitimately burst (CLI
    // bulk uploads, WebDAV, the fs indexer) are untouched.
    //
    // Only the MUTATING routes opt in. The one this really protects is POST
    // /test, which makes an OUTBOUND request per call: a far better
    // amplification primitive than the config writes CodeQL flagged.
    const writeLimit = {
        rateLimit: {
            max: Number(process.env.CANVAS_INFERD_CONFIG_RATE_MAX) || 30,
            timeWindow: '1 minute',
        },
    };
    // Tighter: each call reaches out to a third-party host.
    const testLimit = {
        rateLimit: {
            max: Number(process.env.CANVAS_INFERD_TEST_RATE_MAX) || 10,
            timeWindow: '1 minute',
        },
    };

    const inferd = () => fastify.workspaceManager?.inferd || null;

    const requireInferd = (reply) => {
        if (inferd()) { return true; }
        const r = new ResponseObject().badRequest('Inference service is disabled (CANVAS_INFERD_ENABLED=false)');
        reply.code(r.statusCode).send(r.getResponse());
        return false;
    };

    const isAdmin = async (request) => {
        try { return (await fastify.users.get(request.user.id))?.userType === 'admin'; }
        catch { return false; }
    };

    /** Admin-set host allowlist (empty = only the always-blocked ranges apply). */
    const policy = () => ({ allowHosts: inferd()?.serverConfig?.allowHosts || env.inferd.allowHosts || [] });

    /**
     * A provider error may quote the remote's response body. That is exactly
     * what makes a blocked-but-reachable host readable, so non-admins get the
     * message with any body stripped.
     */
    const safeError = async (request, error) => {
        request.log.warn({ err: error }, 'inferd endpoint test failed');
        if (await isAdmin(request)) { return error.message; }
        const status = error.message.match(/\b([45]\d{2})\b/);
        return status ? `backend returned HTTP ${status[1]}` : 'backend unreachable or rejected the request';
    };

    /**
     * Carry forward secrets the client could not send back, since GET redacts
     * them. Only for providers that already exist in the stored config.
     */
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

    // ── Per-user config ───────────────────────────────────────────────────────

    fastify.get('/config', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireInferd(reply)) { return; }
        try {
            const stored = await fastify.userConfig.read(request.user.id, CONFIG_NAME);
            const ctx = await inferd().contextFor(request.user.id);
            const r = new ResponseObject().found({
                // What this user's workspaces actually embed with, after layering.
                effective: redactConfig(ctx.config),
                // Just their overrides, for round-tripping edits.
                user: redactConfig(stored),
                // What they'd fall back to, so the UI can show "inherited".
                serverDefaults: redactConfig(inferd().serverConfig || {}),
                // Set when their stored config no longer resolves and the server
                // defaults are standing in.
                ...(ctx.invalid ? { invalid: ctx.invalid } : {}),
            });
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            request.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to read embedding config');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.put('/config', { onRequest: [fastify.authenticate], config: writeLimit }, async (request, reply) => {
        if (!requireInferd(reply)) { return; }
        const body = request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            const r = new ResponseObject().badRequest('Embedding config must be a JSON object');
            return reply.code(r.statusCode).send(r.getResponse());
        }
        try {
            const stored = await fastify.userConfig.read(request.user.id, CONFIG_NAME);
            const next = preserveSecrets(body, stored);

            // 1) Shape — must resolve when layered over the server defaults.
            let resolved;
            try { resolved = inferd().validate(next); }
            catch (e) {
                const r = new ResponseObject().badRequest(e.message);
                return reply.code(r.statusCode).send(r.getResponse());
            }

            // 2) Endpoints — checked on the RESOLVED config, so a provider
            // inherited from the server layer is covered too.
            const problems = await checkConfigEndpoints(resolved, policy());
            if (problems.length > 0) {
                const r = new ResponseObject().badRequest(`Rejected embedding endpoint — ${problems.join('; ')}`);
                return reply.code(r.statusCode).send(r.getResponse());
            }

            await fastify.userConfig.write(request.user.id, CONFIG_NAME, next);
            inferd().invalidateUser(request.user.id);

            // Changing a model means the new one embeds into its OWN table, so
            // existing docs are absent from it until re-embedded. Say so rather
            // than letting search quietly go thin.
            const affected = inferd().workspacesOf(request.user.id);
            const r = new ResponseObject().updated({
                user: redactConfig(next),
                effective: redactConfig(resolved),
                workspaces: affected,
                // Space configs are latched when a workspace starts, so a running
                // workspace keeps its current tables until restarted.
                restartRequired: affected.length > 0,
            }, 'Embedding config saved');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            request.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to save embedding config');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    // ── Test a candidate backend ──────────────────────────────────────────────

    // Round-trips one real embedding call so "Test connection" means the model
    // answers, not merely that the host is up.
    fastify.post('/test', { onRequest: [fastify.authenticate], config: testLimit }, async (request, reply) => {
        if (!requireInferd(reply)) { return; }
        const { provider, model, modality = 'text', probe = false } = request.body || {};
        if (!provider || typeof provider !== 'object') {
            const r = new ResponseObject().badRequest('`provider` object required');
            return reply.code(r.statusCode).send(r.getResponse());
        }
        try {
            // Probe: report whether the model is already in the local cache, so
            // the UI can say "downloading" (a first test can take minutes)
            // instead of an indistinct "testing". Pure filesystem check — no
            // outbound request, no model load. `cached: null` = not knowable
            // (remote providers download nothing; local ones without a cacheDir).
            if (probe) {
                const instance = inferd().providerFor(provider);
                const cached = typeof instance.modelCached === 'function' ? instance.modelCached(model) : null;
                const r = new ResponseObject().success({ cached, modality }, 'Cache probed');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            // Same rule as a config save: guard the field this provider TYPE
            // fetches, not whichever URL-ish key happens to be present.
            const target = endpointFor(provider);
            if (target) {
                const verdict = await checkEndpoint(target.value, policy());
                if (!verdict.ok) {
                    const r = new ResponseObject().badRequest(`Rejected embedding endpoint — ${verdict.reason}`);
                    return reply.code(r.statusCode).send(r.getResponse());
                }
            }
            const instance = inferd().providerFor(provider);
            const started = Date.now();
            // Exercise the modality actually being configured: an image space
            // tested with embedQuery would pass on a text-only backend and then
            // fail on first real ingest.
            let vector; let dim;
            if (modality === 'image') {
                if (typeof instance.embedImage !== 'function') {
                    throw new Error('provider type does not support image embedding');
                }
                const res = await instance.embedImage([TEST_PNG], { model }, { contentTypes: ['image/png'] });
                vector = res.vectors?.[0];
                dim = res.dim;
            } else {
                ({ vector, dim } = await instance.embedQuery('canvas embedding connectivity check', { model }));
            }
            const r = new ResponseObject().success({
                ok: Array.isArray(vector),
                dim: dim || vector?.length || 0,
                latencyMs: Date.now() - started,
                modality,
            }, 'Backend answered');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            const r = new ResponseObject().badRequest(await safeError(request, error));
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    // ── Server defaults (admin) ───────────────────────────────────────────────

    const requireAdmin = async (request, reply) => {
        if (await isAdmin(request)) { return true; }
        const r = new ResponseObject().forbidden('Admin access required');
        reply.code(r.statusCode).send(r.getResponse());
        return false;
    };

    fastify.get('/defaults', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireInferd(reply)) { return; }
        // Readable by any authenticated user: the UI shows what you inherit.
        const r = new ResponseObject().found({
            serverDefaults: redactConfig(inferd().serverConfig || {}),
            configPath: env.inferd.configPath,
            allowHosts: policy().allowHosts,
        });
        return reply.code(r.statusCode).send(r.getResponse());
    });

    fastify.put('/defaults', { onRequest: [fastify.authenticate], config: writeLimit }, async (request, reply) => {
        if (!requireInferd(reply)) { return; }
        if (!(await requireAdmin(request, reply))) { return; }
        const body = request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            const r = new ResponseObject().badRequest('Server defaults must be a JSON object');
            return reply.code(r.statusCode).send(r.getResponse());
        }
        try {
            const current = inferd().serverConfig || {};
            const next = preserveSecrets(body, current);

            let resolved;
            try { resolved = inferd().validate(next, { asServerDefault: true }); }
            catch (e) {
                const r = new ResponseObject().badRequest(e.message);
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const problems = await checkConfigEndpoints(resolved, { allowHosts: next.allowHosts || [] });
            if (problems.length > 0) {
                const r = new ResponseObject().badRequest(`Rejected embedding endpoint — ${problems.join('; ')}`);
                return reply.code(r.statusCode).send(r.getResponse());
            }

            // Adopt in-process first: if it fails validation there, nothing has
            // been written and the running config is untouched.
            inferd().setServerConfig(next);

            const filePath = env.inferd.configPath;
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            const tmp = `${filePath}.tmp`;
            await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
            await fs.rename(tmp, filePath);

            const r = new ResponseObject().updated({
                serverDefaults: redactConfig(next),
                configPath: filePath,
                // Every user sits on top of these, so all of them are affected.
                restartRequired: true,
            }, 'Server embedding defaults saved');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (error) {
            request.log.error(error);
            const r = new ResponseObject().serverError(error.message || 'Failed to save server defaults');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });
}
