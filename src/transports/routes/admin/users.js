'use strict';

import ResponseObject from '../../ResponseObject.js';
import { createSSHKeyHelpers } from './ssh-keys-helpers.js';

/**
 * Admin Users Routes
 *
 * Admin-only routes for managing all users
 */
export default async function adminUsersRoutes(fastify, options) {
    const sshKeyHelpers = createSSHKeyHelpers(fastify.users);

    const checkAdmin = async (request, reply) => {
        const userId = request.user.id;
        const user = await fastify.users.get(userId);

        if (!user || user.userType !== 'admin') {
            return reply.code(403).send(ResponseObject.error('Admin access required'));
        }
    };

    fastify.addHook('onRequest', checkAdmin);

    /**
     * List all users
     */
    fastify.get('/', async (request, reply) => {
        try {
            const allUsers = await fastify.users.list();

            // Remove sensitive information
            const sanitizedUsers = allUsers.map(user => ({
                id: user.id,
                name: user.name,
                email: user.email,
                userType: user.userType,
                status: user.status,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
            }));

            return reply.send(ResponseObject.success({ users: sanitizedUsers }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Get user details
     */
    fastify.get('/:userId', async (request, reply) => {
        try {
            const { userId } = request.params;

            const user = await fastify.users.get(userId);
            if (!user) {
                return reply.code(404).send(ResponseObject.error('User not found'));
            }

            // Remove sensitive information
            const sanitizedUser = {
                id: user.id,
                name: user.name,
                email: user.email,
                userType: user.userType,
                status: user.status,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
                metadata: user.metadata,
            };

            return reply.send(ResponseObject.success({ user: sanitizedUser }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Update user
     */
    fastify.put('/:userId', async (request, reply) => {
        try {
            const { userId } = request.params;
            const { name, email, userType, status } = request.body;

            const user = await fastify.users.get(userId);
            if (!user) {
                return reply.code(404).send(ResponseObject.error('User not found'));
            }

            // Build updates
            const updates = {};
            if (name !== undefined) updates.name = name;
            if (email !== undefined) updates.email = email;
            if (userType !== undefined) updates.userType = userType;
            if (status !== undefined) updates.status = status;

            const updatedUser = await fastify.users.update(userId, updates);

            return reply.send(ResponseObject.success({
                message: 'User updated successfully',
                user: {
                    id: updatedUser.id,
                    name: updatedUser.name,
                    email: updatedUser.email,
                    userType: updatedUser.userType,
                    status: updatedUser.status,
                }
            }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Delete user
     */
    fastify.delete('/:userId', async (request, reply) => {
        try {
            const { userId } = request.params;

            const user = await fastify.users.get(userId);
            if (!user) {
                return reply.code(404).send(ResponseObject.error('User not found'));
            }

            // Prevent deleting yourself
            if (userId === request.user.id) {
                return reply.code(400).send(ResponseObject.error('Cannot delete your own account'));
            }

            await fastify.users.remove(userId);

            return reply.send(ResponseObject.success({ message: 'User deleted successfully' }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * SSH Key Management Routes
     */

    /**
     * List user's SSH keys
     * GET /admin/users/:userId/ssh-keys
     */
    fastify.get('/:userId/ssh-keys', async (request, reply) => {
        try {
            const { userId } = request.params;

            const user = await fastify.users.get(userId);
            if (!user) {
                return reply.code(404).send(ResponseObject.error('User not found'));
            }

            const keys = await sshKeyHelpers.listKeys(userId);

            return reply.send(ResponseObject.success({
                keys,
                total: keys.length
            }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Add SSH public key for user
     * POST /admin/users/:userId/ssh-keys
     * Body: { key: "ssh-rsa AAAA... user@host", name?: "My Key" }
     */
    fastify.post('/:userId/ssh-keys', async (request, reply) => {
        try {
            const { userId } = request.params;
            const { key, name } = request.body;

            if (!key) {
                return reply.code(400).send(ResponseObject.error('SSH public key is required'));
            }

            const user = await fastify.users.get(userId);
            if (!user) {
                return reply.code(404).send(ResponseObject.error('User not found'));
            }

            const addedKey = await sshKeyHelpers.addKey(userId, key, name);

            return reply.code(201).send(ResponseObject.success({
                message: 'SSH key added successfully',
                key: addedKey
            }));
        } catch (error) {
            request.log.error(error);
            return reply.code(error.message.includes('Invalid') || error.message.includes('already exists') ? 400 : 500)
                .send(ResponseObject.error(error.message));
        }
    });

    /**
     * Get specific SSH key
     * GET /admin/users/:userId/ssh-keys/:keyId
     */
    fastify.get('/:userId/ssh-keys/:keyId', async (request, reply) => {
        try {
            const { userId, keyId } = request.params;

            const user = await fastify.users.get(userId);
            if (!user) {
                return reply.code(404).send(ResponseObject.error('User not found'));
            }

            const key = await sshKeyHelpers.getKey(userId, keyId);
            if (!key) {
                return reply.code(404).send(ResponseObject.error('SSH key not found'));
            }

            return reply.send(ResponseObject.success({ key }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Delete SSH key
     * DELETE /admin/users/:userId/ssh-keys/:keyId
     */
    fastify.delete('/:userId/ssh-keys/:keyId', async (request, reply) => {
        try {
            const { userId, keyId } = request.params;

            const user = await fastify.users.get(userId);
            if (!user) {
                return reply.code(404).send(ResponseObject.error('User not found'));
            }

            await sshKeyHelpers.removeKey(userId, keyId);

            return reply.send(ResponseObject.success({
                message: 'SSH key removed successfully'
            }));
        } catch (error) {
            request.log.error(error);
            return reply.code(error.message.includes('not found') ? 404 : 500)
                .send(ResponseObject.error(error.message));
        }
    });
}
