'use strict';

import path from 'path';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';
import { HOOK_EVENTS, HOOK_ACTIONS, CLASSIFIER_SURFACE, HOOK_CONTEXT_API, generateHookSkeleton } from '../../../core/workspace/services/hook/meta.js';
import { resolveRuleFiles, loadRuleFile, explainRule } from '../../../core/workspace/services/hook/rules.js';
import { resolveHookFiles } from '../../../core/workspace/services/hook/files.js';
import { classifyDocument, normalizeSchemaId } from '../../../core/workspace/lib/classifier.js';

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
    // Schemas actually present in THIS workspace (schema feature bitmaps),
    // with live document counts — so pickers offer what the DB really holds
    // instead of a hand-maintained list.
    const schemas = await request.workspace.listBitmaps('data/schema/')
      .then((bitmaps) => bitmaps
        .filter((b) => b.size > 0)
        .map((b) => ({ id: b.key, name: b.key.replace(/^data\/schema\//, ''), count: b.size }))
        .sort((a, b) => b.count - a.count))
      .catch(() => []);
    const response = new ResponseObject().found({
      events: HOOK_EVENTS,
      actions: HOOK_ACTIONS.map(({ id, label, description }) => ({ id, label, description })),
      classifier: CLASSIFIER_SURFACE,
      contextApi: HOOK_CONTEXT_API,
      schemas,
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

  // Run log: per-execution records (hook files + rules) from
  // {WORKSPACE_ROOT}/var/hooks/runs.jsonl, newest first.
  fastify.get('/runs', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 500 },
          handler: { type: 'string' },
          event: { type: 'string' },
          failed: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const runLog = fastify.workspaceManager?.hookService?.runLogFor(request.workspace);
      if (!runLog) {
        const response = new ResponseObject().serverError('Hook service unavailable');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const { limit, handler, event, failed } = request.query || {};
      const runs = await runLog.query({ limit, handler, event, failed });
      const response = new ResponseObject().found(runs, 'Workspace hook runs retrieved successfully', 200, runs.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to list workspace hook runs');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Pending actions: approval-gated automation waiting for review. List,
  // detail, and decisions (approve — optionally amended — or decline).
  fastify.get('/pending', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'approved', 'declined', 'failed', 'expired'] },
          handler: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const store = fastify.workspaceManager?.hookService?.pendingFor(request.workspace);
      if (!store) {
        const response = new ResponseObject().serverError('Hook service unavailable');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const { status, handler, limit } = request.query || {};
      const actions = await store.query({ status, handler, limit });
      const response = new ResponseObject().found(actions, 'Pending actions retrieved successfully', 200, actions.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to list pending actions');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.get('/pending/:actionId', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    try {
      const store = fastify.workspaceManager?.hookService?.pendingFor(request.workspace);
      const record = await store?.get(request.params.actionId);
      if (!record) {
        const response = new ResponseObject().notFound(`Pending action ${request.params.actionId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().found(record, 'Pending action retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to get pending action');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Bulk decisions. `approve` entries are actionId strings or
  // { actionId, amend: { '<editable json-path>': value } }; `decline` entries
  // are actionId strings. Per-entry outcomes — one bad id never blocks the
  // rest of a bulk approve.
  fastify.post('/pending/decisions', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      body: {
        type: 'object',
        properties: {
          approve: {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  required: ['actionId'],
                  properties: { actionId: { type: 'string' }, amend: { type: 'object' } },
                },
              ],
            },
          },
          decline: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const hookService = fastify.workspaceManager?.hookService;
      if (!hookService) {
        const response = new ResponseObject().serverError('Hook service unavailable');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const { approve = [], decline = [] } = request.body || {};
      const decidedBy = request.user?.id ?? null;
      const results = [];

      for (const entry of approve) {
        const actionId = typeof entry === 'string' ? entry : entry.actionId;
        const amend = typeof entry === 'object' && entry.amend ? entry.amend : null;
        try {
          const record = await hookService.decidePending(request.workspace, actionId, { decision: 'approve', amend, decidedBy });
          results.push({ actionId, status: record?.status ?? 'approved', result: record?.result ?? null });
        } catch (error) {
          results.push({ actionId, status: 'error', error: error.message });
        }
      }
      for (const actionId of decline) {
        try {
          const record = await hookService.decidePending(request.workspace, actionId, { decision: 'decline', decidedBy });
          results.push({ actionId, status: record?.status ?? 'declined' });
        } catch (error) {
          results.push({ actionId, status: 'error', error: error.message });
        }
      }

      const failed = results.filter((r) => r.status === 'error' || r.status === 'failed').length;
      const response = new ResponseObject().success(
        { decided: results.length, failed, results },
        failed ? 'Decisions applied with errors' : 'Decisions applied',
      );
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError(`Failed to apply decisions: ${error.message}`);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Explain: which rules and JS hooks would fire for a document + event, with
  // a matcher-by-matcher breakdown ("why didn't my rule run"). Path matchers
  // evaluate against `paths` from the body when given (simulating a landing);
  // otherwise against the document's live tree placements.
  fastify.post('/explain', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: {
      body: {
        type: 'object',
        required: ['documentId'],
        properties: {
          documentId: { type: 'integer' },
          event: { type: 'string', default: 'document.inserted' },
          paths: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { documentId, event = 'document.inserted', paths = [] } = request.body || {};
      let document = null;
      try {
        document = await request.workspace.get(documentId);
      } catch (error) {
        request.log.debug(`explain: get(${documentId}) failed: ${error.message}`);
      }
      if (!document) {
        const response = new ResponseObject().notFound(`Document ${documentId} not found (workspace inactive or unknown id)`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Explicit body paths simulate a landing; otherwise evaluate against the
      // document's LIVE placements (same shape backfill uses).
      const treePaths = {};
      if (!paths.length) {
        const placements = await request.workspace.listDocumentPlacements(documentId).catch(() => []);
        for (const placement of placements) {
          if (!placement?.paths?.length) { continue; }
          const key = placement.type === 'context' ? 'context' : placement.tree;
          treePaths[key] = [...new Set([...(treePaths[key] || []), ...placement.paths])];
        }
      }
      const payload = { id: documentId, document, context: paths.length ? { paths } : null, treePaths };
      const classification = classifyDocument(document, payload);

      const rules = [];
      for (const filePath of resolveRuleFiles(request.workspace.hooksPath)) {
        for (const rule of loadRuleFile(filePath, null, request.log)) {
          const explained = explainRule(rule, event, classification);
          rules.push({ id: rule.id || '?', description: rule.description, cascade: rule.cascade === true, ...explained });
        }
      }

      const hooksRoot = request.workspace.hooksPath;
      const hooks = resolveHookFiles(hooksRoot, event)
        .map((p) => ({ path: path.relative(hooksRoot, p), note: 'JS hook — would be invoked; its own code decides what to do' }));

      const response = new ResponseObject().found({
        documentId,
        event,
        schema: document.schema,
        paths,
        rules,
        hooks,
      }, 'Explain evaluated successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to explain hooks for document');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Backfill: run ONE rule or JS hook against existing documents, as if each
  // had just been inserted. dryRun evaluates matchers only (per-doc breakdown).
  // Synthesized envelopes carry origin:'backfill' — downstream writes are
  // cascade-guarded like any automation. Each envelope carries the document's
  // LIVE tree placements (payload.treePaths), so `when.path` matchers — incl.
  // tree-qualified ones like 'backends:/github/x' — evaluate against where
  // the document is filed right now.
  fastify.post('/backfill', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      body: {
        type: 'object',
        properties: {
          ruleId: { type: 'string' },
          hookFile: { type: 'string' },
          event: { type: 'string', default: 'document.inserted' },
          schema: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          dryRun: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { ruleId, hookFile, event = 'document.inserted', schema, limit = 100, dryRun = false } = request.body || {};
      if ((ruleId ? 1 : 0) + (hookFile ? 1 : 0) !== 1) {
        const response = new ResponseObject().badRequest('Pass exactly one of ruleId or hookFile');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const hookService = fastify.workspaceManager?.hookService;
      if (!hookService) {
        const response = new ResponseObject().serverError('Hook service unavailable');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      let rule = null;
      if (ruleId) {
        rule = hookService.findRule(request.workspace, ruleId);
        if (!rule) {
          const response = new ResponseObject().notFound(`Rule "${ruleId}" not found`);
          return reply.code(response.statusCode).send(response.getResponse());
        }
      }

      // Discovery: schema filter from the request, else from the rule's own
      // matcher (short names → full ids via the classifier map — plain prefix
      // concat cannot reach hierarchical ids like data/schema/message/email).
      const ruleSchemas = rule?.when?.schema ? (Array.isArray(rule.when.schema) ? rule.when.schema : [rule.when.schema]) : [];
      const requested = (schema ? [schema] : ruleSchemas)
        .map((s) => normalizeSchemaId(s))
        .filter(Boolean);

      // Hierarchical expansion against the schema bitmaps actually present:
      // a parent-schema rule ('message') must discover sub-schema docs
      // ('message/email'), mirroring the matcher's segment-bounded semantics.
      let schemas = requested;
      if (requested.length) {
        const available = await request.workspace.listBitmaps('data/schema/')
          .then((bitmaps) => bitmaps.map((b) => b.key))
          .catch(() => null);
        if (available) {
          schemas = [...new Set(requested.flatMap((id) => {
            const matches = available.filter((key) => key === id || key.startsWith(`${id}/`));
            return matches.length ? matches : [id];
          }))];
        }
      }

      // One query per expanded schema, unioned by id — alternative schemas are
      // OR in the rule engine, and a single features array would intersect.
      let docs;
      try {
        if (schemas.length) {
          const seen = new Map();
          for (const key of schemas) {
            const batch = await request.workspace.list({ features: [key], limit });
            for (const doc of (Array.isArray(batch) ? batch : batch?.data || [])) {
              if (doc?.id != null && !seen.has(doc.id)) seen.set(doc.id, doc);
            }
            if (seen.size >= limit) break;
          }
          docs = [...seen.values()].slice(0, limit);
        } else {
          const documents = await request.workspace.list({ limit });
          docs = (Array.isArray(documents) ? documents : documents?.data || []).slice(0, limit);
        }
      } catch (error) {
        const response = new ResponseObject().serverError(`Document discovery failed (workspace active?): ${error.message}`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const results = [];
      let matched = 0;
      let failed = 0;
      for (const document of docs) {
        if (!document?.id) { continue; }
        // Live placements ({ treeName: [paths] }; context-type trees merged
        // under 'context' to mirror live-event payload shape).
        const treePaths = {};
        const placements = await request.workspace.listDocumentPlacements(document.id).catch(() => []);
        for (const placement of placements) {
          if (!placement?.paths?.length) { continue; }
          const key = placement.type === 'context' ? 'context' : placement.tree;
          treePaths[key] = [...new Set([...(treePaths[key] || []), ...placement.paths])];
        }
        const payload = {
          id: document.id,
          document,
          context: null,
          directory: null,
          treePaths,
          eventId: crypto.randomUUID(),
          origin: 'backfill',
          depth: 0,
          backfill: true,
        };

        if (dryRun) {
          const explained = rule
            ? explainRule(rule, event, classifyDocument(document, payload))
            : { matched: null, checks: [] }; // JS hooks decide in code
          if (explained.matched) { matched++; }
          results.push({ docId: document.id, schema: document.schema, matched: explained.matched, checks: explained.checks });
          continue;
        }

        const outcome = await hookService.runTargeted(
          request.workspace,
          ruleId ? { ruleId } : { hookFile },
          event,
          payload,
          { trigger: 'backfill' },
        );
        if (outcome.status !== 'skipped') { matched++; }
        if (outcome.status === 'error') { failed++; }
        results.push({ docId: document.id, schema: document.schema, ...outcome });
      }

      const response = new ResponseObject().success({
        target: ruleId ? { ruleId } : { hookFile },
        event,
        dryRun,
        processed: docs.length,
        matched,
        failed,
        results,
      }, dryRun ? 'Backfill dry-run evaluated' : 'Backfill executed');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError(`Backfill failed: ${error.message}`);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Replay one logged run: reload the document(s) by id, rebuild the envelope
  // (fresh eventId, origin:'replay', causedBy = the original eventId) and
  // re-run the recorded handler.
  fastify.post('/runs/:runId/replay', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
  }, async (request, reply) => {
    try {
      const hookService = fastify.workspaceManager?.hookService;
      const runLog = hookService?.runLogFor(request.workspace);
      if (!runLog) {
        const response = new ResponseObject().serverError('Hook service unavailable');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const record = await runLog.get(request.params.runId);
      if (!record) {
        const response = new ResponseObject().notFound(`Run ${request.params.runId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      if (!record.replayEnvelope || record.handlerType === 'dispatch') {
        const response = new ResponseObject().badRequest('Run record carries no replayable envelope');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const basePayload = { ...(record.replayEnvelope.payload || {}) };
      const docId = basePayload.document?.id ?? basePayload.id ?? null;
      if (docId != null) {
        let document = null;
        try { document = await request.workspace.get(docId); }
        catch (error) { request.log.debug(`replay: get(${docId}) failed: ${error.message}`); }
        if (!document) {
          const response = new ResponseObject().notFound(`Document ${docId} no longer exists — cannot replay`);
          return reply.code(response.statusCode).send(response.getResponse());
        }
        basePayload.document = document;
      }

      const payload = {
        ...basePayload,
        eventId: crypto.randomUUID(),
        origin: 'replay',
        causedBy: record.eventId ?? null,
        depth: 0,
      };

      const target = record.handlerType === 'rule' ? { ruleId: record.handler } : { hookFile: record.handler };
      const outcome = await hookService.runTargeted(
        request.workspace, target, record.replayEnvelope.event, payload, { trigger: 'replay' },
      );

      const response = new ResponseObject().success({
        replayedRunId: record.runId,
        target,
        event: record.replayEnvelope.event,
        ...outcome,
      }, 'Run replayed');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError(`Replay failed: ${error.message}`);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Empty rules.json body for workspaces that haven't saved any rules yet.
  // Returned virtually on GET so the UI can open Rules without a 404 toast;
  // the file is only written when something is actually saved (PUT).
  const EMPTY_RULES_JSON = `${JSON.stringify({ $schema: 'canvas.hook-rules/v1', rules: [] }, null, 2)}\n`;

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
      let content;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch (error) {
        if (error?.code === 'ENOENT' && result.path === 'rules.json') {
          content = EMPTY_RULES_JSON;
        } else {
          throw error;
        }
      }
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
