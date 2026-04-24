import { CanvasApiError } from '../errors.js';

/**
 * Agent management and prompting.
 */
export class AgentsResource {
    /** @param {import('../HttpClient.js').HttpClient} http */
    constructor(http) {
        this.#http = http;
    }

    #http;

    // ── CRUD ───────────────────────────────────────────────────────────────

    list(params)   { return this.#http.get('/agents', params); }
    get(id)        { return this.#http.get(`/agents/${id}`); }
    create(config) { return this.#http.post('/agents', config); }
    update(id, data) { return this.#http.put(`/agents/${id}`, data); }
    delete(id)     { return this.#http.delete(`/agents/${id}`); }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    start(id)   { return this.#http.post(`/agents/${id}/start`); }
    stop(id)    { return this.#http.post(`/agents/${id}/stop`); }
    restart(id) { return this.#http.post(`/agents/${id}/restart`); }
    status(id)  { return this.#http.get(`/agents/${id}/status`); }

    // ── Prompting ──────────────────────────────────────────────────────────

    /**
     * Send a prompt and wait for the full response.
     * @param {string} agentId
     * @param {string} message
     */
    prompt(agentId, message) {
        return this.#http.post(`/agents/${agentId}/prompt`, { message });
    }

    /**
     * Stream a prompt response via Server-Sent Events.
     * Yields parsed event objects as they arrive.
     *
     * Event types: start, chunk, thinking, tool_start, tool_end, complete, error
     *
     * @example
     * for await (const event of client.agents.stream(agentId, 'Hello')) {
     *   if (event.type === 'chunk') process.stdout.write(event.delta);
     * }
     *
     * @param {string} agentId
     * @param {string} message
     * @returns {AsyncGenerator<object>}
     */
    async *stream(agentId, message) {
        const response = await this.#http.stream(`/agents/${agentId}/prompt/stream`, { message });
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
                    try { yield JSON.parse(raw); } catch { /* malformed chunk */ }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }
}
