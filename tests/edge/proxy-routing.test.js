'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import EdgeRegistry from '../../src/edge/registry.js';
import EdgeClient from '../../src/edge/EdgeClient.js';
import { proxyRemoteWorkspaces } from '../../src/transports/middleware/edge-proxy.js';

/**
 * Loopback harness: a "server" fastify app whose workspaces scope proxies to
 * an EdgeRegistry, wired frame-by-frame to an EdgeClient dispatching into a
 * local "edge" fastify app — the whole tunnel path minus socket.io.
 */
async function buildLoopback() {
  // the edge-local app (what a ws runtime serves)
  const edgeApp = Fastify({ logger: false });
  edgeApp.get('/rest/v2/workspaces/:id/documents', async (request) => ({
    payload: { from: 'edge', workspace: request.params.id, q: request.query.q ?? null },
  }));
  edgeApp.post('/rest/v2/workspaces/:id/documents', async (request) => ({
    payload: { from: 'edge', received: request.body },
  }));
  await edgeApp.ready();

  const registry = new EdgeRegistry();
  const client = new EdgeClient({
    serverUrl: 'http://localhost:0',
    token: 'canvas-test',
    localApp: edgeApp,
    announce: { instanceId: 'edge-1' },
  });

  // wire the two ends without socket.io
  const clientSocket = {
    // Response frames route back tagged with the edge socket's id ('s1'), which
    // is what received edge:req — the registry now binds frames to that socket.
    emit(event, frame) {
      if (event === 'edge:res') registry.handleRes(frame, 's1');
      else if (event === 'edge:chunk') registry.handleChunk(frame, 's1');
      else if (event === 'edge:end') registry.handleEnd(frame, 's1');
      else if (event === 'edge:err') registry.handleErr(frame, 's1');
    },
  };
  const serverSocket = {
    id: 's1',
    user: { id: 'u1' },
    emit(event, frame) {
      if (event === 'edge:req') client.handleRequest(frame, clientSocket);
    },
  };
  registry.register(serverSocket, {
    instanceId: 'edge-1',
    exports: [{ type: 'workspace', id: 'remote-ws-1', name: 'remote-universe' }],
  });

  // the canvas-server app: auth stub + proxy preHandler + a local fallthrough route
  const serverApp = Fastify({ logger: false });
  serverApp.decorate('edges', registry);
  serverApp.addHook('onRequest', async (request) => { request.user = { id: 'u1' }; });
  serverApp.register(async (scope) => {
    scope.addHook('preHandler', proxyRemoteWorkspaces);
    scope.get('/:id/documents', async (request) => ({ payload: { from: 'server-local', workspace: request.params.id } }));
    scope.post('/:id/documents', async () => ({ payload: { from: 'server-local' } }));
  }, { prefix: '/rest/v2/workspaces' });
  await serverApp.ready();

  return { serverApp, edgeApp, registry, serverSocket };
}

test('remote workspace requests proxy through the tunnel, query intact', async () => {
  const { serverApp, edgeApp } = await buildLoopback();
  const res = await serverApp.inject({ method: 'GET', url: '/rest/v2/workspaces/remote-ws-1/documents?q=find-me' });
  assert.equal(res.statusCode, 200);
  const json = res.json();
  assert.equal(json.payload.from, 'edge');
  assert.equal(json.payload.workspace, 'remote-ws-1');
  assert.equal(json.payload.q, 'find-me');
  await serverApp.close(); await edgeApp.close();
});

test('remote lookup also matches by export name', async () => {
  const { serverApp, edgeApp } = await buildLoopback();
  const res = await serverApp.inject({ method: 'GET', url: '/rest/v2/workspaces/remote-universe/documents' });
  assert.equal(res.json().payload.from, 'edge');
  await serverApp.close(); await edgeApp.close();
});

test('parsed JSON bodies re-serialize across the tunnel', async () => {
  const { serverApp, edgeApp } = await buildLoopback();
  const res = await serverApp.inject({
    method: 'POST',
    url: '/rest/v2/workspaces/remote-ws-1/documents',
    headers: { 'content-type': 'application/json' },
    payload: { documents: [{ title: 'hello' }] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().payload.received, { documents: [{ title: 'hello' }] });
  await serverApp.close(); await edgeApp.close();
});

test('local workspaces fall through to local handlers', async () => {
  const { serverApp, edgeApp } = await buildLoopback();
  const res = await serverApp.inject({ method: 'GET', url: '/rest/v2/workspaces/my-local-ws/documents' });
  assert.equal(res.json().payload.from, 'server-local');
  await serverApp.close(); await edgeApp.close();
});

test("another user's edge is not reachable", async () => {
  const { serverApp, edgeApp, registry, serverSocket } = await buildLoopback();
  // re-register the edge under a different owner
  registry.removeBySocket(serverSocket.id);
  serverSocket.user = { id: 'someone-else' };
  registry.register(serverSocket, {
    instanceId: 'edge-1',
    exports: [{ type: 'workspace', id: 'remote-ws-1' }],
  });
  const res = await serverApp.inject({ method: 'GET', url: '/rest/v2/workspaces/remote-ws-1/documents' });
  assert.equal(res.json().payload.from, 'server-local'); // falls through, no cross-user proxy
  await serverApp.close(); await edgeApp.close();
});

test('edge failure maps to gateway status codes (EDGE_GONE → 503)', async () => {
  const serverApp = Fastify({ logger: false });
  const goneError = Object.assign(new Error('edge disconnected'), { code: 'EDGE_GONE' });
  serverApp.decorate('edges', {
    findByExport: () => ({ instanceId: 'edge-1', export: { type: 'workspace', id: 'remote-ws-1' } }),
    proxyRequest: () => Promise.reject(goneError),
  });
  serverApp.addHook('onRequest', async (request) => { request.user = { id: 'u1' }; });
  serverApp.register(async (scope) => {
    scope.addHook('preHandler', proxyRemoteWorkspaces);
    scope.get('/:id/documents', async () => ({ payload: { from: 'server-local' } }));
  }, { prefix: '/rest/v2/workspaces' });

  const res = await serverApp.inject({ method: 'GET', url: '/rest/v2/workspaces/remote-ws-1/documents' });
  assert.equal(res.statusCode, 503);
  assert.match(res.json().message, /unreachable/i);
  await serverApp.close();
});
