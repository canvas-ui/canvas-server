'use strict';

import BaseLLMConnector from './BaseLLMConnector.js';

/**
 * OpenAI GPT LLM Connector
 */
class OpenAIConnector extends BaseLLMConnector {

    constructor(config) {
        super(config);

        this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
        this.model = config.model || 'gpt-4o';
        this.maxTokens = config.maxTokens || 4096;
        this.baseURL = config.baseURL || 'https://api.openai.com/v1';

        // Validate configuration
        this.validateConfig(['apiKey']);
    }

    /**
     * Chat with GPT
     * @param {Array} messages - Array of message objects
     * @param {Object} options - Chat options
     * @returns {Promise<Object>} Response object
     */
    async chat(messages, options = {}) {
        try {
            if (!this.apiKey) {
                throw new Error('OpenAI API key not configured');
            }

            const { default: fetch } = await import('node-fetch');

            const formattedMessages = this.formatMessages(messages);
            const model = options.model || this.model;
            const maxTokens = options.maxTokens || this.maxTokens;

            const requestBody = {
                model: model,
                messages: formattedMessages,
                max_tokens: maxTokens,
                temperature: options.temperature || 0.7,
                top_p: options.topP || 1.0,
                frequency_penalty: options.frequencyPenalty || 0.0,
                presence_penalty: options.presencePenalty || 0.0
            };

            const response = await fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
            }

            const data = await response.json();

            return {
                content: data.choices[0]?.message?.content || '',
                usage: data.usage,
                model: data.model,
                metadata: {
                    provider: 'openai',
                    model: data.model,
                    usage: data.usage,
                    finish_reason: data.choices[0]?.finish_reason
                }
            };
        } catch (error) {
            this.handleError(error, 'chat');
        }
    }

    /**
     * Chat with GPT using streaming
     * @param {Array} messages - Array of message objects
     * @param {Object} options - Chat options
     * @param {Function} onChunk - Callback for each streaming chunk
     * @returns {Promise<Object>} Final response object
     */
    async chatStream(messages, options = {}, onChunk = () => {}) {
        try {
            if (!this.apiKey) {
                throw new Error('OpenAI API key not configured');
            }

            const { default: fetch } = await import('node-fetch');

            const formattedMessages = this.formatMessages(messages);
            const model = options.model || this.model;
            const maxTokens = options.maxTokens || this.maxTokens;

            const requestBody = {
                model: model,
                messages: formattedMessages,
                max_tokens: maxTokens,
                temperature: options.temperature || 0.7,
                top_p: options.topP || 1.0,
                frequency_penalty: options.frequencyPenalty || 0.0,
                presence_penalty: options.presencePenalty || 0.0,
                stream: true
            };

            const response = await fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
            }

            let fullContent = '';
            let usage = null;
            let responseModel = model;
            let finishReason = null;

            // Process the streaming response
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\n');

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') continue;

                            try {
                                const data = JSON.parse(dataStr);

                                if (data.choices?.[0]?.delta?.content) {
                                    const textChunk = data.choices[0].delta.content;
                                    fullContent += textChunk;

                                    // Call the chunk callback
                                    onChunk({
                                        type: 'content',
                                        content: textChunk,
                                        delta: textChunk
                                    });
                                }

                                if (data.choices?.[0]?.finish_reason) {
                                    finishReason = data.choices[0].finish_reason;
                                }

                                if (data.usage) {
                                    usage = data.usage;
                                }

                                if (data.model) {
                                    responseModel = data.model;
                                }
                            } catch (parseError) {
                                // Ignore parse errors for malformed chunks
                                continue;
                            }
                        }
                    }
                }
            } finally {
                reader.releaseLock();
            }

            return {
                content: fullContent,
                usage: usage,
                model: responseModel,
                metadata: {
                    provider: 'openai',
                    model: responseModel,
                    usage: usage,
                    finish_reason: finishReason
                }
            };
        } catch (error) {
            this.handleError(error, 'chatStream');
        }
    }

    /**
     * Check if OpenAI is available
     * @returns {Promise<boolean>} Availability status
     */
    async isAvailable() {
        try {
            if (!this.apiKey) {
                return false;
            }

            // Simple test call to check API connectivity
            const { default: fetch } = await import('node-fetch');

            const response = await fetch(`${this.baseURL}/models`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                }
            });

            return response.ok;
        } catch (error) {
            return false;
        }
    }

    /**
     * Format messages for OpenAI API
     * @param {Array} messages - Input messages
     * @returns {Array} Formatted messages
     */
    formatMessages(messages) {
        return messages.map(msg => ({
            role: msg.role, // OpenAI supports system, user, assistant roles
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        }));
    }

    /**
     * Get available models
     * @returns {Array} Array of available models
     */
    getAvailableModels() {
        return [
            'gpt-4o',
            'gpt-4o-mini',
            'gpt-4-turbo',
            'gpt-4',
            'gpt-3.5-turbo',
            'gpt-3.5-turbo-16k'
        ];
    }

    /**
     * List models from OpenAI API
     * @returns {Promise<Array>} Available models from API
     */
    async listModels() {
        try {
            if (!this.apiKey) {
                throw new Error('OpenAI API key not configured');
            }

            const { default: fetch } = await import('node-fetch');

            const response = await fetch(`${this.baseURL}/models`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch models: ${response.status}`);
            }

            const data = await response.json();
            return data.data.map(model => ({
                id: model.id,
                created: model.created,
                owned_by: model.owned_by
            }));
        } catch (error) {
            this.handleError(error, 'listModels');
        }
    }
}

export default OpenAIConnector;
