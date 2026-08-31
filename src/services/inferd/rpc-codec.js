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

/**
 * Wire codec for the inferd RPC socket.
 *
 * Frames are length-prefixed rather than newline-delimited: the payloads carry
 * image bytes and vectors, and a scan-for-delimiter framing would have to
 * escape them. Each frame is a 4-byte big-endian byte length followed by that
 * many bytes of UTF-8 JSON.
 *
 * JSON cannot hold a Buffer or a Float32Array, and both are on the hot path
 * (document bytes in, chunk vectors out), so the encoder tags them and the
 * decoder restores them. Base64 costs a third more bytes than the raw form;
 * over a unix socket that is cheaper than the alternative of a second binary
 * channel to keep in sync with the JSON one.
 */

const HEADER_BYTES = 4;
// A frame larger than this is a bug (a runaway document, a corrupt length), not
// a legitimate payload — fail loudly instead of buffering until the box dies.
export const MAX_FRAME_BYTES = 256 * 1024 * 1024;

const BUFFER_TAG = '__inferd_buf__';
const FLOAT32_TAG = '__inferd_f32__';

function replacer(_key, value) {
    // Node serialises a Buffer as {type:'Buffer',data:[...]} — one number per
    // byte, which is ruinous for anything image-sized. Tag it instead.
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
        return { [BUFFER_TAG]: Buffer.from(value.data).toString('base64') };
    }
    return value;
}

function reviver(_key, value) {
    if (value && typeof value === 'object') {
        if (typeof value[BUFFER_TAG] === 'string') {
            return Buffer.from(value[BUFFER_TAG], 'base64');
        }
        if (typeof value[FLOAT32_TAG] === 'string') {
            const buf = Buffer.from(value[FLOAT32_TAG], 'base64');
            // byteOffset matters: Buffer.from(base64) may sit inside a pooled
            // ArrayBuffer, so a bare `new Float32Array(buf.buffer)` would read
            // whatever else the pool holds.
            return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        }
    }
    return value;
}

// Typed arrays have to be tagged before JSON.stringify sees them: the replacer
// receives the already-plain object form for a TypedArray ({"0":…,"1":…}), by
// which point the values are gone.
function prepare(value) {
    if (value instanceof Float32Array) {
        return { [FLOAT32_TAG]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
    }
    if (Buffer.isBuffer(value)) {
        return { [BUFFER_TAG]: value.toString('base64') };
    }
    if (Array.isArray(value)) { return value.map(prepare); }
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        const out = {};
        for (const [key, inner] of Object.entries(value)) { out[key] = prepare(inner); }
        return out;
    }
    return value;
}

export function encodeFrame(message) {
    const json = Buffer.from(JSON.stringify(prepare(message), replacer), 'utf8');
    if (json.byteLength > MAX_FRAME_BYTES) {
        throw new Error(`inferd rpc frame too large: ${json.byteLength} bytes`);
    }
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32BE(json.byteLength, 0);
    return Buffer.concat([header, json], HEADER_BYTES + json.byteLength);
}

/**
 * Incremental frame reader. A socket hands over arbitrary chunk boundaries, so
 * this buffers until a whole frame is present and yields complete messages.
 */
export class FrameDecoder {
    #chunks = [];
    #buffered = 0;

    push(chunk) {
        this.#chunks.push(chunk);
        this.#buffered += chunk.byteLength;

        const messages = [];
        for (;;) {
            if (this.#buffered < HEADER_BYTES) { break; }
            const buf = this.#coalesce();
            const length = buf.readUInt32BE(0);
            if (length > MAX_FRAME_BYTES) {
                throw new Error(`inferd rpc frame too large: ${length} bytes`);
            }
            if (this.#buffered < HEADER_BYTES + length) { break; }
            messages.push(JSON.parse(buf.subarray(HEADER_BYTES, HEADER_BYTES + length).toString('utf8'), reviver));
            const rest = buf.subarray(HEADER_BYTES + length);
            this.#chunks = rest.byteLength ? [rest] : [];
            this.#buffered = rest.byteLength;
        }
        return messages;
    }

    #coalesce() {
        if (this.#chunks.length === 1) { return this.#chunks[0]; }
        const joined = Buffer.concat(this.#chunks, this.#buffered);
        this.#chunks = [joined];
        return joined;
    }
}
