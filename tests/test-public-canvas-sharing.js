#!/usr/bin/env node

import assert from 'assert';
import fetch from 'node-fetch';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8001/rest/v2';
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
  console.error('Set TOKEN to a valid user token before running this test.');
  process.exit(1);
}

async function request(method, endpoint, body, token = TOKEN) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

async function main() {
  const name = `public-canvas-${Date.now()}`;

  const created = await request('POST', '/workspaces', {
    name,
    label: 'Public Canvas Test',
  });
  assert.strictEqual(created.response.status, 201, JSON.stringify(created.data));
  const workspace = created.data.payload;

  const started = await request('POST', `/workspaces/${workspace.id}/start`);
  assert.ok([200, 201].includes(started.response.status), JSON.stringify(started.data));

  const canvasPath = '/status';
  const canvas = await request('PUT', `/workspaces/${workspace.id}/trees/context/path/status`, {
    type: 'canvas',
    querySpec: { features: null, filters: [] },
    metadata: { ui: { layout: 'public-card' } },
  });
  assert.strictEqual(canvas.response.status, 201, JSON.stringify(canvas.data));

  const share = await request('POST', '/pub/c', {
    workspaceId: workspace.id,
    treeName: 'context',
    path: canvasPath,
  });
  assert.strictEqual(share.response.status, 201, JSON.stringify(share.data));
  assert.match(share.data.payload.code, /^[a-z0-9]{8}$/);
  assert.strictEqual(share.data.payload.url, `/pub/c/${share.data.payload.code}`);

  const lockedCanvas = await request('GET', `/workspaces/${workspace.id}/trees/context/path/status`);
  assert.strictEqual(lockedCanvas.response.status, 200, JSON.stringify(lockedCanvas.data));
  assert(lockedCanvas.data.payload.locked, 'Shared canvas should be locked');
  assert(lockedCanvas.data.payload.lockedBy.includes(`public-share:${share.data.payload.code}`));

  const widgetUi = {
    layout: [{ i: 'clock-1', x: 0, y: 0, w: 4, h: 3, minW: 2, minH: 2 }],
    widgets: { 'clock-1': { type: 'clock', config: {} } },
  };
  const savedUi = await request('PATCH', `/workspaces/${workspace.id}/trees/context/path/status`, {
    metadata: { ui: widgetUi },
  });
  assert.strictEqual(savedUi.response.status, 200, JSON.stringify(savedUi.data));

  const publicAfterSave = await request('GET', `/pub/c/${share.data.payload.code}`, undefined, null);
  assert.strictEqual(publicAfterSave.response.status, 200, JSON.stringify(publicAfterSave.data));
  assert.strictEqual(publicAfterSave.data.payload.share.code, share.data.payload.code);
  assert.strictEqual(publicAfterSave.data.payload.canvas.type, 'canvas');
  assert.strictEqual(publicAfterSave.data.payload.canvas.metadata.ui.widgets['clock-1'].type, 'clock');
  assert(Array.isArray(publicAfterSave.data.payload.documents.data), 'Public documents should be returned under documents.data');

  const lookup = await request('GET', `/pub/c?workspaceId=${workspace.id}&treeName=context&path=${encodeURIComponent(canvasPath)}`);
  assert.strictEqual(lookup.response.status, 200, JSON.stringify(lookup.data));
  assert.strictEqual(lookup.data.payload.code, share.data.payload.code);

  const unknown = await request('GET', '/pub/c/deadbeef', undefined, null);
  assert.strictEqual(unknown.response.status, 404, JSON.stringify(unknown.data));

  const deleted = await request('DELETE', `/pub/c/${share.data.payload.code}`);
  assert.strictEqual(deleted.response.status, 200, JSON.stringify(deleted.data));

  const unlockedCanvas = await request('GET', `/workspaces/${workspace.id}/trees/context/path/status`);
  assert.strictEqual(unlockedCanvas.response.status, 200, JSON.stringify(unlockedCanvas.data));
  assert(!unlockedCanvas.data.payload.locked, 'Shared canvas should unlock after unshare');
  assert.strictEqual(unlockedCanvas.data.payload.lockedBy.length, 0, 'All public-share locks should be removed');

  // Share/unshare cycles must not accumulate stale public-share:* locks.
  for (let i = 0; i < 3; i++) {
    const cycleShare = await request('POST', '/pub/c', {
      workspaceId: workspace.id,
      treeName: 'context',
      path: canvasPath,
    });
    assert.strictEqual(cycleShare.response.status, 201, JSON.stringify(cycleShare.data));
    const cycleCode = cycleShare.data.payload.code;
    const locked = await request('GET', `/workspaces/${workspace.id}/trees/context/path/status`);
    assert.strictEqual(locked.data.payload.lockedBy.filter((id) => String(id).startsWith('public-share:')).length, 1);
    assert(locked.data.payload.lockedBy.includes(`public-share:${cycleCode}`));
    const cycleDelete = await request('DELETE', `/pub/c/${cycleCode}`);
    assert.strictEqual(cycleDelete.response.status, 200, JSON.stringify(cycleDelete.data));
    const afterCycle = await request('GET', `/workspaces/${workspace.id}/trees/context/path/status`);
    assert(!afterCycle.data.payload.locked, `Canvas should unlock after cycle ${i + 1}`);
    assert.strictEqual(afterCycle.data.payload.lockedBy.length, 0);
  }

  const afterDelete = await request('GET', `/pub/c/${share.data.payload.code}`, undefined, null);
  assert.strictEqual(afterDelete.response.status, 404, JSON.stringify(afterDelete.data));

  console.log(`Public canvas share ok: ${share.data.payload.url}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

