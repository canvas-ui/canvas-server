'use strict';

import { createLogger } from '../../../../../utils/log.js';

const logger = createLogger('hook:linker');

/**
 * LinkerHook
 *
 * System hook that implements the Context Linker logic.
 * Listens for document.inserted events and links documents to contexts based on rules.
 */
class LinkerHook {
    #contextManager;
    #workspaceManager;

    constructor(options = {}) {
        this.id = 'system:linker';
        this.events = ['document.inserted', 'chat.message'];
        this.#contextManager = options.contextManager;
        this.#workspaceManager = options.workspaceManager;
    }

    async run(eventName, payload, workspaceId) {
        const document = payload.document || payload; // Payload might be the doc itself or { document: ... }

        if (!document || !document.id) return;

        // Only process specific schemas if needed, or let the rules decide
        // For optimization, we might check schema here
        if (document.schema && (document.schema.includes('email') || document.schema.includes('chat'))) {
            await this.#processDocument(document, workspaceId);
        }
    }

    async #processDocument(document, workspaceId) {
        logger.debug(`Processing document ${document.id} for linking...`);

        // Get workspace for DB access
        const workspace = await this.#workspaceManager.getWorkspace(workspaceId);
        if (!workspace) return;

        // First, apply rule-based linking
        const contexts = this.#contextManager.getAllContexts();

        for (const contextMeta of contexts) {
            try {
                const rules = contextMeta.rules || [];
                if (rules.length === 0) continue;

                let match = false;
                for (const rule of rules) {
                    if (this.#evaluateRule(rule, document)) {
                        match = true;
                        break;
                    }
                }

                if (match) {
                    await this.#linkDocumentToContext(document, contextMeta, workspaceId);
                }
            } catch (err) {
                logger.debug(`Error processing context ${contextMeta.id}: ${err.message}`);
            }
        }

        // Second, apply contact-based linking for emails
        if (document.schema && document.schema.includes('email') && document.data?.from) {
            await this.#linkByContact(document, workspace);
        }
    }

    async #linkByContact(document, workspace) {
        logger.debug(`Attempting contact-based linking for document ${document.id}`);

        try {
            // Extract email from "from" field
            // Format might be "Name <email@domain.com>" or just "email@domain.com"
            const fromField = document.data.from;
            const emailMatch = fromField.match(/<([^>]+)>/) || [null, fromField];
            const senderEmail = emailMatch[1]?.trim().toLowerCase();

            if (!senderEmail) {
                logger.debug('Could not extract sender email');
                return;
            }

            logger.debug(`Looking for contact with email: ${senderEmail}`);

            // Find contact document by email
            // We need to query synapsd for a contact with this email
            // Assuming contacts have schema 'data/abstraction/contact' and data.email field
            const contactDocs = await workspace.find({
                context: workspace.getContextTreeSelector('/'),
                attributes: { allOf: ['data/abstraction/contact'] },
                parse: true,
            });

            let contactDoc = null;
            for (const doc of contactDocs) {
                if (doc.data?.email?.toLowerCase() === senderEmail) {
                    contactDoc = doc;
                    break;
                }
            }

            if (!contactDoc) {
                logger.debug(`No contact found for email: ${senderEmail}`);
                return;
            }

            logger.debug(`Found contact document ${contactDoc.id} for ${senderEmail}`);

            // Get all context bitmaps that contain this contact
            const contextBitmaps = await workspace.db.getBitmapsForDocument(
                contactDoc.id,
                'context/',
            );

            if (contextBitmaps.length === 0) {
                logger.debug(`Contact ${contactDoc.id} is not in any contexts`);
                return;
            }

            logger.debug(`Contact is in ${contextBitmaps.length} context(s): ${contextBitmaps.join(', ')}`);

            // Add the email document to all those contexts
            for (const bitmapKey of contextBitmaps) {
                await workspace.db.bitmapIndex.tick(bitmapKey, document.id);
                logger.debug(`Added email ${document.id} to context bitmap ${bitmapKey}`);
            }

            logger.debug(`Successfully linked email ${document.id} to ${contextBitmaps.length} context(s) via contact`);

        } catch (err) {
            logger.debug(`Failed to link by contact: ${err.message}`);
        }
    }

    #evaluateRule(rule, document) {
        if (!rule.type || !document.schema) return false;

        if (!document.schema.includes(rule.type)) return false;

        const criteria = rule.criteria || {};

        if (criteria.subject && document.data?.subject) {
            if (!document.data.subject.toLowerCase().includes(criteria.subject.toLowerCase())) {
                return false;
            }
        }

        if (criteria.sender && document.data?.from) {
            if (!document.data.from.toLowerCase().includes(criteria.sender.toLowerCase())) {
                return false;
            }
        }

        return true;
    }

    async #linkDocumentToContext(document, contextMeta, workspaceId) {
        logger.debug(`Linking document ${document.id} to context ${contextMeta.id}`);

        const workspace = await this.#workspaceManager.getWorkspace(workspaceId);
        if (!workspace) return;

        const contextBitmapArray = contextMeta.contextBitmapArray || [];
        if (contextBitmapArray.length === 0) return;

        const contextTag = `tag/context:${contextMeta.id}`;

        try {
            // We need to re-fetch the document to get current bitmaps?
            // Or assume the payload has them?
            // Safer to fetch or just send update if we know what to add.
            // But updateDocument replaces arrays.

            const existingDoc = await workspace.db.get(document.id);
            if (!existingDoc) return;

            await workspace.db.put({
                id: document.id,
            }, {
                context: workspace.getContextTreeSelector(contextMeta.path || '/', contextMeta.treeId || null),
                features: [contextTag],
            });

            logger.debug(`Linked document ${document.id} to context ${contextMeta.id}`);

        } catch (err) {
            logger.debug(`Failed to link document: ${err.message}`);
        }
    }
}

export default LinkerHook;
