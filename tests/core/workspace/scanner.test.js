import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

import { discoverWorkspaceCandidates, validateWorkspaceConfig } from '../../../src/core/workspace/lib/scanner.js';

function makeWorkspaceDir(root, name, config) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  if (config !== undefined) {
    writeFileSync(path.join(dir, 'workspace.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return dir;
}

test('discovers directories holding a valid workspace.json across roots', async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const rootA = path.join(tmp, 'Workspaces');
  const rootB = path.join(tmp, 'workspaces');
  makeWorkspaceDir(rootA, 'alpha', { id: 'id-alpha', name: 'alpha' });
  makeWorkspaceDir(rootB, 'beta', { id: 'id-beta', name: 'beta' });
  makeWorkspaceDir(rootA, 'no-config'); // plain dir, no workspace.json — ignored

  const { candidates, skipped } = await discoverWorkspaceCandidates([rootA, rootB]);
  assert.deepEqual(candidates.map((c) => c.config.id).sort(), ['id-alpha', 'id-beta']);
  assert.equal(skipped.length, 0);
});

test('skips corrupt and incomplete workspace.json without throwing', async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const root = path.join(tmp, 'Workspaces');
  makeWorkspaceDir(root, 'corrupt', '{ not json');
  makeWorkspaceDir(root, 'no-id', { name: 'no-id' });
  makeWorkspaceDir(root, 'ok', { id: 'id-ok', name: 'ok' });

  const { candidates, skipped } = await discoverWorkspaceCandidates([root]);
  assert.deepEqual(candidates.map((c) => c.config.id), ['id-ok']);
  assert.equal(skipped.length, 2);
});

test('missing roots are ignored silently (zero-workspace user)', async () => {
  const { candidates, skipped } = await discoverWorkspaceCandidates([
    '/nonexistent/Workspaces',
    null,
  ]);
  assert.equal(candidates.length, 0);
  assert.equal(skipped.length, 0);
});

test('validateWorkspaceConfig requires id and name', () => {
  assert.equal(validateWorkspaceConfig({ id: 'a', name: 'b' }), null);
  assert.ok(validateWorkspaceConfig(null));
  assert.ok(validateWorkspaceConfig({ name: 'b' }));
  assert.ok(validateWorkspaceConfig({ id: 'a' }));
});
