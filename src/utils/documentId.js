'use strict';

/**
 * Document ID validation utility
 * Enforces consistent parsing across the entire application
 */

const MAX_DOCUMENT_ID = Math.pow(2, 32) - 1; // 2^32 - 1 = 4,294,967,295

/**
 * Parse and validate a single document ID
 * @param {any} id - The ID to parse (string, number, etc.)
 * @param {string} context - Context for error messages (e.g. "request parameter", "array element")
 * @returns {number} - Valid positive integer document ID
 * @throws {Error} - If ID is invalid
 */
export function parseDocumentId(id, context = 'Document ID') {
    // Handle null/undefined
    if (id === null || id === undefined) {
        throw new Error(`${context} is required`);
    }

    // Convert to number using parseInt to handle leading zeros and string conversion
    const numId = parseInt(id, 10);

    // Check for invalid conversion (NaN)
    if (isNaN(numId)) {
        throw new Error(`${context} must be a valid number. Received: ${id}`);
    }

    // Check for positive integer only (no zero, no negative)
    if (numId <= 0) {
        throw new Error(`${context} must be a positive integer. Received: ${numId}`);
    }

    // Check for maximum value (2^32 - 1)
    if (numId > MAX_DOCUMENT_ID) {
        throw new Error(`${context} must be less than ${MAX_DOCUMENT_ID}. Received: ${numId}`);
    }

    // Ensure we didn't lose precision (reject floating point inputs)
    if (String(id).includes('.') && parseFloat(id) !== numId) {
        throw new Error(`${context} must be an integer, not a floating point number. Received: ${id}`);
    }

    return numId;
}

/**
 * Parse and validate an array of document IDs
 * @param {Array} idArray - Array of IDs to parse
 * @param {string} context - Context for error messages
 * @returns {Array<number>} - Array of valid positive integer document IDs
 * @throws {Error} - If any ID is invalid
 */
export function parseDocumentIdArray(idArray, context = 'Document ID array') {
    if (!Array.isArray(idArray)) {
        throw new Error(`${context} must be an array`);
    }

    return idArray.map((id, index) => {
        try {
            return parseDocumentId(id, `${context} element at index ${index}`);
        } catch (error) {
            // Re-throw with more context
            throw new Error(`${error.message}`, { cause: error });
        }
    });
}

/**
 * Parse and validate document IDs with detailed error reporting for batch operations
 * Returns an object with successful and failed conversions instead of throwing
 * @param {Array} idArray - Array of IDs to parse
 * @param {string} context - Context for error messages
 * @returns {Object} - {successful: Array<{index, id, originalValue}>, failed: Array<{index, originalValue, error}>}
 */
export function parseDocumentIdArraySafe(idArray, context = 'Document ID array') {
    if (!Array.isArray(idArray)) {
        throw new Error(`${context} must be an array`);
    }

    const result = {
        successful: [],
        failed: []
    };

    idArray.forEach((originalValue, index) => {
        try {
            const parsedId = parseDocumentId(originalValue, `${context} element at index ${index}`);
            result.successful.push({
                index,
                id: parsedId,
                originalValue
            });
        } catch (error) {
            result.failed.push({
                index,
                originalValue,
                error: error.message
            });
        }
    });

    return result;
}
