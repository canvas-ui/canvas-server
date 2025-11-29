'use strict';

import { ImapFlow } from 'imapflow';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import createError from '@fastify/error';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Custom errors
const ImapAuthError = createError('ERR_IMAP_AUTH', 'IMAP authentication failed', 401);
const ImapConfigError = createError('ERR_IMAP_CONFIG', 'IMAP configuration error', 500);

/**
 * IMAP Authentication Strategy
 */
class ImapAuthStrategy {
  #config;
  #initialized = false;

  constructor() {
    this.#config = null;
  }

  /**
   * Initialize the IMAP auth strategy
   */
  async initialize() {
    if (this.#initialized) return;

    try {
      // Load auth configuration (created by AuthService if needed)
      const configPath = path.join(process.cwd(), 'server/config/auth.json');
      if (!fs.existsSync(configPath)) {
        throw new ImapConfigError('Auth configuration file not found - AuthService should have created it');
      }

      const configData = fs.readFileSync(configPath, 'utf8');
      this.#config = JSON.parse(configData);

      if (!this.#config.strategies?.imap?.enabled) {
        console.log('[IMAP] IMAP authentication is disabled');
        return;
      }

      console.log('[IMAP] IMAP authentication strategy initialized');
      this.#initialized = true;
    } catch (error) {
      console.error('[IMAP] Failed to initialize IMAP strategy:', error.message);
      throw new ImapConfigError(`Failed to initialize IMAP strategy: ${error.message}`);
    }
  }

  /**
   * Check if IMAP auth is enabled
   */
  isEnabled() {
    return this.#initialized && this.#config?.strategies?.imap?.enabled;
  }

  /**
   * Get IMAP configuration for a domain
   * @param {string} domain - Email domain
   * @returns {Object|null} - IMAP configuration
   */
  getImapConfig(domain) {
    if (!this.isEnabled()) return null;

    const domainConfig = this.#config.strategies.imap.domains[domain];
    if (!domainConfig) {
      console.log(`[IMAP] No configuration found for domain: ${domain}`);
      return null;
    }

    return domainConfig;
  }

  /**
   * Extract domain from email address
   * @param {string} email - Email address
   * @returns {string} - Domain part
   */
  extractDomain(email) {
    const parts = email.split('@');
    return parts.length === 2 ? parts[1].toLowerCase() : null;
  }

  /**
   * Authenticate user against IMAP server
   * @param {string} email - User email
   * @param {string} password - User password
   * @returns {Promise<Object>} - Authentication result
   */
  async authenticate(email, password) {
    if (!this.isEnabled()) {
      throw new ImapConfigError('IMAP authentication is not enabled');
    }

    if (!email || !password) {
      throw new ImapAuthError('Email and password are required');
    }

    const domain = this.extractDomain(email);
    if (!domain) {
      throw new ImapAuthError('Invalid email format');
    }

    const imapConfig = this.getImapConfig(domain);
    if (!imapConfig) {
      throw new ImapAuthError(`IMAP authentication not supported for domain: ${domain}`);
    }

    console.log(`[IMAP] Attempting authentication for ${email} against ${imapConfig.host}`);

    // Build connection configuration with proper TLS support
    const connectionConfig = {
      host: imapConfig.host,
      port: imapConfig.port,
      secure: imapConfig.secure || false, // Use SSL/TLS from the start
      auth: {
        user: email,
        pass: password
      },
      logger: false // Disable logging for security
    };

    // Add STARTTLS support if configured
    if (imapConfig.startTLS) {
      connectionConfig.requireTLS = true;
    }

    // Add TLS options if specified
    if (imapConfig.tlsOptions) {
      connectionConfig.tls = imapConfig.tlsOptions;
    }

    console.log(`[IMAP] Connection config: ${imapConfig.host}:${imapConfig.port} (secure: ${connectionConfig.secure}, startTLS: ${!!imapConfig.startTLS})`);

    const client = new ImapFlow(connectionConfig);

    try {
      // Attempt to connect and authenticate
      await client.connect();
      console.log(`[IMAP] Successfully authenticated ${email}`);

      // Get some basic info about the user if possible
      const mailboxes = await client.list();

      await client.logout();

      return {
        success: true,
        email: email.toLowerCase(),
        domain: domain,
        imapServer: imapConfig.host,
        serverName: imapConfig.name || imapConfig.host
      };
    } catch (error) {
      console.error(`[IMAP] Authentication failed for ${email}:`, error.message);

      // Close connection if it was opened
      try {
        await client.close();
      } catch (closeError) {
        // Ignore close errors
      }

      throw new ImapAuthError(`IMAP authentication failed: ${error.message}`);
    }
  }

  /**
   * Create user from IMAP authentication result
   * @param {Object} authResult - IMAP authentication result
   * @param {Object} userManager - User manager instance
   * @returns {Promise<Object>} - Created user
   */
  async createUserFromImapAuth(authResult, userManager) {
    if (!this.isEnabled()) {
      throw new ImapConfigError('IMAP authentication is not enabled');
    }

    const imapSettings = this.#config.strategies.imap;

    console.log(`[IMAP] Creating user for ${authResult.email}`);

    // Check if user already exists
    let existingUser;
    try {
      existingUser = await userManager.getUserByEmail(authResult.email);
    } catch (error) {
      // User doesn't exist, which is fine
    }

    if (existingUser) {
      console.log(`[IMAP] User ${authResult.email} already exists`);
      return existingUser;
    }

    // Create new user
    const userData = {
      id: authResult.email,
      name: this.#generateUsernameFromEmail(authResult.email), // Generate proper username
      email: authResult.email,
      userType: imapSettings.defaultUserType || 'user',
      status: imapSettings.defaultStatus || 'active',
      authMethod: 'imap',
      // imapDomain: authResult.domain, // Not used yet
      // imapServer: authResult.imapServer, // Not used yet
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    };

    try {
      const newUser = await userManager.createUser(userData);
      console.log(`[IMAP] Successfully created user: ${newUser.id}`);

      // Ensure user's workspace and context are set up
      await userManager.ensureUserUniverseWorkspaceIsRunning(newUser.id);
      await userManager.ensureDefaultUserContextExists(newUser.id);

      return newUser;
    } catch (error) {
      console.error(`[IMAP] Failed to create user:`, error.message);
      throw new Error(`Failed to create user: ${error.message}`);
    }
  }

  /**
   * Get available domains for login form
   * @returns {Array} - Array of domain configurations
   */
  getAvailableDomains() {
    if (!this.isEnabled()) return [];

    const domains = this.#config.strategies.imap.domains;
    return Object.entries(domains).map(([domain, config]) => ({
      domain,
      name: config.name || domain,
      requireAppPassword: config.requireAppPassword || false
    }));
  }

  /**
   * Generate a GitHub-style username from an email address
   * @param {string} email - Email address
   * @returns {string} - Valid username
   * @private
   */
  #generateUsernameFromEmail(email) {
    // Extract the local part (before @)
    let username = email.split('@')[0].toLowerCase();

    // Remove special characters, keep only letters, numbers, dots, underscores, hyphens
    username = username.replace(/[^a-z0-9._-]/g, '');

    // Replace dots and underscores with hyphens for consistency
    username = username.replace(/[._]/g, '-');

    // Remove consecutive hyphens (safe from ReDoS)
    while (username.includes('--')) {
      username = username.replace(/--/g, '-');
    }

    // Remove leading and trailing hyphens (safe from ReDoS)
    while (username.startsWith('-')) {
      username = username.slice(1);
    }
    while (username.endsWith('-')) {
      username = username.slice(0, -1);
    }

    // Ensure minimum length
    if (username.length < 3) {
      username = username + '123';
    }

    // Ensure maximum length
    if (username.length > 39) {
      username = username.substring(0, 39);
      // Remove trailing hyphens if we cut in the middle
      username = username.replace(/-+$/, '');
    }

    // Check for reserved names and append number if needed
    const reservedNames = [
      'admin', 'administrator', 'root', 'system', 'support', 'help',
      'api', 'www', 'mail', 'ftp', 'localhost', 'test', 'demo',
      'canvas', 'universe', 'workspace', 'context', 'user', 'users'
    ];

    if (reservedNames.includes(username)) {
      username = username + '1';
    }

    return username;
  }
}

// Export singleton instance
export const imapAuthStrategy = new ImapAuthStrategy();
export default imapAuthStrategy;
