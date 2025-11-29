'use strict';

import { authService, imapAuthStrategy, ldapAuthStrategy, login, register, verifyEmail, requestPasswordReset, resetPassword, validateUser, requestEmailVerification } from '../auth/strategies.js';
import ResponseObject from '../ResponseObject.js';

// Persistent rate limiter (per-IP) using jim index store to survive process restarts
const rateLimitBuckets = new Map(); // fallback in-memory
function rateLimit({ max, windowMs }, keyName = 'generic') {
  return async function onRequest(request, reply) {
    try {
      const ip = request.ip || request.headers['x-forwarded-for'] || request.socket?.remoteAddress || 'unknown';
      const routeUrl = request.routeOptions?.url || request.url;
      const key = `${keyName}:${routeUrl}:${ip}`;
      const now = Date.now();
      // Prefer persistent limiter via authService if available
      if (request.server?.authService?.checkAndIncrementRateLimit) {
        const result = await request.server.authService.checkAndIncrementRateLimit(key, max, windowMs);
        if (result.limited) {
          const response = new ResponseObject().tooManyRequests('Too many requests, please try again later');
          return reply.code(response.statusCode).send(response.getResponse());
        }
      } else {
        // Fallback in-memory limiter
        const bucket = rateLimitBuckets.get(key) || { count: 0, resetAt: now + windowMs };
        if (now > bucket.resetAt) {
          bucket.count = 0;
          bucket.resetAt = now + windowMs;
        }
        bucket.count += 1;
        rateLimitBuckets.set(key, bucket);
        if (bucket.count > max) {
          const response = new ResponseObject().tooManyRequests('Too many requests, please try again later');
          return reply.code(response.statusCode).send(response.getResponse());
        }
      }
    } catch (e) {
      // If rate limiter fails, do not block request
    }
  };
}

/**
 * Auth routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function authRoutes(fastify, options) {
  // Get authentication configuration
  fastify.get('/config', async (request, reply) => {
    try {
      await imapAuthStrategy.initialize();
      await ldapAuthStrategy.initialize();

      const config = {
        strategies: {
          local: {
            enabled: true,
            passwordPolicy: authService.getPasswordPolicy(),
            requireEmailVerification: authService.isEmailVerificationRequired()
          },
          imap: {
            enabled: imapAuthStrategy.isEnabled(),
            domains: imapAuthStrategy.getAvailableDomains()
          },
          ldap: {
            enabled: ldapAuthStrategy.isEnabled()
          }
        }
      };

      const response = new ResponseObject().success(config, 'Authentication configuration retrieved');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to retrieve authentication configuration');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Login endpoint
  fastify.post('/login', {
    onRequest: [rateLimit({ max: authService.getRateLimitConfig('loginAttempts')?.maxAttempts || 5, windowMs: authService.getRateLimitConfig('loginAttempts')?.windowMs || 15 * 60 * 1000 }, 'login')],
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          strategy: { type: 'string', enum: ['local', 'imap', 'ldap', 'auto'] }
        }
      }
    }
  }, async (request, reply) => {
    try {
      // Check if users service is available
      if (!fastify.users) {
        fastify.log.error('User manager not available in login endpoint');
        const response = new ResponseObject().serverError('User management system not available');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const { email, password, strategy = 'auto' } = request.body;

      // Ensure external auth strategies are initialized before login attempt
      if (strategy === 'imap' || strategy === 'auto') {
        try {
          await imapAuthStrategy.initialize();
        } catch (error) {
          fastify.log.warn(`IMAP strategy initialization failed: ${error.message}. IMAP login may be unavailable.`);
          // If strategy is explicitly 'imap', fail fast
          if (strategy === 'imap') {
            const response = new ResponseObject().serverError('IMAP authentication is not available.');
            return reply.code(response.statusCode).send(response.getResponse());
          }
        }
      }

      if (strategy === 'ldap' || strategy === 'auto') {
        try {
          await ldapAuthStrategy.initialize();
        } catch (error) {
          fastify.log.warn(`LDAP strategy initialization failed: ${error.message}. LDAP login may be unavailable.`);
          // If strategy is explicitly 'ldap', fail fast
          if (strategy === 'ldap') {
            const response = new ResponseObject().serverError('LDAP authentication is not available.');
            return reply.code(response.statusCode).send(response.getResponse());
          }
        }
      }

      const result = await login(email, password, fastify.users, strategy);

      // Generate JWT token
      const token = authService.generateJWT(result.user);

      const response = new ResponseObject().success({
        token,
        user: {
          id: result.user.id,
          name: result.user.name || result.user.email,
          email: result.user.email,
          authMethod: result.authMethod || 'local'
        }
      }, 'Login successful');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      if (error.code === 'ERR_INVALID_CREDENTIALS') {
        fastify.log.info(`Login failed: ${error.message}`);
        const response = new ResponseObject().unauthorized(error.message || 'Login failed');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Handle IMAP-specific errors with more descriptive messages
      if (error.code === 'ERR_IMAP_AUTH') {
        fastify.log.info(`IMAP login failed: ${error.message}`);
        const response = new ResponseObject().unauthorized(error.message || 'Email server authentication failed');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (error.code === 'ERR_IMAP_CONFIG') {
        fastify.log.info(`IMAP config error: ${error.message}`);
        const response = new ResponseObject().badRequest('Unsupported login domain - email server not configured');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Handle LDAP-specific errors
      if (error.code === 'ERR_LDAP_AUTH') {
        fastify.log.info(`LDAP login failed: ${error.message}`);
        const response = new ResponseObject().unauthorized(error.message || 'LDAP authentication failed');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (error.code === 'ERR_LDAP_CONFIG') {
        fastify.log.info(`LDAP config error: ${error.message}`);
        const response = new ResponseObject().badRequest('LDAP authentication not configured properly');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Check if error message indicates unsupported domain
      if (error.message && error.message.includes('not supported for domain')) {
        fastify.log.info(`Unsupported domain: ${error.message}`);
        const response = new ResponseObject().badRequest('Unsupported login domain - please check your email address or contact administrator');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'An unexpected error occurred during login');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Logout endpoint (client-side only)
  fastify.post('/logout', {
  }, async (request, reply) => {
    const response = new ResponseObject().success({ success: true }, 'Logout successful');
    return reply.code(response.statusCode).send(response.getResponse());
  });

  // Register endpoint
  fastify.post('/register', {
    onRequest: [rateLimit({ max: authService.getRateLimitConfig('registration')?.maxAttempts || 3, windowMs: authService.getRateLimitConfig('registration')?.windowMs || 60 * 60 * 1000 }, 'register')],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'email', 'password'],
        properties: {
          name: {
            type: 'string',
            minLength: 3,
            maxLength: 39,
            pattern: '^[a-z0-9_-]+$',
            description: 'Username (3-39 chars, lowercase letters, numbers, underscores, hyphens only)'
          },
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 12 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const result = await register(request.body, fastify.users);

      if (!result.success) {
        // Include server-provided details when available
        const response = new ResponseObject().badRequest(result.message || 'Registration failed', result.details || null);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // If a verification token was created, try sending email but never expose the token
      if (result.data?.token) {
        try {
          await authService.sendVerificationEmail(result.data.user, result.data.token, request);
        } catch (e) {
          fastify.log.warn('[Register] Failed to send verification email:', e?.message);
        }
      }

      const response = new ResponseObject().created({ user: result.data.user }, 'Registration successful');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error('[Register Route Error]', error.message);

      // Provide specific error messages for username validation
      if (error.message.includes('User name')) {
        const response = new ResponseObject().badRequest(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().serverError('Registration failed');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Update password endpoint
  fastify.put('/password', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', minLength: 1 },
          newPassword: { type: 'string', minLength: 12 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { currentPassword, newPassword } = request.body;
      const validPassword = await authService.verifyPassword(request.user.id, currentPassword);

      if (!validPassword) {
        const response = new ResponseObject().unauthorized('Current password is incorrect');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      await authService.setPassword(request.user.id, newPassword);
      const response = new ResponseObject().success({ success: true }, 'Password updated successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to update password');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Forgot password endpoint
  fastify.post('/forgot-password', {
    onRequest: [rateLimit({ max: authService.getRateLimitConfig('passwordReset')?.maxAttempts || 3, windowMs: authService.getRateLimitConfig('passwordReset')?.windowMs || 60 * 60 * 1000 }, 'forgot-password')],
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      await requestPasswordReset(request.body.email, fastify.users);
      const response = new ResponseObject().success({
        success: true,
        message: 'If an account exists with this email, you will receive password reset instructions.'
      }, 'Password reset email sent');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to process password reset request');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Reset password endpoint
  fastify.post('/reset-password', {
    schema: {
      body: {
        type: 'object',
        required: ['token', 'newPassword'],
        properties: {
          token: { type: 'string' },
          newPassword: { type: 'string', minLength: 12 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { token, newPassword } = request.body;
      const success = await resetPassword(token, newPassword, fastify.users);

      if (!success) {
        const response = new ResponseObject().badRequest('Password reset token is invalid or expired');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success({ success: true }, 'Password reset successful');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to reset password');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Request verification email endpoint
  fastify.post('/verify-email', {
    onRequest: [rateLimit({ max: authService.getRateLimitConfig('tokenOperations')?.maxAttempts || 5, windowMs: authService.getRateLimitConfig('tokenOperations')?.windowMs || 5 * 60 * 1000 }, 'verify-email')],
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const result = await requestEmailVerification(request.body.email, fastify.users);

      // Try to send the email if we could create a token
      if (result?.token && result?.user) {
        try {
          await authService.sendVerificationEmail(result.user, result.token, request);
        } catch (e) {
          fastify.log.warn('[Verify Email] Failed to send verification email:', e?.message);
        }
      }

      const response = new ResponseObject().success({
        success: true,
        message: 'If an account exists with this email, you will receive verification instructions.'
      }, 'Verification email sent');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to process email verification request');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Verify email token endpoint
  fastify.get('/verify-email/:token', {
    schema: {
      params: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      await verifyEmail(request.params.token, fastify.users);
      const response = new ResponseObject().success({ success: true }, 'Email verified successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to verify email');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // List API tokens endpoint
  fastify.get('/tokens', {
    onRequest: [fastify.authenticate]

  }, async (request, reply) => {
    try {
      const tokens = await authService.listTokens(request.user.id);
      const response = new ResponseObject().found(tokens, 'API tokens retrieved successfully', 200, tokens.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list API tokens');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Create API token endpoint
  fastify.post('/tokens', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const token = await authService.createToken(request.user.id, request.body);
      const response = new ResponseObject().created({
        id: token.id,
        token: token.value,
        name: token.name,
        description: token.description,
        createdAt: token.createdAt
      }, 'API token created successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to create API token');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Delete API token endpoint
  fastify.delete('/tokens/:tokenId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['tokenId'],
        properties: {
          tokenId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const success = await authService.deleteToken(request.user.id, request.params.tokenId);
      if (!success) {
        const response = new ResponseObject().notFound('Token not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().success({ success: true }, 'Token deleted successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to delete token');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Update API token endpoint
  fastify.put('/tokens/:tokenId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['tokenId'],
        properties: {
          tokenId: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const result = await authService.updateToken(request.user.id, request.params.tokenId, request.body);
      if (!result) {
        const response = new ResponseObject().notFound('Token not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().success(result, 'Token updated successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to update token');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Verify token endpoint (no auth required)
  fastify.post('/token/verify', {
    schema: {
      body: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const result = await authService.verifyToken(request.body.token);

      if (!result.valid) {
        const response = new ResponseObject().unauthorized('Invalid token');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success({
        valid: true,
        user: {
          id: result.user.id,
          email: result.user.email,
          userType: result.user.userType
        }
      }, 'Token verified successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to verify token');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get current user endpoint
  fastify.get('/me', {
    onRequest: [fastify.authenticateCustom]

  }, async (request, reply) => {
    // Check if reply has already been sent by auth middleware or other mechanism
    if (reply.sent) {
      fastify.log.warn('[Auth/Me] Reply already sent before handler execution');
      return;
    }

    try {
      // Enhanced logging for debugging authentication issues
      fastify.log.info(`[Auth/Me] Request received, headers: ${JSON.stringify({
        authorization: request.headers.authorization ? `Bearer ${request.headers.authorization.substring(7, 16)}...` : undefined,
        'user-agent': request.headers['user-agent'],
        referer: request.headers.referer
      })}`);

      fastify.log.info(`[Auth/Me] Request user object: ${request.user ? `id=${request.user.id}` : 'undefined'}`);

      let userId = null;
      let userData = null;

      // First attempt: Check if auth middleware set the user object
      if (request.user && request.user.id) {
        userId = request.user.id;
        fastify.log.info(`[Auth/Me] Using user ID from request: ${userId}`);
      }
      // Second attempt: Try to extract user ID from token
      else {
        fastify.log.warn('[Auth/Me] User object missing or incomplete, attempting token extraction');

        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          fastify.log.error('[Auth/Me] No valid authorization header found');
          const response = new ResponseObject().unauthorized('Authentication required');
          return reply.code(response.statusCode).send(response.getResponse());
        }

        const token = authHeader.split(' ')[1];
        fastify.log.info(`[Auth/Me] Attempting manual token validation: ${token.substring(0, 10)}...`);

        try {
          // Handle API token
          if (token.startsWith('canvas-')) {
            fastify.log.info('[Auth/Me] Detected API token, verifying manually');
            const tokenResult = await fastify.authService.verifyApiToken(token);
            if (tokenResult) {
              userId = tokenResult.userId;
              fastify.log.info(`[Auth/Me] API token validation successful: ${userId}`);
            }
          }
          // Handle JWT token
          else {
            fastify.log.info('[Auth/Me] Attempting JWT verification');
            const decoded = fastify.jwt.verify(token);
            userId = decoded.sub;
            fastify.log.info(`[Auth/Me] JWT verification successful: ${userId}`);
          }
        } catch (tokenError) {
          fastify.log.error(`[Auth/Me] Token validation failed: ${tokenError.message}`);
          const response = new ResponseObject().unauthorized(`Invalid token: ${tokenError.message}`);
          return reply.code(response.statusCode).send(response.getResponse());
        }
      }

      // Verify we have a user ID
      if (!userId) {
        fastify.log.error('[Auth/Me] Failed to extract user ID from request or token');
        const response = new ResponseObject().unauthorized('Authentication failed - unable to identify user');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Get user data from database
      try {
        userData = await fastify.users.getById(userId);

        if (!userData) {
          fastify.log.error(`[Auth/Me] User not found in database: ${userId}`);
          const response = new ResponseObject().unauthorized(`Authentication failed - user account no longer exists: ${userId}`);
          return reply.code(response.statusCode).send(response.getResponse());
        }

        fastify.log.info(`[Auth/Me] Successfully retrieved user data: ${userData.id}`);
      } catch (dbError) {
        fastify.log.error(`[Auth/Me] Database error: ${dbError.message}`);

        // Handle the specific case where user exists in token but not in database
        if (dbError.message.includes('User not found in index')) {
          fastify.log.warn(`[Auth/Me] User ${userId} has valid token but missing from database - clearing authentication`);

          // Return a specific error that the frontend can handle
          const response = new ResponseObject().unauthorized(
            'Your session is invalid. Please log in again.',
            {
              code: 'USER_NOT_FOUND_IN_DATABASE',
              userId: userId,
              action: 'logout'
            }
          );
          return reply.code(response.statusCode).send(response.getResponse());
        }

        // For other database errors, return a generic server error
        const response = new ResponseObject().serverError('Database error when retrieving user profile');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Check if reply has been sent during our manual auth process
      if (reply.sent) {
        fastify.log.warn('[Auth/Me] Reply already sent during handler execution');
        return;
      }

      // Return user profile
      const response = new ResponseObject().found({
        id: userData.id,
        name: userData.name || userData.email,
        email: userData.email,
        userType: userData.userType || 'user',
        status: userData.status || 'active'
      }, 'User profile retrieved successfully');

      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      // Check if reply has been sent before responding to error
      if (reply.sent) {
        fastify.log.error(`[Auth/Me] Error after reply already sent: ${error.message}`);
        return;
      }

      fastify.log.error(`[Auth/Me] Unexpected error: ${error.message}`, error);
      const response = new ResponseObject().serverError('Failed to get user profile');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
