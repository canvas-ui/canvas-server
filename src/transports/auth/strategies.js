'use strict';

import authService from './service.js';
import imapAuthStrategy from './imap-strategy.js';
import createError from '@fastify/error';
import { authService as _authService } from './service.js';
import ResponseObject from '../ResponseObject.js';

// Export the auth service and strategies
export { authService, imapAuthStrategy };

/**
 * Custom errors
 */
const InvalidTokenError = createError('ERR_INVALID_TOKEN', 'Invalid or expired token', 401);
const InvalidCredentialsError = createError('ERR_INVALID_CREDENTIALS', 'Invalid credentials', 401);
const UserValidationError = createError('ERR_USER_VALIDATION', 'User validation failed', 401);

/**
 * Validate user object to ensure it has required properties
 * @param {Object} user - User object to validate
 * @param {Array<string>} requiredProps - Array of required properties
 * @returns {Object} - Validated user object
 * @throws {Error} - If validation fails
 */
export function validateUser(user, requiredProps = ['id', 'name', 'email']) {
  // Check if user exists
  if (!user) {
    throw new UserValidationError('User not found');
  }

  if (typeof user !== 'object') {
    throw new UserValidationError(`User is not an object, received ${typeof user}`);
  }

  // Check required properties
  const missingProps = [];
  for (const prop of requiredProps) {
    if (user[prop] === undefined || user[prop] === null || user[prop] === '') {
      missingProps.push(prop);
    }
  }

  if (missingProps.length > 0) {
    throw new UserValidationError(`User missing required properties: ${missingProps.join(', ')}`);
  }

  // Don't attempt to modify the user object directly, as some properties may be read-only
  // Instead, return a plain JavaScript object with the validated properties
  const validatedUser = {};

  // Copy all enumerable properties from the user object
  for (const prop in user) {
    if (Object.prototype.hasOwnProperty.call(user, prop)) {
      // For email, store lowercase version
      if (prop === 'email' && typeof user[prop] === 'string') {
        validatedUser[prop] = user[prop].toLowerCase();
      } else {
        validatedUser[prop] = user[prop];
      }
    }
  }

  // Ensure all required properties are copied
  for (const prop of requiredProps) {
    if (!(prop in validatedUser)) {
      validatedUser[prop] = user[prop];
    }
  }

  // If the original object is a class instance with methods, preserve important non-enumerable methods
  // by attaching them to our plain object (if accessible via getters)
  const methodsToPreserve = ['save', 'delete', 'update', 'toJSON'];
  for (const method of methodsToPreserve) {
    if (typeof user[method] === 'function') {
      validatedUser[method] = user[method].bind(user);
    }
  }

  return validatedUser;
}

/**
 * Verify JWT for authenticated routes
 * @param {Object} request - Fastify request object
 * @param {Object} reply - Fastify reply object
 */
export async function verifyJWT(request, reply) {
  // Check for token in Authorization header
  if (!request.headers.authorization || !request.headers.authorization.startsWith('Bearer ')) {
    console.log('[Auth/JWT] No Bearer token or invalid format');
    const error = new Error('Bearer token required');
    error.statusCode = 401;
    throw error;
  }

  const token = request.headers.authorization.split(' ')[1];
  if (!token) {
    console.log('[Auth/JWT] Empty token');
    const error = new Error('Token is empty');
    error.statusCode = 401;
    throw error;
  }

  // Only process JWT tokens, not API tokens
  if (token.startsWith('canvas-')) {
    console.log(`[Auth/JWT] Not a JWT token (has canvas- prefix): ${token.substring(0, 10)}...`);
    const error = new Error('Not a JWT token');
    error.statusCode = 401;
    throw error;
  }

  console.log(`[Auth/JWT] Verifying JWT token: ${token.substring(0, 10)}...`);

  let decoded;
  try {
    decoded = await request.jwtVerify(); // This returns the payload
    console.log(`[Auth/JWT] JWT verified, subject: ${decoded.sub}`);
  } catch (jwtError) {
    console.error(`[Auth/JWT] JWT verification failed: ${jwtError.message}`);
    const error = new Error(`JWT verification failed: ${jwtError.message}`);
    error.statusCode = 401;
    throw error;
  }

  const userManager = request.server.userManager;
  if (!userManager) {
    console.error('[Auth/JWT] userManager not available on server');
    const error = new Error('User manager not initialized');
    error.statusCode = 500;
    throw error;
  }

  console.log(`[Auth/JWT] Getting user by ID: ${decoded.sub}`);
  let user;
  try {
    user = await userManager.getUserById(decoded.sub);
    console.log(`[Auth/JWT] User retrieved: ${!!user}, ID: ${user ? user.id : 'null'}`);
  } catch (userError) {
    console.error(`[Auth/JWT] Error retrieving user: ${userError.message}`);

    // Handle the specific case where user exists in token but not in database
    if (userError.message.includes('User not found in index')) {
      console.warn(`[Auth/JWT] User ${decoded.sub} has valid JWT token but missing from database`);
      const error = new Error('Your session is invalid. Please log in again.');
      error.statusCode = 401;
      throw error;
    }

    const error = new Error(`Error retrieving user: ${userError.message}`);
    error.statusCode = 401;
    throw error;
  }

  if (!user) {
    console.error(`[Auth/JWT] User not found: ${decoded.sub}`);
    const error = new Error(`User not found: ${decoded.sub}`);
    error.statusCode = 401;
    throw error;
  }

  // Validate user status directly without modifying any properties
  if (user.status !== 'active') {
    console.log(`[Auth/JWT] User ${user.id} not active (${user.status})`);
    const error = new Error('User account is not active');
    error.statusCode = 401;
    throw error;
  }

  // Only check version if both token and user have versions
  if (decoded.ver && (user.updatedAt || user.createdAt)) {
    const userVersion = user.updatedAt || user.createdAt;
    if (decoded.ver !== userVersion) {
      console.log(`[Auth/JWT] Token version mismatch: ${decoded.ver} vs ${userVersion}`);
      const error = new Error('Token is invalid - user data has changed');
      error.statusCode = 401;
      throw error;
    }
  }

  // Create a simplified user object that contains only the essential properties
  const essentialUserData = {
    id: user.id,
    name: user.name || user.email,
    email: user.email ? user.email.toLowerCase() : null,
    userType: user.userType || 'user',
    status: user.status || 'active'
  };

  console.log(`[Auth/JWT] Preparing to authenticate user: ${essentialUserData.id}`);
  request.user = essentialUserData; // Set request.user directly
  console.log(`[Auth/JWT] User ${essentialUserData.id} authenticated via JWT (set on request.user)`);
}

/**
 * Verify API token for authenticated routes
 * @param {Object} request - Fastify request object
 * @param {Object} reply - Fastify reply object
 */
export async function verifyApiToken(request, reply) {
  // Check for token in Authorization header
  if (!request.headers.authorization || !request.headers.authorization.startsWith('Bearer ')) {
    console.log('[Auth/API] No Bearer token or invalid format');
    const error = new Error('Bearer token required');
    error.statusCode = 401;
    throw error;
  }

  const token = request.headers.authorization.split(' ')[1];
  if (!token) {
    console.log('[Auth/API] Empty token');
    const error = new Error('Token is empty');
    error.statusCode = 401;
    throw error;
  }

  // Only process tokens with the "canvas-" prefix, which identifies it as an API token
  if (!token.startsWith('canvas-')) {
    console.log(`[Auth/API] Not an API token (missing canvas- prefix): ${token.substring(0, 10)}...`);
    const error = new Error('Not an API token');
    error.statusCode = 401;
    throw error;
  }

  console.log(`[Auth/API] Verifying API token: ${token.substring(0, 10)}...`);
  console.log(`[Auth/API] Full token: ${token}`);
  console.log(`[Auth/API] Server has authService: ${!!request.server.authService}`);

  let tokenResult;
  try {
    tokenResult = await request.server.authService.verifyApiToken(token);
    console.log(`[Auth/API] Token verification result: ${JSON.stringify(tokenResult)}`);
  } catch (tokenError) {
    console.error(`[Auth/API] Token verification error: ${tokenError.message}`);
    console.error(`[Auth/API] Token verification error stack: ${tokenError.stack}`);
    const error = new Error(`API token verification failed: ${tokenError.message}`);
    error.statusCode = 401;
    throw error;
  }

  if (!tokenResult) {
    console.error('[Auth/API] Invalid API token - verification returned null');
    const error = new Error('Invalid API token');
    error.statusCode = 401;
    throw error;
  }

  // Load user from UserManager
  const userManager = request.server.userManager;
  if (!userManager) {
    console.error('[Auth/API] userManager not available on server');
    const error = new Error('User manager not initialized');
    error.statusCode = 500;
    throw error;
  }

  console.log(`[Auth/API] Getting user with ID: ${tokenResult.userId}`);
  let user;
  try {
    user = await userManager.getUserById(tokenResult.userId);
    console.log(`[Auth/API] User found: ${!!user}, user ID: ${user ? user.id : 'null'}`);
  } catch (userError) {
    console.error(`[Auth/API] Error retrieving user: ${userError.message}`);

    // Handle the specific case where user exists in token but not in database
    if (userError.message.includes('User not found in index')) {
      console.warn(`[Auth/API] User ${tokenResult.userId} has valid API token but missing from database`);
      const error = new Error('Your session is invalid. Please log in again.');
      error.statusCode = 401;
      throw error;
    }

    const error = new Error(`Error retrieving user: ${userError.message}`);
    error.statusCode = 401;
    throw error;
  }

  if (!user) {
    console.error(`[Auth/API] User not found for token userId: ${tokenResult.userId}`);
    const error = new Error('User not found for this API token');
    error.statusCode = 401;
    throw error;
  }

  // Check required properties without modifying the object
  if (!user.id || !user.email) {
    console.error(`[Auth/API] User missing required properties`);
    const error = new Error('User missing required properties: id or email');
    error.statusCode = 401;
    throw error;
  }

  // Validate user status directly without modifying any properties
  if (user.status !== 'active') {
    console.error(`[Auth/API] User account not active: ${user.status}`);
    const error = new Error('User account is not active');
    error.statusCode = 401;
    throw error;
  }

  // Create a simplified user object with essential properties
  const essentialUserData = {
    id: user.id,
    name: user.name || user.email,
    email: user.email ? user.email.toLowerCase() : null,
    userType: user.userType || 'user',
    status: user.status || 'active'
  };

  console.log(`[Auth/API] Preparing to authenticate user: ${essentialUserData.id}`);
  request.user = essentialUserData; // Set request.user directly
  request.token = tokenResult.tokenId; // Keep this for API token specific logic if any

  console.log(`[Auth/API] Authentication successful for user ${essentialUserData.id}`);
}

/**
 * Login with email/password (supports both local and IMAP authentication)
 * @param {string} email - User email
 * @param {string} password - User password
 * @param {Object} userManager - User manager instance
 * @param {string} strategy - Authentication strategy ('local', 'imap', 'auto')
 * @returns {Promise<Object>} - User object and token
 */
export async function login(email, password, userManager, strategy = 'auto') {
  if (!email || !password) {
    throw new InvalidCredentialsError('Email and password are required');
  }

  // Validate userManager
  if (!userManager) {
    throw new Error('User manager is not initialized');
  }

  console.log(`[Auth/Login] Attempting login for ${email} with strategy: ${strategy}`);

  // Auto-detect strategy based on existing user or IMAP configuration
  if (strategy === 'auto') {
    // First check if user exists locally
    let existingUser;
    try {
      existingUser = await userManager.getUserByEmail(email);
    } catch (error) {
      // User doesn't exist, which is fine for auto-detection
      existingUser = null;
    }

    if (existingUser && existingUser.authMethod === 'imap') {
      strategy = 'imap';
    } else if (existingUser) {
      strategy = 'local';
    } else {
      // User doesn't exist, check if IMAP is configured for this domain
      const domain = email.split('@')[1]?.toLowerCase();
      if (domain && imapAuthStrategy.isEnabled() && imapAuthStrategy.getImapConfig(domain)) {
        strategy = 'imap';
      } else {
        strategy = 'local';
      }
    }
  }

  console.log(`[Auth/Login] Using authentication strategy: ${strategy}`);

  // IMAP Authentication
  if (strategy === 'imap') {
    try {
      // Initialize IMAP strategy if not already done
      await imapAuthStrategy.initialize();

      // Authenticate against IMAP server
      const imapResult = await imapAuthStrategy.authenticate(email, password);

      // Get or create user
      const user = await imapAuthStrategy.createUserFromImapAuth(imapResult, userManager);

      console.log(`[Auth/Login] IMAP login successful for user: ${user.id}`);
      return { user, authMethod: 'imap' };
    } catch (error) {
      console.log(`[Auth/Login] IMAP authentication failed: ${error.message}`);
      // If IMAP fails and we're in auto mode, don't fall back to local auth for security
      if (strategy === 'imap') {
        throw error;
      }
    }
  }

  // Local Authentication (original logic)
  if (strategy === 'local') {
    // Get user by email
    let user;
    try {
      user = await userManager.getUserByEmail(email);
    } catch (error) {
      console.log(`[Auth/Login] User not found for email: ${email}`);
      throw new InvalidCredentialsError('Invalid email or password');
    }

    if (!user) {
      console.log(`[Auth/Login] User not found for email: ${email}`);
      throw new InvalidCredentialsError('Invalid email or password');
    }

    console.log(`[Auth/Login] User found: ${user.id}`);

    // Verify password
    const validPassword = await authService.verifyPassword(user.id, password);
    if (!validPassword) {
      console.log(`[Auth/Login] Password verification failed for user: ${user.id}`);
      throw new InvalidCredentialsError('Invalid email or password');
    }

    // Check if account is active
    if (user.status !== 'active') {
      console.log(`[Auth/Login] User account not active: ${user.id}, status: ${user.status}`);
      throw new InvalidCredentialsError('Account is not active');
    }

    // Ensure users "Universe" workspace is running
    await userManager.ensureUserUniverseWorkspaceIsRunning(user.id);

    // Ensure users default context exists
    await userManager.ensureDefaultUserContextExists(user.id);

    console.log(`[Auth/Login] Local login successful for user: ${user.id}`);
    return { user, authMethod: 'local' };
  }

  throw new InvalidCredentialsError('No valid authentication method found');
}

/**
 * Register a new user
 * @param {Object} userData - User data for registration
 * @param {Object} userManager - User manager instance
 * @returns {Promise<Object>} - Created user and verification token
 */
export async function register(userData, userManager) {
  // Validate password FIRST to avoid creating a user if it fails policy
  try {
    await authService.validatePasswordComplexity(userData.password);
  } catch (error) {
    return {
      success: false,
      message: error?.message || 'Password does not meet complexity requirements',
      details: error?.details || undefined,
    };
  }

  // Create user
  const requireVerification = _authService.isEmailVerificationRequired();
  const user = await userManager.createUser({
    name: userData.name,
    email: userData.email,
    // firstName: userData.firstName,
    // lastName: userData.lastName,
    userType: 'user',
    status: requireVerification ? 'pending' : 'active'
  });

  // Set password with rollback on failure
  try {
    await authService.setPassword(user.id, userData.password);
  } catch (error) {
    // Best-effort rollback to avoid leaving a partially created user
    try {
      await userManager.deleteUser(user.id);
    } catch (_) {
      // ignore rollback errors
    }

    // Return validation error in a structured way so the route can respond 400
    return {
      success: false,
      message: error?.message || 'Password does not meet complexity requirements',
      details: error?.details || undefined,
    };
  }

  // Create verification token (non-fatal if this fails)
  let verificationToken;
  try {
    verificationToken = await authService.createEmailVerificationToken(user.id, user.email);
  } catch (_) {
    verificationToken = undefined;
  }

  return {
    success: true,
    data: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      },
      token: verificationToken // This is the email verification token
    }
  };
}

/**
 * Verify email with token
 * @param {string} token - Verification token
 * @param {Object} userManager - User manager instance
 * @returns {Promise<Object>} - Updated user
 */
export async function verifyEmail(token, userManager) {
  const tokenData = await authService.verifyOneTimeToken(token, 'verification');
  if (!tokenData) {
    throw new InvalidTokenError('Invalid or expired verification token');
  }

  // Get user
  const user = await userManager.getUserById(tokenData.userId);
  if (!user) {
    throw new Error('User not found');
  }

  // Update user status
  const updatedUser = await userManager.updateUser(user.id, {
    status: 'active',
    emailVerified: true,
    emailVerifiedAt: new Date().toISOString()
  });

  return updatedUser;
}

/**
 * Request email verification for a user by email address
 * @param {string} email - User email
 * @param {Object} userManager - User manager instance
 * @returns {Promise<void>}
 */
export async function requestEmailVerification(email, userManager) {
  if (!email) return null;
  let user;
  try {
    user = await userManager.getUserByEmail(email);
  } catch (_) {
    // Do not reveal user existence
    return null;
  }
  if (!user) return null;

  // Remove any existing verification tokens so we can issue a fresh one
  try {
    const tokens = await authService.listTokens(user.id);
    for (const t of tokens) {
      if (t?.type === 'verification' && t?.name === 'Email Verification') {
        await authService.deleteToken(user.id, t.id);
      }
    }
  } catch (_) {
    // Best effort cleanup; continue even if this fails
  }

  const token = await authService.createEmailVerificationToken(user.id, user.email);
  return { user, token };
}

/**
 * Request password reset
 * @param {string} email - User email
 * @param {Object} userManager - User manager instance
 * @returns {Promise<Object>} - Reset token
 */
export async function requestPasswordReset(email, userManager) {
  const user = await userManager.getUserByEmail(email);
  if (!user) {
    // Don't reveal if user exists, but don't create token either
    return null;
  }

  const resetToken = await authService.createPasswordResetToken(user.id, user.email);
  return { email: user.email, resetToken };
}

/**
 * Reset password with token
 * @param {string} token - Reset token
 * @param {string} newPassword - New password
 * @param {Object} userManager - User manager instance
 * @returns {Promise<Object>} - Updated user
 */
export async function resetPassword(token, newPassword, userManager) {
  const tokenData = await authService.verifyOneTimeToken(token, 'password_reset');
  if (!tokenData) {
    throw new InvalidTokenError('Invalid or expired reset token');
  }

  // Get user
  const user = await userManager.getUserById(tokenData.userId);
  if (!user) {
    throw new Error('User not found');
  }

  // Set new password
  await authService.setPassword(user.id, newPassword);

  // If user was pending verification, activate them
  if (user.status === 'pending') {
    await userManager.updateUser(user.id, {
      status: 'active',
      emailVerified: true,
      emailVerifiedAt: new Date().toISOString()
    });
  }

  return { success: true };
}
