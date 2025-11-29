'use strict';

import crypto from 'crypto';
import { createDebug } from '../../../utils/log/index.js';

const debug = createDebug('canvas-server:pub:token-auth');

/**
 * Token authentication helper for pub routes
 */

/**
 * Validate and extract token from request
 * @param {Object} request - Fastify request
 * @returns {string|null} Token value or null if not found
 */
export function extractToken(request) {
  // Check query parameter first
  if (request.query.token) {
    return request.query.token;
  }

  // Check Authorization header (Bearer token)
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    if (token.startsWith('canvas-')) {
      return token;
    }
  }

  return null;
}

/**
 * Create token hash for ACL lookup
 * @param {string} token - The token value
 * @returns {string} SHA256 hash with prefix
 */
export function createTokenHash(token) {
  return `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

/**
 * Validate token against resource ACL
 * @param {string} token - The token value
 * @param {Object} resourceACL - The resource ACL object
 * @param {string} requiredPermission - Required permission level
 * @returns {Object|null} Token data if valid, null otherwise
 */
export function validateToken(token, resourceACL, requiredPermission) {
  if (!token || !resourceACL || !resourceACL.tokens) {
    return null;
  }

  const tokenHash = createTokenHash(token);
  const tokenData = resourceACL.tokens[tokenHash];

  if (!tokenData) {
    debug(`Token not found in ACL: ${tokenHash.substring(0, 16)}...`);
    return null;
  }

  // Check expiration
  if (tokenData.expiresAt && new Date() > new Date(tokenData.expiresAt)) {
    debug(`Token has expired: ${tokenData.expiresAt}`);
    return null;
  }

  // Check usage limits for secret-link tokens
  if (tokenData.type === 'secret-link' && tokenData.maxUses) {
    if (tokenData.currentUses >= tokenData.maxUses) {
      debug(`Token has exceeded maximum uses: ${tokenData.currentUses}/${tokenData.maxUses}`);
      return null;
    }
  }

  // Check permissions
  if (!tokenData.permissions.includes(requiredPermission)) {
    debug(`Token lacks required permission. Has: ${tokenData.permissions}, needs: ${requiredPermission}`);
    return null;
  }

  return tokenData;
}

/**
 * Increment token usage for secret-link tokens
 * @param {string} token - The token value
 * @param {Object} resourceACL - The resource ACL object
 * @param {Function} updateACLFn - Function to update the ACL
 * @returns {Promise<boolean>} True if updated successfully
 */
export async function incrementTokenUsage(token, resourceACL, updateACLFn) {
  if (!token || !resourceACL || !resourceACL.tokens) {
    return false;
  }

  const tokenHash = createTokenHash(token);
  const tokenData = resourceACL.tokens[tokenHash];

  if (!tokenData || tokenData.type !== 'secret-link' || !tokenData.maxUses) {
    return true; // No need to increment for non-secret-link tokens
  }

  // Increment usage count
  tokenData.currentUses = (tokenData.currentUses || 0) + 1;
  resourceACL.tokens[tokenHash] = tokenData;

  try {
    await updateACLFn(resourceACL);
    debug(`Incremented token usage: ${tokenData.currentUses}/${tokenData.maxUses}`);
    return true;
  } catch (error) {
    debug(`Failed to increment token usage: ${error.message}`);
    return false;
  }
}

/**
 * Check if user can access resource via token
 * @param {Object} request - Fastify request
 * @param {Object} resourceACL - The resource ACL object
 * @param {string} requiredPermission - Required permission level
 * @returns {Object|null} Access info if valid, null otherwise
 */
export function checkTokenAccess(request, resourceACL, requiredPermission) {
  const token = extractToken(request);
  if (!token) {
    return null;
  }

  const tokenData = validateToken(token, resourceACL, requiredPermission);
  if (!tokenData) {
    return null;
  }

  return {
    token,
    tokenData,
    accessType: 'token'
  };
}
