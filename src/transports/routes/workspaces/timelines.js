'use strict';

import ResponseObject from '../../ResponseObject.js';

export default async function workspaceTimelineRoutes(fastify, _options) {
  async function getWorkspaceInstance(request, reply) {
    const identifier = request.params.id;
    const userId = request.user.id;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const workspaceId = isUuid ? identifier : await fastify.workspaceManager.resolveWorkspaceId(userId, identifier);

    if (!workspaceId) {
      const ro = new ResponseObject().notFound(`Workspace not found: ${identifier}`);
      reply.code(ro.statusCode).send(ro.getResponse());
      return null;
    }

    const workspace = await fastify.workspaceManager.getWorkspace(workspaceId, userId);
    if (!workspace) {
      const ro = new ResponseObject().notFound(`Workspace not found: ${identifier}`);
      reply.code(ro.statusCode).send(ro.getResponse());
      return null;
    }

    if (!workspace.isActive) {
      const ro = new ResponseObject().workspaceNotActive();
      reply.code(ro.statusCode).send(ro.getResponse());
      return null;
    }

    return workspace;
  }

  // Read scoping mirrors documents.js: a directory tree must land in
  // spec.directory, not spec.context. Returns { context, directory } with
  // exactly one populated; defaults to context.
  function resolveScopeSelectors(workspace, source = {}, fallbackPath = '/') {
    const path = source?.context ?? fallbackPath;
    const treeNameOrId = source?.treeNameOrTreeId ?? null;
    const treeType = source?.treeType ?? null;

    let isDirectory = treeType === 'directory';
    if (!treeType && treeNameOrId) {
      try {
        isDirectory = workspace.getTree(treeNameOrId)?.type === 'directory';
      } catch (err) {
        if (!/not found/i.test(err?.message || '')) throw err;
      }
    }

    return isDirectory
      ? { context: null, directory: workspace.getDirectoryTreeSelector(path, treeNameOrId) }
      : { context: workspace.getContextTreeSelector(path, treeNameOrId), directory: null };
  }

  function buildAttributes(source) {
    const { allOf, noneOf, anyOf } = source;
    if (!allOf?.length && !noneOf?.length && !anyOf?.length) return undefined;
    const attrs = {};
    if (allOf?.length) attrs.allOf = allOf;
    if (noneOf?.length) attrs.noneOf = noneOf;
    if (anyOf?.length) attrs.anyOf = anyOf;
    return attrs;
  }

  // GET /workspaces/:id/timelines
  // Plain payload is a string[] of names (stable contract). `?verbose=true`
  // returns [{ name, quantum }] — one call for a settings/legend UI instead of
  // N per-name lookups.
  fastify.get('/', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: { verbose: { type: 'boolean', default: false } },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      const names = await workspace.listTimelines();
      const timelines = request.query.verbose
        ? names.map((name) => ({ name, quantum: workspace.getTimelineQuantum(name) }))
        : names;
      const ro = new ResponseObject().found(timelines, 'Timelines retrieved successfully', 200, timelines.length);
      return reply.code(ro.statusCode).send(ro.getResponse());
    } catch (err) {
      fastify.log.error(err);
      const ro = new ResponseObject().serverError('Failed to list timelines');
      return reply.code(ro.statusCode).send(ro.getResponse());
    }
  });

  // POST /workspaces/:id/timelines
  // Optional `quantum` parametrizes the timeline's membership granularity
  // ('Gyr'|'Myr'|'Kyr'|'year'|'month'|'day'; default 'day') — set BEFORE any
  // entry lands, since cells written under one quantum are not re-tiled.
  fastify.post('/', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          quantum: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      const { name, quantum } = request.body;
      if (quantum) {
        try {
          workspace.setTimelineQuantum(name, quantum);
        } catch (err) {
          const ro = new ResponseObject().badRequest(err.message);
          return reply.code(ro.statusCode).send(ro.getResponse());
        }
      }
      const result = await workspace.createTimeline(name);
      const ro = new ResponseObject().created(
        { ...result, quantum: workspace.getTimelineQuantum(name) },
        'Timeline created successfully',
      );
      return reply.code(ro.statusCode).send(ro.getResponse());
    } catch (err) {
      fastify.log.error(err);
      const ro = new ResponseObject().serverError('Failed to create timeline');
      return reply.code(ro.statusCode).send(ro.getResponse());
    }
  });

  // GET /workspaces/:id/timelines/:name
  fastify.get('/:name', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      const { name } = request.params;
      const exists = workspace.hasTimeline(name);
      if (!exists) {
        const ro = new ResponseObject().notFound(`Timeline not found: ${name}`);
        return reply.code(ro.statusCode).send(ro.getResponse());
      }

      const ro = new ResponseObject().found(
        { name, exists: true, quantum: workspace.getTimelineQuantum(name) },
        'Timeline found',
      );
      return reply.code(ro.statusCode).send(ro.getResponse());
    } catch (err) {
      fastify.log.error(err);
      const ro = new ResponseObject().serverError('Failed to get timeline');
      return reply.code(ro.statusCode).send(ro.getResponse());
    }
  });

  // PUT /workspaces/:id/timelines/:name/quantum
  // Persisted in workspace.json and applied to the live index. NOTE: existing
  // membership cells are not re-tiled; changing quantum on a populated timeline
  // is safe for coarser queries but new entries tile at the new quantum —
  // prefer setting it before ingestion (the UI warns, the API allows).
  fastify.put('/:name/quantum', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['quantum'],
        properties: { quantum: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      const { name } = request.params;
      let quantum;
      try {
        quantum = workspace.setTimelineQuantum(name, request.body.quantum);
      } catch (err) {
        const ro = new ResponseObject().badRequest(err.message);
        return reply.code(ro.statusCode).send(ro.getResponse());
      }
      const ro = new ResponseObject().updated({ name, quantum }, 'Timeline quantum updated');
      return reply.code(ro.statusCode).send(ro.getResponse());
    } catch (err) {
      fastify.log.error(err);
      const ro = new ResponseObject().serverError('Failed to set timeline quantum');
      return reply.code(ro.statusCode).send(ro.getResponse());
    }
  });

  // GET /workspaces/:id/timelines/:name/decompose?start=&end=&scale=
  // Covering decomposition of a range at the timeline's quantum — the cells the
  // membership plane would store/probe. Debug + UI density planning.
  fastify.get('/:name/decompose', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        required: ['start'],
        properties: {
          start: { type: 'string' },
          end: { type: 'string' },
          scale: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      const { name } = request.params;
      const { start, end, scale } = request.query;
      const interval = end != null ? { start, end } : { start, end: start };
      if (scale) interval.scale = scale;

      const result = workspace.decomposeTimelineRange(name, interval);
      const ro = new ResponseObject().found(result, 'Timeline range decomposed', 200, result.cells.length);
      return reply.code(ro.statusCode).send(ro.getResponse());
    } catch (err) {
      fastify.log.error(err);
      const ro = new ResponseObject().badRequest(err.message || 'Failed to decompose timeline range');
      return reply.code(ro.statusCode).send(ro.getResponse());
    }
  });

  // DELETE /workspaces/:id/timelines/:name
  fastify.delete('/:name', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      const { name } = request.params;

      if (name.startsWith('crud:') || name === 'content') {
        const ro = new ResponseObject().forbidden(`System timeline "${name}" cannot be deleted`);
        return reply.code(ro.statusCode).send(ro.getResponse());
      }

      const removed = await workspace.deleteTimeline(name);
      if (!removed) {
        const ro = new ResponseObject().notFound(`Timeline not found: ${name}`);
        return reply.code(ro.statusCode).send(ro.getResponse());
      }

      const ro = new ResponseObject().deleted({ name }, 'Timeline deleted successfully');
      return reply.code(ro.statusCode).send(ro.getResponse());
    } catch (err) {
      fastify.log.error(err);
      const ro = new ResponseObject().serverError('Failed to delete timeline');
      return reply.code(ro.statusCode).send(ro.getResponse());
    }
  });

  // POST /workspaces/:id/timelines/histogram
  // Per-bucket document counts for one or more timelines, intersected with the
  // same candidate scope as the documents listing (context/directory path,
  // features, filters, canvas querySpec folding). Buckets are caller-supplied
  // intervals — the UI computes its visible periods, the server counts.
  // Body: { names, buckets, context?, treeNameOrTreeId?, treeType?,
  //         allOf?/anyOf?/noneOf?, filters?, scope?, applyCanvasSpec? }
  fastify.post('/histogram', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['names', 'buckets'],
        additionalProperties: false,
        properties: {
          names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 },
          buckets: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            items: {
              type: 'object',
              required: ['start', 'end'],
              properties: { start: {}, end: {} },
            },
          },
          treeNameOrTreeId: { type: 'string' },
          treeType: { type: 'string', enum: ['context', 'directory'] },
          context: { type: 'string', default: '/' },
          allOf: { type: 'array', items: { type: 'string' }, default: [] },
          anyOf: { type: 'array', items: { type: 'string' }, default: [] },
          noneOf: { type: 'array', items: { type: 'string' }, default: [] },
          filters: { type: 'array', items: { type: 'string' }, default: [] },
          scope: { type: 'string', enum: ['path', 'workspace'], default: 'path' },
          applyCanvasSpec: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      const body = request.body;
      const { context: ctxSelector, directory: dirSelector } = body.scope === 'workspace'
        ? { context: null, directory: null }
        : resolveScopeSelectors(workspace, body, '/');

      const spec = {
        context: ctxSelector,
        directory: dirSelector,
        attributes: buildAttributes(body),
        filters: body.filters,
        applyCanvasQuerySpec: body.applyCanvasSpec,
      };

      const buckets = await workspace.timelineHistogram(body.names, body.buckets, spec);
      const ro = new ResponseObject().found({ buckets }, 'Timeline histogram computed', 200, buckets.length);
      return reply.code(ro.statusCode).send(ro.getResponse());
    } catch (err) {
      fastify.log.error(err);
      const ro = new ResponseObject().serverError('Failed to compute timeline histogram');
      return reply.code(ro.statusCode).send(ro.getResponse());
    }
  });

  // POST /workspaces/:id/timelines/:name/query
  // Body: { start, end?, scale?, mode?, scales? }
  fastify.post('/:name/query', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['start'],
        properties: {
          start: {},
          end: {},
          scale: { type: 'string' },
          mode: { type: 'string', enum: ['union', 'layers', 'grouped'] },
          scales: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      const { name } = request.params;
      const { start, end, scale, mode, scales } = request.body;
      const interval = end != null ? { start, end } : { start };
      if (scale) interval.scale = scale;

      const options = {};
      if (mode) options.mode = mode;
      if (scales) options.scales = scales;

      const ids = await workspace.queryTimeline(name, interval, options);
      const ro = new ResponseObject().found(ids, 'Timeline query successful', 200, Array.isArray(ids) ? ids.length : 0);
      return reply.code(ro.statusCode).send(ro.getResponse());
    } catch (err) {
      fastify.log.error(err);
      const ro = new ResponseObject().serverError('Failed to query timeline');
      return reply.code(ro.statusCode).send(ro.getResponse());
    }
  });

  // Normalize an entry body { start, end?, scale? } → engine interval value.
  function entryInterval({ start, end, scale }) {
    const interval = end != null ? { start, end } : { start, end: start };
    if (scale) interval.scale = scale;
    return interval;
  }

  // POST /workspaces/:id/timelines/:name/entries
  // Insert manual timeline positions for a document. Two forms:
  // - single (back-compat): { id, start, end?, scale? } — the PRIMARY interval.
  // - multi-position:       { id, entries: [{ start, end?, scale?, primary? }] }
  //   The entry flagged `primary: true` (or the first) becomes the sortable
  //   primary interval; the rest land in the tiled membership plane. Open-ended
  //   intervals are only representable as the primary (engine contract).
  fastify.post('/:name/entries', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {},
          start: {},
          end: {},
          scale: { type: 'string' },
          entries: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              required: ['start'],
              properties: {
                start: {},
                end: {},
                scale: { type: 'string' },
                primary: { type: 'boolean' },
              },
            },
          },
        },
        anyOf: [{ required: ['start'] }, { required: ['entries'] }],
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      const { name } = request.params;
      const { id, entries } = request.body;

      if (Array.isArray(entries)) {
        let primaryIndex = entries.findIndex((e) => e.primary === true);
        if (primaryIndex === -1) primaryIndex = 0;
        const extras = entries.filter((_, i) => i !== primaryIndex);

        await workspace.insertTimelineEntry(name, id, entryInterval(entries[primaryIndex]));
        if (extras.length > 0) {
          await workspace.insertTimelineEntries(name, id, extras.map(entryInterval));
        }
        const ro = new ResponseObject().created(
          { timelineName: name, id, entries: entries.length },
          'Timeline entries inserted',
        );
        return reply.code(ro.statusCode).send(ro.getResponse());
      }

      await workspace.insertTimelineEntry(name, id, entryInterval(request.body));
      const ro = new ResponseObject().created({ timelineName: name, id }, 'Timeline entry inserted');
      return reply.code(ro.statusCode).send(ro.getResponse());
    } catch (err) {
      fastify.log.error(err);
      const ro = new ResponseObject().serverError('Failed to insert timeline entry');
      return reply.code(ro.statusCode).send(ro.getResponse());
    }
  });

  // DELETE /workspaces/:id/timelines/:name/entries/:docId
  // Removes the primary interval. Membership cells from manual multi-position
  // entries are interval-derived — pass the intervals they were inserted with
  // via an optional body { entries: [{ start, end?, scale? }] } to clear them
  // too (document-declared entries never need this; the row re-derives).
  fastify.delete('/:name/entries/:docId', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: ['object', 'null'],
        properties: {
          entries: {
            type: 'array',
            maxItems: 100,
            items: {
              type: 'object',
              required: ['start'],
              properties: { start: {}, end: {}, scale: { type: 'string' } },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;

      const { name, docId } = request.params;
      const intervals = Array.isArray(request.body?.entries)
        ? request.body.entries.map(entryInterval)
        : null;
      await workspace.removeTimelineEntry(name, docId, intervals ? { intervals } : {});
      const ro = new ResponseObject().deleted({ timelineName: name, id: docId }, 'Timeline entry removed');
      return reply.code(ro.statusCode).send(ro.getResponse());
    } catch (err) {
      fastify.log.error(err);
      const ro = new ResponseObject().serverError('Failed to remove timeline entry');
      return reply.code(ro.statusCode).send(ro.getResponse());
    }
  });
}
