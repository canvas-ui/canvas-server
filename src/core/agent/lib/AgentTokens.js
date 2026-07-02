'use strict';

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

/*
 * AgentTokens — token primitives for agent principals.
 *
 * Unlike WorkspaceTokens (which owns a config-store ACL map), agent tokens are
 * single-active-per-agent and their hash lives inside the agent's index entry
 * (entry.access.tokenHash). This module therefore only provides the pure
 * mint/hash/verify primitives; storage is owned by the Agents service.
 */

export const AGENT_TOKEN_PREFIX = 'canvas-agent-';

export const AGENT_TOKEN_PERMISSIONS = ['read', 'write'];

export function hashToken(tokenValue) {
    return `sha256:${crypto.createHash('sha256').update(tokenValue).digest('hex')}`;
}

export function isAgentToken(tokenValue) {
    return typeof tokenValue === 'string' && tokenValue.startsWith(AGENT_TOKEN_PREFIX);
}

/**
 * Mint a new agent token.
 * @param {Object} [options]
 * @param {string[]} [options.permissions]
 * @param {string|null} [options.expiresAt]
 * @returns {{ id: string, value: string, hash: string, permissions: string[], createdAt: string, expiresAt: string|null }}
 */
export function mintAgentToken(options = {}) {
    const permissions = normalizeAgentPermissions(options.permissions);
    const value = `${AGENT_TOKEN_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
    return {
        id: uuidv4(),
        value,
        hash: hashToken(value),
        permissions,
        createdAt: new Date().toISOString(),
        expiresAt: options.expiresAt || null,
    };
}

export function normalizeAgentPermissions(permissions) {
    const requested = Array.isArray(permissions) && permissions.length > 0
        ? permissions
        : ['read'];
    const normalized = [...new Set(requested.map((entry) => String(entry).toLowerCase().trim()))];
    for (const permission of normalized) {
        if (!AGENT_TOKEN_PERMISSIONS.includes(permission)) {
            throw new Error(`Invalid agent permission "${permission}" (allowed: ${AGENT_TOKEN_PERMISSIONS.join(', ')})`);
        }
    }
    return normalized;
}

/**
 * Verify a token value against a stored access record.
 * @param {string} tokenValue
 * @param {Object|null} access - agent access record ({ tokenHash, tokenExpiresAt? })
 * @returns {boolean}
 */
export function verifyAgentTokenValue(tokenValue, access) {
    if (!isAgentToken(tokenValue) || !access?.tokenHash) return false;
    const hash = hashToken(tokenValue);
    if (hash !== access.tokenHash) return false;
    if (access.tokenExpiresAt && new Date(access.tokenExpiresAt) < new Date()) return false;
    return true;
}
