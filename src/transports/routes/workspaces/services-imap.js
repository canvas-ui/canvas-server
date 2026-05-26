'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

function mailboxSchema(required = []) {
    return {
        type: 'object',
        required,
        properties: {
            id: { type: 'string' },
            enabled: { type: 'boolean' },
            host: { type: 'string' },
            port: { type: 'integer' },
            tls: { type: 'boolean' },
            allowSelfSigned: { type: 'boolean' },
            user: { type: 'string' },
            password: { type: 'string' },
            folder: { type: 'string' },
            mode: { type: 'string', enum: ['poll'] },
            pollInterval: { type: 'integer' },
            initialSyncDays: { type: 'integer' },
            lastUid: { type: 'integer' },
        },
    };
}

export default async function workspaceImapServiceRoutes(fastify) {
    // IMAP is owned by the workspace's stored layer; routes delegate to
    // request.workspace.* (config in config/stored.json, protocol in stored).

    fastify.get('/mailboxes', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const mailboxes = await request.workspace.listImapMailboxes();
            const response = new ResponseObject().found(mailboxes, 'Workspace IMAP mailboxes retrieved successfully', 200, mailboxes.length);
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().serverError('Failed to list workspace IMAP mailboxes');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.post('/mailboxes', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            body: mailboxSchema(['host', 'user', 'password']),
        },
    }, async (request, reply) => {
        try {
            const mailbox = await request.workspace.saveImapMailbox(request.body || {});
            const response = new ResponseObject().created(mailbox, 'Workspace IMAP mailbox created successfully');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().badRequest(error.message || 'Failed to create workspace IMAP mailbox');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.post('/mailboxes/folders', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            body: mailboxSchema(['host', 'user', 'password']),
        },
    }, async (request, reply) => {
        try {
            const folders = await request.workspace.discoverImapFolders(request.body || {});
            const response = new ResponseObject().found(folders, 'Workspace IMAP folders discovered successfully', 200, folders.length);
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().badRequest(error.message || 'Failed to discover workspace IMAP folders');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.get('/mailboxes/:mailboxId', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
        schema: {
            params: {
                type: 'object',
                required: ['id', 'mailboxId'],
                properties: {
                    id: { type: 'string' },
                    mailboxId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const mailbox = await request.workspace.getImapMailbox(request.params.mailboxId);
            if (!mailbox) {
                const response = new ResponseObject().notFound('Workspace IMAP mailbox not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const response = new ResponseObject().found(mailbox, 'Workspace IMAP mailbox retrieved successfully');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().serverError('Failed to get workspace IMAP mailbox');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.get('/mailboxes/folders/:mailboxId', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
        schema: {
            params: {
                type: 'object',
                required: ['id', 'mailboxId'],
                properties: {
                    id: { type: 'string' },
                    mailboxId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const folders = await request.workspace.listImapMailboxFolders(request.params.mailboxId);
            const response = new ResponseObject().found(folders, 'Workspace IMAP folders retrieved successfully', 200, folders.length);
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().badRequest(error.message || 'Failed to list workspace IMAP folders');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.post('/mailboxes/folders/:mailboxId', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            params: {
                type: 'object',
                required: ['id', 'mailboxId'],
                properties: {
                    id: { type: 'string' },
                    mailboxId: { type: 'string' },
                },
            },
            body: {
                type: 'object',
                required: ['folders'],
                properties: {
                    folders: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const mailboxes = await request.workspace.subscribeImapFolders(request.params.mailboxId, request.body?.folders || []);
            const response = new ResponseObject().success(mailboxes, 'Workspace IMAP folders subscribed successfully', 200, mailboxes.length);
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().badRequest(error.message || 'Failed to subscribe workspace IMAP folders');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.patch('/mailboxes/:mailboxId', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            params: {
                type: 'object',
                required: ['id', 'mailboxId'],
                properties: {
                    id: { type: 'string' },
                    mailboxId: { type: 'string' },
                },
            },
            body: mailboxSchema(),
        },
    }, async (request, reply) => {
        try {
            const mailbox = await request.workspace.saveImapMailbox({
                ...(request.body || {}),
                id: request.params.mailboxId,
            });
            const response = new ResponseObject().updated(mailbox, 'Workspace IMAP mailbox updated successfully');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().badRequest(error.message || 'Failed to update workspace IMAP mailbox');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.delete('/mailboxes/:mailboxId', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            params: {
                type: 'object',
                required: ['id', 'mailboxId'],
                properties: {
                    id: { type: 'string' },
                    mailboxId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const deleted = await request.workspace.removeImapMailbox(request.params.mailboxId);
            if (!deleted) {
                const response = new ResponseObject().notFound('Workspace IMAP mailbox not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const response = new ResponseObject().deleted(deleted, 'Workspace IMAP mailbox deleted successfully');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().serverError('Failed to delete workspace IMAP mailbox');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.post('/mailboxes/:mailboxId/test', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            params: {
                type: 'object',
                required: ['id', 'mailboxId'],
                properties: {
                    id: { type: 'string' },
                    mailboxId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const result = await request.workspace.testImapMailbox(request.params.mailboxId);
            const response = new ResponseObject().success(result, 'Workspace IMAP mailbox tested successfully');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().badRequest(error.message || 'Failed to test workspace IMAP mailbox');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.post('/mailboxes/:mailboxId/sync', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            params: {
                type: 'object',
                required: ['id', 'mailboxId'],
                properties: {
                    id: { type: 'string' },
                    mailboxId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const result = await request.workspace.syncImapMailbox(request.params.mailboxId);
            const response = new ResponseObject().success(result, 'Workspace IMAP mailbox synced successfully');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().badRequest(error.message || 'Failed to sync workspace IMAP mailbox');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.post('/mailboxes/:mailboxId/start', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            params: {
                type: 'object',
                required: ['id', 'mailboxId'],
                properties: {
                    id: { type: 'string' },
                    mailboxId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            request.workspace.setServiceConfig('imap', { enabled: true });
            const result = await request.workspace.startImapMailbox(request.params.mailboxId);
            const response = new ResponseObject().success(result, 'Workspace IMAP mailbox started successfully');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().badRequest(error.message || 'Failed to start workspace IMAP mailbox');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.post('/mailboxes/:mailboxId/stop', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            params: {
                type: 'object',
                required: ['id', 'mailboxId'],
                properties: {
                    id: { type: 'string' },
                    mailboxId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const result = await request.workspace.stopImapMailbox(request.params.mailboxId);
            const response = new ResponseObject().success(result, 'Workspace IMAP mailbox stopped successfully');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().badRequest(error.message || 'Failed to stop workspace IMAP mailbox');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });
}
