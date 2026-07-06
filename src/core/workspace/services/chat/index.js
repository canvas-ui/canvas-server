'use strict';

import EventEmitter from 'eventemitter2';
import path from 'path';
import fs from 'fs';
import { WebClient } from '@slack/web-api';
import { Client as TeamsClient } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';
import { createLogger } from '../../../../utils/log.js';
import { getBackendChannelContext } from '../../../../utils/backend-documents.js';

const logger = createLogger('chat-service');

/**
 * ChatService
 *
 * Manages Slack and Microsoft Teams integration.
 */
class ChatService extends EventEmitter {
    #workspaceManager;
    #hookService;
    #slackClients = new Map(); // workspaceId -> WebClient
    #teamsClients = new Map(); // workspaceId -> { client, config }
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
        logger.debug('ChatService initialized');
        return this;
    }

    async enable(workspace) {
        logger.debug(`Enabling ChatService for workspace ${workspace.id}`);

        try {
            const configPath = path.join(workspace.rootPath, 'config', 'chat.json');
            if (!fs.existsSync(configPath)) {
                logger.debug(`No Chat config found at ${configPath}`);
                return false;
            }

            const configContent = await fs.promises.readFile(configPath, 'utf-8');
            const config = JSON.parse(configContent);

            // Setup Slack if configured
            if (config.slack && config.slack.token) {
                await this.addSlackWorkspace(workspace.id, workspace.owner, config.slack);
            }

            // Setup Teams if configured
            if (config.teams && config.teams.tenantId) {
                await this.addTeamsAccount(workspace.id, workspace.owner, config.teams);
            }

            // Start polling
            if (config.pollInterval) {
                this.#startPolling(workspace.id, config.pollInterval);
            }

            return true;
        } catch (err) {
            logger.debug(`Failed to enable ChatService: ${err.message}`);
            return false;
        }
    }

    async disable(workspace) {
        logger.debug(`Disabling ChatService for workspace ${workspace.id}`);
        this.#stopPolling(workspace.id);
        this.#slackClients.delete(workspace.id);
        this.#teamsClients.delete(workspace.id);
        return true;
    }

    /**
     * Add a Slack workspace
     */
    async addSlackWorkspace(workspaceId, userId, config) {
        logger.debug(`Adding Slack workspace for ${workspaceId}`);

        try {
            const client = new WebClient(config.token);

            // Test the connection
            await client.auth.test();

            this.#slackClients.set(workspaceId, {
                client,
                config,
                userId,
                channels: config.channels || []
            });

            return { success: true };
        } catch (err) {
            logger.debug(`Failed to add Slack workspace: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    /**
     * Add a Microsoft Teams account
     */
    async addTeamsAccount(workspaceId, userId, config) {
        logger.debug(`Adding Teams account for ${workspaceId}`);

        try {
            const credential = new ClientSecretCredential(
                config.tenantId,
                config.clientId,
                config.clientSecret
            );

            const client = TeamsClient.initWithMiddleware({
                authProvider: {
                    getAccessToken: async () => {
                        const token = await credential.getToken('https://graph.microsoft.com/.default');
                        return token.token;
                    }
                }
            });

            this.#teamsClients.set(workspaceId, {
                client,
                config,
                userId,
                userPrincipalName: config.userPrincipalName || config.email,
                teams: config.teams || []
            });

            return { success: true };
        } catch (err) {
            logger.debug(`Failed to add Teams account: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    #startPolling(workspaceId, intervalMs = 60000) {
        logger.debug(`Starting chat polling for workspace ${workspaceId} every ${intervalMs}ms`);

        const intervalId = setInterval(async () => {
            try {
                await this.fetchNewMessages(workspaceId);
            } catch (err) {
                logger.debug(`Error during polling: ${err.message}`);
            }
        }, intervalMs);

        this.#pollingIntervals.set(workspaceId, intervalId);
    }

    #stopPolling(workspaceId) {
        const intervalId = this.#pollingIntervals.get(workspaceId);
        if (intervalId) {
            clearInterval(intervalId);
            this.#pollingIntervals.delete(workspaceId);
            logger.debug(`Stopped polling for workspace ${workspaceId}`);
        }
    }

    /**
     * Fetch new messages from Slack and Teams
     */
    async fetchNewMessages(workspaceId) {
        logger.debug(`Fetching new messages for workspace ${workspaceId}`);

        const messages = [];

        // Fetch from Slack
        const slackMessages = await this.#fetchSlackMessages(workspaceId);
        messages.push(...slackMessages);

        // Fetch from Teams
        const teamsMessages = await this.#fetchTeamsMessages(workspaceId);
        messages.push(...teamsMessages);

        return messages;
    }

    async #fetchSlackMessages(workspaceId) {
        const clientData = this.#slackClients.get(workspaceId);
        if (!clientData) return [];

        const { client, config, userId, channels } = clientData;
        const messages = [];

        try {
            for (const channelId of channels) {
                const result = await client.conversations.history({
                    channel: channelId,
                    limit: 10
                });

                // Get channel info for name
                const channelInfo = await client.conversations.info({ channel: channelId });
                const channelName = channelInfo.channel?.name || channelId;

                for (const message of result.messages || []) {
                    if (message.type === 'message' && !message.subtype) {
                        // Use Message schema helper
                        const chatDoc = {
                            schema: 'data/abstraction/message',
                            data: {
                                text: message.text,
                                sender: {
                                    id: message.user,
                                    username: message.username,
                                },
                                channel: {
                                    id: channelId,
                                    name: channelName,
                                    type: 'channel',
                                },
                                platform: 'slack',
                                timestamp: new Date(parseFloat(message.ts) * 1000).toISOString(),
                                threadId: message.thread_ts,
                                reactions: message.reactions?.map(r => ({
                                    emoji: r.name,
                                    count: r.count,
                                    users: r.users,
                                })),
                                platformMetadata: {
                                    messageId: message.ts,
                                    teamId: message.team,
                                },
                            },
                            metadata: {
                                source: 'slack',
                                workspaceId: workspaceId,
                            }
                        };

                        messages.push(chatDoc);

                        // Dispatch via HookService
                        if (this.#hookService) {
                            const workspace = await this.#workspaceManager.getWorkspace(workspaceId, userId);
                            if (workspace) {
                                const accountId = message.team || config.team || config.workspace || workspaceId;
                                const contextSpec = getBackendChannelContext('slack', accountId, channelName || channelId);
                                const docId = await workspace.put(chatDoc, {
                                    directory: workspace.getBackendsTreeSelector(contextSpec),
                                    emitEvent: false,
                                    allowBackendsWrite: true,
                                });
                                chatDoc.id = docId;

                                await this.#hookService.dispatchEvent('chat.message', { document: chatDoc }, workspaceId);
                            }
                        }
                    }
                }
            }
        } catch (err) {
            logger.debug(`Error fetching Slack messages: ${err.message}`);
        }

        return messages;
    }

    async #fetchTeamsMessages(workspaceId) {
        const clientData = this.#teamsClients.get(workspaceId);
        if (!clientData) return [];

        const { client, userId, userPrincipalName, teams } = clientData;
        const messages = [];

        try {
            for (const teamId of teams) {
                // Get channels for the team
                const channels = await client
                    .api(`/teams/${teamId}/channels`)
                    .get();

                for (const channel of channels.value || []) {
                    // Get messages from channel
                    const chatMessages = await client
                        .api(`/teams/${teamId}/channels/${channel.id}/messages`)
                        .top(10)
                        .get();

                    for (const message of chatMessages.value || []) {
                        const chatDoc = {
                            schema: 'data/abstraction/message',
                            data: {
                                text: message.body?.content || '',
                                html: message.body?.contentType === 'html' ? message.body.content : undefined,
                                sender: {
                                    id: message.from?.user?.id,
                                    displayName: message.from?.user?.displayName,
                                },
                                channel: {
                                    id: channel.id,
                                    name: channel.displayName,
                                    type: 'channel',
                                },
                                platform: 'teams',
                                timestamp: message.createdDateTime || new Date().toISOString(),
                                editedAt: message.lastModifiedDateTime,
                                replyCount: message.replyCount,
                                mentions: message.mentions?.map(m => ({
                                    id: m.mentioned?.user?.id,
                                    name: m.mentioned?.user?.displayName,
                                    type: 'user',
                                })),
                                platformMetadata: {
                                    messageId: message.id,
                                    permalink: message.webUrl,
                                },
                            },
                            metadata: {
                                source: 'teams',
                                workspaceId: workspaceId,
                            }
                        };

                        messages.push(chatDoc);

                        // Dispatch via HookService
                        if (this.#hookService) {
                            const workspace = await this.#workspaceManager.getWorkspace(workspaceId, userId);
                            if (workspace) {
                                const contextSpec = getBackendChannelContext('teams', userPrincipalName || teamId, channel.displayName || channel.id);
                                const docId = await workspace.put(chatDoc, {
                                    directory: workspace.getBackendsTreeSelector(contextSpec),
                                    emitEvent: false,
                                    allowBackendsWrite: true,
                                });
                                chatDoc.id = docId;

                                await this.#hookService.dispatchEvent('chat.message', { document: chatDoc }, workspaceId);
                            }
                        }
                    }
                }
            }
        } catch (err) {
            logger.debug(`Error fetching Teams messages: ${err.message}`);
        }

        return messages;
    }
}

export default ChatService;
