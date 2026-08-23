import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Server as SocketServer } from 'socket.io';

import RemoteWorkspace from '../../../src/core/workspace/lib/RemoteWorkspace.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const REMOTE_ID = '3e9d73a3-423a-4ca1-b389-641ee1cf29e5';
const LOCAL_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function payload(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: status < 400 ? 'success' : 'error', statusCode: status, payload: body, ...extra }));
}

/**
 * A fake canvas-server: enough of /rest/v2/workspaces/<id>/* for the facade,
 * plus a socket.io endpoint that accepts any token and echoes subscriptions.
 * Every request is recorded so tests can assert on the wire.
 */
async function mockRemote({ readOnly = false } = {}) {
  const calls = [];
  let status = 'active';
  const tree = {
    id: 'ctx-tree', type: 'context', name: '/', children: [
      { id: 'L-work', type: 'context', name: 'work', locked: false, lockedBy: [], metadata: {}, children: [
        { id: 'L-foo', type: 'canvas', name: 'foo', locked: false, lockedBy: [], querySpec: { features: ['x'] }, metadata: {}, children: [] },
      ] },
    ],
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b ? JSON.parse(b) : null)); });
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), multi: url.searchParams, body, auth: req.headers.authorization });
    const p = url.pathname.replace(`/rest/v2/workspaces/${REMOTE_ID}`, '');
    if (p === '' && req.method === 'GET') return payload(res, 200, { workspace: { id: REMOTE_ID, name: 'shared', status, color: '#112233' } });
    if (p === '/start') { status = 'active'; return payload(res, 200, true); }
    if (p === '/trees') return payload(res, 200, [{ id: 'ctx-tree', name: 'context', type: 'context' }, { id: 'dir-tree', name: 'directory', type: 'directory' }]);
    if (p === '/trees/ctx-tree') return payload(res, 200, tree);
    if (p === '/trees/dir-tree') return payload(res, 200, { id: 'dir-tree', type: 'directory', name: '/', children: [] });
    if (p.startsWith('/trees/ctx-tree/path/') && req.method === 'PUT') {
      if (readOnly) return payload(res, 403, null, { message: 'Workspace token lacks required permission: write' });
      const segs = p.replace('/trees/ctx-tree/path/', '').split('/');
      let node = tree;
      for (const seg of segs) {
        let next = node.children.find((c) => c.name === seg);
        if (!next) { next = { id: `L-${seg}`, type: 'context', name: seg, locked: false, lockedBy: [], metadata: {}, children: [] }; node.children.push(next); }
        node = next;
      }
      return payload(res, 201, { id: node.id, path: `/${segs.join('/')}` });
    }
    if (/\/trees\/ctx-tree\/layers\/[^/]+\/(un)?lock$/.test(p)) {
      if (readOnly) return payload(res, 403, null, { message: 'Workspace token lacks required permission: write' });
      return payload(res, 200, { lockedBy: [body.lockBy] });
    }
    if (p === '/documents' && req.method === 'GET') {
      if (url.searchParams.get('idsOnly') === 'true') return payload(res, 200, [100001], { count: 1, totalCount: 1 });
      return payload(res, 200, [{ id: 100001, schema: 'data/schema/note' }], { count: 1, totalCount: 7 });
    }
    if (p === '/documents' && req.method === 'POST') return payload(res, 201, [100002]);
    if (p === '/documents/by-hash/sha256/abc') return payload(res, 200, { id: 100001 });
    if (p === '/documents/by-hash/sha256/nope') return payload(res, 404, null, { message: 'not found' });
    return payload(res, 404, null, { message: `mock: no route ${req.method} ${p}` });
  });
  const ioServer = new SocketServer(server, { transports: ['websocket'] });
  const sockets = [];
  ioServer.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('subscribe', ({ channel }) => socket.emit('subscribed', { channel }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, calls, sockets, ioServer,
    setStatus(s) { status = s; },
    async close() { ioServer.close(); await new Promise((r) => server.close(r)); },
  };
}

function facade(remote, overrides = {}) {
  return new RemoteWorkspace({
    entry: {
      id: LOCAL_ID, name: 'shared@remote-1', owner: 'user0001', host: 'remote-1', origin: 'remote',
      remote: { url: remote.url, workspaceId: REMOTE_ID, workspaceName: 'shared', permissions: ['read', 'write'] },
      ...overrides,
    },
    credentials: { token: 'canvas-workspace-secret' },
    allowInsecure: true,
    logger: quiet,
  });
}

test('start() loads trees; the context tree answers path lookups synchronously', async () => {
  const remote = await mockRemote();
  const ws = facade(remote);
  try {
    assert.equal(ws.isActive, false);
    await ws.start();
    assert.equal(ws.isActive, true);
    assert.equal(ws.status, 'active');
    const tree = ws.getContextTree();
    assert.equal(tree.id, 'ctx-tree');
    assert.equal(ws.getTree('ctx-tree').type, 'context');
    assert.equal(ws.getDefaultContextTree().id, 'ctx-tree');
    assert.throws(() => ws.getTree('nope'), /Tree not found/);
    assert.throws(() => ws.getDirectoryTree('ctx-tree'), /not a directory tree/);
    assert.deepEqual(tree.paths, ['/', '/work', '/work/foo']);
    const leaf = tree.getLayerForPath('/work/foo');
    assert.equal(leaf.type, 'canvas');
    assert.deepEqual(leaf.querySpec, { features: ['x'] });
    assert.equal(tree.getLayerForPath('/missing'), null);
    assert.deepEqual(tree.getNodeIdsForPath('/work/foo'), ['ctx-tree', 'L-work', 'L-foo']);
    assert.ok(remote.calls.every((c) => c.auth === 'Bearer canvas-workspace-secret'));
  } finally { ws.dispose(); await remote.close(); }
});

test('document queries translate the in-process spec to the /documents query string', async () => {
  const remote = await mockRemote();
  const ws = facade(remote);
  try {
    await ws.start();
    const rows = await ws.list({ context: { tree: 'ctx-tree', path: '/work/foo' }, features: ['data/schema/note', '!tag/x'], filters: ['f1'], limit: 20, page: 2, sortBy: 'crud:created', order: 'desc' });
    assert.equal(rows.length, 1);
    assert.equal(rows.count, 1);
    assert.equal(rows.totalCount, 7);
    const q = remote.calls.at(-1);
    assert.equal(q.path, `/rest/v2/workspaces/${REMOTE_ID}/documents`);
    assert.equal(q.query.treeNameOrTreeId, 'ctx-tree');
    assert.equal(q.query.treeType, 'context');
    assert.equal(q.query.context, '/work/foo');
    assert.deepEqual(q.multi.getAll('allOf'), ['data/schema/note', '!tag/x']);
    assert.deepEqual(q.multi.getAll('filters'), ['f1']);
    assert.equal(q.query.limit, '20');
    assert.equal(q.query.page, '2');
    assert.equal(q.query.sortBy, 'crud:created');

    await ws.list({ context: null });
    assert.equal(remote.calls.at(-1).query.scope, 'workspace');

    await ws.search({ query: 'invoices', context: { tree: 'ctx-tree', path: '/work' }, attributes: { anyOf: ['a'], noneOf: ['b'] } });
    const s = remote.calls.at(-1);
    assert.equal(s.query.q, 'invoices');
    assert.deepEqual(s.multi.getAll('anyOf'), ['a']);
    assert.deepEqual(s.multi.getAll('noneOf'), ['b']);

    assert.equal(await ws.has(100001, { context: { tree: 'ctx-tree', path: '/work' } }), true);
    const h = remote.calls.at(-1);
    assert.equal(h.query.idsOnly, 'true');
    assert.deepEqual(h.multi.getAll('ids'), ['100001']);

    assert.deepEqual(await ws.getByChecksumString('sha256/abc'), { id: 100001 });
    assert.equal(await ws.getByChecksumString('sha256/nope'), null);
    assert.equal(await ws.hasByChecksumString('sha256/nope', { context: { tree: 'ctx-tree', path: '/work' } }), false);

    const inserted = await ws.putMany([{ schema: 'data/schema/note', data: { title: 't' } }], { context: { tree: 'ctx-tree', path: '/work/foo' }, features: ['tag/x'] });
    assert.deepEqual(inserted, [100002]);
    const ins = remote.calls.at(-1);
    assert.equal(ins.method, 'POST');
    assert.equal(ins.body.context, '/work/foo');
    assert.equal(ins.body.treeNameOrTreeId, 'ctx-tree');
    assert.deepEqual(ins.body.features, ['tag/x']);
    assert.equal(ins.body.documents.length, 1);
    assert.equal(await ws.put({ schema: 'data/schema/note' }, { context: { tree: 'ctx-tree', path: '/work' } }), 100002);

    await ws.linkMany([1, 2], { context: { tree: 'ctx-tree', path: '/work' } });
    assert.deepEqual(remote.calls.at(-1).body.documentIds, [1, 2]);
  } finally { ws.dispose(); await remote.close(); }
});

test('insertPath is a no-op for existing paths, creates missing ones, and locks are best-effort on read-only tokens', async () => {
  const remote = await mockRemote({ readOnly: true });
  const ws = facade(remote);
  try {
    await ws.start();
    const tree = ws.getContextTree();
    const before = remote.calls.length;
    const existing = await tree.insertPath('/work/foo');
    assert.deepEqual(existing.data, ['L-work', 'L-foo']);
    assert.equal(remote.calls.length, before, 'no remote write for an existing path');
    await assert.rejects(() => tree.insertPath('/work/new'), (err) => err.statusCode === 403);
    const lock = await tree.lockPath('/work/foo', 'ctx-1');
    assert.deepEqual(lock.layerIds, [], 'read-only token: locks skipped, not fatal');
  } finally { ws.dispose(); await remote.close(); }
  const writable = await mockRemote();
  const ws2 = facade(writable);
  try {
    await ws2.start();
    const tree = ws2.getContextTree();
    const created = await tree.insertPath('/work/new');
    assert.deepEqual(created.data, ['L-work', 'L-new']);
    assert.equal(tree.getLayerForPath('/work/new')?.id, 'L-new', 'tree re-read after the insert');
    const lock = await tree.lockPath('/work/new', 'ctx-1');
    assert.deepEqual(lock.layerIds, ['L-work', 'L-new']);
    assert.deepEqual(writable.calls.filter((c) => /\/lock$/.test(c.path)).map((c) => c.body), [{ lockBy: 'ctx-1' }, { lockBy: 'ctx-1' }]);
  } finally { ws2.dispose(); await writable.close(); }
});

test('live socket: subscribes with the share token, relays events with the local workspace id, refreshes trees, goes offline on disconnect', async () => {
  const remote = await mockRemote();
  const ws = facade(remote);
  try {
    await ws.start();
    for (let i = 0; i < 50 && !ws.isLive; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(ws.isLive, true);
    const socket = remote.sockets[0];
    assert.equal(socket.handshake.auth.token, 'canvas-workspace-secret');

    const seen = [];
    ws.on('document.inserted', (p) => seen.push(p));
    socket.emit('document.inserted', { workspaceId: REMOTE_ID, workspaceName: 'shared', id: 100009 });
    for (let i = 0; i < 50 && !seen.length; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].workspaceId, LOCAL_ID);
    assert.equal(seen[0].workspaceName, 'shared@remote-1');
    assert.equal(seen[0].remoteWorkspaceId, REMOTE_ID);
    assert.equal(seen[0].id, 100009);

    const treeReads = () => remote.calls.filter((c) => c.path.endsWith('/trees/ctx-tree')).length;
    const before = treeReads();
    socket.emit('tree.path.inserted', { workspaceId: REMOTE_ID, path: '/work/bar' });
    for (let i = 0; i < 50 && treeReads() === before; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(treeReads(), before + 1, 'tree.* events trigger one coalesced re-read');

    socket.disconnect(true);
    for (let i = 0; i < 50 && ws.status !== 'offline'; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(ws.status, 'offline');
    assert.match(ws.statusMessage, /live connection lost/);
  } finally { ws.dispose(); await remote.close(); }
});
