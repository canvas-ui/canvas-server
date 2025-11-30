'use strict';

import ResponseObject from '../../ResponseObject.js';

/**
 * Admin Users Routes
 *
 * Admin-only routes for managing all users
 */
export default async function adminUsersRoutes(fastify, options) {
    const { users } = options;

    // Middleware to check admin role
    const checkAdmin = async (request, reply) => {
        const userId = request.user.id;
        const user = await users.get(userId);

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
            const allUsers = await users.list();

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

            const user = await users.get(userId);
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

            const user = await users.get(userId);
            if (!user) {
                return reply.code(404).send(ResponseObject.error('User not found'));
            }

            // Build updates
            const updates = {};
            if (name !== undefined) updates.name = name;
            if (email !== undefined) updates.email = email;
            if (userType !== undefined) updates.userType = userType;
            if (status !== undefined) updates.status = status;

            const updatedUser = await users.update(userId, updates);

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

            const user = await users.get(userId);
            if (!user) {
                return reply.code(404).send(ResponseObject.error('User not found'));
            }

            // Prevent deleting yourself
            if (userId === request.user.id) {
                return reply.code(400).send(ResponseObject.error('Cannot delete your own account'));
            }

            await users.remove(userId);

            return reply.send(ResponseObject.success({ message: 'User deleted successfully' }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });
}
