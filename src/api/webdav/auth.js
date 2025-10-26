'use strict';

import { HTTPAuthentication } from 'webdav-server';
import { authService } from '../auth/strategies.js';
import { createDebug } from '../../utils/log/index.js';

const debug = createDebug('webdav:auth');

/**
 * Canvas WebDAV Authentication Manager
 * Integrates WebDAV authentication with Canvas auth system (JWT/API tokens)
 */
export class CanvasWebDAVAuthentication extends HTTPAuthentication {
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
        debug('No authorization header provided');
        return callback(null, null);
      }

      let token = null;

      // Try Bearer token first (preferred method)
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
        debug('Bearer token detected');
      }
      // Try HTTP Basic Auth (fallback for WebDAV clients that don't support Bearer)
      else if (authHeader.startsWith('Basic ')) {
        try {
          const base64Credentials = authHeader.substring(6);
          const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
          const [username, password] = credentials.split(':');

          // For Basic Auth, we use the password field as the token
          // Username can be anything (typically email or username)
          token = password;
          debug(`Basic auth detected for user: ${username}`);
        } catch (e) {
          debug(`Failed to parse Basic auth: ${e.message}`);
          return callback(null, null);
        }
      }

      if (!token) {
        debug('No valid token found in authorization header');
        return callback(null, null);
      }

      // Verify token using Canvas auth service
      const result = await authService.verifyToken(token);

      if (!result || !result.valid) {
        debug(`Token verification failed: ${result?.message || 'Invalid token'}`);
        return callback(null, null);
      }

      debug(`User authenticated: ${result.user.id} (${result.user.email})`);

      // Return user object with required fields
      callback(null, {
        uid: result.user.id,
        username: result.user.name || result.user.email,
        email: result.user.email,
        isDefaultUser: false,
        isAdministrator: result.user.userType === 'admin'
      });
    } catch (error) {
      debug(`Authentication error: ${error.message}`);
      callback(error, null);
    }
  }

  /**
   * Verify user has access to requested workspace
   */
  async checkWorkspaceAccess(userId, workspaceName) {
    try {
      // Get workspace by name for this user
      const workspace = await this.workspaceManager.getWorkspace(userId, workspaceName);

      if (!workspace) {
        debug(`Workspace not found: ${workspaceName} for user ${userId}`);
        return false;
      }

      // Check if user is owner or has access via ACL
      if (workspace.owner === userId) {
        debug(`User ${userId} is owner of workspace ${workspaceName}`);
        return true;
      }

      // Check ACL permissions
      const acl = workspace.acl || [];
      const userAccess = acl.find(entry => entry.userId === userId);

      if (userAccess && userAccess.permissions?.includes('read')) {
        debug(`User ${userId} has read access to workspace ${workspaceName}`);
        return true;
      }

      debug(`User ${userId} does not have access to workspace ${workspaceName}`);
      return false;
    } catch (error) {
      debug(`Error checking workspace access: ${error.message}`);
      return false;
    }
  }
}

export default CanvasWebDAVAuthentication;

