import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getIncomingEmailContext,
  getIncomingFileContext,
  getIncomingFileContextFromStoredLocation,
  getIncomingMessageContext,
} from './incoming-documents.js';

test('builds email incoming paths with provider, account, and folder', () => {
  assert.equal(
    getIncomingEmailContext('imap', 'foo@bar.tld', 'Inbox'),
    '/.incoming/imap/foo@bar.tld/inbox'
  );
});

test('builds message incoming paths with provider, account, and channel', () => {
  assert.equal(
    getIncomingMessageContext('slack', 'acme-workspace', 'dev-backend'),
    '/.incoming/message/slack/acme-workspace/dev-backend'
  );
});

test('builds file incoming paths from explicit provenance', () => {
  assert.equal(
    getIncomingFileContext('s3', 'prod-archive', 'somebucket', 'logs/2026/03/app.log'),
    '/.incoming/file/s3/prod-archive/somebucket/logs/2026/03/app.log'
  );
});

test('builds file incoming paths from stored locations using parent directory', () => {
  assert.equal(
    getIncomingFileContextFromStoredLocation({
      backend: 'fs:workspace',
      key: 'docs/spec.md',
      driver: 'file',
      source: {
        provider: 'fs',
        account: 'workspace',
        container: 'workspace',
        path: 'docs/spec.md',
      },
    }),
    '/.incoming/file/fs/workspace/workspace/docs'
  );
});

test('places root-level files at container context with no subpath', () => {
  assert.equal(
    getIncomingFileContextFromStoredLocation({
      backend: 'fs:workspace',
      key: 'readme.md',
      driver: 'file',
      source: {
        provider: 'fs',
        account: 'workspace',
        container: 'workspace',
        path: 'readme.md',
      },
    }),
    '/.incoming/file/fs/workspace/workspace'
  );
});
