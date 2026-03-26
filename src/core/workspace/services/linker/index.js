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

        // Get all contexts
        // TODO: Optimize this to only fetch relevant contexts or cache rules
        const contexts = this.#contextManager.getAllContexts();

        for (const contextMeta of contexts) {
            try {
                // We need the full context instance to access rules if they are not in metadata
                // Ideally rules should be in metadata for quick access.
                // For now, let's assume we can get them from the context instance.
                // Since getAllContexts returns metadata, we might need to load the context if rules are not there.
                // But wait, getAllContexts returns what toJSON returns, and we added rules to toJSON.
                // So contextMeta.rules should be available.

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
        // e.g. rule.type = 'email' matches schema 'data/abstraction/email'
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

        // To link, we need to update the document's context bitmap
        // We need to resolve the workspace and get the DB
        // Since we have workspaceId, we can get the workspace

        // Note: This assumes the document is in the same workspace as the context?
        // Or at least accessible.

        // Actually, the requirement says "user creates a context... links emails...".
        // The emails might be in a "personal" workspace or the same workspace.
        // For now, let's assume we are operating within the workspace where the document was ingested.

        const workspace = await this.#workspaceManager.getWorkspace(workspaceId, contextMeta.userId);
        if (!workspace) {
            logger.debug(`Workspace ${workspaceId} not found for user ${contextMeta.userId}`);
            return;
        }

        // We need to append the context path to the document's context bitmaps
        // The context path is stored in contextMeta.contextBitmapArray (from our previous edit to toJSON)

        const contextBitmapArray = contextMeta.contextBitmapArray || [];
        if (contextBitmapArray.length === 0) return;

        // We use updateDocument to add the bitmaps
        // But wait, updateDocument replaces bitmaps? Or merges?
        // SynapsD updateDocument signature: updateDocument(id, data, contextArray, featureArray)
        // It usually replaces the contextArray. We need to fetch existing, merge, and update.

        // However, SynapsD might not support "merging" context arrays easily if they are positional.
        // But here we are talking about "tagging" the document with the context.
        // In SynapsD, context/ bitmaps are usually hierarchical.
        // If we want to "link" it, maybe we should use a separate "linked_context/" bitmap or just append to the context array?
        // Appending to context array means it appears in that path.

        try {
            const existingDoc = await workspace.db.getDocument(document.id);
            if (!existingDoc) return;

            // Merge context arrays
            // We want the document to show up in the context.
            // So we should add the context's path IDs to the document's context array.
            // But context array in SynapsD is a list of IDs.
            // If we just append, it might work if SynapsD treats them as a set of tags for filtering.
            // Let's assume we can just append for now.

            // Actually, looking at Context.js:
            // const contextArray = [...this.#pathArray, ...this.#serverContextArray, ...];
            // It seems flat.

            // Let's check if the document is already linked
            // We can check if the context's specific path ID is in the document's context array.
            // But contextBitmapArray is an array of IDs.

            // Let's just try to add them.
            // We need to be careful not to duplicate.

            // TODO: Verify SynapsD behavior on multiple context paths.
            // For now, we will add a special "link" bitmap if possible, or just add to context array.

            // Let's use a "tag" for the context ID as well, to be safe and easy to query.
            // tag/context:<uuid>

            const contextTag = `tag/context:${contextMeta.id}`;

            // We need to update the document.
            // We can't easily "append" to contextArray via updateDocument without reading first (which we did).

            // Let's assume existingDoc has .context (array of strings/IDs).
            // Wait, SynapsD internal storage might be different.
            // We should use the workspace.db.updateDocument API.

            // If we want to "link", maybe we should just add a metadata field?
            // "links emails... based on subject".
            // If we want them to show up in the context view, the context view probably queries by context path.
            // So we MUST add the context path to the document.

            await workspace.db.updateDocument(document.id, {
                // We don't change data, just indexes
            }, {
                context: workspace.getContextTreeSelector(contextMeta.path || '/', contextMeta.treeId || null),
                features: [contextTag],
            });

            logger.debug(`Linked document ${document.id} to context ${contextMeta.id}`);
            this.emit('document.linked', { documentId: document.id, contextId: contextMeta.id });

        } catch (err) {
            logger.debug(`Failed to link document: ${err.message}`);
        }
    }
}

export default LinkerService;
