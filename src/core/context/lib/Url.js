'use strict';

/**
 * Context URL Parser
 *
 * Formats supported:
 * - workspace://path - Format with workspace and path
 * - /path - Simple path format (uses current workspace)
 *
 * The parser enforces standard URL structure and rejects malformed URLs.
 */

// Constants
const DEFAULT_PATH = '/';

class Url {
    #raw;
    #url;
    #workspaceName;
    #path;
    #pathArray;
    #valid = false;

    constructor(url) {
        this.#raw = url;
        this.setUrl(url);
    }

    get raw() {
        return this.#raw;
    } // Unparsed URL
    get url() {
        return this.#url;
    } // Full URL string
    get workspaceName() {
        return this.#workspaceName;
    }
    get workspaceId() {
        // Keep backward compatibility - return workspaceName
        return this.#workspaceName;
    }
    get path() {
        return this.#path;
    }
    get pathArray() {
        return this.#pathArray;
    }
    get isValid() {
        return this.#valid;
    }

    setUrl(url) {
        try {
            // Store the raw input
            this.#raw = url;

            // Basic validation - only reject if completely invalid
            Url.validate(url);

            // Clean and normalize the URL
            const cleanedUrl = this.cleanUrl(url);

            // Set the workspace name
            this.#workspaceName = this.parseWorkspace(cleanedUrl);

            // Set the URL path
            this.#path = this.parsePath(cleanedUrl);

            // Store the sanitized URL
            this.#url = this.formatUrl();

            // Set the URL path array
            this.#pathArray = this.#path.split('/').filter((segment) => segment.length > 0);

            this.#valid = true;
        } catch (error) {
            this.#valid = false;
            this.#url = null;
            this.#workspaceName = null;
            this.#path = DEFAULT_PATH;
            this.#pathArray = [];

            throw error;
        }
    }

    validate(url) {
        return Url.validate(url);
    }

    static validate(url) {
        if (!url || typeof url !== 'string') {
            throw new Error('Invalid URL: URL must be a string');
        }

        // Only reject URLs with truly problematic characters that can't be cleaned
        // Reduced the list to only the most problematic characters
        if (/[`'"<>{}[\]]/gi.test(url)) {
            throw new Error(`Unsupported characters in the context URL, got "${url}"`);
        }

        return url;
    }

    // Clean and normalize URLs to standard format
    cleanUrl(url) {
        // Start with basic cleanup
        let cleaned = url
            .trim() // Remove leading/trailing whitespace
            .replace(/\\/g, '/') // Standardize on forward slashes
            .replace(/ +/g, '_'); // Replace spaces with underscores

        // Reject URLs with multiple :// sequences - these are malformed
        const protocolMatches = cleaned.match(/:\/\//g);
        if (protocolMatches && protocolMatches.length > 1) {
            throw new Error(`Malformed URL: Multiple '://' sequences found in '${url}'`);
        }

        // Handle workspace URL format
        if (cleaned.includes('://')) {
            const colonSlashIndex = cleaned.indexOf('://');
            let workspacePart = cleaned.substring(0, colonSlashIndex);
            let pathPart = cleaned.substring(colonSlashIndex + 3);

            // Clean workspace part - only allow alphanumeric, underscores, and hyphens
            workspacePart = workspacePart.replace(/[^a-zA-Z0-9_-]/g, '');

            // Reject if workspace name becomes empty after cleaning
            if (!workspacePart) {
                throw new Error(`Invalid workspace name in URL: '${url}'`);
            }

            // Clean path part
            pathPart = this.cleanPath(pathPart);

            // Reconstruct the URL
            cleaned = `${workspacePart}://${pathPart}`;
        } else {
            // Simple path format - just clean the path
            cleaned = this.cleanPath(cleaned);
        }

        return cleaned;
    }

    // Clean path component
    cleanPath(path) {
        if (!path) return '';

        // Remove invalid characters, keeping only alphanumeric, slashes, underscores, hyphens, and dots
        let cleaned = path.replace(/[^a-zA-Z0-9/_.-]/g, '');

        // Normalize multiple consecutive slashes to single slash
        cleaned = cleaned.replace(/\/+/g, '/');

        // Remove leading slash duplicates after ://
        if (cleaned.startsWith('//')) {
            cleaned = cleaned.replace(/^\/+/, '/');
        }

        // Handle empty path or just slashes - normalize to empty for workspace URLs
        if (!cleaned || cleaned === '/' || /^\/+$/.test(cleaned)) {
            return '';
        }

        // Remove trailing slashes unless it's the root
        if (cleaned.endsWith('/') && cleaned.length > 1) {
            cleaned = cleaned.replace(/\/+$/, '');
        }

        return cleaned;
    }

    // Format the URL based on the parsed components
    formatUrl() {
        if (this.#workspaceName) {
            return `${this.#workspaceName}://${this.#path.replace(/^\//, '')}`;
        } else {
            return this.#path;
        }
    }

    // Parse the workspace portion of the url if present
    parseWorkspace(url) {
        // Check for workspace format with protocol
        const workspaceRegex = /^([a-zA-Z0-9_-]+):\/\/(.*)$/;
        const workspaceMatch = url.match(workspaceRegex);

        if (workspaceMatch && workspaceMatch.length >= 2) {
            return workspaceMatch[1];
        }

        // If it's just a path, return null - let the application decide which workspace to use
        return null;
    }

    // Parse the path portion of the url
    parsePath(url) {
        // Handle workspace format: workspace://path
        const workspaceRegex = /^([a-zA-Z0-9_-]+):\/\/(.*)$/;
        const workspaceMatch = url.match(workspaceRegex);

        if (workspaceMatch && workspaceMatch.length >= 3) {
            let path = workspaceMatch[2];

            // Handle empty path (root case workspace:// or workspace:///)
            if (!path || path === '') {
                return '/';
            }

            // Ensure path starts with /
            if (!path.startsWith('/')) {
                path = '/' + path;
            }

            // Remove trailing slash unless it's the root path
            if (path.length > 1 && path.endsWith('/')) {
                path = path.slice(0, -1);
            }

            return path;
        }

        // Handle simple path format
        let path = url.startsWith('/') ? url : '/' + url;

        // Remove trailing slash unless it's the root path
        if (path.length > 1 && path.endsWith('/')) {
            path = path.slice(0, -1);
        }

        return path;
    }
}

export default Url;
