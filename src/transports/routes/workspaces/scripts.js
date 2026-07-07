'use strict';

import path from 'path';
import { promises as fs } from 'fs';
import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

/**
 * Workspace scripts management — the `git/scripts/` sibling of the hooks
 * routes. Scripts are the shell helpers hooks spawn (ytdl.sh, fetch-url.sh,
 * user-written ones); like hooks they live in the workspace git repo, so
 * writes are committed and a push/clone via /workspaces/:id/git sees them.
 */

function validateScriptPath(inputPath) {
  const segments = String(inputPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);

  if (!segments.length) {
    return { error: 'Script path is required' };
  }
  if (segments.includes('..')) {
    return { error: 'Invalid script path' };
  }
  // Flat directory (plus one optional subdirectory level, mirroring hooks).
  if (segments.length > 2) {
    return { error: 'Scripts must be {name} or {dir}/{name}' };
  }
  return { path: segments.join('/') };
}

function scriptsRoot(workspace) {
  return path.join(workspace.rootPath, 'git', 'scripts');
}

async function listScriptFiles(basePath) {
  const entries = [];
  const dirents = await fs.readdir(basePath, { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.isFile()) {
      const stat = await fs.stat(path.join(basePath, dirent.name));
      entries.push({ path: dirent.name, size: stat.size, modifiedAt: stat.mtime.toISOString() });
      continue;
    }
    if (!dirent.isDirectory()) { continue; }
    const subDirents = await fs.readdir(path.join(basePath, dirent.name), { withFileTypes: true });
    for (const sub of subDirents) {
      if (!sub.isFile()) { continue; }
      const rel = `${dirent.name}/${sub.name}`;
      const stat = await fs.stat(path.join(basePath, rel));
      entries.push({ path: rel, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function commitScripts(fastify, request, message) {
  if (!fastify.dotfileManager?.commitScripts) { return; }
  try {
    await fastify.dotfileManager.commitScripts(request.workspace, message, request.user?.id);
  } catch (error) {
    request.log.debug(`Script git commit skipped: ${error.message}`);
  }
}

export default async function workspaceScriptsRoutes(fastify) {
  fastify.get('/', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    try {
      const basePath = scriptsRoot(request.workspace);
      await fs.mkdir(basePath, { recursive: true });
      const files = await listScriptFiles(basePath);
      const response = new ResponseObject().found(files, 'Workspace scripts retrieved successfully', 200, files.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to list workspace scripts');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.get('/*', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    try {
      const result = validateScriptPath(request.params['*']);
      if (result.error) {
        const response = new ResponseObject().badRequest(result.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const content = await fs.readFile(path.join(scriptsRoot(request.workspace), result.path), 'utf-8');
      const response = new ResponseObject().found({ path: result.path, content }, 'Workspace script retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = error?.code === 'ENOENT'
        ? new ResponseObject().notFound('Workspace script not found')
        : new ResponseObject().serverError('Failed to get workspace script');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.put('/*', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const result = validateScriptPath(request.params['*']);
      if (result.error) {
        const response = new ResponseObject().badRequest(result.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const filePath = path.join(scriptsRoot(request.workspace), result.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, request.body?.content || '', 'utf-8');
      // Hooks spawn scripts via `bash <script>`, but keep them directly
      // executable too for shell users working in the clone.
      await fs.chmod(filePath, 0o755).catch(() => {});
      await commitScripts(fastify, request, `Update script ${result.path}`);

      const response = new ResponseObject().success({ path: result.path }, 'Workspace script saved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to save workspace script');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.delete('/*', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
  }, async (request, reply) => {
    try {
      const result = validateScriptPath(request.params['*']);
      if (result.error) {
        const response = new ResponseObject().badRequest(result.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      await fs.unlink(path.join(scriptsRoot(request.workspace), result.path));
      await commitScripts(fastify, request, `Delete script ${result.path}`);
      const response = new ResponseObject().deleted({ path: result.path }, 'Workspace script deleted successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = error?.code === 'ENOENT'
        ? new ResponseObject().notFound('Workspace script not found')
        : new ResponseObject().serverError('Failed to delete workspace script');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
