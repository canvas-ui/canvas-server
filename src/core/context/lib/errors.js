'use strict';

/**
 * Coded context errors. Callers (REST routes, ws handlers) branch on `.code`
 * / `.statusCode` instead of string-matching messages, so they can tell a
 * transient "not ready" condition from a permanent "forbidden"/"not found".
 */
export const ContextErrorCode = {
    ACCESS_DENIED: 'ACCESS_DENIED',       // 403 — caller lacks permission
    CONTEXT_NOT_FOUND: 'CONTEXT_NOT_FOUND', // 404 — no such context for this user
    WORKSPACE_NOT_READY: 'WORKSPACE_NOT_READY', // 503 — workspace down/starting (retry)
};

function coded(message, code, statusCode, retryable = false) {
    const err = new Error(message);
    err.code = code;
    err.statusCode = statusCode;
    err.retryable = retryable;
    return err;
}

export const accessDenied = (message) =>
    coded(message, ContextErrorCode.ACCESS_DENIED, 403);

export const contextNotFound = (message) =>
    coded(message, ContextErrorCode.CONTEXT_NOT_FOUND, 404);

export const workspaceNotReady = (message) =>
    coded(message, ContextErrorCode.WORKSPACE_NOT_READY, 503, true);
