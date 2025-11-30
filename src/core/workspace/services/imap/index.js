'use strict';

import EventEmitter from 'eventemitter2';
import path from 'path';
import fs from 'fs';
import { createDebug } from '../../../../utils/log/index.js';

const debug = createDebug('imap-service');

/**
 * ImapService
 *
 * Manages IMAP connections and fetches emails.
 */
class ImapService extends EventEmitter {
    #workspaceManager;
    #connections = new Map(); // userId -> connection

    #hookService;

    constructor(options = {}) {
        super();
        this.#workspaceManager = options.workspaceManager;
        this.#hookService = options.hookService;

        if (!this.#workspaceManager) {
            throw new Error('WorkspaceManager is required');
        }
        // HookService is optional but recommended
    }

    async initialize() {
        debug('ImapService initialized');
        return this;
    }

    async enable(workspace) {
        debug(`Enabling ImapService for workspace ${workspace.id}`);

        // Load config from workspace/config/imap.json
        // We can use Conf or just fs.
        // Workspace has a rootPath.

        try {
            const configPath = path.join(workspace.rootPath, 'config', 'imap.json');
            if (!fs.existsSync(configPath)) {
                debug(`No IMAP config found at ${configPath}`);
                return false;
            }

            const configContent = await fs.promises.readFile(configPath, 'utf-8');
            const config = JSON.parse(configContent);

            if (config.accounts && Array.isArray(config.accounts)) {
                for (const account of config.accounts) {
                    await this.addAccount(workspace.owner, account);
                }
            }

            return true;
        } catch (err) {
            debug(`Failed to enable ImapService: ${err.message}`);
            return false;
        }
    }

    /**
     * Add an IMAP account for a user
     * @param {string} userId
     * @param {Object} config - { host, port, user, password, tls }
     */
    async addAccount(userId, config) {
        // TODO: Implement actual IMAP connection logic using 'imap' or 'node-imap' package
        debug(`Adding IMAP account for user ${userId}`);

        // Mock connection for now
        this.#connections.set(userId, { config, status: 'connected' });

        return { success: true };
    }

    /**
     * Fetch new emails (stub)
     */
    async fetchNewEmails(userId, workspaceId) {
        debug(`Fetching new emails for user ${userId}`);
        // TODO: Fetch from IMAP
        // For each email, convert to document and emit 'email.received'

        // Simulation
        const mockEmail = {
            id: 'mock-email-' + Date.now(),
            schema: 'data/abstraction/email',
            data: {
                subject: 'Project X Update',
                from: 'boss@example.com',
                body: 'Please review the latest changes.'
            }
        };

        // Dispatch via HookService if available
        if (this.#hookService) {
            await this.#hookService.dispatchEvent('email.received', { document: mockEmail }, workspaceId);
        } else {
            this.emit('email.received', { userId, document: mockEmail });
        }

        return [mockEmail];
    }
}

export default ImapService;
