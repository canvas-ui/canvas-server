/**
 * Thrown when the Canvas server returns an error response or a request fails.
 */
export class CanvasApiError extends Error {
    /**
     * @param {string} message
     * @param {number} statusCode
     * @param {object} [body] - Raw response body
     */
    constructor(message, statusCode, body) {
        super(message);
        this.name = 'CanvasApiError';
        this.statusCode = statusCode;
        this.body = body ?? null;
    }
}
