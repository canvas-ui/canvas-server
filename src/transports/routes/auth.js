'use strict';

import { authService, imapAuthStrategy, ldapAuthStrategy, login, register, verifyEmail, requestPasswordReset, resetPassword, validateUser as _validateUser, requestEmailVerification } from '../auth/strategies.js';
import ResponseObject from '../ResponseObject.js';
import { v4 as uuidv4 } from 'uuid';

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
    } catch  {
      // If rate limiter fails, do not block request
    }
  };
}

/**
 * Auth routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function authRoutes(fastify, _options) {
  // Get authentication configuration
  fastify.get('/config', async (request, reply) => {
    try {
      await imapAuthStrategy.initialize();
      await ldapAuthStrategy.initialize();

      const config = {
        allowUserRegistrations: authService.areRegistrationsAllowed(),
        strategies: {
          local: {
            enabled: authService.isLocalEnabled(),
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
          password: { type: 'string', minLength: 8 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      if (!authService.areRegistrationsAllowed()) {
        const response = new ResponseObject().forbidden('User registrations are disabled on this server');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (!authService.isLocalEnabled()) {
        const response = new ResponseObject().forbidden('Registration is disabled');
        return reply.code(response.statusCode).send(response.getResponse());
      }

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
      fastify.log.error('[Register Route Error]', error);

      // Provide specific error messages for various validation issues
      if (error.message.includes('User name')) {
        const response = new ResponseObject().badRequest(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (error.message.includes('already exists') || error.message.includes('duplicate') || error.message.includes('Email already registered')) {
        const response = new ResponseObject().badRequest(error.message || 'Email or username already exists');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (error.message.includes('Invalid') || error.message.includes('validation')) {
        const response = new ResponseObject().badRequest(error.message || 'Invalid registration data');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().serverError(error.message || 'Registration failed');
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
          newPassword: { type: 'string', minLength: 8 }
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
    // Reset tokens are secrets guessed here — throttle to stop brute forcing.
    onRequest: [rateLimit({ max: authService.getRateLimitConfig('passwordReset')?.maxAttempts || 3, windowMs: authService.getRateLimitConfig('passwordReset')?.windowMs || 60 * 60 * 1000 }, 'reset-password')],
    schema: {
      body: {
        type: 'object',
        required: ['token', 'newPassword'],
        properties: {
          token: { type: 'string' },
          newPassword: { type: 'string', minLength: 8 }
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
    // Same secret-token brute-force surface as the POST sibling — throttle it.
    onRequest: [rateLimit({ max: authService.getRateLimitConfig('tokenOperations')?.maxAttempts || 5, windowMs: authService.getRateLimitConfig('tokenOperations')?.windowMs || 5 * 60 * 1000 }, 'verify-email-token')],
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

  /**
   * Devices: register/list/update
   * Stored in the per-user server-side device registry.
   */

  async function revokeDeviceTokens(userId, deviceId) {
    const tokens = await fastify.authService.listTokens(userId);
    const matches = (tokens || []).filter((token) => token.type === 'device' && token.deviceId === deviceId);

    for (const token of matches) {
      await fastify.authService.deleteToken(userId, token.id);
    }
  }

  // Register a device and mint a device-scoped token
  fastify.post('/devices/register', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          deviceId: { type: 'string' },
          name: { type: 'string' },
          hostname: { type: 'string' },
          fqdn: { type: 'string' },
          description: { type: 'string' },
          platform: { type: 'string' },
          arch: { type: 'string' },
          type: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      if (!fastify.deviceRegistry) {
        throw new Error('Device registry not available');
      }

      const input = request.body || {};
      const newDeviceId = String(input.deviceId || '').trim() || uuidv4();
      const name =
        String(input.name || '').trim() ||
        String(input.fqdn || '').trim() ||
        String(input.hostname || '').trim() ||
        'unknown-device';
      const description = String(input.description || '').trim() || undefined;
      const device = await fastify.deviceRegistry.upsertDevice(request.user.id, {
        deviceId: newDeviceId,
        name,
        description,
        platform: input.platform,
        arch: input.arch,
        type: input.type,
      });

      await revokeDeviceTokens(request.user.id, newDeviceId);

      // Mint a device token (canvas-...)
      const token = await fastify.authService.createToken(request.user.id, {
        type: 'device',
        name: `device:${newDeviceId}`,
        description: `Device token for ${name}`,
        deviceId: newDeviceId,
        deviceNameAtIssue: name,
      });

      const response = new ResponseObject().created({
        ...device,
        token: token.value,
      }, 'Device registered');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to register device');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // List devices
  fastify.get('/devices', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      if (!fastify.deviceRegistry) {
        throw new Error('Device registry not available');
      }

      const devices = await fastify.deviceRegistry.listDevices(request.user.id);

      const response = new ResponseObject().found(devices, 'Devices retrieved successfully', 200, devices.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list devices');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Update a device
  fastify.patch('/devices/:deviceId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['deviceId'],
        properties: {
          deviceId: { type: 'string' }
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
      if (!fastify.deviceRegistry) {
        throw new Error('Device registry not available');
      }

      const deviceId = request.params.deviceId;
      const name = request.body?.name === undefined ? undefined : String(request.body.name || '').trim();
      const description = request.body?.description === undefined ? undefined : String(request.body.description || '').trim();

      if (name !== undefined && !name) {
        const response = new ResponseObject().badRequest('name must not be empty');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      if (name === undefined && description === undefined) {
        const response = new ResponseObject().badRequest('name or description is required');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const device = await fastify.deviceRegistry.updateDevice(request.user.id, deviceId, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      });

      const response = new ResponseObject().success(device, 'Device updated');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      if (error.message?.includes('not found')) {
        const response = new ResponseObject().notFound('Device not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().serverError('Failed to update device');
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
    // Unauthenticated by design (integrations validate a token they hold), so
    // throttle it — otherwise it is an offline-harvested-token confirmation and
    // account-discovery oracle. userType is withheld from the response below to
    // avoid turning it into an admin-account finder.
    onRequest: [rateLimit({ max: authService.getRateLimitConfig('tokenOperations')?.maxAttempts || 5, windowMs: authService.getRateLimitConfig('tokenOperations')?.windowMs || 5 * 60 * 1000 }, 'token-verify')],
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
          email: result.user.email
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
        userData = await fastify.users.get(userId);

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

  // Refresh a JWT session: mint a fresh JWT while the current one is still valid.
  // This enables clients (e.g. the browser extension) to keep a session alive across
  // the JWT expiry window without re-prompting for credentials. Only JWT-authenticated
  // sessions can be refreshed — API/device tokens are opaque and already long-lived,
  // so there is nothing to renew for them.
  fastify.post('/token/refresh', {
    onRequest: [fastify.authenticateCustom]
  }, async (request, reply) => {
    if (reply.sent) return;

    try {
      if (request.authStrategy && request.authStrategy !== 'jwt') {
        const response = new ResponseObject().badRequest('Only JWT sessions can be refreshed; API tokens do not expire');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const userId = request.user?.id;
      if (!userId) {
        const response = new ResponseObject().unauthorized('Authentication required');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const user = await fastify.users.get(userId);
      if (!user) {
        const response = new ResponseObject().unauthorized('User account no longer exists');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const token = authService.generateJWT(user);
      const expiresIn = authService.getJwtExpiry() || '1d';

      const response = new ResponseObject().success({
        token,
        expiresIn,
        user: {
          id: user.id,
          name: user.name || user.email,
          email: user.email
        }
      }, 'Token refreshed successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`[Auth/Refresh] Failed to refresh token: ${error.message}`);
      const response = new ResponseObject().serverError('Failed to refresh token');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
