'use strict';

/**
 * Coded workspace errors. Mirrors the context errors.js pattern: callers
 * (REST routes, ws handlers) branch on `.code` / `.statusCode` instead of
 * string-matching messages, so they can tell a transient "not ready"
 * condition from a permanent "forbidden"/"not found".
 */
export const WorkspaceErrorCode = {
    ACCESS_DENIED: 'ACCESS_DENIED',             // 403 — caller lacks permission
    WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND', // 404 — no such workspace for this user
    WORKSPACE_NOT_READY: 'WORKSPACE_NOT_READY', // 503 — workspace down/not instantiable (retry)
    NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',         // 501 — e.g. remote workspace resolution
};

function coded(message, code, statusCode, retryable = false) {
    const err = new Error(message);
    err.code = code;
    err.statusCode = statusCode;
    err.retryable = retryable;
    return err;
}

export const accessDenied = (message) =>
    coded(message, WorkspaceErrorCode.ACCESS_DENIED, 403);

export const workspaceNotFound = (message) =>
    coded(message, WorkspaceErrorCode.WORKSPACE_NOT_FOUND, 404);

export const workspaceNotReady = (message) =>
    coded(message, WorkspaceErrorCode.WORKSPACE_NOT_READY, 503, true);

export const notImplemented = (message) =>
    coded(message, WorkspaceErrorCode.NOT_IMPLEMENTED, 501);
