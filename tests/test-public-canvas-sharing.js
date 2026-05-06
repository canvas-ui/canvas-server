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

  const publicRead = await request('GET', `/pub/c/${share.data.payload.code}`, undefined, null);
  assert.strictEqual(publicRead.response.status, 200, JSON.stringify(publicRead.data));
  assert.strictEqual(publicRead.data.payload.share.code, share.data.payload.code);
  assert.strictEqual(publicRead.data.payload.canvas.type, 'canvas');
  assert(Array.isArray(publicRead.data.payload.documents.data), 'Public documents should be returned under documents.data');

  const lookup = await request('GET', `/pub/c?workspaceId=${workspace.id}&treeName=context&path=${encodeURIComponent(canvasPath)}`);
  assert.strictEqual(lookup.response.status, 200, JSON.stringify(lookup.data));
  assert.strictEqual(lookup.data.payload.code, share.data.payload.code);

  const unknown = await request('GET', '/pub/c/deadbeef', undefined, null);
  assert.strictEqual(unknown.response.status, 404, JSON.stringify(unknown.data));

  const deleted = await request('DELETE', `/pub/c/${share.data.payload.code}`);
  assert.strictEqual(deleted.response.status, 200, JSON.stringify(deleted.data));

  const unlockedCanvas = await request('GET', `/workspaces/${workspace.id}/trees/context/path/status`);
  assert.strictEqual(unlockedCanvas.response.status, 200, JSON.stringify(unlockedCanvas.data));
  assert(!unlockedCanvas.data.payload.lockedBy.includes(`public-share:${share.data.payload.code}`));

  const afterDelete = await request('GET', `/pub/c/${share.data.payload.code}`, undefined, null);
  assert.strictEqual(afterDelete.response.status, 404, JSON.stringify(afterDelete.data));

  console.log(`Public canvas share ok: ${share.data.payload.url}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

