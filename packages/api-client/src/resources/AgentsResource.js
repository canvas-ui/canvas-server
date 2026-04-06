import { CanvasApiError } from '../errors.js';

/**
 * AI agent management, chat, and MCP tool access.
 */
export class AgentsResource {
    /**
     * @param {import('../HttpClient.js').HttpClient} http
     */
    constructor(http) {
        this.#http = http;
    }

    #http;

    // ── Agent CRUD ─────────────────────────────────────────────────────────

    list(params) {
        return this.#http.get('/agents', params);
    }

    /** @param {string} id */
    get(id) {
        return this.#http.get(`/agents/${id}`);
    }

    /**
     * @param {object} config
     */
    create(config) {
        return this.#http.post('/agents', config);
    }

    /** @param {string} id */
    delete(id) {
        return this.#http.delete(`/agents/${id}`);
    }

    // ── Chat ───────────────────────────────────────────────────────────────

    /**
     * Send a message and receive a complete response (non-streaming).
     *
     * @param {string} agentId
     * @param {string|object} message - Plain string or a message object
     * @returns {Promise<{ data: object }>}
     */
    chat(agentId, message) {
        const body = typeof message === 'string' ? { message } : message;
        return this.#http.post(`/agents/${agentId}/chat`, body);
    }

    /**
     * Stream a chat response via Server-Sent Events.
     * Returns an async generator that yields parsed chunks as they arrive.
     *
     * @example
     * for await (const chunk of client.agents.chatStream(agentId, 'Hello')) {
     *   process.stdout.write(chunk.delta ?? '');
     * }
     *
     * @param {string} agentId
     * @param {string|object} message
     * @returns {AsyncGenerator<object>}
     */
    async *chatStream(agentId, message) {
        const body = typeof message === 'string' ? { message } : message;
        const response = await this.#http.stream(`/agents/${agentId}/chat/stream`, body);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') return;
                    try {
                        yield JSON.parse(raw);
                    } catch {
                        // Malformed chunk — skip
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    // ── Memory ─────────────────────────────────────────────────────────────

    /**
     * @param {string} agentId
     * @param {object} [params]
     */
    memory(agentId, params) {
        return this.#http.get(`/agents/${agentId}/memory`, params);
    }

    // ── MCP Tools ──────────────────────────────────────────────────────────

    mcp = {
        /**
         * List available MCP tools for an agent.
         * @param {string} agentId
         */
        tools: (agentId) => this.#http.get(`/agents/${agentId}/mcp/tools`),

        /**
         * Call an MCP tool.
         * @param {string} agentId
         * @param {string} toolName
         * @param {object} [args]
         */
        call: (agentId, toolName, args) =>
            this.#http.post(`/agents/${agentId}/mcp/tools/${toolName}`, args ?? {}),
    };
}
