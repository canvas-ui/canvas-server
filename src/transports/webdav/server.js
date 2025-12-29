'use strict';

import webdavServer from 'webdav-server';
const webdav = webdavServer.v2;
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { CanvasWebDAVAuthentication } from './auth.js';
import { createLogger } from '../../utils/log.js';

const logger = createLogger('webdav:server');

/**
 * Canvas WebDAV Server Manager
 * Manages WebDAV server instance and workspace-to-path mapping
 */
export class WebDAVServerManager {
  #userManager = null;
  #workspaceManager = null;
  #authentication = null;

  constructor(userManager, workspaceManager) {
    this.#userManager = userManager;
    this.#workspaceManager = workspaceManager;
    this.#authentication = new CanvasWebDAVAuthentication(userManager, workspaceManager);
  }

  /**
   * Initialize - no-op now, kept for compatibility
   */
  async initialize() {
    logger.debug('WebDAV server manager initialized');
  }

  /**
   * Create a new WebDAV server instance for this specific request
   * This ensures complete isolation between concurrent requests
   */
  createServerInstance() {
    logger.debug('Creating new WebDAV server instance for request');

    // Create WebDAV server with custom authentication that always succeeds
    const userManager = new webdav.SimpleUserManager();
    const privilegeManager = new webdav.SimplePathPrivilegeManager();

    // Add a default user for the WebDAV server
    const defaultUser = userManager.addUser('webdav', 'webdav', false);
    privilegeManager.setRights(defaultUser, '/', ['all']);

    // Create custom authentication that always succeeds
    const customAuth = {
      getUser: (ctx, callback) => {
        callback(null, defaultUser);
      },
      askForAuthentication: (ctx) => {
        return defaultUser;
      }
    };

    const server = new webdav.WebDAVServer({
      httpAuthentication: customAuth,
      userManager: userManager,
      privilegeManager: privilegeManager,
      lockTimeout: 3600000,
      strictMode: false
    });

    logger.debug('WebDAV server instance created');
    return server;
  }

  /**
   * Shutdown - no-op now since we create instances per request
   */
  async shutdown() {
    logger.debug('WebDAV server manager shutdown (no-op)');
  }

  /**
   * Map workspace name to physical file system path
   * Returns the home directory path for the workspace
   */
  async getWorkspaceHomePath(userId, workspaceName) {
    try {
      // Resolve workspace name to ID
      const workspaceId = this.#workspaceManager.resolveWorkspaceId(userId, workspaceName);
      if (!workspaceId) {
        logger.debug(`Workspace not found: ${workspaceName} for user ${userId}`);
        return null;
      }

      // Get workspace for this user
      const workspace = await this.#workspaceManager.getWorkspace(workspaceId, userId);
      if (!workspace) {
        logger.debug(`Workspace not found: ${workspaceName} for user ${userId}`);
        return null;
      }

      // Check if user has access
      const hasAccess = await this.#authentication.checkWorkspaceAccess(userId, workspaceName);
      if (!hasAccess) {
        logger.debug(`User ${userId} does not have access to workspace ${workspaceName}`);
        return null;
      }

      // Get workspace directory path
      const workspaceDir = workspace.rootPath || workspace.path;
      if (!workspaceDir) {
        logger.debug(`Workspace ${workspaceName} does not have a valid path`);
        return null;
      }

      // Return the home subdirectory within the workspace
      const homePath = path.join(workspaceDir, 'home');

      // Ensure the home directory exists
      if (!existsSync(homePath)) {
        logger.debug(`Creating home directory: ${homePath}`);
        try {
          mkdirSync(homePath, { recursive: true });
        } catch (err) {
          logger.debug(`Failed to create home directory: ${err.message}`);
          return null;
        }
      }

      logger.debug(`Resolved workspace home path: ${homePath}`);
      return homePath;
    } catch (error) {
      logger.debug(`Error resolving workspace home path: ${error.message}`);
      return null;
    }
  }

  /**
   * Mount a workspace's home directory on a server instance
   * Each request gets its own server instance, so no race conditions
   */
  async mountWorkspace(server, userId, workspaceName) {
    const homePath = await this.getWorkspaceHomePath(userId, workspaceName);

    if (!homePath) {
      throw new Error(`Cannot mount workspace: ${workspaceName}`);
    }

    // Mount at root '/' - security isolation comes from:
    // 1. Each request has its own server instance
    // 2. Authentication/authorization in routes
    // 3. Filesystem already namespaced per user
    const mountPath = '/';

    logger.debug(`Mounting workspace at ${mountPath} -> ${homePath}`);

    return new Promise((resolve, reject) => {
      server.setFileSystem(mountPath, new webdav.PhysicalFileSystem(homePath), (success) => {
        if (success) {
          logger.debug(`Workspace mounted successfully`);
          resolve(mountPath);
        } else {
          logger.debug(`Failed to mount workspace`);
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
    // Create a fresh WebDAV server instance for this request
    const server = this.createServerInstance();

    try {
      logger.debug(`=== WebDAV Request Start ===`);
      logger.debug(`Method: ${request.method}`);
      logger.debug(`URL: ${request.url}`);
      logger.debug(`Headers: ${JSON.stringify(request.headers, null, 2)}`);
      logger.debug(`User: ${userId}, Workspace: ${workspaceName}`);

      // Mount workspace on this request's server instance
      logger.debug(`Mounting workspace ${workspaceName}...`);
      await this.mountWorkspace(server, userId, workspaceName);
      logger.debug(`Workspace ${workspaceName} mounted successfully`);

      // Use Fastify's raw Node.js request/response objects
      // webdav-server works directly with Node.js http module objects
      let nodeRequest = request.raw;  // Use 'let' so we can replace it if needed
      const nodeResponse = response.raw;

      // Rewrite URL to remove /webdav/:workspaceName/home prefix
      // The WebDAV server is mounted at / (root) for this specific request instance
      const urlPrefix = `/webdav/${workspaceName}/home`;
      const originalUrl = nodeRequest.url;
      let rewrittenUrl = originalUrl;

      if (originalUrl.startsWith(urlPrefix)) {
        // Strip /webdav/:workspaceName/home prefix
        rewrittenUrl = originalUrl.substring(urlPrefix.length) || '/';
      }

      logger.debug(`Original URL: ${originalUrl}`);
      logger.debug(`Rewritten URL: ${rewrittenUrl}`);

      // Override the URL on the request object
      nodeRequest.url = rewrittenUrl;

      logger.debug(`Raw request method: ${nodeRequest.method}`);
      logger.debug(`Raw request headers: ${JSON.stringify(nodeRequest.headers, null, 2)}`);

      // Intercept response to rewrite URLs in XML responses
      const originalSetHeader = nodeResponse.setHeader.bind(nodeResponse);
      const originalWriteHead = nodeResponse.writeHead.bind(nodeResponse);
      const originalWrite = nodeResponse.write.bind(nodeResponse);
      const originalEnd = nodeResponse.end.bind(nodeResponse);

      let responseBody = [];
      let headersWritten = false;
      let isXmlResponse = null; // null = unknown, true = XML, false = not XML

      // Capture content-type from setHeader
      nodeResponse.setHeader = function(name, value) {
        logger.debug(`Response setHeader: ${name} = ${value}`);
        if (name.toLowerCase() === 'content-type' && typeof value === 'string' && isXmlResponse === null) {
          isXmlResponse = value.includes('xml');
          logger.debug(`Detected ${isXmlResponse ? 'XML' : 'non-XML'} response early`);
        }
        return originalSetHeader(name, value);
      };

      // Capture content-type from writeHead
      nodeResponse.writeHead = function(statusCode, statusMessage, headers) {
        logger.debug(`Response writeHead called: ${statusCode}`);
        headersWritten = true;

        // Check for content-type in headers if not yet determined
        if (isXmlResponse === null) {
          const hdrs = (typeof statusMessage === 'object') ? statusMessage : headers;
          if (hdrs) {
            for (const [key, value] of Object.entries(hdrs)) {
              if (key.toLowerCase() === 'content-type' && typeof value === 'string') {
                isXmlResponse = value.includes('xml');
                logger.debug(`Detected ${isXmlResponse ? 'XML' : 'non-XML'} response in writeHead`);
                break;
              }
            }
          }
        }

        return originalWriteHead(statusCode, statusMessage, headers);
      };

      // Capture response body for XML, pass-through for others
      nodeResponse.write = function(chunk, encoding, callback) {
        logger.debug(`Response write called: ${chunk ? chunk.length : 0} bytes, isXml=${isXmlResponse}`);

        // If we still don't know content-type, check now
        if (isXmlResponse === null) {
          const contentType = nodeResponse.getHeader('content-type') || '';
          isXmlResponse = contentType.includes('xml');
          logger.debug(`Late detection: ${isXmlResponse ? 'XML' : 'non-XML'} response`);
        }

        if (isXmlResponse) {
          // Buffer XML responses for URL rewriting
          if (chunk) {
            responseBody.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8'));
            logger.debug(`Buffered ${chunk.length} bytes for XML rewriting`);
          }
          if (typeof encoding === 'function') callback = encoding;
          if (callback) callback();
          return true;
        } else {
          // Pass through non-XML responses directly
          return originalWrite(chunk, encoding, callback);
        }
      };

      // Rewrite URLs and send response
      nodeResponse.end = function(chunk, encoding, callback) {
        logger.debug(`Response end called, isXml=${isXmlResponse}`);

        if (typeof chunk === 'function') {
          callback = chunk;
          chunk = null;
        } else if (typeof encoding === 'function') {
          callback = encoding;
          encoding = null;
        }

        // Final check for XML if still unknown
        if (isXmlResponse === null) {
          const contentType = nodeResponse.getHeader('content-type') || '';
          isXmlResponse = contentType.includes('xml');
          logger.debug(`Final detection in end(): ${isXmlResponse ? 'XML' : 'non-XML'} response`);
        }

        // Rewrite URLs if this is an XML response
        if (isXmlResponse) {
          // Add final chunk to buffer if present
          if (chunk) {
            responseBody.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8'));
          }

          if (responseBody.length > 0) {
            const buffer = Buffer.concat(responseBody);
            let content = buffer.toString('utf-8');

            logger.debug(`Rewriting URLs in XML response (${buffer.length} bytes)`);
            // URLs in response will be like: / or /test.txt or /test2/
            // Need to rewrite to: /webdav/:workspaceName/home/ or /webdav/:workspaceName/home/test.txt

            content = content.replace(
              /<D:href>(https?:\/\/[^\/]+)?([^<]*)<\/D:href>/gi,
              (match, protocol, urlPath) => {
                // Prepend the public URL prefix to all paths
                if (urlPath === '/' || urlPath === '') {
                  return `<D:href>${protocol || ''}${urlPrefix}/</D:href>`;
                } else if (urlPath.startsWith('/')) {
                  return `<D:href>${protocol || ''}${urlPrefix}${urlPath}</D:href>`;
                }
                return match;
              }
            );

            const rewrittenBuffer = Buffer.from(content, 'utf-8');
            logger.debug(`Rewrote ${content.match(/<D:href>/gi)?.length || 0} URLs`);

            // Write headers if not written yet
            if (!headersWritten) {
              originalWriteHead(nodeResponse.statusCode || 207, {
                ...nodeResponse.getHeaders(),
                'content-length': rewrittenBuffer.length
              });
            } else {
              originalSetHeader('content-length', rewrittenBuffer.length);
            }

            // Write the rewritten content
            originalWrite(rewrittenBuffer);
          }
          return originalEnd.call(nodeResponse, callback);
        } else {
          // Non-XML response - pass through directly (data already streamed via originalWrite in write())
          logger.debug(`Passing through non-XML end()`);
          return originalEnd.call(nodeResponse, chunk, encoding, callback);
        }
      };

      // Set required WebDAV headers on the response
      if (!nodeResponse.headersSent) {
        // Indicate WebDAV compliance levels
        nodeResponse.setHeader('DAV', '1, 2');
        nodeResponse.setHeader('MS-Author-Via', 'DAV');
        logger.debug(`WebDAV headers set: DAV=1,2, MS-Author-Via=DAV`);
      }

      logger.debug(`Executing WebDAV request...`);

      // Fastify has consumed the request stream, so we need to recreate it
      const hasBody = nodeRequest.headers['content-length'] && parseInt(nodeRequest.headers['content-length']) > 0;
      logger.debug(`Request has body: ${hasBody}, content-length: ${nodeRequest.headers['content-length']}`);

      if (hasBody && request.body) {
        // Fastify parsed the body - we need to create a NEW readable stream for the WebDAV server
        const { Readable } = await import('stream');
        const bodyBuffer = Buffer.isBuffer(request.body) ? request.body : Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
        logger.debug(`Creating new request stream from ${bodyBuffer.length} byte buffer`);

        // Create a new readable stream from the buffer
        const bodyStream = Readable.from([bodyBuffer]);

        // Copy critical properties from the original request to the new stream
        bodyStream.httpVersion = nodeRequest.httpVersion;
        bodyStream.httpVersionMajor = nodeRequest.httpVersionMajor;
        bodyStream.httpVersionMinor = nodeRequest.httpVersionMinor;
        bodyStream.url = nodeRequest.url;
        bodyStream.method = nodeRequest.method;
        bodyStream.headers = nodeRequest.headers;
        bodyStream.rawHeaders = nodeRequest.rawHeaders;
        bodyStream.socket = nodeRequest.socket;
        bodyStream.connection = nodeRequest.connection;

        // Replace nodeRequest with the new stream
        nodeRequest = bodyStream;
        logger.debug(`Replaced nodeRequest with new readable stream`);
      }

      // Execute WebDAV request using native Node.js request/response
      // Wrap in Promise to properly handle async execution
      await new Promise((resolve, reject) => {
        let resolved = false;
        const doResolve = (reason) => {
          if (!resolved) {
            resolved = true;
            logger.debug(`Promise resolving: ${reason}`);
            resolve();
          }
        };

        try {
          logger.debug(`Calling server.executeRequest with method: ${nodeRequest.method}`);

          // Set up event listeners BEFORE calling executeRequest
          nodeResponse.on('finish', () => {
            logger.debug(`WebDAV response finished event`);
            doResolve('finish');
          });

          nodeResponse.on('close', () => {
            logger.debug(`WebDAV response closed event`);
            doResolve('close');
          });

          nodeResponse.on('error', (err) => {
            logger.debug(`WebDAV response error event: ${err.message}`);
            logger.debug(`Error stack: ${err.stack}`);
            if (!resolved) {
              resolved = true;
              reject(err);
            }
          });

          // Call executeRequest - this should trigger the response
          const result = server.executeRequest(nodeRequest, nodeResponse);
          logger.debug(`server.executeRequest returned: ${result}`);
          logger.debug(`Response headersSent: ${nodeResponse.headersSent}`);
          logger.debug(`Response finished: ${nodeResponse.finished}`);
          logger.debug(`Response writableEnded: ${nodeResponse.writableEnded}`);

          // Set a timeout to prevent hanging
          setTimeout(() => {
            if (!resolved) {
              logger.debug(`⚠️ WebDAV request timeout after 10s`);
              logger.debug(`  headersSent: ${nodeResponse.headersSent}`);
              logger.debug(`  finished: ${nodeResponse.finished}`);
              logger.debug(`  writableEnded: ${nodeResponse.writableEnded}`);

              // Force end the response if it hasn't been ended
              if (!nodeResponse.writableEnded && !nodeResponse.finished) {
                logger.debug(`Force ending response...`);
                try {
                  nodeResponse.end();
                } catch (e) {
                  logger.debug(`Error force ending: ${e.message}`);
                }
              }
              doResolve('timeout');
            }
          }, 10000); // 10 second timeout for debugging

        } catch (err) {
          logger.debug(`WebDAV execution error: ${err.message}`);
          logger.debug(`Error stack: ${err.stack}`);
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        }
      });

      logger.debug(`WebDAV request executed successfully`);
      logger.debug(`=== WebDAV Request End ===`);
    } catch (error) {
      logger.debug(`=== WebDAV Error ===`);
      logger.debug(`Error handling WebDAV request: ${error.message}`);
      logger.debug(`Stack trace: ${error.stack}`);
      logger.debug(`Response sent: ${response.sent}`);
      logger.debug(`Headers sent: ${response.raw.headersSent}`);
      logger.debug(`=== End Error ===`);

      if (!response.sent && !response.raw.headersSent) {
        logger.debug(`Sending error response...`);
        response.code(500).send({
          error: 'Internal Server Error',
          message: error.message
        });
      }
    }
  }
}

export default WebDAVServerManager;

