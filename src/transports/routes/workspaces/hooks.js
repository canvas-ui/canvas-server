'use strict';

import path from 'path';
import { promises as fs } from 'fs';
import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';
import { HOOK_EVENTS, HOOK_ACTIONS, CLASSIFIER_SURFACE, generateHookSkeleton } from '../../../core/workspace/services/hook/meta.js';

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

  if (segments.includes('..')) {
    return { error: 'Invalid hook path' };
  }

  const normalized = segments.join('/');

  // Declarative rules: `rules.json` plus one level of `rules/{name}.json`.
  // An `example-`/`disabled-`/`_` prefix (inactive file) is allowed for toggling.
  if (normalized.endsWith('.json')) {
    const isRulesFile = /^(?:example-|disabled-|_)?rules\.json$/.test(normalized)
      || (normalized.startsWith('rules/') && segments.length === 2);
    if (!isRulesFile) {
      return { error: 'JSON files must be rules.json or rules/{name}.json' };
    }
    return { path: normalized };
  }

  if (!normalized.endsWith('.js')) {
    return { error: 'Only .js hook files and rules .json files are allowed' };
  }

  // Allowed shapes: `{event}.js` (single handler), `{event}/{name}.js`
  // (one of several handlers for an event), or shared modules under `lib/`.
  const isLibFile = normalized.startsWith('lib/');
  if (!isLibFile && segments.length > 2) {
    return { error: 'Hooks must be {event}.js, {event}/{name}.js, or files under lib/' };
  }

  return { path: normalized };
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function statEntry(basePath, relativePath) {
  const stat = await fs.stat(path.join(basePath, relativePath));
  return { path: relativePath, size: stat.size, modifiedAt: stat.mtime.toISOString() };
}

// Lists root `{event}.js` files plus one level of subdirectory handlers
// (`{event}/*.js` and `lib/*.js`). Handlers for an event are grouped under its
// directory; clients render them grouped by event name. Declarative rule files
// (`rules.json`, `rules/*.json`) are included alongside.
async function listHookFiles(basePath) {
  const dirents = await fs.readdir(basePath, { withFileTypes: true });
  const entries = [];
  const isListable = (name, dirName = null) => name.endsWith('.js')
    || (dirName === null && /^(?:example-|disabled-|_)?rules\.json$/.test(name))
    || (dirName === 'rules' && name.endsWith('.json'));

  for (const dirent of dirents) {
    if (dirent.isFile() && isListable(dirent.name)) {
      entries.push(await statEntry(basePath, dirent.name));
      continue;
    }
    if (!dirent.isDirectory()) { continue; }

    const subDirents = await fs.readdir(path.join(basePath, dirent.name), { withFileTypes: true });
    for (const sub of subDirents) {
      if (sub.isFile() && isListable(sub.name, dirent.name)) {
        entries.push(await statEntry(basePath, `${dirent.name}/${sub.name}`));
      }
    }
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function commitHooks(fastify, request, message) {
  if (!fastify.dotfileManager?.commitHooks) { return; }
  try {
    await fastify.dotfileManager.commitHooks(request.workspace, message, request.user?.id);
  } catch (error) {
    request.log.debug(`Hook git commit skipped: ${error.message}`);
  }
}

export default async function workspaceHooksRoutes(fastify) {
  fastify.get('/', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    try {
      await fs.mkdir(request.workspace.hooksPath, { recursive: true });
      // Lazily backfill seed examples a pre-existing workspace never received
      // (seeding otherwise only happens on git-repo initialization).
      await fastify.dotfileManager?.backfillSeed?.(request.workspace, request.user?.id)
        ?.catch((error) => request.log.debug(`Seed backfill skipped: ${error.message}`));
      const files = await listHookFiles(request.workspace.hooksPath);
      const response = new ResponseObject().found(files, 'Workspace hooks retrieved successfully', 200, files.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to list workspace hooks');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Hook authoring metadata for clients (event catalog, actions, classifier
  // surface) — the create-hook wizard is a thin client of this + /generate.
  fastify.get('/meta', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    const response = new ResponseObject().found({
      events: HOOK_EVENTS,
      actions: HOOK_ACTIONS.map(({ id, label, description }) => ({ id, label, description })),
      classifier: CLASSIFIER_SURFACE,
    }, 'Workspace hook metadata retrieved successfully');
    return reply.code(response.statusCode).send(response.getResponse());
  });

  // Generate an editable hook skeleton from event + actions and write it into
  // git/hooks (Create > select event > select actions > edit skeleton).
  fastify.post('/generate', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      body: {
        type: 'object',
        required: ['event'],
        properties: {
          event: { type: 'string' },
          name: { type: 'string' },
          actions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { event, name, actions } = request.body || {};
      let skeleton;
      try {
        skeleton = generateHookSkeleton({ event, name, actions });
      } catch (error) {
        const response = new ResponseObject().badRequest(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const filePath = path.join(request.workspace.hooksPath, skeleton.path);
      if (await fileExists(filePath)) {
        const response = new ResponseObject().conflict(`Hook ${skeleton.path} already exists`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, skeleton.content, 'utf-8');
      await commitHooks(fastify, request, `Create hook ${skeleton.path}`);

      const response = new ResponseObject().created(
        { path: skeleton.path, content: skeleton.content },
        'Workspace hook created successfully',
      );
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to generate workspace hook');
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
      await commitHooks(fastify, request, `Update hook ${result.path}`);

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
      await commitHooks(fastify, request, `Delete hook ${result.path}`);
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
