'use strict';

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import { env } from '../../env.js';

// Import jim from Server.js
import { jim } from '../../Server.js';

// Constants
const TOKEN_TYPES = {
  API: 'api',
  DEVICE: 'device',
  REFRESH: 'refresh',
  VERIFICATION: 'verification',
  PASSWORD_RESET: 'password_reset'
};

/**
 * TokenManager - Manages tokens with hybrid storage (file-based + jim index fallback)
 */
class TokenManager {
  #userHomePath;
  #usersIndex;

  constructor(userHomePath, usersIndex) {
    this.#userHomePath = userHomePath;
    this.#usersIndex = usersIndex || null;
  }

  /**
   * Get tokens file path for a user
   * @param {string} userId - User ID
   * @returns {string} - Path to tokens.json
   */
  #getTokensFilePath(userId) {
    const user = this.#usersIndex?.get?.(userId);
    const email = user?.email;
    if (!email) {
      throw new Error(`Cannot resolve token storage path: user ${userId} missing email in users index`);
    }
    return path.join(this.#userHomePath, email, 'config', 'tokens.json');
  }

  /**
   * Read tokens from file
   * @param {string} userId - User ID
   * @returns {Object} - Tokens object
   */
  readTokens(userId) {
    const tokensPath = this.#getTokensFilePath(userId);

    if (!fs.existsSync(tokensPath)) {
      return {};
    }

    try {
      const data = fs.readFileSync(tokensPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error(`[TokenManager] Failed to read tokens for ${userId}:`, error.message);
      return {};
    }
  }

  /**
   * Write tokens to file
   * @param {string} userId - User ID
   * @param {Object} tokens - Tokens object
   */
  writeTokens(userId, tokens) {
    const tokensPath = this.#getTokensFilePath(userId);
    const configDir = path.dirname(tokensPath);

    // Ensure config directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    try {
      fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2), 'utf8');
    } catch (error) {
      console.error(`[TokenManager] Failed to write tokens for ${userId}:`, error.message);
      throw error;
    }
  }

  /**
   * List all user IDs that have token files
   * @returns {Array<string>} - Array of user IDs
   */
  listUserIds() {
    // Source of truth: user IDs from the users index.
    // This keeps auth token verification returning real user IDs (not directory names).
    const store = this.#usersIndex?.store || {};
    return Object.keys(store || {});
  }
}

/**
 * AuthService - Handles authentication, token management and password operations
 */
class AuthService {
  #tokensStore;
  #passwordsStore;
  #initialized = false;
  #defaultSaltRounds = 10;
  #tokenCreationLock = new Map();
  #authConfig = null;
  #smtpConfig = null;
  #rateLimitStore;
  #tokenManager = null;

  constructor() {
    // Init happens in initialize() to ensure env is loaded
  }

  /**
   * Ensure auth configuration exists with default values
   * @private
   */
  #ensureAuthConfig() {
    const configPath = path.join(process.cwd(), 'server/config/auth.json');

    // Create default auth configuration if it doesn't exist
    if (!fs.existsSync(configPath)) {
      console.log('[AuthService] Auth configuration file not found, creating default configuration...');

      // Ensure the config directory exists
      const configDir = path.dirname(configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Create default configuration with all supported strategies and security settings
      const defaultConfig = {
        strategies: {
          local: {
            enabled: true,
            requireEmailVerification: false,
            passwordPolicy: {
              minLength: 8,
              requireUppercase: false,
              requireLowercase: false,
              requireNumbers: true,
              requireSpecialChars: true,
              maxLength: 128
            },
            rateLimiting: {
              loginAttempts: { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutDuration: 30 * 60 * 1000 },
              registration: { maxAttempts: 3, windowMs: 60 * 60 * 1000 },
              passwordReset: { maxAttempts: 3, windowMs: 60 * 60 * 1000 },
              tokenOperations: { maxAttempts: 5, windowMs: 5 * 60 * 1000 },
              apiOperations: { maxAttempts: 10, windowMs: 5 * 60 * 1000 },
              userProfile: { maxAttempts: 30, windowMs: 60 * 1000 }
            }
          },
          imap: {
            enabled: false,
            domains: {
              "acmedomain.tld": {
                "host": "mail.acmedomain.tld",
                "port": 465,
                "secure": true
              }
            },
            defaultUserType: 'user',
            defaultStatus: 'active'
          },
          ldap: {
            enabled: false,
            servers: {
              primary: {
                url: 'ldap://ldap.example.com:389',
                bindDN: 'cn=admin,dc=example,dc=com',
                bindPassword: '',
                searchBase: 'ou=users,dc=example,dc=com',
                searchFilter: '(mail={{email}})',
                attributes: ['mail', 'cn', 'displayName', 'memberOf'],
                tls: false
              },
              secondary: {
                url: 'ldap://ldap2.example.com:389',
                bindDN: 'cn=admin,dc=example,dc=com',
                bindPassword: '',
                searchBase: 'ou=users,dc=example,dc=com',
                searchFilter: '(mail={{email}})',
                attributes: ['mail', 'cn', 'displayName', 'memberOf'],
                tls: false
              }
            },
            defaultUserType: 'user',
            defaultStatus: 'active'
          }
        },
        jwt: {
          secret: 'your-secure-jwt-secret-here',
          expiresIn: '1d'
        }
      };

      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
      console.log('[AuthService] Default auth configuration created at:', configPath);
    }

    try {
      const data = fs.readFileSync(configPath, 'utf8');
      this.#authConfig = JSON.parse(data);
    } catch (e) {
      console.warn('[AuthService] Failed to read auth configuration, using defaults only:', e.message);
      this.#authConfig = null;
    }
  }

  /**
   * Read auth.json fresh from disk (falls back to startup-cached value on error)
   * @private
   */
  #readAuthConfig() {
    const configPath = path.join(process.cwd(), 'server/config/auth.json');
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return this.#authConfig;
    }
  }

  /**
   * Ensure SMTP configuration exists with default values
   * @private
   */
  #ensureSmtpConfig() {
    const smtpPath = path.join(process.cwd(), 'server/config/smtp.json');
    if (!fs.existsSync(smtpPath)) {
      console.log('[AuthService] SMTP configuration file not found, creating default configuration...');
      const defaultSmtp = {
        enabled: false,
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        auth: { user: 'your-email@example.com', pass: 'your-password' },
        from: { name: 'Canvas Server', email: 'noreply@example.com' },
        tlsOptions: {}
      };
      fs.writeFileSync(smtpPath, JSON.stringify(defaultSmtp, null, 2), 'utf8');
      console.log('[AuthService] Default SMTP configuration created at:', smtpPath);
    }
    try {
      const data = fs.readFileSync(smtpPath, 'utf8');
      this.#smtpConfig = JSON.parse(data);
    } catch (e) {
      console.warn('[AuthService] Failed to read SMTP configuration, email sending will be disabled:', e.message);
      this.#smtpConfig = null;
    }
  }

  /**
   * Initialize the auth service
   * @param {Object} options - Initialization options
   * @param {string} options.userHomePath - Path to user home directory root
   */
  async initialize(options = {}) {
    if (this.#initialized) return;

    // Ensure auth configuration exists with defaults
    this.#ensureAuthConfig();
    this.#ensureSmtpConfig();

    // Initialize storage for tokens and passwords using jim
    this.#tokensStore = jim.createIndex('tokens');
    this.#passwordsStore = jim.createIndex('passwords');
    this.#rateLimitStore = jim.createIndex('rateLimits');

    // Initialize file-based token manager if user home path is provided
    if (options.userHomePath) {
      const usersIndex = jim.createIndex('users');
      this.#tokenManager = new TokenManager(options.userHomePath, usersIndex);
      console.log('[AuthService] TokenManager initialized with user home path:', options.userHomePath);
    }

    this.#initialized = true;
  }

  /**
   * Helper to ensure service is initialized
   */
  #ensureInitialized() {
    if (!this.#initialized) {
      throw new Error('AuthService not initialized');
    }
  }

  /**
   * Hash a password using bcrypt
   * @param {string} password - Plain text password
   * @returns {Promise<string>} - Hashed password
   */
  async hashPassword(password) {
    return bcrypt.hash(password, this.#defaultSaltRounds);
  }

  /**
   * Compare a password with a hash
   * @param {string} password - Plain text password to check
   * @param {string} hash - Stored hash to compare against
   * @returns {Promise<boolean>} - Whether the password matches
   */
  async comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
  }

  /**
   * Generate a secure random password that meets complexity requirements
   * @param {number} length - Password length
   * @returns {string} - Generated password
   */
  generateSecurePassword(length = 12) {
    const policy = this.getPasswordPolicy();
    const minLength = Math.max(length, policy.minLength);

    // Character sets for each requirement
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    const special = '!?@%&*()_+-';

    let password = '';
    const requiredChars = [];

    // Add required characters first
    if (policy.requireLowercase) {
      const char = lowercase[crypto.randomInt(lowercase.length)];
      requiredChars.push(char);
      password += char;
    }

    if (policy.requireUppercase) {
      const char = uppercase[crypto.randomInt(uppercase.length)];
      requiredChars.push(char);
      password += char;
    }

    if (policy.requireNumbers) {
      const char = numbers[crypto.randomInt(numbers.length)];
      requiredChars.push(char);
      password += char;
    }

    if (policy.requireSpecialChars) {
      const char = special[crypto.randomInt(special.length)];
      requiredChars.push(char);
      password += char;
    }

    // Fill remaining length with random characters from all sets
    const allChars = lowercase + uppercase + numbers + special;
    const remainingLength = minLength - password.length;

    for (let i = 0; i < remainingLength; i++) {
      const char = allChars[crypto.randomInt(allChars.length)];
      password += char;
    }

    // Shuffle the password to avoid predictable patterns
    const passwordArray = password.split('');
    for (let i = passwordArray.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [passwordArray[i], passwordArray[j]] = [passwordArray[j], passwordArray[i]];
    }

    return passwordArray.join('');
  }

  /**
   * Create a new token for a user
   * @param {string} userId - User ID
   * @param {Object} options - Token options
   * @returns {Promise<Object>} - The created token
   */
  async createToken(userId, options = {}) {
    this.#ensureInitialized();

    // Check if there's already a token creation in progress for this user
    if (this.#tokenCreationLock.has(userId)) {
      throw new Error('Token creation already in progress for this user');
    }

    try {
      // Set lock
      this.#tokenCreationLock.set(userId, true);

      const tokenType = options.type || TOKEN_TYPES.API;
      const tokenId = options.id || uuidv4();
      const name = options.name || `${tokenType} token`;
      const description = options.description || '';
      const expiresIn = options.expiresIn || null; // null means no expiration

      // Load existing tokens (prefer file-based, fallback to jim)
      let tokensJson;
      if (this.#tokenManager) {
        tokensJson = this.#tokenManager.readTokens(userId);
      } else {
        tokensJson = this.#tokensStore.get(userId) || {};
      }

      // Check for duplicate token names
      const existingTokens = Object.values(tokensJson);
      const hasDuplicateName = existingTokens.some(token =>
        token.name === name && token.type === tokenType
      );

      if (hasDuplicateName) {
        throw new Error(`A token with the name "${name}" already exists`);
      }

      // Generate token value with canvas- prefix
      const randomPart = crypto.randomBytes(24).toString('hex');
      const tokenValue = `canvas-${randomPart}`;
      const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');

      const token = {
        id: tokenId,
        userId,
        type: tokenType,
        name,
        description,
        hash: tokenHash,
        ...(options.deviceId ? { deviceId: options.deviceId } : {}),
        ...(options.deviceNameAtIssue ? { deviceNameAtIssue: options.deviceNameAtIssue } : {}),
        createdAt: new Date().toISOString(),
        expiresAt: expiresIn ? new Date(Date.now() + expiresIn).toISOString() : null,
        lastUsedAt: null
      };

      // Add new token
      tokensJson[tokenId] = token;

      // Save tokens (prefer file-based, fallback to jim)
      if (this.#tokenManager) {
        this.#tokenManager.writeTokens(userId, tokensJson);
      } else {
        this.#tokensStore.set(userId, tokensJson);
      }

      // Return token with value (only returned on creation)
      return {
        ...token,
        value: tokenValue
      };
    } finally {
      // Always release the lock
      this.#tokenCreationLock.delete(userId);
    }
  }

  /**
   * Update an existing token
   * @param {string} userId - User ID
   * @param {string} tokenId - Token ID
   * @param {Object} updates - Properties to update
   * @returns {Promise<Object>} - Updated token
   */
  async updateToken(userId, tokenId, updates = {}) {
    this.#ensureInitialized();

    // Load tokens (prefer file-based, fallback to jim)
    let tokensJson;
    if (this.#tokenManager) {
      tokensJson = this.#tokenManager.readTokens(userId);
    } else {
      tokensJson = this.#tokensStore.get(userId) || {};
    }

    // Verify token exists
    if (!tokensJson[tokenId]) {
      throw new Error('Token not found');
    }

    const token = tokensJson[tokenId];

    // Apply updates (only allow updating name and description)
    if (updates.name) token.name = updates.name;
    if (updates.description) token.description = updates.description;

    // Save tokens (prefer file-based, fallback to jim)
    if (this.#tokenManager) {
      this.#tokenManager.writeTokens(userId, tokensJson);
    } else {
      this.#tokensStore.set(userId, tokensJson);
    }

    return token;
  }

  /**
   * Delete a token
   * @param {string} userId - User ID
   * @param {string} tokenId - Token ID to delete
   * @returns {Promise<boolean>} - True if deleted
   */
  async deleteToken(userId, tokenId) {
    this.#ensureInitialized();

    // Load tokens (prefer file-based, fallback to jim)
    let tokensJson;
    if (this.#tokenManager) {
      tokensJson = this.#tokenManager.readTokens(userId);
    } else {
      tokensJson = this.#tokensStore.get(userId) || {};
    }

    // Verify token exists
    if (!tokensJson[tokenId]) {
      return false;
    }

    // Delete token
    delete tokensJson[tokenId];

    // Save tokens (prefer file-based, fallback to jim)
    if (this.#tokenManager) {
      this.#tokenManager.writeTokens(userId, tokensJson);
    } else {
      if (Object.keys(tokensJson).length === 0) {
        this.#tokensStore.delete(userId);
      } else {
        this.#tokensStore.set(userId, tokensJson);
      }
    }

    return true;
  }

  /**
   * List all tokens for a user
   * @param {string} userId - User ID
   * @returns {Promise<Array>} - Array of token objects
   */
  async listTokens(userId) {
    this.#ensureInitialized();

    // Load tokens (prefer file-based, fallback to jim)
    let tokensJson;
    if (this.#tokenManager) {
      tokensJson = this.#tokenManager.readTokens(userId);
    } else {
      tokensJson = this.#tokensStore.get(userId) || {};
    }

    return Object.values(tokensJson).map(token => {
      // Never return the hash
      const { hash, ...tokenWithoutHash } = token;
      return tokenWithoutHash;
    });
  }

  /**
   * Verify an API token
   * @param {string} tokenValue - The API token to verify
   * @returns {Promise<Object|null>} - User ID if valid, null otherwise
   */
  async verifyApiToken(tokenValue) {
    this.#ensureInitialized();

    if (!tokenValue) return null;

    // Hash the provided token value
    const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');

    // Get list of user IDs (prefer file-based, fallback to jim)
    let userIds;
    if (this.#tokenManager) {
      userIds = this.#tokenManager.listUserIds();
    } else {
      userIds = this.#tokensStore.store ? Object.keys(this.#tokensStore.store) : [];
    }

    for (const userId of userIds) {
      // Load user tokens (prefer file-based, fallback to jim)
      let userTokens;
      if (this.#tokenManager) {
        userTokens = this.#tokenManager.readTokens(userId);
      } else {
        userTokens = this.#tokensStore.get(userId) || {};
      }

      for (const tokenId in userTokens) {
        const token = userTokens[tokenId];

        // Skip non-API tokens
        if (token.type !== TOKEN_TYPES.API) continue;

        // Check if token is expired
        if (token.expiresAt && new Date(token.expiresAt) < new Date()) continue;

        // Compare hash
        if (token.hash === tokenHash) {
          // Update last used
          token.lastUsedAt = new Date().toISOString();

          // Save updated token (prefer file-based, fallback to jim)
          if (this.#tokenManager) {
            this.#tokenManager.writeTokens(userId, userTokens);
          } else {
            this.#tokensStore.set(userId, userTokens);
          }

          return { userId, tokenId };
        }
      }
    }

    return null;
  }

  /**
   * Verify a device token and return { userId, tokenId, deviceId }
   * @param {string} tokenValue
   * @returns {Promise<{userId: string, tokenId: string, deviceId: string} | null>}
   */
  async verifyDeviceToken(tokenValue) {
    this.#ensureInitialized();

    if (!tokenValue) return null;

    const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');

    let userIds;
    if (this.#tokenManager) {
      userIds = this.#tokenManager.listUserIds();
    } else {
      userIds = this.#tokensStore.store ? Object.keys(this.#tokensStore.store) : [];
    }

    for (const userId of userIds) {
      let userTokens;
      if (this.#tokenManager) {
        userTokens = this.#tokenManager.readTokens(userId);
      } else {
        userTokens = this.#tokensStore.get(userId) || {};
      }

      for (const tokenId in userTokens) {
        const token = userTokens[tokenId];
        if (token.type !== TOKEN_TYPES.DEVICE) continue;
        if (!token.deviceId) continue;
        if (token.expiresAt && new Date(token.expiresAt) < new Date()) continue;

        if (token.hash === tokenHash) {
          token.lastUsedAt = new Date().toISOString();

          if (this.#tokenManager) {
            this.#tokenManager.writeTokens(userId, userTokens);
          } else {
            this.#tokensStore.set(userId, userTokens);
          }

          return { userId, tokenId, deviceId: token.deviceId };
        }
      }
    }

    return null;
  }

  /**
   * Verify a one-time token (password reset, email verification)
   * @param {string} tokenValue - Token value to verify
   * @param {string} type - Token type to verify
   * @returns {Promise<Object|null>} - Token data if valid
   */
  async verifyOneTimeToken(tokenValue, type) {
    this.#ensureInitialized();

    if (!tokenValue) return null;

    // Hash the provided token value
    const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');

    // Get list of user IDs (prefer file-based, fallback to jim)
    let userIds;
    if (this.#tokenManager) {
      userIds = this.#tokenManager.listUserIds();
    } else {
      userIds = this.#tokensStore.store ? Object.keys(this.#tokensStore.store) : [];
    }

    for (const userId of userIds) {
      // Load user tokens (prefer file-based, fallback to jim)
      let userTokens;
      if (this.#tokenManager) {
        userTokens = this.#tokenManager.readTokens(userId);
      } else {
        userTokens = this.#tokensStore.get(userId) || {};
      }

      let tokenFound = false;
      let tokenId;

      for (const id in userTokens) {
        const token = userTokens[id];

        // Skip tokens of wrong type
        if (token.type !== type) continue;

        // Check if token is expired
        if (token.expiresAt && new Date(token.expiresAt) < new Date()) continue;

        // Compare hash
        if (token.hash === tokenHash) {
          tokenFound = true;
          tokenId = id;
          // One-time tokens should be deleted after use
          delete userTokens[id];
          break;
        }
      }

      if (tokenFound) {
        // Save tokens (prefer file-based, fallback to jim)
        if (this.#tokenManager) {
          this.#tokenManager.writeTokens(userId, userTokens);
        } else {
          if (Object.keys(userTokens).length === 0) {
            this.#tokensStore.delete(userId);
          } else {
            this.#tokensStore.set(userId, userTokens);
          }
        }

        return { userId, tokenId };
      }
    }

    return null;
  }

  /**
   * Create a password reset token
   * @param {string} userId - User ID
   * @param {string} email - User email
   * @returns {Promise<Object>} - Reset token
   */
  async createPasswordResetToken(userId, email) {
    return this.createToken(userId, {
      type: TOKEN_TYPES.PASSWORD_RESET,
      name: 'Password Reset',
      description: `Password reset for ${email}`,
      expiresIn: 1000 * 60 * 60 * 24 // 24 hours
    });
  }

  /**
   * Create an email verification token
   * @param {string} userId - User ID
   * @param {string} email - User email
   * @returns {Promise<Object>} - Verification token
   */
  async createEmailVerificationToken(userId, email) {
    return this.createToken(userId, {
      type: TOKEN_TYPES.VERIFICATION,
      name: 'Email Verification',
      description: `Email verification for ${email}`,
      expiresIn: 1000 * 60 * 60 * 48 // 48 hours
    });
  }

  /**
   * Set a user's password
   * @param {string} userId - User ID
   * @param {string} password - New password
   * @returns {Promise<boolean>} - Success
   */
  async setPassword(userId, password) {
    this.#ensureInitialized();

    if (!userId || !password) {
      throw new Error('User ID and password are required');
    }

    // Enforce password policy (configurable later via server/config/auth.json)
    const policy = this.getPasswordPolicy();
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasDigit = /[0-9]/.test(password);
    const hasSpecial = /[^A-Za-z0-9]/.test(password);
    const tooLong = policy.maxLength ? password.length > policy.maxLength : false;
    const unmet = {
      minLength: policy.minLength ? password.length < policy.minLength : false,
      maxLength: tooLong,
      uppercase: policy.requireUppercase ? !hasUpper : false,
      lowercase: policy.requireLowercase ? !hasLower : false,
      number: policy.requireNumbers ? !hasDigit : false,
      special: policy.requireSpecialChars ? !hasSpecial : false,
    };
    const failed = Object.values(unmet).some(Boolean);
    if (failed) {
      const parts = [];
      if (unmet.minLength) parts.push(`at least ${policy.minLength} characters`);
      if (unmet.maxLength) parts.push(`no more than ${policy.maxLength} characters`);
      if (unmet.uppercase) parts.push('an uppercase letter');
      if (unmet.lowercase) parts.push('a lowercase letter');
      if (unmet.number) parts.push('a number');
      if (unmet.special) parts.push('a special character');
      const message = parts.length
        ? `Password must contain ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}.`
        : 'Password does not meet complexity requirements';
      const error = new Error(message);
      error.code = 'ERR_PASSWORD_COMPLEXITY';
      error.details = { policy, unmet };
      throw error;
    }

    const passwordHash = await this.hashPassword(password);

    // Store password
    this.#passwordsStore.set(userId, {
      hash: passwordHash,
      updatedAt: new Date().toISOString()
    });

    return true;
  }

  /**
   * Validate a password against the current policy without persisting
   * @param {string} password
   * @returns {Promise<boolean>} - true if password satisfies policy, otherwise throws
   */
  async validatePasswordComplexity(password) {
    this.#ensureInitialized();
    if (!password) {
      const err = new Error('Password is required');
      err.code = 'ERR_PASSWORD_REQUIRED';
      throw err;
    }
    const policy = this.getPasswordPolicy();
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasDigit = /[0-9]/.test(password);
    const hasSpecial = /[^A-Za-z0-9]/.test(password);
    const tooLong = policy.maxLength ? password.length > policy.maxLength : false;
    const unmet = {
      minLength: policy.minLength ? password.length < policy.minLength : false,
      maxLength: tooLong,
      uppercase: policy.requireUppercase ? !hasUpper : false,
      lowercase: policy.requireLowercase ? !hasLower : false,
      number: policy.requireNumbers ? !hasDigit : false,
      special: policy.requireSpecialChars ? !hasSpecial : false,
    };
    const failed = Object.values(unmet).some(Boolean);
    if (failed) {
      const parts = [];
      if (unmet.minLength) parts.push(`at least ${policy.minLength} characters`);
      if (unmet.maxLength) parts.push(`no more than ${policy.maxLength} characters`);
      if (unmet.uppercase) parts.push('an uppercase letter');
      if (unmet.lowercase) parts.push('a lowercase letter');
      if (unmet.number) parts.push('a number');
      if (unmet.special) parts.push('a special character');
      const message = parts.length
        ? `Password must contain ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}.`
        : 'Password does not meet complexity requirements';
      const error = new Error(message);
      error.code = 'ERR_PASSWORD_COMPLEXITY';
      error.details = { policy, unmet };
      throw error;
    }
    return true;
  }

  /**
   * Verify a user's password
   * @param {string} userId - User ID
   * @param {string} password - Password to verify
   * @returns {Promise<boolean>} - True if password matches
   */
  async verifyPassword(userId, password) {
    this.#ensureInitialized();

    if (!userId || !password) return false;

    // Check if user has a password
    const passwordData = this.#passwordsStore.get(userId);
    if (!passwordData || !passwordData.hash) {
      return false;
    }

    // Compare password
    return this.comparePassword(password, passwordData.hash);
  }

  /**
   * Generate a JWT token for a user
   * @param {Object} user - User object
   * @param {Object} options - JWT options
   * @returns {string} - JWT token
   */
  generateJWT(user, options = {}) {
    if (!env.auth.jwtSecret) {
      throw new Error('JWT secret key is not configured');
    }

    // Warn loudly if using the insecure default secret
    if (env.auth.jwtSecret === 'canvas-jwt-secret-change-in-production') {
      console.warn('[Security] Insecure default JWT secret is in use. Please set CANVAS_JWT_SECRET or server/config/auth.json');
    }

    const payload = {
      sub: user.id,
      email: user.email,
      userType: user.userType
    };

    // Only add version if user has an updated or created timestamp
    if (user.updatedAt || user.createdAt) {
      payload.ver = user.updatedAt || user.createdAt;
    }

    return jwt.sign(
      payload,
      env.auth.jwtSecret,
      {
        expiresIn: options.expiresIn || this.getJwtExpiry() || env.auth.tokenExpiry || '1d'
      }
    );
  }

  /**
   * Get password policy from config with safe defaults (reads fresh from disk)
   */
  getPasswordPolicy() {
    const policy = this.#readAuthConfig()?.strategies?.local?.passwordPolicy || {};
    return {
      minLength: policy.minLength ?? 6,
      requireUppercase: policy.requireUppercase ?? false,
      requireLowercase: policy.requireLowercase ?? false,
      requireNumbers: policy.requireNumbers ?? true,
      requireSpecialChars: policy.requireSpecialChars ?? true,
      maxLength: policy.maxLength ?? 128
    };
  }

  /**
   * Get rate limiting config for a given key (uses startup cache — rate limits are baked in at startup)
   */
  getRateLimitConfig(key) {
    const rl = this.#authConfig?.strategies?.local?.rateLimiting || {};
    return rl[key] || null;
  }

  /**
   * Get JWT expiry from config if set
   */
  getJwtExpiry() {
    return this.#authConfig?.jwt?.expiresIn || null;
  }

  /**
   * Whether local strategy requires email verification (reads fresh from disk)
   */
  isEmailVerificationRequired() {
    return !!this.#readAuthConfig()?.strategies?.local?.requireEmailVerification;
  }

  /**
   * Whether local (password) strategy is enabled (reads fresh from disk)
   */
  isLocalEnabled() {
    const local = this.#readAuthConfig()?.strategies?.local;
    return local?.enabled !== false; // default true if missing
  }

  /**
   * Send an email using SMTP or sendmail fallback
   */
  async sendEmail(to, subject, text, html) {
    if (!this.#smtpConfig || this.#smtpConfig.enabled === false) {
      console.log('[Email] SMTP disabled; skipping send to', to);
      return false;
    }
    const from = `${this.#smtpConfig.from?.name || 'Canvas Server'} <${this.#smtpConfig.from?.email || 'noreply@example.com'}>`;
    let transporter;
    try {
      if (this.#smtpConfig.host) {
        transporter = nodemailer.createTransport({
          host: this.#smtpConfig.host,
          port: this.#smtpConfig.port || 587,
          secure: !!this.#smtpConfig.secure,
          auth: this.#smtpConfig.auth || undefined,
          tls: this.#smtpConfig.tlsOptions || undefined
        });
      } else {
        transporter = nodemailer.createTransport({ sendmail: true, newline: 'unix', path: '/usr/sbin/sendmail' });
      }
      await transporter.sendMail({ from, to, subject, text, html });
      return true;
    } catch (e) {
      console.error('[Email] Failed to send email:', e.message);
      return false;
    }
  }

  /**
   * Send verification email to user with token
   */
  async sendVerificationEmail(user, token, request) {
    const origin = `${request.protocol}://${request.headers.host}`;
    const verifyUrl = `${origin}/rest/v2/auth/verify-email/${token.value}`;
    const subject = 'Verify your email address';
    const text = `Hello ${user.name || user.email},\n\nPlease verify your email by clicking the link below:\n${verifyUrl}\n\nThis link expires in 48 hours.`;
    const html = `<p>Hello ${user.name || user.email},</p><p>Please verify your email by clicking the link below:</p><p><a href="${verifyUrl}">Verify Email</a></p><p>This link expires in 48 hours.</p>`;
    return this.sendEmail(user.email, subject, text, html);
  }

  /**
   * Persistent rate limiter using jim index
   * @param {string} bucketKey
   * @param {number} max
   * @param {number} windowMs
   * @returns {Promise<{limited: boolean, resetAt: number}>}
   */
  async checkAndIncrementRateLimit(bucketKey, max, windowMs) {
    this.#ensureInitialized();
    const now = Date.now();
    const existing = this.#rateLimitStore.get(bucketKey) || { count: 0, resetAt: now + windowMs };
    if (now > existing.resetAt) {
      existing.count = 0;
      existing.resetAt = now + windowMs;
    }
    existing.count += 1;
    this.#rateLimitStore.set(bucketKey, existing);
    return { limited: existing.count > max, resetAt: existing.resetAt };
  }

  /**
   * Verify a JWT or API token
   * @param {string} token - The token to verify
   * @returns {Promise<Object>} - Result of verification with user data if valid
   */
  async verifyToken(token) {
    this.#ensureInitialized();

    if (!token) {
      return { valid: false, message: 'No token provided' };
    }

    try {
      // If it's an API token (starts with canvas-)
      if (token.startsWith('canvas-')) {
        const tokenResult = await this.verifyApiToken(token);
        if (!tokenResult) {
          return { valid: false, message: 'Invalid API token' };
        }

        // Get user from the database or storage
        const userIndex = jim.createIndex('users');
        const user = userIndex.get(tokenResult.userId);

        if (!user) {
          return { valid: false, message: 'User not found' };
        }

        return {
          valid: true,
          user: {
            id: user.id,
            name: user.name || user.email,
            email: user.email,
            userType: user.userType || 'user',
            status: user.status || 'active'
          },
          tokenType: 'api'
        };
      }

      // If it's a JWT token
      else {
        if (!env.auth.jwtSecret) {
          return { valid: false, message: 'JWT secret not configured' };
        }

        const decoded = jwt.verify(token, env.auth.jwtSecret);

        // Get user from the database
        const userIndex = jim.createIndex('users');
        const user = userIndex.get(decoded.sub);

        if (!user) {
          return { valid: false, message: 'User not found' };
        }

        // Check user status
        if (user.status !== 'active') {
          return { valid: false, message: 'User account is not active' };
        }

        // Check token version if available
        if (decoded.ver && (user.updatedAt || user.createdAt)) {
          const userVersion = user.updatedAt || user.createdAt;
          if (decoded.ver !== userVersion) {
            return { valid: false, message: 'Token version mismatch' };
          }
        }

        return {
          valid: true,
          user: {
            id: user.id,
            name: user.name || user.email,
            email: user.email,
            userType: user.userType || 'user',
            status: user.status || 'active'
          },
          tokenType: 'jwt'
        };
      }
    } catch (error) {
      return { valid: false, message: error.message };
    }
  }
}

// Export a singleton instance
export const authService = new AuthService();
export default authService;
