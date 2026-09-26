import { requireWorkspaceRead, requireWorkspaceWrite, requireWorkspaceAdmin } from '../../middleware/workspace-acl.js';

export default async function messageRoutes(app) {
    const fail = (reply, error) => reply.code(error.statusCode || 400).send({ status: 'error', message: error.message });
    app.get('/accounts', { onRequest: [app.authenticate, requireWorkspaceRead()] }, async (request) => ({
        status: 'success', payload: await request.workspace.messagingAccounts(),
    }));
    app.get('/reply-target/:docId', { onRequest: [app.authenticate, requireWorkspaceRead()] }, async (request, reply) => {
        try {
            const id = Number(request.params.docId);
            if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid document ID');
            const binding = request.resourceToken;
            if (binding?.type === 'agent' && binding.basePath && binding.basePath !== '/') {
                const ids = await request.workspace.list({ context: binding.basePath, ids: [id], idsOnly: true, limit: 1 });
                if (!ids.includes(id)) return reply.code(403).send({ status: 'error', message: 'Message is outside the agent scope' });
            }
            return { status: 'success', payload: await request.workspace.messageReplyTarget(id) };
        } catch (error) { return fail(reply, error); }
    });
    app.get('/:driver/:address/connection', { onRequest: [app.authenticate, requireWorkspaceAdmin()] }, async (request, reply) => {
        if (request.resourceToken) return reply.code(403).send({ status: 'error', message: 'Device pairing requires a user account' });
        try { return { status: 'success', payload: await request.workspace.messageConnection(request.params.driver, request.params.address) }; }
        catch (error) { return fail(reply, error); }
    });
    app.delete('/:driver/:address/connection', { onRequest: [app.authenticate, requireWorkspaceAdmin()] }, async (request, reply) => {
        if (request.resourceToken) return reply.code(403).send({ status: 'error', message: 'Device pairing requires a user account' });
        try { return { status: 'success', payload: await request.workspace.messageConnection(request.params.driver, request.params.address, true) }; }
        catch (error) { return fail(reply, error); }
    });
    app.get('/outbox/:requestId', { onRequest: [app.authenticate, requireWorkspaceWrite()] }, async (request, reply) => {
        if (request.resourceToken && request.resourceToken.type !== 'agent') return reply.code(403).send({ status: 'error', message: 'Share tokens cannot access the outbox' });
        try { return { status: 'success', payload: await request.workspace.messageSendStatus(request.params.requestId, request.resourceToken?.agentId || request.user.id) }; }
        catch (error) { return fail(reply, error); }
    });
    app.post('/send', {
        onRequest: [app.authenticate, requireWorkspaceWrite()],
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
        schema: { body: {
            type: 'object', required: ['requestId', 'text'], additionalProperties: false,
            properties: {
                requestId: { type: 'string', pattern: '^[\\w-]{16,128}$' },
                text: { type: 'string', minLength: 1, maxLength: 32000 },
                driver: { type: 'string', enum: ['imap', 'slack', 'whatsapp'] }, address: { type: 'string', maxLength: 256 },
                target: { type: 'string', maxLength: 256 }, replyToDocumentId: { type: 'integer', minimum: 1 },
                subject: { type: 'string', maxLength: 998 }, replyAll: { type: 'boolean' },
                ...Object.fromEntries(['to', 'cc', 'bcc'].map((k) => [k, { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 320 } }])),
            },
        } },
    }, async (request, reply) => {
        // A document/workspace share does not grant use of an account identity.
        if (request.resourceToken && request.resourceToken.type !== 'agent') return reply.code(403).send({ status: 'error', message: 'Share tokens cannot send messages' });
        try {
            const binding = request.resourceToken;
            const result = await request.workspace.sendMessage(request.body, {
                id: binding?.agentId || request.user.id,
                isAgent: binding?.type === 'agent', basePath: binding?.basePath || '/',
            });
            return { status: 'success', payload: result };
        } catch (error) { return fail(reply, error); }
    });
}
