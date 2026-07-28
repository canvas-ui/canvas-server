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
