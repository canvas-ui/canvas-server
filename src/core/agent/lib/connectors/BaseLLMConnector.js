'use strict';

// Logging
import { createDebug } from '../../../../utils/log/index.js';
const debug = createDebug('agent-manager:llm-connector');

/**
 * Base LLM Connector
 *
 * Abstract base class for all LLM connectors.
 * Provides common interface and utilities.
 */
class BaseLLMConnector {

    constructor(config = {}) {
        this.config = config;
        this.name = this.constructor.name;
        debug(`Initialized ${this.name} with config keys: ${Object.keys(config).join(', ')}`);
    }

    /**
     * Chat with the LLM
     * @param {Array} messages - Array of message objects
     * @param {Object} options - Chat options
     * @returns {Promise<Object>} Response object
     */
    async chat(messages, options = {}) {
        throw new Error('chat() method must be implemented by subclass');
    }

    /**
     * Chat with the LLM using streaming
     * @param {Array} messages - Array of message objects
     * @param {Object} options - Chat options
     * @param {Function} onChunk - Callback for each streaming chunk
     * @returns {Promise<Object>} Final response object
     */
    async chatStream(messages, options = {}, onChunk = () => {}) {
        throw new Error('chatStream() method must be implemented by subclass');
    }

    /**
     * Check if the connector is available
     * @returns {Promise<boolean>} Availability status
     */
    async isAvailable() {
        throw new Error('isAvailable() method must be implemented by subclass');
    }

    /**
     * Get connector information
     * @returns {Object} Connector info
     */
    getInfo() {
        return {
            name: this.name,
            config: this.sanitizeConfig()
        };
    }

    /**
     * Sanitize config for logging (remove sensitive data)
     * @returns {Object} Sanitized config
     */
    sanitizeConfig() {
        const sanitized = { ...this.config };
        // Remove sensitive keys
        const sensitiveKeys = ['apiKey', 'key', 'token', 'password', 'secret'];
        for (const key of sensitiveKeys) {
            if (sanitized[key]) {
                sanitized[key] = '***';
            }
        }
        return sanitized;
    }

    /**
     * Format messages for the specific LLM format
     * @param {Array} messages - Input messages
     * @returns {Array} Formatted messages
     */
    formatMessages(messages) {
        return messages.map(msg => ({
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        }));
    }

    /**
     * Parse response from LLM
     * @param {*} response - Raw LLM response
     * @returns {Object} Parsed response
     */
    parseResponse(response) {
        if (typeof response === 'string') {
            return { content: response };
        }
        return response;
    }

    /**
     * Handle errors from LLM calls
     * @param {Error} error - The error
     * @param {string} operation - The operation that failed
     */
    handleError(error, operation = 'LLM operation') {
        debug(`${this.name} error during ${operation}: ${error.message}`);

        // Create standardized error
        const standardError = new Error(`${this.name} ${operation} failed: ${error.message}`);
        standardError.originalError = error;
        standardError.connector = this.name;
        standardError.operation = operation;

        throw standardError;
    }

    /**
     * Validate required configuration
     * @param {Array} requiredKeys - Array of required config keys
     */
    validateConfig(requiredKeys = []) {
        for (const key of requiredKeys) {
            if (!this.config[key]) {
                throw new Error(`${this.name}: Missing required configuration: ${key}`);
            }
        }
    }
}

export default BaseLLMConnector;
