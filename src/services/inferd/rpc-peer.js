'use strict';

/*
 * Wire protocol for the inferd socket — the canvas-server half.
 *
 * This is deliberately a COPY of canvas-inferd/src/rpc/*.js, not an import.
 * Importing it would put canvas-inferd (and with it onnxruntime, transformers.js
 * and a native model runtime) back into this package's dependency tree, which
 * is exactly what moving inference out of process was for. A protocol boundary
 * having an implementation on each side is the normal shape; the two files are
 * small and stable, and they must be changed together.
 */

import { EventEmitter } from 'node:events';
import { encodeFrame, FrameDecoder } from './rpc-codec.js';

/**
 * RpcPeer — a symmetric request/response peer over one duplex stream.
 *
 * Deliberately symmetric rather than client/server: inferd needs to call the
 * server as much as the server calls inferd. Embedding a document is
 * server → `enqueue`, then inferd → `resolveInput` for the bytes, then inferd →
 * `storeVectors` with the result. A one-way client could only poll for that.
 *
 * Wire shape (see codec.js for framing):
 *   { t: 'req', id, method, params }
 *   { t: 'res', id, result }
 *   { t: 'res', id, error: { message, code, stack } }
 *
 * Errors cross the wire as data and are rethrown on the calling side with the
 * remote's message and code — a caller should not have to care which process
 * refused it, only why.
 */
export class RpcPeer extends EventEmitter {
    #stream;
    #decoder = new FrameDecoder();
    #handlers = new Map();
    #pending = new Map();
    #nextId = 1;
    #closed = false;
    #label;

    constructor(stream, { label = 'rpc' } = {}) {
        super();
        this.#stream = stream;
        this.#label = label;

        stream.on('data', (chunk) => {
            let messages;
            try {
                messages = this.#decoder.push(chunk);
            } catch (error) {
                this.emit('error', error);
                this.destroy(error);
                return;
            }
            for (const message of messages) { this.#dispatch(message); }
        });
        stream.on('error', (error) => { this.emit('error', error); this.#failPending(error); });
        stream.on('close', () => this.#onClose());
        stream.on('end', () => this.#onClose());
    }

    get closed() { return this.#closed; }

    /** Register a method this peer answers. */
    handle(method, fn) { this.#handlers.set(method, fn); return this; }

    /** Register many at once — `{ name: fn }`. */
    handleAll(methods = {}) {
        for (const [name, fn] of Object.entries(methods)) {
            if (typeof fn === 'function') { this.handle(name, fn); }
        }
        return this;
    }

    /** Call a method on the other side. Resolves with its return value. */
    call(method, params = []) {
        if (this.#closed) {
            return Promise.reject(new Error(`${this.#label}: peer is closed (calling ${method})`));
        }
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject, method });
            try {
                this.#stream.write(encodeFrame({ t: 'req', id, method, params }));
            } catch (error) {
                this.#pending.delete(id);
                reject(error);
            }
        });
    }

    async #dispatch(message) {
        if (message?.t === 'res') {
            const pending = this.#pending.get(message.id);
            if (!pending) { return; } // a response to a call we already gave up on
            this.#pending.delete(message.id);
            if (message.error) { pending.reject(RpcPeer.#rehydrate(message.error, pending.method)); }
            else { pending.resolve(message.result); }
            return;
        }
        if (message?.t !== 'req') { return; }

        const handler = this.#handlers.get(message.method);
        if (!handler) {
            this.#respond(message.id, null, new Error(`${this.#label}: no handler for "${message.method}"`));
            return;
        }
        try {
            const result = await handler(...(Array.isArray(message.params) ? message.params : []));
            this.#respond(message.id, result ?? null, null);
        } catch (error) {
            this.#respond(message.id, null, error);
        }
    }

    #respond(id, result, error) {
        if (this.#closed) { return; }
        const payload = error
            ? { t: 'res', id, error: { message: error.message, code: error.code, stack: error.stack } }
            : { t: 'res', id, result };
        try {
            this.#stream.write(encodeFrame(payload));
        } catch (writeError) {
            // A result too large to frame is still a failed call — tell the
            // caller, or it waits forever on a response that cannot be sent.
            if (!error) {
                this.#stream.write(encodeFrame({
                    t: 'res', id, error: { message: writeError.message, code: writeError.code },
                }));
            }
        }
    }

    static #rehydrate(wire, method) {
        const error = new Error(wire.message || `${method} failed`);
        if (wire.code) { error.code = wire.code; }
        // Keep the remote stack as a property: overwriting `stack` would hide
        // which local call site is actually blocked on this.
        if (wire.stack) { error.remoteStack = wire.stack; }
        return error;
    }

    #onClose() {
        if (this.#closed) { return; }
        this.#closed = true;
        this.#failPending(new Error(`${this.#label}: connection closed`));
        this.emit('close');
    }

    #failPending(error) {
        for (const [, pending] of this.#pending) { pending.reject(error); }
        this.#pending.clear();
    }

    destroy(error) {
        this.#closed = true;
        this.#failPending(error || new Error(`${this.#label}: destroyed`));
        try { this.#stream.destroy(); } catch { /* already gone */ }
    }
}

export default RpcPeer;
