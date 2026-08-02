'use strict';

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readWorkspaceConfig, listRemotes, saveRemote, removeRemote } from '../../src/edge/remote-config.js';
import { buildAnnounce, connectRemotes } from '../../src/edge/runtime.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-remote-'));
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({
    id: 'ws-uuid-1',
    name: 'universe',
    label: 'Universe',
  }, null, 2));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveRemote adds, updates by url, and persists', () => {
  saveRemote(dir, { url: 'https://my.cnvs.ai/', token: 'canvas-aaa' });
  let remotes = listRemotes(readWorkspaceConfig(dir));
  assert.equal(remotes.length, 1);
  assert.equal(remotes[0].url, 'https://my.cnvs.ai'); // trailing slash normalized
  assert.equal(remotes[0].enabled, true);

  saveRemote(dir, { url: 'https://my.cnvs.ai', token: 'canvas-bbb', enabled: false });
  remotes = listRemotes(readWorkspaceConfig(dir));
  assert.equal(remotes.length, 1); // updated, not duplicated
  assert.equal(remotes[0].token, 'canvas-bbb');
  assert.equal(remotes[0].enabled, false);
});

test('removeRemote drops the entry and reports whether it existed', () => {
  saveRemote(dir, { url: 'https://a.example', token: 't' });
  assert.equal(removeRemote(dir, 'https://a.example/'), true);
  assert.equal(removeRemote(dir, 'https://a.example'), false);
  assert.equal(listRemotes(readWorkspaceConfig(dir)).length, 0);
});

test('listRemotes skips malformed entries', () => {
  const config = { remotes: [{ url: 'https://ok.example', token: 't' }, { url: 42 }, null, { token: 'orphan' }] };
  const remotes = listRemotes(config);
  assert.equal(remotes.length, 1);
  assert.equal(remotes[0].url, 'https://ok.example');
});

test('buildAnnounce uses workspace id as instanceId and exports the workspace', () => {
  const announce = buildAnnounce({ id: 'ws-uuid-1', name: 'universe' });
  assert.equal(announce.instanceId, 'ws-uuid-1');
  assert.deepEqual(announce.exports, [{ type: 'workspace', id: 'ws-uuid-1', name: 'universe' }]);
  assert.throws(() => buildAnnounce({}), /no id/);
});

test('connectRemotes connects one client per enabled remote and forwards events', () => {
  saveRemote(dir, { url: 'https://a.example', token: 'canvas-a' });
  saveRemote(dir, { url: 'https://b.example', token: 'canvas-b', enabled: false });
  saveRemote(dir, { url: 'https://c.example', token: 'canvas-c' });

  const created = [];
  const events = { on() {}, off() {} };
  const clientFactory = (opts) => {
    const client = { opts, forwarded: null, closed: false, forwardEvents(e) { this.forwarded = e; }, close() { this.closed = true; } };
    created.push(client);
    return client;
  };

  const runtime = connectRemotes({ dir, localApp: { inject: async () => ({}) }, events, clientFactory });

  assert.equal(created.length, 2); // disabled remote skipped
  assert.deepEqual(created.map((c) => c.opts.serverUrl), ['https://a.example', 'https://c.example']);
  assert.equal(created[0].opts.announce.instanceId, 'ws-uuid-1');
  assert.equal(created[0].forwarded, events);

  runtime.close();
  assert.ok(created.every((c) => c.closed));
});
