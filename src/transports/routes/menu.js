'use strict';

import ResponseObject from '../ResponseObject.js';

/**
 * Menu Structure Route
 *
 * Returns dynamic menu structure based on user role
 */
export default async function menuRoutes(fastify, _options) {
    fastify.get('/menu', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        try {
            const userId = request.user.id;

            const user = await fastify.users.get(userId);
            if (!user) {
                return reply.code(404).send(ResponseObject.error('User not found'));
            }

            const isAdmin = user.userType === 'admin';

            // Base menu items for all users
            const menuItems = [
                {
                    id: 'universe',
                    label: 'Universe',
                    icon: 'home',
                    path: '/universe',
                    children: [
                        { id: 'universe-documents', label: 'Documents', path: '/universe/documents' },
                        { id: 'universe-tree', label: 'Tree', path: '/universe/tree' },
                        { id: 'universe-dotfiles', label: 'Dotfiles', path: '/universe/dotfiles' },
                    ]
                },
                {
                    id: 'contexts',
                    label: 'Contexts',
                    icon: 'layers',
                    path: '/contexts',
                },
                {
                    id: 'workspaces',
                    label: 'Workspaces',
                    icon: 'briefcase',
                    path: '/workspaces',
                },
                {
                    id: 'agents',
                    label: 'Agents',
                    icon: 'bot',
                    path: '/agents',
                },
                {
                    id: 'roles',
                    label: 'Roles',
                    icon: 'users',
                    path: '/roles',
                },
            ];

            // Add admin-only menu items
            if (isAdmin) {
                menuItems.push(
                    {
                        id: 'divider-admin',
                        type: 'divider',
                    },
                    {
                        id: 'admin-users',
                        label: 'Canvas Users',
                        icon: 'user-cog',
                        path: '/admin/users',
                        adminOnly: true,
                    },
                    {
                        id: 'admin-workspaces',
                        label: 'Canvas Workspaces',
                        icon: 'server',
                        path: '/admin/workspaces',
                        adminOnly: true,
                    }
                );
            }

            return reply.send(ResponseObject.success({
                menu: menuItems,
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    userType: user.userType,
                }
            }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });
}
