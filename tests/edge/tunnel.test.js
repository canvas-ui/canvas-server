'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import EdgeRegistry from '../../src/edge/registry.js';
import EdgeClient from '../../src/edge/EdgeClient.js';

function fakeSocket(id = 's1', userId = 'u1') {
  const socket = new EventEmitter();
  socket.id = id;
  socket.user = { id: userId };
  socket.sent = [];
  const emit = socket.emit.bind(socket);
  socket.emit = (event, payload) => {
    socket.sent.push([event, payload]);
    return emit(event, payload);
  };
  return socket;
}

test('registry: announce + proxyRequest round trip', async () => {
  const registry = new EdgeRegistry();
  const socket = fakeSocket();
  const instanceId = registry.register(socket, { instanceId: 'edge-1', runtime: 'ws' });
  assert.equal(instanceId, 'edge-1');
  assert.equal(registry.list('u1').length, 1);

  const pending = registry.proxyRequest('edge-1', {
    method: 'GET',
    path: '/rest/v2/workspaces',
    headers: { authorization: 'Bearer x' },
  });

  const [event, frame] = socket.sent.at(-1);
  assert.equal(event, 'edge:req');
  assert.equal(frame.method, 'GET');
  assert.equal(frame.path, '/rest/v2/workspaces');

  // Response frames must carry the id of the socket that received edge:req —
  // the registry drops frames from any other socket.
  registry.handleRes({ id: frame.id, status: 200, headers: { 'content-type': 'application/json' } }, socket.id);
  registry.handleChunk({ id: frame.id, seq: 0, data: Buffer.from('{"ok":').toString('base64') }, socket.id);
  registry.handleChunk({ id: frame.id, seq: 1, data: Buffer.from('true}').toString('base64') }, socket.id);
  registry.handleEnd({ id: frame.id }, socket.id);

  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), '{"ok":true}');
});

test('registry: response frames from a foreign socket are ignored', async () => {
  const registry = new EdgeRegistry();
  const socket = fakeSocket('s1', 'u1');
  registry.register(socket, { instanceId: 'edge-1' });

  const pending = registry.proxyRequest('edge-1', { method: 'GET', path: '/x', timeoutMs: 100 });
  const [, frame] = socket.sent.at(-1);

  // An attacker socket sprays a forged response for a guessed id — must NOT
  // resolve the victim's request.
  registry.handleRes({ id: frame.id, status: 200, headers: {} }, 'attacker-socket');
  registry.handleEnd({ id: frame.id }, 'attacker-socket');

  await assert.rejects(pending, (err) => err.code === 'EDGE_TIMEOUT');
});

test('registry: request ids are unguessable, not sequential', async () => {
  const registry = new EdgeRegistry();
  const socket = fakeSocket();
  registry.register(socket, { instanceId: 'edge-1' });
  // Short timeout + swallow so these never-answered requests do not leak.
  registry.proxyRequest('edge-1', { method: 'GET', path: '/a', timeoutMs: 20 }).catch(() => {});
  registry.proxyRequest('edge-1', { method: 'GET', path: '/b', timeoutMs: 20 }).catch(() => {});
  const [, a] = socket.sent.at(-2);
  const [, b] = socket.sent.at(-1);
  assert.notEqual(a.id, 'r1');
  assert.notEqual(b.id, 'r2');
  assert.match(a.id, /^r[0-9a-f]{36}$/);
  await new Promise((r) => setTimeout(r, 40));
});

test('registry: edge error rejects the pending request', async () => {
  const registry = new EdgeRegistry();
  const socket = fakeSocket();
  registry.register(socket, { instanceId: 'edge-1' });

  const pending = registry.proxyRequest('edge-1', { method: 'GET', path: '/x' });
  const [, frame] = socket.sent.at(-1);
  registry.handleErr({ id: frame.id, code: 'EDGE_DISPATCH_FAILED', message: 'boom' }, socket.id);

  await assert.rejects(pending, (err) => err.code === 'EDGE_DISPATCH_FAILED' && err.message === 'boom');
});

test('registry: disconnect fails in-flight requests and removes the edge', async () => {
  const registry = new EdgeRegistry();
  const socket = fakeSocket();
  registry.register(socket, { instanceId: 'edge-1' });

  const pending = registry.proxyRequest('edge-1', { method: 'GET', path: '/x' });
  const removed = registry.removeBySocket(socket.id);

  assert.deepEqual(removed, ['edge-1']);
  assert.equal(registry.get('edge-1'), null);
  await assert.rejects(pending, (err) => err.code === 'EDGE_GONE');
  await assert.rejects(
    registry.proxyRequest('edge-1', { method: 'GET', path: '/x' }),
    (err) => err.code === 'EDGE_GONE'
  );
});

test('client: dispatches proxied requests into the local app and streams back', async () => {
  const injected = [];
  const localApp = {
    inject: async (opts) => {
      injected.push(opts);
      return {
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        rawPayload: Buffer.from('{"created":true}'),
      };
    },
  };
  const client = new EdgeClient({
    serverUrl: 'http://localhost:0',
    token: 'canvas-test',
    localApp,
    announce: { instanceId: 'edge-1' },
  });

  const socket = fakeSocket();
  await client.handleRequest({
    id: 'r1',
    method: 'POST',
    path: '/rest/v2/workspaces/w1/documents',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"documents":[]}').toString('base64'),
    bodyEncoding: 'base64',
  }, socket);

  assert.equal(injected[0].method, 'POST');
  assert.equal(injected[0].payload.toString(), '{"documents":[]}');

  const events = socket.sent.map(([event]) => event);
  assert.deepEqual(events, ['edge:res', 'edge:chunk', 'edge:end']);
  const res = socket.sent[0][1];
  assert.equal(res.id, 'r1');
  assert.equal(res.status, 201);
  const chunk = socket.sent[1][1];
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), '{"created":true}');
});

test('client: dispatch failure emits edge:err with the request id', async () => {
  const localApp = { inject: async () => { throw new Error('nope'); } };
  const client = new EdgeClient({
    serverUrl: 'http://localhost:0',
    token: 'canvas-test',
    localApp,
    announce: { instanceId: 'edge-1' },
  });

  const socket = fakeSocket();
  await client.handleRequest({ id: 'r9', method: 'GET', path: '/x' }, socket);

  const [event, frame] = socket.sent.at(-1);
  assert.equal(event, 'edge:err');
  assert.equal(frame.id, 'r9');
  assert.equal(frame.code, 'EDGE_DISPATCH_FAILED');
});
