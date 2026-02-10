#!/usr/bin/env node
'use strict';

/**
 * Minimal smoke test for admin user management.
 *
 * Usage:
 *   CANVAS_BASE_URL="http://127.0.0.1:8001/rest/v2" \
 *   CANVAS_ADMIN_TOKEN="canvas-..." \
 *   node tests/test-admin-user-crud.js
 */

const BASE_URL = process.env.CANVAS_BASE_URL || 'http://127.0.0.1:8001/rest/v2';
let ADMIN_TOKEN = process.env.CANVAS_ADMIN_TOKEN;
const ADMIN_EMAIL = process.env.CANVAS_ADMIN_EMAIL || 'admin@canvas.local';
const ADMIN_PASSWORD = process.env.CANVAS_ADMIN_PASSWORD;

async function ensureToken() {
  if (ADMIN_TOKEN) return ADMIN_TOKEN;
  if (!ADMIN_PASSWORD) {
    console.error('Missing CANVAS_ADMIN_TOKEN or CANVAS_ADMIN_PASSWORD env var');
    process.exit(2);
  }
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, strategy: 'local' }),
  });
  const json = await res.json().catch(() => null);
  const token = json?.payload?.token || json?.payload?.payload?.token;
  if (!token) {
    console.error('Failed to login for token:', res.status, json);
    process.exit(2);
  }
  ADMIN_TOKEN = token;
  return ADMIN_TOKEN;
}

function randId(len = 6) {
  return Math.random().toString(36).slice(2, 2 + len);
}

async function api(path, { method = 'GET', body } = {}) {
  await ensureToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { res, json };
}

(async () => {
  const username = `u_${randId()}`;
  const email = `${username}@example.com`;

  // 1) Weak password should be rejected (400), and must not create the user.
  {
    const { res } = await api('/admin/users', {
      method: 'POST',
      body: { name: username, email, password: 'weakpassword', userType: 'user', status: 'active' },
    });
    if (res.status !== 400) {
      console.error('Expected 400 for weak password, got:', res.status);
      process.exit(1);
    }
  }

  // 2) Create user with strong password
  let userId;
  {
    const { res, json } = await api('/admin/users', {
      method: 'POST',
      body: { name: username, email, password: 'Abcdef1!2345', userType: 'user', status: 'active' },
    });
    if (res.status !== 201) {
      console.error('Expected 201 for create, got:', res.status, json);
      process.exit(1);
    }
    userId = json?.payload?.id;
    if (!userId) {
      console.error('Missing created user id in response:', json);
      process.exit(1);
    }
  }

  // 3) Update user password
  {
    const { res, json } = await api(`/admin/users/${userId}`, {
      method: 'PUT',
      body: { password: 'Abcdef1!2345' },
    });
    if (res.status !== 200) {
      console.error('Expected 200 for password update, got:', res.status, json);
      process.exit(1);
    }
  }

  // 4) Delete user
  {
    const { res, json } = await api(`/admin/users/${userId}`, { method: 'DELETE' });
    if (res.status !== 200) {
      console.error('Expected 200 for delete, got:', res.status, json);
      process.exit(1);
    }
  }

  console.log('OK: admin user CRUD smoke test passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

