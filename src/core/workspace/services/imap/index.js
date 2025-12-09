'use strict';

import EventEmitter from 'eventemitter2';
import path from 'path';
import fs from 'fs';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { createLogger } from '../../../../utils/log.js';

const logger = createLogger('imap-service');

/**
 * ImapService
 *
 * Manages IMAP connections and fetches emails.
 */
class ImapService extends EventEmitter {
    #workspaceManager;
    #hookService;
    #connections = new Map(); // workspaceId -> { config, imap, status }
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
        logger.debug('ImapService initialized');
        return this;
    }

    async enable(workspace) {
        logger.debug(`Enabling ImapService for workspace ${workspace.id}`);

        try {
            const configPath = path.join(workspace.rootPath, 'config', 'imap.json');
            if (!fs.existsSync(configPath)) {
                logger.debug(`No IMAP config found at ${configPath}`);
                return false;
            }

            const configContent = await fs.promises.readFile(configPath, 'utf-8');
            const config = JSON.parse(configContent);

            if (config.accounts && Array.isArray(config.accounts)) {
                for (const account of config.accounts) {
                    await this.addAccount(workspace.id, workspace.owner, account);
                }

                // Start polling for new emails
                if (config.pollInterval) {
                    this.#startPolling(workspace.id, config.pollInterval);
                }
            }

            return true;
        } catch (err) {
            logger.debug(`Failed to enable ImapService: ${err.message}`);
            return false;
        }
    }

    async disable(workspace) {
        logger.debug(`Disabling ImapService for workspace ${workspace.id}`);
        this.#stopPolling(workspace.id);

        const connection = this.#connections.get(workspace.id);
        if (connection && connection.imap) {
            connection.imap.end();
        }
        this.#connections.delete(workspace.id);
        return true;
    }

    /**
     * Add an IMAP account for a workspace
     */
    async addAccount(workspaceId, userId, config) {
        logger.debug(`Adding IMAP account for workspace ${workspaceId}`);

        try {
            const imap = new Imap({
                user: config.user,
                password: config.password,
                host: config.host,
                port: config.port || 993,
                tls: config.tls !== false,
                tlsOptions: { rejectUnauthorized: false }
            });

            this.#connections.set(workspaceId, {
                config,
                imap,
                userId,
                status: 'disconnected'
            });

            // Setup event handlers
            this.#setupImapHandlers(workspaceId, imap);

            return { success: true };
        } catch (err) {
            logger.debug(`Failed to add IMAP account: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    #setupImapHandlers(workspaceId, imap) {
        imap.once('ready', () => {
            logger.debug(`IMAP connection ready for workspace ${workspaceId}`);
            const connection = this.#connections.get(workspaceId);
            if (connection) {
                connection.status = 'connected';
            }
        });

        imap.once('error', (err) => {
            logger.debug(`IMAP error for workspace ${workspaceId}: ${err.message}`);
            const connection = this.#connections.get(workspaceId);
            if (connection) {
                connection.status = 'error';
            }
        });

        imap.once('end', () => {
            logger.debug(`IMAP connection ended for workspace ${workspaceId}`);
            const connection = this.#connections.get(workspaceId);
            if (connection) {
                connection.status = 'disconnected';
            }
        });
    }

    #startPolling(workspaceId, intervalMs = 60000) {
        logger.debug(`Starting email polling for workspace ${workspaceId} every ${intervalMs}ms`);

        const intervalId = setInterval(async () => {
            try {
                await this.fetchNewEmails(workspaceId);
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
     * Fetch new emails from IMAP server
     */
    async fetchNewEmails(workspaceId) {
        logger.debug(`Fetching new emails for workspace ${workspaceId}`);

        const connection = this.#connections.get(workspaceId);
        if (!connection) {
            logger.debug(`No IMAP connection found for workspace ${workspaceId}`);
            return [];
        }

        const { imap, userId } = connection;

        return new Promise((resolve, reject) => {
            const emails = [];

            imap.once('ready', () => {
                imap.openBox('INBOX', false, (err, box) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    // Search for unseen emails
                    imap.search(['UNSEEN'], (err, results) => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        if (!results || results.length === 0) {
                            logger.debug('No new emails found');
                            imap.end();
                            resolve([]);
                            return;
                        }

                        logger.debug(`Found ${results.length} new email(s)`);

                        const fetch = imap.fetch(results, {
                            bodies: '',
                            markSeen: true
                        });

                        fetch.on('message', (msg, seqno) => {
                            logger.debug(`Processing message #${seqno}`);
                            let buffer = '';

                            msg.on('body', (stream, info) => {
                                stream.on('data', (chunk) => {
                                    buffer += chunk.toString('utf8');
                                });
                            });

                            msg.once('end', async () => {
                                try {
                                    const parsed = await simpleParser(buffer);

                                    const emailDoc = {
                                        schema: 'data/abstraction/email',
                                        data: {
                                            subject: parsed.subject || '(no subject)',
                                            from: parsed.from?.text || '',
                                            to: parsed.to?.text || '',
                                            date: parsed.date?.toISOString() || new Date().toISOString(),
                                            body: parsed.text || '',
                                            html: parsed.html || '',
                                            messageId: parsed.messageId || `imap-${seqno}-${Date.now()}`
                                        },
                                        metadata: {
                                            source: 'imap',
                                            workspaceId: workspaceId,
                                            seqno: seqno
                                        }
                                    };

                                    emails.push(emailDoc);

                                    // Dispatch via HookService if available
                                    if (this.#hookService) {
                                        // First, insert into DB to get document ID
                                        const workspace = await this.#workspaceManager.getWorkspace(workspaceId, userId);
                                        if (workspace) {
                                            const docId = await workspace.db.insertDocument(emailDoc, '/', [], false);
                                            emailDoc.id = docId;

                                            await this.#hookService.dispatchEvent('email.received', { document: emailDoc }, workspaceId);
                                        }
                                    }
                                } catch (parseErr) {
                                    logger.debug(`Error parsing email: ${parseErr.message}`);
                                }
                            });
                        });

                        fetch.once('error', (err) => {
                            logger.debug(`Fetch error: ${err.message}`);
                            reject(err);
                        });

                        fetch.once('end', () => {
                            logger.debug('Fetch completed');
                            imap.end();
                            resolve(emails);
                        });
                    });
                });
            });

            imap.once('error', (err) => {
                logger.debug(`IMAP error: ${err.message}`);
                reject(err);
            });

            // Connect if not already connected
            if (connection.status !== 'connected') {
                imap.connect();
            }
        });
    }
}

export default ImapService;
