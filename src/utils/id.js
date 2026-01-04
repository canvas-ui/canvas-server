import { ulid } from 'ulid';
import { v4 as uuidv4 } from 'uuid';
import { customAlphabet } from 'nanoid';
import { randomBytes } from 'node:crypto';

/**
 * Generate a UUID
 * @param {number} [length] - Length of the UUID
 * @param {string} [prefix] - Prefix for the UUID
 * @param {string} [delimiter='-'] - Delimiter between prefix and UUID
 * @returns {string} UUID
 */
function generateUUID(length, prefix, delimiter = '-') {
    const id = (length) ? uuidv4().replace(/-/g, '').slice(0, length) : uuidv4();
    return (prefix ? `${prefix}${delimiter}${id}` : id);
}

/**
 * Generate a ULID
 * @param {number} [length=12] - Length of the ULID
 * @param {string} [prefix] - Prefix for the ULID
 * @param {string} [delimiter='-'] - Delimiter between prefix and ULID
 * @returns {string} ULID
 */
function generateULID(length = 12, prefix, delimiter = '-') {
    const id = ulid().replace(/-/g, '').slice(0, length).toLowerCase();
    return (prefix ? `${prefix}${delimiter}${id}` : id);
}

/**
 * Generate a nanoid
 * @param {number} [length=12] - Length of the nanoid
 * @param {string} [prefix] - Prefix for the nanoid
 * @param {string} [delimiter='-'] - Delimiter between prefix and nanoid
 * @returns {string} nanoid
 */
function generateNanoid(length = 12, prefix, delimiter = '-') {
    const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', length);
    const id = nanoid();
    return (prefix ? `${prefix}${delimiter}${id}` : id);
}

/**
 * Generate an index key
 * @param {string} module - Module name
 * @param {string} key - Key name
 * @param {string} [delimiter] - Delimiter for the index key
 * @returns {string} Index key
 */
function generateIndexKey(module, key, delimiter = '/') {
    return `${module}${delimiter}${key}`;
}

/**
 * Generate an ephemeral context id in format xxxx-xxxx (hex)
 * @returns {string}
 */
function generateEphemeralContextId() {
    const s = randomBytes(4).toString('hex'); // 8 chars
    return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export {
    generateULID,
    generateUUID,
    generateNanoid,
    generateEphemeralContextId,
    generateIndexKey
};
