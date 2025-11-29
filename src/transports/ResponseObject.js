'use strict';

import crypto from 'crypto';

// This is a new file I'm creating to standardize our API responses.
export default class ResponseObject {
    constructor() {
        this.status = 'error'; // Default to error to ensure explicit success setting
        this.statusCode = 500; // Default to 500 Internal Server Error
        this.message = null;
        this.payload = null;
        this.count = null; // Initialize count property
        this.totalCount = null; // Initialize totalCount property
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
