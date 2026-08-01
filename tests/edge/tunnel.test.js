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

  registry.handleRes({ id: frame.id, status: 200, headers: { 'content-type': 'application/json' } });
  registry.handleChunk({ id: frame.id, seq: 0, data: Buffer.from('{"ok":').toString('base64') });
  registry.handleChunk({ id: frame.id, seq: 1, data: Buffer.from('true}').toString('base64') });
  registry.handleEnd({ id: frame.id });

  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), '{"ok":true}');
});

test('registry: edge error rejects the pending request', async () => {
  const registry = new EdgeRegistry();
  const socket = fakeSocket();
  registry.register(socket, { instanceId: 'edge-1' });

  const pending = registry.proxyRequest('edge-1', { method: 'GET', path: '/x' });
  const [, frame] = socket.sent.at(-1);
  registry.handleErr({ id: frame.id, code: 'EDGE_DISPATCH_FAILED', message: 'boom' });

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
