'use strict';

import { v2 as webdav } from 'webdav-server';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { CanvasWebDAVAuthentication } from './auth.js';
import { createDebug } from '../../utils/log/index.js';

const debug = createDebug('webdav:server');

/**
 * Canvas WebDAV Server Manager
 * Manages WebDAV server instance and workspace-to-path mapping
 */
export class WebDAVServerManager {
  #server = null;
  #userManager = null;
  #workspaceManager = null;
  #authentication = null;

  constructor(userManager, workspaceManager) {
    this.#userManager = userManager;
    this.#workspaceManager = workspaceManager;
    this.#authentication = new CanvasWebDAVAuthentication(userManager, workspaceManager);
  }

  /**
   * Initialize the WebDAV server
   */
  async initialize() {
    if (this.#server) {
      debug('WebDAV server already initialized');
      return;
    }

    debug('Initializing WebDAV server');

    // Create WebDAV server with Canvas authentication
    this.#server = new webdav.WebDAVServer({
      httpAuthentication: this.#authentication,
      requireAuthentication: true,
      privilegeManager: new webdav.SimplePathPrivilegeManager(),
      // Enable file locking for Class 2 WebDAV compatibility
      lockTimeout: 3600000, // 1 hour lock timeout
      strictMode: false // More lenient for various WebDAV clients
    });

    debug('WebDAV server initialized successfully');
  }

  /**
   * Get the WebDAV server instance
   */
  getServer() {
    if (!this.#server) {
      throw new Error('WebDAV server not initialized. Call initialize() first.');
    }
    return this.#server;
  }

  /**
   * Map workspace name to physical file system path
   * Returns the home directory path for the workspace
   */
  async getWorkspaceHomePath(userId, workspaceName) {
    try {
      // Get workspace for this user
      const workspace = await this.#workspaceManager.getWorkspace(userId, workspaceName);

      if (!workspace) {
        debug(`Workspace not found: ${workspaceName} for user ${userId}`);
        return null;
      }

      // Check if user has access
      const hasAccess = await this.#authentication.checkWorkspaceAccess(userId, workspaceName);
      if (!hasAccess) {
        debug(`User ${userId} does not have access to workspace ${workspaceName}`);
        return null;
      }

      // Get workspace directory path
      const workspaceDir = workspace.rootPath || workspace.path;
      if (!workspaceDir) {
        debug(`Workspace ${workspaceName} does not have a valid path`);
        return null;
      }

      // Return the home subdirectory within the workspace
      const homePath = path.join(workspaceDir, 'home');

      // Ensure the home directory exists
      if (!existsSync(homePath)) {
        debug(`Creating home directory: ${homePath}`);
        try {
          mkdirSync(homePath, { recursive: true });
        } catch (err) {
          debug(`Failed to create home directory: ${err.message}`);
          return null;
        }
      }

      debug(`Resolved workspace home path: ${homePath}`);
      return homePath;
    } catch (error) {
      debug(`Error resolving workspace home path: ${error.message}`);
      return null;
    }
  }

  /**
   * Mount a workspace's home directory as a WebDAV resource
   */
  async mountWorkspace(userId, workspaceName) {
    const server = this.getServer();
    const homePath = await this.getWorkspaceHomePath(userId, workspaceName);

    if (!homePath) {
      throw new Error(`Cannot mount workspace: ${workspaceName}`);
    }

    // Create mount path for this workspace
    const mountPath = `/${workspaceName}/home`;

    // Check if already mounted
    try {
      const resource = await new Promise((resolve, reject) => {
        server.getResource(mountPath, (e, r) => {
          if (e) reject(e);
          else resolve(r);
        });
      });

      if (resource) {
        debug(`Workspace already mounted: ${mountPath}`);
        return mountPath;
      }
    } catch (e) {
      // Not mounted yet, continue
    }

    // Mount the physical file system at this path
    return new Promise((resolve, reject) => {
      server.setFileSystem(mountPath, new webdav.PhysicalFileSystem(homePath), (success) => {
        if (success) {
          debug(`Workspace mounted successfully: ${mountPath} -> ${homePath}`);
          resolve(mountPath);
        } else {
          debug(`Failed to mount workspace: ${mountPath}`);
          reject(new Error(`Failed to mount workspace: ${workspaceName}`));
        }
      });
    });
  }

  /**
   * Handle WebDAV request
   * This is called from the Fastify route handler
   */
  async handleRequest(request, response, userId, workspaceName) {
    const server = this.getServer();

    try {
      // Ensure workspace is mounted
      await this.mountWorkspace(userId, workspaceName);

      // Use Fastify's raw Node.js request/response objects
      // webdav-server works directly with Node.js http module objects
      const nodeRequest = request.raw;
      const nodeResponse = response.raw;

      // Set required WebDAV headers on the response
      if (!nodeResponse.headersSent) {
        // Indicate WebDAV compliance levels
        nodeResponse.setHeader('DAV', '1, 2');
        nodeResponse.setHeader('MS-Author-Via', 'DAV');
      }

      // Execute WebDAV request using native Node.js request/response
      server.executeRequest(nodeRequest, nodeResponse);
    } catch (error) {
      debug(`Error handling WebDAV request: ${error.message}`);

      if (!response.sent && !response.raw.headersSent) {
        response.code(500).send({
          error: 'Internal Server Error',
          message: error.message
        });
      }
    }
  }
}

export default WebDAVServerManager;

