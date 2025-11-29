'use strict';

import BaseLLMConnector from './BaseLLMConnector.js';

/**
 * Ollama LLM Connector
 * Uses OpenAI-compatible API when available
 */
class OllamaConnector extends BaseLLMConnector {

    constructor(config) {
        super(config);

        this.host = config.host || 'http://localhost:11434';
        this.model = config.model || 'qwen2.5-coder:latest';
        this.timeout = config.timeout || 30000;
    }

    /**
     * Chat with Ollama model
     * @param {Array} messages - Array of message objects
     * @param {Object} options - Chat options
     * @returns {Promise<Object>} Response object
     */
    async chat(messages, options = {}) {
        try {
            const { default: fetch } = await import('node-fetch');

            const formattedMessages = this.formatMessages(messages);
            const model = options.model || this.model;

            // Try OpenAI-compatible endpoint first
            let response;
            try {
                response = await fetch(`${this.host}/v1/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: formattedMessages,
                        stream: false,
                        temperature: options.temperature || 0.7,
                        top_p: options.topP || 1.0,
                        frequency_penalty: options.frequencyPenalty || 0.0,
                        presence_penalty: options.presencePenalty || 0.0,
                        num_ctx: options.numCtx || 4096
                    }),
                    timeout: this.timeout
                });
            } catch (error) {
                // Fallback to native Ollama API
                return await this.#chatNativeAPI(messages, options);
            }

            if (!response.ok) {
                // Try native API as fallback
                return await this.#chatNativeAPI(messages, options);
            }

            const data = await response.json();

            return {
                content: data.choices[0]?.message?.content || '',
                model: data.model,
                metadata: {
                    provider: 'ollama',
                    model: data.model,
                    finish_reason: data.choices[0]?.finish_reason
                }
            };
        } catch (error) {
            this.handleError(error, 'chat');
        }
    }

    /**
     * Chat with streaming (fallback to regular chat for now)
     * @param {Array} messages - Array of message objects
     * @param {Object} options - Chat options
     * @param {Function} onChunk - Callback for each streaming chunk
     * @returns {Promise<Object>} Response object
     */
    async chatStream(messages, options = {}, onChunk = () => {}) {
        // For now, fallback to regular chat and emit the full response as a single chunk
        // TODO: Implement proper streaming when Ollama streaming API is integrated
        const response = await this.chat(messages, options);

        // Emit the full content as a single chunk
        if (response.content) {
            onChunk({
                type: 'content',
                content: response.content,
                delta: response.content
            });
        }

        return response;
    }

    /**
     * Chat using native Ollama API
     * @param {Array} messages - Array of message objects
     * @param {Object} options - Chat options
     * @returns {Promise<Object>} Response object
     * @private
     */
    async #chatNativeAPI(messages, options = {}) {
        const { default: fetch } = await import('node-fetch');

        const model = options.model || this.model;

        // Convert messages to prompt for native API
        const prompt = this.#convertMessagesToPrompt(messages);

        const response = await fetch(`${this.host}/api/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: model,
                prompt: prompt,
                stream: false,
                options: {
                    temperature: options.temperature || 0.7,
                    top_p: options.topP || 1.0,
                    frequency_penalty: options.frequencyPenalty || 0.0,
                    presence_penalty: options.presencePenalty || 0.0,
                    num_ctx: options.numCtx || 4096
                }
            }),
            timeout: this.timeout
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Ollama API error (${response.status}): ${errorText}`);
        }

        const data = await response.json();

        return {
            content: data.response || '',
            model: data.model,
            metadata: {
                provider: 'ollama',
                model: data.model,
                context: data.context
            }
        };
    }

    /**
     * Convert messages array to a single prompt for native API
     * @param {Array} messages - Messages array
     * @returns {string} Combined prompt
     * @private
     */
    #convertMessagesToPrompt(messages) {
        let prompt = '';

        for (const message of messages) {
            switch (message.role) {
                case 'system':
                    prompt += `System: ${message.content}\n\n`;
                    break;
                case 'user':
                    prompt += `Human: ${message.content}\n\n`;
                    break;
                case 'assistant':
                    prompt += `Assistant: ${message.content}\n\n`;
                    break;
                default:
                    prompt += `${message.content}\n\n`;
            }
        }

        prompt += 'Assistant: ';
        return prompt;
    }

    /**
     * Check if Ollama is available
     * @returns {Promise<boolean>} Availability status
     */
    async isAvailable() {
        try {
            const { default: fetch } = await import('node-fetch');

            // Check if Ollama is running
            const response = await fetch(`${this.host}/api/tags`, {
                method: 'GET',
                timeout: 5000
            });

            return response.ok;
        } catch (error) {
            return false;
        }
    }

    /**
     * List available models
     * @returns {Promise<Array>} Available models
     */
    async listModels() {
        try {
            const { default: fetch } = await import('node-fetch');

            const response = await fetch(`${this.host}/api/tags`, {
                method: 'GET',
                timeout: this.timeout
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch models: ${response.status}`);
            }

            const data = await response.json();
            return data.models || [];
        } catch (error) {
            this.handleError(error, 'listModels');
        }
    }

    /**
     * Pull a model from Ollama registry
     * @param {string} modelName - Name of the model to pull
     * @returns {Promise<boolean>} Success status
     */
    async pullModel(modelName) {
        try {
            const { default: fetch } = await import('node-fetch');

            const response = await fetch(`${this.host}/api/pull`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: modelName
                }),
                timeout: 300000 // 5 minutes for model pulling
            });

            return response.ok;
        } catch (error) {
            this.handleError(error, 'pullModel');
        }
    }

    /**
     * Check if a specific model is available
     * @param {string} modelName - Name of the model to check
     * @returns {Promise<boolean>} Model availability
     */
    async hasModel(modelName) {
        try {
            const models = await this.listModels();
            return models.some(model => model.name === modelName);
        } catch (error) {
            return false;
        }
    }

    /**
     * Get model information
     * @param {string} modelName - Name of the model
     * @returns {Promise<Object>} Model information
     */
    async getModelInfo(modelName) {
        try {
            const { default: fetch } = await import('node-fetch');

            const response = await fetch(`${this.host}/api/show`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: modelName
                }),
                timeout: this.timeout
            });

            if (!response.ok) {
                throw new Error(`Failed to get model info: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            this.handleError(error, 'getModelInfo');
        }
    }

    /**
     * Get common/popular models
     * @returns {Array} Array of popular model names
     */
    getPopularModels() {
        return [
            'qwen2.5-coder:latest',
            'llama3.1:latest',
            'mistral:latest',
            'codellama:latest',
            'deepseek-coder:latest',
            'phi3:latest',
            'gemma2:latest'
        ];
    }
}

export default OllamaConnector;
