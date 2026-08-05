'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ResponseObject from '../../src/transports/ResponseObject.js';

const ROUTES_DIR = path.join(
  path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
  'src/transports/routes',
);

test('workspaceNotActive is one canonical response', () => {
  const response = new ResponseObject().workspaceNotActive().getResponse();
  assert.equal(response.statusCode, 409);
  assert.equal(response.code, 'WORKSPACE_NOT_ACTIVE');
  assert.equal(response.message, 'Workspace is not active. Start the workspace first.');
  assert.equal(response.status, 'error');
});

test('code is only serialized when set', () => {
  assert.equal('code' in new ResponseObject().notFound('nope').getResponse(), false);
});

test('isWorkspaceNotActiveError matches what Workspace throws, and nothing else', () => {
  // The literal message from Workspace#getActiveDb().
  assert.ok(ResponseObject.isWorkspaceNotActiveError(new Error('Workspace not active')));
  assert.ok(ResponseObject.isWorkspaceNotActiveError(new Error('Workspace is not active. Start the workspace first.')));

  assert.equal(ResponseObject.isWorkspaceNotActiveError(new Error('Agent is not active')), false);
  assert.equal(ResponseObject.isWorkspaceNotActiveError(new Error('Workspace not found')), false);
  assert.equal(ResponseObject.isWorkspaceNotActiveError(null), false);
});

// The reason this response was normalized in the first place: every route used
// to spell it out for itself, so the same condition reached clients as a 400,
// a 404 or a 500 depending on who caught it. Clients act on this one — a query
// against a stopped workspace starts it and replays itself — so a route that
// hand-rolls its own wording silently breaks that. Fail here instead.
test('no route hand-rolls its own workspace-not-active response', () => {
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) { continue; }

      fs.readFileSync(full, 'utf8').split('\n').forEach((line, index) => {
        // A ResponseObject built with a message that says the workspace isn't
        // active — anything other than the shared helper.
        if (/new ResponseObject\(\)\.\w+\([^)]*[Ww]orkspace[^)]*not active/.test(line)) {
          offenders.push(`${path.relative(ROUTES_DIR, full)}:${index + 1}`);
        }
      });
    }
  };
  walk(ROUTES_DIR);

  assert.deepEqual(offenders, [], `use new ResponseObject().workspaceNotActive() instead at: ${offenders.join(', ')}`);
});
