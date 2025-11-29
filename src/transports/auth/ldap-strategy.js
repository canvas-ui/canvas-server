'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import createError from '@fastify/error';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Custom errors
const LdapAuthError = createError('ERR_LDAP_AUTH', 'LDAP authentication failed', 401);
const LdapConfigError = createError('ERR_LDAP_CONFIG', 'LDAP configuration error', 500);

/**
 * LDAP Authentication Strategy
 *
 * Note: This implementation requires the 'ldapjs' package.
 * Install with: npm install ldapjs
 */
class LdapAuthStrategy {
  #config;
  #initialized = false;
  #ldap = null;

  constructor() {
    this.#config = null;
  }

  /**
   * Initialize the LDAP auth strategy
   */
  async initialize() {
    if (this.#initialized) return;

    try {
      // Attempt to load ldapjs module
      try {
        const ldapModule = await import('ldapjs');
        this.#ldap = ldapModule.default || ldapModule;
      } catch (importError) {
        console.warn('[LDAP] ldapjs module not found. LDAP authentication will be disabled.');
        console.warn('[LDAP] Install with: npm install ldapjs');
        return;
      }

      // Load auth configuration (created by AuthService if needed)
      const configPath = path.join(process.cwd(), 'server/config/auth.json');
      if (!fs.existsSync(configPath)) {
        throw new LdapConfigError('Auth configuration file not found - AuthService should have created it');
      }

      const configData = fs.readFileSync(configPath, 'utf8');
      this.#config = JSON.parse(configData);

      if (!this.#config.strategies?.ldap?.enabled) {
        console.log('[LDAP] LDAP authentication is disabled');
        return;
      }

      console.log('[LDAP] LDAP authentication strategy initialized');
      this.#initialized = true;
    } catch (error) {
      console.error('[LDAP] Failed to initialize LDAP strategy:', error.message);
      throw new LdapConfigError(`Failed to initialize LDAP strategy: ${error.message}`);
    }
  }

  /**
   * Check if LDAP auth is enabled
   */
  isEnabled() {
    return this.#initialized && this.#config?.strategies?.ldap?.enabled && this.#ldap !== null;
  }

  /**
   * Get LDAP server configuration
   * @param {string} serverName - Server name (e.g., 'primary', 'secondary')
   * @returns {Object|null} - LDAP server configuration
   */
  getLdapServerConfig(serverName = 'primary') {
    if (!this.isEnabled()) return null;

    const serverConfig = this.#config.strategies.ldap.servers[serverName];
    if (!serverConfig) {
      console.log(`[LDAP] No configuration found for server: ${serverName}`);
      return null;
    }

    return serverConfig;
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
   * Authenticate user against LDAP server
   * @param {string} email - User email
   * @param {string} password - User password
   * @param {string} serverName - LDAP server name to use (default: 'primary')
   * @returns {Promise<Object>} - Authentication result
   */
  async authenticate(email, password, serverName = 'primary') {
    if (!this.isEnabled()) {
      throw new LdapConfigError('LDAP authentication is not enabled');
    }

    if (!email || !password) {
      throw new LdapAuthError('Email and password are required');
    }

    const ldapConfig = this.getLdapServerConfig(serverName);
    if (!ldapConfig) {
      throw new LdapAuthError(`LDAP server not configured: ${serverName}`);
    }

    console.log(`[LDAP] Attempting authentication for ${email} against ${ldapConfig.url}`);

    // Create LDAP client
    const client = this.#ldap.createClient({
      url: ldapConfig.url,
      tlsOptions: ldapConfig.tls ? { rejectUnauthorized: false } : undefined
    });

    return new Promise((resolve, reject) => {
      // Bind with search credentials if provided, otherwise try direct bind
      const bindDN = ldapConfig.bindDN || null;
      const bindPassword = ldapConfig.bindPassword || null;

      const doSearch = () => {
        // Replace placeholder in search filter
        const searchFilter = ldapConfig.searchFilter.replace('{{email}}', email);
        const searchOptions = {
          filter: searchFilter,
          scope: 'sub',
          attributes: ldapConfig.attributes || ['mail', 'cn', 'displayName']
        };

        console.log(`[LDAP] Searching for user in base: ${ldapConfig.searchBase}`);
        console.log(`[LDAP] Search filter: ${searchFilter}`);

        client.search(ldapConfig.searchBase, searchOptions, (searchErr, searchRes) => {
          if (searchErr) {
            client.unbind();
            return reject(new LdapAuthError(`LDAP search failed: ${searchErr.message}`));
          }

          let userEntry = null;

          searchRes.on('searchEntry', (entry) => {
            userEntry = entry.object;
            console.log(`[LDAP] Found user: ${userEntry.dn}`);
          });

          searchRes.on('error', (err) => {
            client.unbind();
            reject(new LdapAuthError(`LDAP search error: ${err.message}`));
          });

          searchRes.on('end', (result) => {
            if (result.status !== 0) {
              client.unbind();
              return reject(new LdapAuthError(`LDAP search failed with status: ${result.status}`));
            }

            if (!userEntry) {
              client.unbind();
              return reject(new LdapAuthError('User not found in LDAP directory'));
            }

            // Now authenticate the user with their DN and password
            client.bind(userEntry.dn, password, (bindErr) => {
              client.unbind();

              if (bindErr) {
                return reject(new LdapAuthError(`LDAP authentication failed: ${bindErr.message}`));
              }

              console.log(`[LDAP] Successfully authenticated ${email}`);

              // Extract user attributes
              const displayName = userEntry.displayName || userEntry.cn || email.split('@')[0];
              const userEmail = userEntry.mail || email;

              resolve({
                success: true,
                email: userEmail.toLowerCase(),
                name: displayName,
                dn: userEntry.dn,
                attributes: userEntry
              });
            });
          });
        });
      };

      // If we have bind credentials, use them first, otherwise try anonymous search
      if (bindDN && bindPassword) {
        client.bind(bindDN, bindPassword, (err) => {
          if (err) {
            client.unbind();
            return reject(new LdapAuthError(`LDAP bind failed: ${err.message}`));
          }
          doSearch();
        });
      } else {
        // Try anonymous search (some LDAP servers allow this)
        doSearch();
      }
    });
  }

  /**
   * Try authentication against multiple LDAP servers (fallback/redundancy)
   * @param {string} email - User email
   * @param {string} password - User password
   * @returns {Promise<Object>} - Authentication result
   */
  async authenticateWithFallback(email, password) {
    if (!this.isEnabled()) {
      throw new LdapConfigError('LDAP authentication is not enabled');
    }

    const servers = Object.keys(this.#config.strategies.ldap.servers);

    for (const serverName of servers) {
      try {
        console.log(`[LDAP] Trying server: ${serverName}`);
        const result = await this.authenticate(email, password, serverName);
        return result;
      } catch (error) {
        console.log(`[LDAP] Server ${serverName} failed: ${error.message}`);
        // Continue to next server
      }
    }

    throw new LdapAuthError('Authentication failed on all LDAP servers');
  }

  /**
   * Create user from LDAP authentication result
   * @param {Object} authResult - LDAP authentication result
   * @param {Object} userManager - User manager instance
   * @returns {Promise<Object>} - Created user
   */
  async createUserFromLdapAuth(authResult, userManager) {
    if (!this.isEnabled()) {
      throw new LdapConfigError('LDAP authentication is not enabled');
    }

    const ldapSettings = this.#config.strategies.ldap;

    console.log(`[LDAP] Creating user for ${authResult.email}`);

    // Check if user already exists
    let existingUser;
    try {
      existingUser = await userManager.getUserByEmail(authResult.email);
    } catch (error) {
      // User doesn't exist, which is fine
    }

    if (existingUser) {
      console.log(`[LDAP] User ${authResult.email} already exists`);
      return existingUser;
    }

    // Generate username from email local part
    const username = this.#generateUsernameFromEmail(authResult.email);

    // Create new user
    const userData = {
      id: authResult.email,
      name: username,
      email: authResult.email,
      userType: ldapSettings.defaultUserType || 'user',
      status: ldapSettings.defaultStatus || 'active',
      authMethod: 'ldap',
      authMetadata: {
        provider: 'ldap',
        dn: authResult.dn,
        displayName: authResult.name,
        attributes: authResult.attributes,
        authenticatedAt: new Date().toISOString()
      },
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    };

    try {
      const newUser = await userManager.createUser(userData);
      console.log(`[LDAP] Successfully created user: ${newUser.id}`);

      // Ensure user's workspace and context are set up
      await userManager.ensureUserUniverseWorkspaceIsRunning(newUser.id);
      await userManager.ensureDefaultUserContextExists(newUser.id);

      return newUser;
    } catch (error) {
      console.error(`[LDAP] Failed to create user:`, error.message);
      throw new Error(`Failed to create user: ${error.message}`);
    }
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

    // Remove consecutive hyphens
    while (username.includes('--')) {
      username = username.replace(/--/g, '-');
    }

    // Remove leading and trailing hyphens
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
export const ldapAuthStrategy = new LdapAuthStrategy();
export default ldapAuthStrategy;

