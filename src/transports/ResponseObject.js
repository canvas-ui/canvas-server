'use strict';

export default class ResponseObject {
    constructor() {
        this.status = 'error';
        this.statusCode = 500;
        this.message = null;
        this.payload = null;
        this.count = null;
        this.totalCount = null;
        // Optional diagnostic payload (e.g. search calibration data); only
        // serialized when set, so existing responses are unchanged.
        this.debug = null;
        // Optional per-line match counts (compound search); same opt-in rule.
        this.lines = null;
        // Optional machine-readable error code (e.g. WORKSPACE_NOT_ACTIVE), for
        // conditions a client must react to rather than just display. Same
        // opt-in rule: only serialized when set.
        this.code = null;
    }

    /**
     * Canonical "this workspace exists but is stopped" condition.
     *
     * Clients act on this one — a query against a sleeping workspace starts it
     * and replays itself — so it must look identical no matter which route
     * noticed. Match on `code`; the message is stable but is for humans.
     */
    static WORKSPACE_NOT_ACTIVE = 'WORKSPACE_NOT_ACTIVE';
    static WORKSPACE_NOT_ACTIVE_MESSAGE = 'Workspace is not active. Start the workspace first.';

    /**
     * True for the error Workspace throws from its own guards (`Workspace not
     * active`), so a catch block can map it to the canonical response instead
     * of a 500. Deliberately narrow: `Agent is not active` must not match.
     */
    static isWorkspaceNotActiveError(error) {
        return /workspace (is )?not active/i.test(error?.message || '');
    }

    // Static factories — allows `ResponseObject.error(msg)` without `new`
    static success(payload, message, statusCode, count, totalCount) { return new ResponseObject().success(payload, message, statusCode, count, totalCount); }
    static created(payload, message, statusCode, count) { return new ResponseObject().created(payload, message, statusCode, count); }
    static found(payload, message, statusCode, count, totalCount) { return new ResponseObject().found(payload, message, statusCode, count, totalCount); }
    static updated(payload, message, statusCode, count) { return new ResponseObject().updated(payload, message, statusCode, count); }
    static deleted(payload, message, statusCode, count) { return new ResponseObject().deleted(payload, message, statusCode, count); }
    static error(message, payload, statusCode) { return new ResponseObject().error(message, payload, statusCode); }
    static notFound(message, payload, statusCode) { return new ResponseObject().notFound(message, payload, statusCode); }
    static badRequest(message, payload, statusCode) { return new ResponseObject().badRequest(message, payload, statusCode); }
    static unauthorized(message, payload, statusCode) { return new ResponseObject().unauthorized(message, payload, statusCode); }
    static forbidden(message, payload, statusCode) { return new ResponseObject().forbidden(message, payload, statusCode); }
    static conflict(message, payload, statusCode) { return new ResponseObject().conflict(message, payload, statusCode); }
    static workspaceNotActive(payload) { return new ResponseObject().workspaceNotActive(payload); }
    static serverError(message, payload, statusCode) { return new ResponseObject().serverError(message, payload, statusCode); }
    static tooManyRequests(message, payload, statusCode) { return new ResponseObject().tooManyRequests(message, payload, statusCode); }

    /**
     * Map a thrown error to a response by its `statusCode` (set on coded errors
     * like the context errors). Lets routes drop message string-matching:
     *   403 → forbidden, 404 → notFound, 503 → retryable error,
     *   anything else → generic 500 with `fallbackMessage`.
     */
    static fromError(error, fallbackMessage = 'Request failed') {
        // Coded errors from the core carry no statusCode, but they are just as
        // much the caller's problem as a 404 — surface them rather than hiding
        // them behind a generic 500. `cause` is checked too because batch paths
        // (putMany) rewrap per-item failures with index context.
        const code = error?.code || error?.cause?.code;
        // The caller named a document id that does not exist.
        if (code === 'ENODOCUMENT') { return new ResponseObject().notFound(error.message); }
        // A connector source refused a write-through (revoked token, missing
        // scope, object deleted upstream): 502, with the reason it gave.
        if (code === 'ECONNECTORWRITE') { return new ResponseObject().error(error.message, null, 502); }

        switch (error?.statusCode) {
            case 403: return new ResponseObject().forbidden(error.message);
            case 404: return new ResponseObject().notFound(error.message);
            case 503: return new ResponseObject().error(error.message, { retryable: true }, 503);
            default:  return new ResponseObject().error(fallbackMessage);
        }
    }

    // Success: Generic success
    success(payload, message = 'Request successful', statusCode = 200, count = null, totalCount = null) {
        this.status = 'success';
        this.statusCode = statusCode;
        this.message = message;
        this.payload = payload;
        this.count = count;
        this.totalCount = totalCount;
        return this;
    }

    // Create: Successful creation of a resource
    created(payload, message = 'Resource created successfully', statusCode = 201, count = null) {
        this.status = 'success';
        this.statusCode = statusCode;
        this.message = message;
        this.payload = payload;
        this.count = count;
        return this;
    }

    // Read: Successful retrieval of a resource
    found(payload, message = 'Resource found', statusCode = 200, count = null, totalCount = null) {
        this.status = 'success';
        this.statusCode = statusCode;
        this.message = message;
        this.payload = payload;
        this.count = count;
        this.totalCount = totalCount;
        return this;
    }

    // Update: Successful update of a resource
    updated(payload, message = 'Resource updated successfully', statusCode = 200, count = null) {
        this.status = 'success';
        this.statusCode = statusCode;
        this.message = message;
        this.payload = payload;
        this.count = count;
        return this;
    }

    // Delete: Successful deletion of a resource
    deleted(payload, message = 'Resource deleted successfully', statusCode = 200, count = null) {
        this.status = 'success';
        this.statusCode = statusCode;
        this.message = message;
        this.payload = payload;
        this.count = count;
        return this;
    }

    // Not Found: Resource not found
    notFound(message = 'Resource not found', payload = null, statusCode = 404) {
        this.status = 'error';
        this.statusCode = statusCode;
        this.message = message;
        this.payload = payload;
        return this;
    }

    // Error: Generic error
    error(message, payload = null, statusCode = 500) {
        this.status = 'error';
        this.statusCode = statusCode;
        this.message = message;
        this.payload = payload;
        return this;
    }

    // Bad Request: Invalid request payload
    badRequest(message = 'Invalid request payload', payload = null, statusCode = 400) {
        this.status = 'error';
        this.statusCode = statusCode;
        this.message = message;
        this.payload = payload;
        return this;
    }

    // Unauthorized: Authentication required
    unauthorized(message = 'Authentication required', payload = null, statusCode = 401) {
        this.status = 'error';
        this.statusCode = statusCode;
        this.message = message;
        this.payload = payload;
        return this;
    }

    // Forbidden: Insufficient permissions
    forbidden(message = 'Insufficient permissions', payload = null, statusCode = 403) {
        this.status = 'error';
        this.statusCode = statusCode;
        this.message = message;
        this.payload = payload;
        return this;
    }

    // Conflict: Conflict in request, such as duplicate payload
    conflict(message = 'Conflict in request', payload = null, statusCode = 409) {
        this.status = 'error';
        this.statusCode = statusCode;
        this.message = message;
        this.payload = payload;
        return this;
    }

    // Workspace Not Active: the workspace exists and the caller may use it, it
    // just isn't running. 409 (not 400/404/500) — the request is well formed
    // and the resource exists; it conflicts with the workspace's current state.
    // The message is a fixed string on purpose: identical bytes from every
    // route is the whole point.
    workspaceNotActive(payload = null) {
        this.status = 'error';
        this.statusCode = 409;
        this.message = ResponseObject.WORKSPACE_NOT_ACTIVE_MESSAGE;
        this.payload = payload;
        this.code = ResponseObject.WORKSPACE_NOT_ACTIVE;
        return this;
    }

    // Server Error: Internal server error
    serverError(message = 'Internal server error', payload = null, statusCode = 500) {
        this.status = 'error';
        this.statusCode = statusCode;
        this.message = message;
        this.payload = payload;
        return this;
    }

    // Too Many Requests: Rate limit exceeded
    tooManyRequests(message = 'Too many requests, please try again later', payload = null, statusCode = 429) {
        this.status = 'error';
        this.statusCode = statusCode;
        this.message = message;
        this.payload = payload;
        return this;
    }

    // Method to get the final response object
    getResponse() {
        return {
            status: this.status,
            statusCode: this.statusCode,
            message: this.message,
            payload: this.payload,
            count: this.count,
            totalCount: this.totalCount,
            ...(this.debug != null ? { debug: this.debug } : {}),
            ...(this.lines != null ? { lines: this.lines } : {}),
            ...(this.code != null ? { code: this.code } : {}),
        };
    }
}
