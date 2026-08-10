'use strict';

import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { generateNanoid } from '../../../utils/id.js';

/**
 * SSH Key Management Helpers
 * Provides functions to manage SSH public keys for users
 */

/**
 * Parse SSH public key
 * @param {string} keyString - SSH public key string
 * @returns {Object} Parsed key { type, keyData, comment }
 */
function parseSSHPublicKey(keyString) {
    const trimmed = keyString.trim();
    const parts = trimmed.split(/\s+/);

    if (parts.length < 2) {
        throw new Error('Invalid SSH public key format');
    }

    const keyType = parts[0];
    const keyData = parts[1];
    const comment = parts.slice(2).join(' ') || '';

    // Validate key type
    const validTypes = ['ssh-rsa', 'ssh-dss', 'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'];
    if (!validTypes.includes(keyType)) {
        throw new Error(`Invalid SSH key type: ${keyType}. Must be one of: ${validTypes.join(', ')}`);
    }

    // Validate key data is base64
    try {
        Buffer.from(keyData, 'base64');
    } catch  {
        throw new Error('Invalid SSH key data: not valid base64');
    }

    return {
        type: keyType,
        keyData,
        comment
    };
}

/**
 * Generate SSH key fingerprint (SHA256)
 * @param {string} keyData - Base64 encoded key data
 * @returns {string} SHA256 fingerprint in format SHA256:xxx
 */
function getSSHKeyFingerprint(keyData) {
    const keyBuffer = Buffer.from(keyData, 'base64');
    const hash = crypto.createHash('sha256').update(keyBuffer).digest('base64');
    // Remove padding and format like OpenSSH
    return `SHA256:${hash.replace(/=+$/, '')}`;
}

/**
 * Get MD5 fingerprint (legacy format for compatibility)
 * @param {string} keyData - Base64 encoded key data
 * @returns {string} MD5 fingerprint in format aa:bb:cc:...
 */
function getMD5Fingerprint(keyData) {
    const keyBuffer = Buffer.from(keyData, 'base64');
    const hash = crypto.createHash('md5').update(keyBuffer).digest('hex');
    return hash.match(/.{2}/g).join(':');
}

/**
 * Ensure .ssh directory exists with proper permissions
 * @param {string} userHomePath - User home directory path
 * @returns {Promise<string>} SSH directory path
 */
async function ensureSSHDirectory(userHomePath) {
    const sshDir = path.join(userHomePath, '.ssh');

    if (!existsSync(sshDir)) {
        await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });
    } else {
        // Ensure proper permissions
        await fs.chmod(sshDir, 0o700);
    }

    return sshDir;
}

/**
 * Write authorized_keys file
 * @param {string} userHomePath - User home directory path
 * @param {Array} keys - Array of SSH key objects
 * @returns {Promise<void>}
 */
async function writeAuthorizedKeys(userHomePath, keys) {
    const sshDir = await ensureSSHDirectory(userHomePath);
    const authorizedKeysPath = path.join(sshDir, 'authorized_keys');

    // Build authorized_keys content
    const lines = keys.map(key => {
        const comment = key.name ? `# ${key.name} (${key.id})` : `# ${key.id}`;
        const keyLine = `${key.type} ${key.keyData} ${key.comment || key.id}`;
        return `${comment}\n${keyLine}`;
    });

    const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');

    await fs.writeFile(authorizedKeysPath, content, { mode: 0o600 });
}

/**
 * Create SSH key helpers factory
 * @param {Object} users - Users service instance
 * @returns {Object} SSH key helper functions
 */
export function createSSHKeyHelpers(users) {

    /**
     * Get user's SSH keys from index store
     * @param {string} userId - User ID
     * @returns {Promise<Array>} Array of SSH key objects
     * @private
     */
    async function getUserSSHKeys(userId) {
        const userData = users._getIndexStore().get(userId);
        if (!userData) {
            throw new Error(`User not found: ${userId}`);
        }
        return userData.sshKeys || [];
    }

    /**
     * Update user's SSH keys in index store
     * @param {string} userId - User ID
     * @param {Array} keys - Array of SSH key objects
     * @returns {Promise<void>}
     * @private
     */
    async function updateUserSSHKeys(userId, keys) {
        const userData = users._getIndexStore().get(userId);
        if (!userData) {
            throw new Error(`User not found: ${userId}`);
        }

        userData.sshKeys = keys;
        userData.updatedAt = new Date().toISOString();
        users._getIndexStore().set(userId, userData);

        // Write to filesystem
        const user = await users.get(userId);
        await writeAuthorizedKeys(user.homePath, keys);
    }

    return {
        /**
         * List all SSH keys for a user
         * @param {string} userId - User ID
         * @returns {Promise<Array>} Array of SSH key objects
         */
        async listKeys(userId) {
            return await getUserSSHKeys(userId);
        },

        /**
         * Get a specific SSH key
         * @param {string} userId - User ID
         * @param {string} keyId - Key ID
         * @returns {Promise<Object|null>} SSH key object or null
         */
        async getKey(userId, keyId) {
            const keys = await getUserSSHKeys(userId);
            return keys.find(k => k.id === keyId) || null;
        },

        /**
         * Add SSH public key for user
         * @param {string} userId - User ID
         * @param {string} keyString - SSH public key string
         * @param {string} [name] - Optional key name/description
         * @returns {Promise<Object>} Added key object
         */
        async addKey(userId, keyString, name = null) {
            // Parse and validate key
            const parsed = parseSSHPublicKey(keyString);
            const fingerprint = getSSHKeyFingerprint(parsed.keyData);
            const md5Fingerprint = getMD5Fingerprint(parsed.keyData);

            // Get existing keys
            const keys = await getUserSSHKeys(userId);

            // Check for duplicate fingerprint
            const duplicate = keys.find(k => k.fingerprint === fingerprint);
            if (duplicate) {
                throw new Error('SSH key already exists for this user');
            }

            // Create key object
            const keyId = generateNanoid(12);
            const keyObj = {
                id: keyId,
                name: name || parsed.comment || 'Unnamed Key',
                type: parsed.type,
                keyData: parsed.keyData,
                comment: parsed.comment,
                fingerprint,
                md5Fingerprint,
                addedAt: new Date().toISOString(),
                lastUsed: null
            };

            // Add to keys array
            keys.push(keyObj);

            // Update in store and filesystem
            await updateUserSSHKeys(userId, keys);

            return keyObj;
        },

        /**
         * Remove SSH key
         * @param {string} userId - User ID
         * @param {string} keyId - Key ID
         * @returns {Promise<void>}
         */
        async removeKey(userId, keyId) {
            const keys = await getUserSSHKeys(userId);

            const keyIndex = keys.findIndex(k => k.id === keyId);
            if (keyIndex === -1) {
                throw new Error('SSH key not found');
            }

            // Remove key
            keys.splice(keyIndex, 1);

            // Update in store and filesystem
            await updateUserSSHKeys(userId, keys);
        },

        /**
         * Update key metadata (name, last used, etc.)
         * @param {string} userId - User ID
         * @param {string} keyId - Key ID
         * @param {Object} updates - Updates to apply
         * @returns {Promise<Object>} Updated key object
         */
        async updateKey(userId, keyId, updates) {
            const keys = await getUserSSHKeys(userId);

            const key = keys.find(k => k.id === keyId);
            if (!key) {
                throw new Error('SSH key not found');
            }

            // Apply updates (only allow certain fields)
            const allowedUpdates = ['name', 'lastUsed'];
            for (const field of allowedUpdates) {
                if (updates[field] !== undefined) {
                    key[field] = updates[field];
                }
            }

            key.updatedAt = new Date().toISOString();

            // Update in store and filesystem
            await updateUserSSHKeys(userId, keys);

            return key;
        }
    };
}
