'use strict';

/*
 * Console adapter — dev fallback. Always available so notify() has a
 * deliverable target before any real channel is configured.
 */
export class ConsoleAdapter {
    #logger;

    constructor({ logger = console } = {}) {
        this.#logger = logger;
    }

    get name() { return 'console'; }

    async sendText(recipient, text) {
        const line = `[notify:console] to=${recipient || 'user'}: ${text}`;
        (this.#logger.info || this.#logger.log).call(this.#logger, line);
        return { delivered: true };
    }
}

export default ConsoleAdapter;
