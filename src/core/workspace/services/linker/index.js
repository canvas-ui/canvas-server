'use strict';

import EventEmitter from 'eventemitter2';
import { createLogger } from '../../../../utils/log.js';

const logger = createLogger('linker-service');

/**
 * LinkerService
 *
 * Monitors incoming documents and links them to contexts based on rules.
 */
class LinkerService extends EventEmitter {
    #workspaceManager;
    #contextManager;
    #initialized = false;

    constructor(options = {}) {
        super();
        this.#workspaceManager = options.workspaceManager;
        this.#contextManager = options.contextManager;

        if (!this.#workspaceManager || !this.#contextManager) {
            throw new Error('WorkspaceManager and ContextManager are required');
        }
    }

    async initialize() {
        if (this.#initialized) return this;
        logger.debug('LinkerService initialized');
        this.#initialized = true;
        return this;
    }

    /**
     * Process a document against all active context rules
     * @param {Object} document - The document to process
     * @param {string} workspaceId - The workspace ID where the document resides
     */
    async processDocument(document, workspaceId) {
        if (!this.#initialized) throw new Error('LinkerService not initialized');
        if (!document) return;

        logger.debug(`Processing document ${document.id} for linking...`);

        const contexts = this.#contextManager.getAllContexts();

        for (const contextMeta of contexts) {
            try {
                const rules = contextMeta.rules || [];
                if (rules.length === 0) continue;

                let match = false;
                for (const rule of rules) {
                    if (this.#evaluateRule(rule, document)) {
                        match = true;
                        break; // One match is enough to link to this context
                    }
                }

                if (match) {
                    await this.#linkDocumentToContext(document, contextMeta, workspaceId);
                }
            } catch (err) {
                logger.debug(`Error processing context ${contextMeta.id}: ${err.message}`);
            }
        }
    }

    #evaluateRule(rule, document) {
        if (!rule.type || !document.schema) return false;

        // Basic type check
        // e.g. rule.type = 'email' matches schema 'data/schema/message/email'
        if (!document.schema.includes(rule.type)) return false;

        const criteria = rule.criteria || {};

        // Check subject/title
        if (criteria.subject && document.data?.subject) {
            if (!document.data.subject.toLowerCase().includes(criteria.subject.toLowerCase())) {
                return false;
            }
        }

        // Check sender/from
        if (criteria.sender && document.data?.from) {
            // sender might be "Name <email>" or just email
            if (!document.data.from.toLowerCase().includes(criteria.sender.toLowerCase())) {
                return false;
            }
        }

        // Check content/body (if available and not too expensive)
        if (criteria.content && document.data?.body) {
            if (!document.data.body.toLowerCase().includes(criteria.content.toLowerCase())) {
                return false;
            }
        }

        return true;
    }

    async #linkDocumentToContext(document, contextMeta, workspaceId) {
        logger.debug(`Linking document ${document.id} to context ${contextMeta.id}`);

        const workspace = await this.#workspaceManager.getWorkspace(workspaceId, contextMeta.userId);
        if (!workspace) {
            logger.debug(`Workspace ${workspaceId} not found for user ${contextMeta.userId}`);
            return;
        }

        if (!(contextMeta.contextBitmapArray || []).length) return;

        try {
            const contextTag = `tag/context:${contextMeta.id}`;
            await workspace.link(document.id, {
                context: workspace.getContextTreeSelector(contextMeta.path || '/', contextMeta.treeId || null),
                features: [contextTag],
                emitEvent: false,
            });

            logger.debug(`Linked document ${document.id} to context ${contextMeta.id}`);
            this.emit('document.linked', { documentId: document.id, contextId: contextMeta.id });

        } catch (err) {
            logger.debug(`Failed to link document: ${err.message}`);
        }
    }
}

export default LinkerService;
