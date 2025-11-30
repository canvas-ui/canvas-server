'use strict';

import EventEmitter from 'eventemitter2';
import path from 'path';
import fs from 'fs';
import { Client } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';
import { createDebug } from '../../../../utils/log/index.js';

const debug = createDebug('graph-service');

/**
 * GraphService
 *
 * Manages Microsoft 365 integration via Microsoft Graph API.
 */
class GraphService extends EventEmitter {
    #workspaceManager;
    #hookService;
    #clients = new Map(); // workspaceId -> { client, config }
    #pollingIntervals = new Map(); // workspaceId -> intervalId

    constructor(options = {}) {
        super();
        this.#workspaceManager = options.workspaceManager;
        this.#hookService = options.hookService;

        if (!this.#workspaceManager) {
            throw new Error('WorkspaceManager is required');
        }
    }

    async initialize() {
        debug('GraphService initialized');
        return this;
    }

    async enable(workspace) {
        debug(`Enabling GraphService for workspace ${workspace.id}`);

        try {
            const configPath = path.join(workspace.rootPath, 'config', 'graph.json');
            if (!fs.existsSync(configPath)) {
                debug(`No Graph config found at ${configPath}`);
                return false;
            }

            const configContent = await fs.promises.readFile(configPath, 'utf-8');
            const config = JSON.parse(configContent);

            if (config.tenantId && config.clientId && config.clientSecret) {
                await this.addAccount(workspace.id, workspace.owner, config);

                // Start polling for new emails
                if (config.pollInterval) {
                    this.#startPolling(workspace.id, config.pollInterval);
                }
            }

            return true;
        } catch (err) {
            debug(`Failed to enable GraphService: ${err.message}`);
            return false;
        }
    }

    async disable(workspace) {
        debug(`Disabling GraphService for workspace ${workspace.id}`);
        this.#stopPolling(workspace.id);
        this.#clients.delete(workspace.id);
        return true;
    }

    /**
     * Add a Microsoft 365 account for a workspace
     */
    async addAccount(workspaceId, userId, config) {
        debug(`Adding Microsoft 365 account for workspace ${workspaceId}`);

        try {
            const credential = new ClientSecretCredential(
                config.tenantId,
                config.clientId,
                config.clientSecret
            );

            const client = Client.initWithMiddleware({
                authProvider: {
                    getAccessToken: async () => {
                        const token = await credential.getToken('https://graph.microsoft.com/.default');
                        return token.token;
                    }
                }
            });

            this.#clients.set(workspaceId, {
                client,
                config,
                userId,
                userPrincipalName: config.userPrincipalName || config.email
            });

            return { success: true };
        } catch (err) {
            debug(`Failed to add Microsoft 365 account: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    #startPolling(workspaceId, intervalMs = 60000) {
        debug(`Starting email polling for workspace ${workspaceId} every ${intervalMs}ms`);

        const intervalId = setInterval(async () => {
            try {
                await this.fetchNewEmails(workspaceId);
            } catch (err) {
                debug(`Error during polling: ${err.message}`);
            }
        }, intervalMs);

        this.#pollingIntervals.set(workspaceId, intervalId);
    }

    #stopPolling(workspaceId) {
        const intervalId = this.#pollingIntervals.get(workspaceId);
        if (intervalId) {
            clearInterval(intervalId);
            this.#pollingIntervals.delete(workspaceId);
            debug(`Stopped polling for workspace ${workspaceId}`);
        }
    }

    /**
     * Fetch new emails from Microsoft 365
     */
    async fetchNewEmails(workspaceId) {
        debug(`Fetching new emails for workspace ${workspaceId}`);

        const clientData = this.#clients.get(workspaceId);
        if (!clientData) {
            debug(`No Graph client found for workspace ${workspaceId}`);
            return [];
        }

        const { client, userId, userPrincipalName } = clientData;

        try {
            // Get unread messages from inbox
            const messages = await client
                .api(`/users/${userPrincipalName}/mailFolders/inbox/messages`)
                .filter('isRead eq false')
                .top(50)
                .select('id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,internetMessageId')
                .get();

            debug(`Found ${messages.value.length} new email(s)`);

            const emails = [];
            for (const message of messages.value) {
                const emailDoc = {
                    schema: 'data/abstraction/email',
                    data: {
                        subject: message.subject || '(no subject)',
                        from: message.from?.emailAddress?.address || '',
                        to: message.toRecipients?.map(r => r.emailAddress.address).join(', ') || '',
                        date: message.receivedDateTime || new Date().toISOString(),
                        body: message.bodyPreview || '',
                        html: message.body?.contentType === 'html' ? message.body.content : '',
                        messageId: message.internetMessageId || message.id
                    },
                    metadata: {
                        source: 'graph',
                        workspaceId: workspaceId,
                        graphMessageId: message.id
                    }
                };

                emails.push(emailDoc);

                // Mark as read
                await client
                    .api(`/users/${userPrincipalName}/messages/${message.id}`)
                    .update({ isRead: true });

                // Dispatch via HookService if available
                if (this.#hookService) {
                    const workspace = await this.#workspaceManager.getWorkspace(workspaceId, userId);
                    if (workspace) {
                        const docId = await workspace.db.insertDocument(emailDoc, '/', [], false);
                        emailDoc.id = docId;

                        await this.#hookService.dispatchEvent('email.received', { document: emailDoc }, workspaceId);
                    }
                }
            }

            return emails;
        } catch (err) {
            debug(`Error fetching emails: ${err.message}`);
            return [];
        }
    }

    /**
     * Fetch calendar events
     */
    async fetchCalendarEvents(workspaceId, startDate, endDate) {
        debug(`Fetching calendar events for workspace ${workspaceId}`);

        const clientData = this.#clients.get(workspaceId);
        if (!clientData) {
            debug(`No Graph client found for workspace ${workspaceId}`);
            return [];
        }

        const { client, userPrincipalName } = clientData;

        try {
            const events = await client
                .api(`/users/${userPrincipalName}/calendarView`)
                .query({
                    startDateTime: startDate.toISOString(),
                    endDateTime: endDate.toISOString()
                })
                .select('id,subject,start,end,location,attendees,body')
                .get();

            debug(`Found ${events.value.length} calendar event(s)`);
            return events.value;
        } catch (err) {
            debug(`Error fetching calendar events: ${err.message}`);
            return [];
        }
    }
}

export default GraphService;
