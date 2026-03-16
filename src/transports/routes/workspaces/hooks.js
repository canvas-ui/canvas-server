'use strict';

import path from 'path';
import { promises as fs } from 'fs';
import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

function normalizePathSegments(inputPath = '') {
  return String(inputPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
}

function validateHookPath(inputPath) {
  const segments = normalizePathSegments(inputPath);
  if (!segments.length) {
    return { error: 'Hook path is required' };
  }

  const normalized = segments.join('/');
  const isLibFile = normalized.startsWith('lib/');
  const isRootFile = !normalized.includes('/');

  if (!normalized.endsWith('.js')) {
    return { error: 'Only .js hook files are allowed' };
  }

  if (!isRootFile && !isLibFile) {
    return { error: 'Hooks must be root-level event files or files under lib/' };
  }

  return { path: normalized };
}

async function listHookFiles(basePath, relativeDir = '') {
  const absoluteDir = path.join(basePath, relativeDir);
  const dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
  const entries = [];

  for (const dirent of dirents) {
    const relativePath = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      if (relativePath === 'lib' || relativePath.startsWith('lib/')) {
        entries.push(...await listHookFiles(basePath, relativePath));
      }
      continue;
    }

    if (!dirent.isFile() || !relativePath.endsWith('.js')) {
      continue;
    }

    if (relativePath.includes('/') && !relativePath.startsWith('lib/')) {
      continue;
    }

    const stat = await fs.stat(path.join(basePath, relativePath));
    entries.push({
      path: relativePath,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export default async function workspaceHooksRoutes(fastify) {
  fastify.get('/', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    try {
      await fs.mkdir(request.workspace.hooksPath, { recursive: true });
      const files = await listHookFiles(request.workspace.hooksPath);
      const response = new ResponseObject().found(files, 'Workspace hooks retrieved successfully', 200, files.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to list workspace hooks');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.get('/*', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    try {
      const result = validateHookPath(request.params['*']);
      if (result.error) {
        const response = new ResponseObject().badRequest(result.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const filePath = path.join(request.workspace.hooksPath, result.path);
      const content = await fs.readFile(filePath, 'utf-8');
      const response = new ResponseObject().found({ path: result.path, content }, 'Workspace hook retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = error?.code === 'ENOENT'
        ? new ResponseObject().notFound('Workspace hook not found')
        : new ResponseObject().serverError('Failed to get workspace hook');
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
      const result = validateHookPath(request.params['*']);
      if (result.error) {
        const response = new ResponseObject().badRequest(result.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const filePath = path.join(request.workspace.hooksPath, result.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, request.body?.content || '', 'utf-8');

      const response = new ResponseObject().success({ path: result.path }, 'Workspace hook saved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to save workspace hook');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.delete('/*', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
  }, async (request, reply) => {
    try {
      const result = validateHookPath(request.params['*']);
      if (result.error) {
        const response = new ResponseObject().badRequest(result.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      await fs.unlink(path.join(request.workspace.hooksPath, result.path));
      const response = new ResponseObject().deleted({ path: result.path }, 'Workspace hook deleted successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = error?.code === 'ENOENT'
        ? new ResponseObject().notFound('Workspace hook not found')
        : new ResponseObject().serverError('Failed to delete workspace hook');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
