import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getBackendEmailContext,
  getBackendFileContext,
  getBackendFileContextFromStoredLocation,
  getBackendChannelContext,
  isLegacyBackendsPath,
  normalizeBackendsTreePath,
} from './backend-documents.js';

test('builds email backend paths with driver, account, and folder', () => {
  assert.equal(
    getBackendEmailContext('imap', 'foo@bar.tld', 'Inbox'),
    '/imap/foo@bar.tld/inbox'
  );
});

test('builds channel backend paths with driver, account, and channel (no kind segment)', () => {
  assert.equal(
    getBackendChannelContext('slack', 'acme-workspace', 'dev-backend'),
    '/slack/acme-workspace/dev-backend'
  );
});

test('builds file backend paths from explicit provenance (no kind segment)', () => {
  assert.equal(
    getBackendFileContext('s3', 'prod-archive', 'somebucket', 'logs/2026/03/app.log'),
    '/s3/prod-archive/somebucket/logs/2026/03/app.log'
  );
});

test('preserves colon in backend addresses', () => {
  assert.equal(
    getBackendFileContext('file', 'workspace:home', null, 'foo/bar'),
    '/file/workspace:home/foo/bar'
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
    '/file/workspace:home/docs'
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
    '/file/workspace:home'
  );
});

test('isLegacyBackendsPath matches only old /.backends-prefixed paths', () => {
  assert.equal(isLegacyBackendsPath('/.backends'), true);
  assert.equal(isLegacyBackendsPath('/.backends/imap/foo@bar.tld'), true);
  assert.equal(isLegacyBackendsPath('/.backends-not'), false);
  assert.equal(isLegacyBackendsPath('/imap/foo@bar.tld'), false);
  assert.equal(isLegacyBackendsPath('/foo'), false);
});

test('normalizeBackendsTreePath is tree-relative and strips the legacy prefix', () => {
  assert.equal(normalizeBackendsTreePath('/'), '/');
  assert.equal(normalizeBackendsTreePath('imap/foo'), '/imap/foo');
  assert.equal(normalizeBackendsTreePath('/imap/foo'), '/imap/foo');
  assert.equal(normalizeBackendsTreePath('/.backends'), '/');
  assert.equal(normalizeBackendsTreePath('/.backends/imap/foo'), '/imap/foo');
});
