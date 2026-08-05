'use strict';

import ResponseObject from '../ResponseObject.js';
import UserConfigStore from '../../core/user/ConfigStore.js';

/**
 * User Routes
 *
 * Per-user client configuration. Always scoped to the authenticated caller
 * (`/me`) - there is no cross-user read or write here; user administration
 * lives under /rest/v2/admin/users.
 */
export default async function userRoutes(fastify, options) {

    // ── Module roots ────────────────────────────────────────────────────────
    // Where this user's workspaces, roles and agents live on disk. The three
    // top-level per-user modules are independently relocatable — a personal
    // instance points them at ~/Workspaces, ~/Roles, ~/Agents.

    fastify.get('/me/paths', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        try {
            const paths = fastify.users.getUserPaths(request.user.id);
            // Resolved paths plus the explicit overrides behind them, so a UI can
            // show which modules are relocated and which follow the default.
            const overrides = fastify.users.indexStore.get(request.user.id)?.paths || {};
            return reply.send(ResponseObject.found({ paths, overrides }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    // Partial update: only the modules present in the body are touched, and
    // `null` clears an override (back to the server default). Relocating is not
    // a move — existing workspaces/agents stay where they are and keep working;
    // discovery and newly created entries follow the new root.
    fastify.put('/me/paths', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        const body = request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return reply.code(400).send(ResponseObject.badRequest('Expected a JSON object of {workspaces, roles, agents}'));
        }
        try {
            const paths = await fastify.users.setUserPaths(request.user.id, body);
            return reply.send(ResponseObject.updated({ paths }));
        } catch (error) {
            request.log.error(error);
            // Bad path values are the caller's mistake, not a server fault.
            return reply.code(400).send(ResponseObject.badRequest(error.message));
        }
    });

    fastify.get('/me/config/:name', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        const { name } = request.params;

        if (!UserConfigStore.isValidName(name)) {
            return reply.code(404).send(ResponseObject.notFound(`Unknown user config "${name}"`));
        }
        // Configs the server acts on are served by their own endpoint, which
        // redacts secrets (this one would hand back stored API keys verbatim).
        if (UserConfigStore.requiresValidation(name)) {
            return reply.code(400).send(ResponseObject.badRequest(`"${name}" is served by /rest/v2/${name}/config`));
        }

        try {
            const config = await fastify.userConfig.read(request.user.id, name);
            return reply.send(ResponseObject.found(config));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    // Whole-document replace. The client owns the shape, so it reads, merges
    // and writes back; there is no per-key merge on the server.
    fastify.put('/me/config/:name', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        const { name } = request.params;

        if (!UserConfigStore.isValidName(name)) {
            return reply.code(404).send(ResponseObject.notFound(`Unknown user config "${name}"`));
        }
        // This route is deliberately schema-less, so it must not be a way to
        // store a config the server later acts on unvalidated.
        if (UserConfigStore.requiresValidation(name)) {
            return reply.code(400).send(ResponseObject.badRequest(`"${name}" must be written through /rest/v2/${name}/config, which validates it`));
        }

        const body = request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return reply.code(400).send(ResponseObject.badRequest('User config must be a JSON object'));
        }

        try {
            const config = await fastify.userConfig.write(request.user.id, name, body);
            return reply.send(ResponseObject.updated(config));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });
}
