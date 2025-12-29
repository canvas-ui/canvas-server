'use strict';

import webdavServer from 'webdav-server';
const { HTTPBasicAuthentication } = webdavServer;
import { authService } from '../auth/strategies.js';
import { createLogger } from '../../utils/log.js';

const logger = createLogger('webdav:auth');

/**
 * Canvas WebDAV Authentication Manager
 * Integrates WebDAV authentication with Canvas auth system (JWT/API tokens)
 */
export class CanvasWebDAVAuthentication extends HTTPBasicAuthentication {
  constructor(userManager, workspaceManager) {
    super(userManager, 'Canvas WebDAV');
    this.userManager = userManager;
    this.workspaceManager = workspaceManager;
  }

  /**
   * Extract and validate authentication credentials
   * Supports both Bearer token and HTTP Basic Auth (where password = token)
   */
  async getUser(ctx, callback) {
    try {
      const authHeader = ctx.headers.find('authorization');

      if (!authHeader) {
        logger.debug('No authorization header provided');
        // Set WWW-Authenticate header for Windows WebDAV clients
        ctx.response.setHeader('WWW-Authenticate', 'Basic realm="Canvas WebDAV", Bearer realm="Canvas WebDAV"');
        return callback(null, null);
      }

      let token = null;

      // Try Bearer token first (preferred method)
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
        logger.debug('Bearer token detected');
      }
      // Try HTTP Basic Auth (fallback for WebDAV clients that don't support Bearer)
      else if (authHeader.startsWith('Basic ')) {
        try {
          const base64Credentials = authHeader.substring(6);
          const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
          const [username, password] = credentials.split(':', 2);
          logger.debug(`Basic auth detected for user: ${username}`);

          // Check if password is an API token (starts with canvas-)
          if (password.startsWith('canvas-')) {
            token = password;
            logger.debug('Using password as API token');
          } else {
            // Try to authenticate with username/password
            logger.debug('Attempting username/password authentication');
            try {
              const user = await this.userManager.getByEmail(username);

              // Verify password
              const passwordValid = await authService.verifyPassword(user.id, password);
              if (!passwordValid) {
                logger.debug(`Invalid password for user: ${username}`);
                return callback(null, null);
              }

              logger.debug(`Password authentication successful for user: ${username}`);
              // Return user object directly
              return callback(null, {
                uid: user.id,
                username: user.name || user.email,
                email: user.email,
                isDefaultUser: false,
                isAdministrator: user.userType === 'admin'
              });
            } catch (userError) {
              logger.debug(`User not found or error: ${userError.message}`);
              return callback(null, null);
            }
          }
        } catch (e) {
          logger.debug(`Failed to parse Basic auth: ${e.message}`);
          return callback(null, null);
        }
      }

      if (!token) {
        logger.debug('No valid token found in authorization header');
        return callback(null, null);
      }

      // Verify token using Canvas auth service
      const result = await authService.verifyToken(token);

      if (!result || !result.valid) {
        logger.debug(`Token verification failed: ${result?.message || 'Invalid token'}`);
        return callback(null, null);
      }

      logger.debug(`User authenticated: ${result.user.id} (${result.user.email})`);

      // Return user object with required fields
      callback(null, {
        uid: result.user.id,
        username: result.user.name || result.user.email,
        email: result.user.email,
        isDefaultUser: false,
        isAdministrator: result.user.userType === 'admin'
      });
    } catch (error) {
      logger.debug(`Authentication error: ${error.message}`);
      callback(error, null);
    }
  }

  /**
   * Verify user has access to requested workspace
   */
  async checkWorkspaceAccess(userId, workspaceName) {
    try {
      // Resolve workspace name to ID
      const workspaceId = this.workspaceManager.resolveWorkspaceId(userId, workspaceName);
      if (!workspaceId) {
        logger.debug(`Workspace not found: ${workspaceName} for user ${userId}`);
        return false;
      }

      // Get workspace by ID for this user
      const workspace = await this.workspaceManager.getWorkspace(workspaceId, userId);
      if (!workspace) {
        logger.debug(`Workspace not found: ${workspaceName} for user ${userId}`);
        return false;
      }

      // Check if user is owner or has access via ACL
      if (workspace.owner === userId) {
        logger.debug(`User ${userId} is owner of workspace ${workspaceName}`);
        return true;
      }

      // Check ACL permissions
      const acl = workspace.acl || [];
      const userAccess = acl.find(entry => entry.userId === userId);

      if (userAccess && userAccess.permissions?.includes('read')) {
        logger.debug(`User ${userId} has read access to workspace ${workspaceName}`);
        return true;
      }

      logger.debug(`User ${userId} does not have access to workspace ${workspaceName}`);
      return false;
    } catch (error) {
      logger.debug(`Error checking workspace access: ${error.message}`);
      return false;
    }
  }
}

export default CanvasWebDAVAuthentication;

