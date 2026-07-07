import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getBackendEmailContext,
  getBackendFileContext,
  getBackendFileContextFromStoredLocation,
  getBackendChannelContext,
  isBackendsContextSpec,
  normalizeBackendsTreePath,
} from './backend-documents.js';

test('builds email backend paths with driver, account, and folder', () => {
  assert.equal(
    getBackendEmailContext('imap', 'foo@bar.tld', 'Inbox'),
    '/.backends/imap/foo@bar.tld/inbox'
  );
});

test('builds channel backend paths with driver, account, and channel (no kind segment)', () => {
  assert.equal(
    getBackendChannelContext('slack', 'acme-workspace', 'dev-backend'),
    '/.backends/slack/acme-workspace/dev-backend'
  );
});

test('builds file backend paths from explicit provenance (no kind segment)', () => {
  assert.equal(
    getBackendFileContext('s3', 'prod-archive', 'somebucket', 'logs/2026/03/app.log'),
    '/.backends/s3/prod-archive/somebucket/logs/2026/03/app.log'
  );
});

test('preserves colon in backend addresses', () => {
  assert.equal(
    getBackendFileContext('file', 'workspace:home', null, 'foo/bar'),
    '/.backends/file/workspace:home/foo/bar'
  );
});

test('builds file backend paths from stored locations using parent directory', () => {
  assert.equal(
    getBackendFileContextFromStoredLocation({
      backend: 'workspace:home',
      key: 'docs/spec.md',
      driver: 'file',
      source: {
        provider: 'workspace',
        account: 'home',
        container: 'home',
        path: 'docs/spec.md',
      },
    }),
    '/.backends/file/workspace:home/docs'
  );
});

test('places root-level files at the backend address with no subpath', () => {
  assert.equal(
    getBackendFileContextFromStoredLocation({
      backend: 'workspace:home',
      key: 'readme.md',
      driver: 'file',
      source: {
        provider: 'workspace',
        account: 'home',
        container: 'home',
        path: 'readme.md',
      },
    }),
    '/.backends/file/workspace:home'
  );
});

test('isBackendsContextSpec matches root and descendants only', () => {
  assert.equal(isBackendsContextSpec('/.backends'), true);
  assert.equal(isBackendsContextSpec('/.backends/imap/foo@bar.tld'), true);
  assert.equal(isBackendsContextSpec('/.backends-not'), false);
  assert.equal(isBackendsContextSpec('/foo'), false);
  assert.equal(isBackendsContextSpec('/.other'), false);
});

test('normalizeBackendsTreePath prefixes unprefixed paths', () => {
  assert.equal(normalizeBackendsTreePath('/'), '/.backends');
  assert.equal(normalizeBackendsTreePath('imap/foo'), '/.backends/imap/foo');
  assert.equal(normalizeBackendsTreePath('/.backends/imap/foo'), '/.backends/imap/foo');
});
