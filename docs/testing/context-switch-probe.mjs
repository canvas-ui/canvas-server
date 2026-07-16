#!/usr/bin/env node
// Context-switch latency probe. Subscribes to a context channel, then (optionally)
// fires N url switches and reports ms from POST to the matching context.url.set event.
//
// Usage:
//   CANVAS_URL=http://127.0.0.1:8001 CANVAS_TOKEN=$(cat /path/to/token) \
//     node docs/testing/context-switch-probe.mjs <contextId> [urlA] [urlB] [rounds]
//
//   - with only <contextId>: passive sniffer, logs every context/document event w/ timestamps
//   - with urlA+urlB: alternates POST /contexts/:id/url between them (default 5 rounds)
//
// Run from the repo root so socket.io-client resolves from node_modules.

import { io } from 'socket.io-client';

const BASE = process.env.CANVAS_URL || 'http://127.0.0.1:8001';
const TOKEN = process.env.CANVAS_TOKEN;
const [contextId, urlA, urlB, roundsArg] = process.argv.slice(2);
const rounds = Number(roundsArg || 5);

if (!TOKEN || !contextId) {
  console.error('need CANVAS_TOKEN env + <contextId> arg');
  process.exit(1);
}

const socket = io(BASE, { transports: ['websocket'], auth: { token: TOKEN } });
const pending = new Map(); // url -> t0

socket.on('connect', () => {
  console.log(`[${ts()}] connected ${socket.id}`);
  socket.emit('subscribe', { channel: `context:${contextId}` }, (ack) =>
    console.log(`[${ts()}] subscribe ack:`, JSON.stringify(ack)));
});

socket.onAny((event, payload) => {
  const line = `[${ts()}] ${event} ${short(payload)}`;
  console.log(line);
  if (event.includes('url') && payload?.url && pending.has(payload.url)) {
    const dt = performance.now() - pending.get(payload.url);
    pending.delete(payload.url);
    console.log(`>>> switch -> event latency: ${dt.toFixed(0)} ms (${payload.url})`);
  }
});

socket.on('connect_error', (e) => console.error(`[${ts()}] connect_error`, e.message));
socket.on('disconnect', (r) => console.log(`[${ts()}] disconnected: ${r}`));

function ts() { return new Date().toISOString().slice(11, 23); }
function short(o) { const s = JSON.stringify(o) ?? ''; return s.length > 220 ? s.slice(0, 220) + '…' : s; }

async function setUrl(url) {
  pending.set(url, performance.now());
  const res = await fetch(`${BASE}/rest/v2/contexts/${encodeURIComponent(contextId)}/url`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) console.error(`POST /url ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

if (urlA && urlB) {
  setTimeout(async () => {
    for (let i = 0; i < rounds; i++) {
      const url = i % 2 === 0 ? urlA : urlB;
      console.log(`[${ts()}] --- round ${i + 1}/${rounds}: switching to ${url}`);
      await setUrl(url);
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log('done; staying connected as sniffer (ctrl-c to exit)');
  }, 1500);
}
