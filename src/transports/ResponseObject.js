'use strict';

export default class ResponseObject {
    constructor() {
        this.status = 'error';
        this.statusCode = 500;
        this.message = null;
        this.payload = null;
        this.count = null;
        this.totalCount = null;
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
    static serverError(message, payload, statusCode) { return new ResponseObject().serverError(message, payload, statusCode); }
    static tooManyRequests(message, payload, statusCode) { return new ResponseObject().tooManyRequests(message, payload, statusCode); }

    /**
     * Map a thrown error to a response by its `statusCode` (set on coded errors
     * like the context errors). Lets routes drop message string-matching:
     *   403 → forbidden, 404 → notFound, 503 → retryable error,
     *   anything else → generic 500 with `fallbackMessage`.
     */
    static fromError(error, fallbackMessage = 'Request failed') {
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
        };
    }
}
