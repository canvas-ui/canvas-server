#!/usr/bin/env node
// End-to-end check of the device-mirror protocol (docs/sync-protocol.md) against a
// running hub. Creates/uses a workspace named `synctest`; needs the admin password
// of that instance. Usage:
//   HUB=http://127.0.0.1:8109 ADMIN_PASSWORD=... node scripts/sync-e2e.mjs
// Do not point it at a production hub — it writes files and registers a device.

import { writeFileSync } from 'node:fs';
import path from 'node:path';

const H = process.env.HUB || 'http://127.0.0.1:8109';
const results = [];
const ok = (name, cond, detail = '') => { results.push([cond ? 'PASS' : 'FAIL', name, detail]); if (!cond) console.error('FAIL', name, detail); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, { token, body, headers = {}, raw = false } = {}) {
    const res = await fetch(H + p, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* raw */ }
    return { status: res.status, json, text, headers: res.headers };
}

const ping = await call('GET', '/rest/v2/ping');
ok('ping instanceId', typeof ping.json?.payload?.instanceId === 'string', ping.json?.payload?.instanceId);

const login = await call('POST', '/rest/v2/auth/login', { body: { email: 'admin@canvas.local', password: process.env.ADMIN_PASSWORD || 'C_7EcL&D4J@p', strategy: 'auto' } });
const T = login.json?.payload?.token || login.json?.payload?.accessToken;
ok('login', !!T, login.status + ' ' + (T ? '' : login.text.slice(0, 200)));

const WS = 'synctest';
const created = await call('POST', '/rest/v2/workspaces', { token: T, body: { name: WS, layout: 'home' } });
ok('create workspace', [200, 201].includes(created.status), `${created.status}`);
const started = await call('POST', `/rest/v2/workspaces/${WS}/start`, { token: T });
ok('start workspace', started.status < 300, `${started.status}`);
const info = await call('GET', `/rest/v2/workspaces/${WS}`, { token: T });
const rootPath = info.json?.payload?.workspace?.rootPath || info.json?.payload?.rootPath;
ok('workspace rootPath', !!rootPath, rootPath);

const B = `/rest/v2/workspaces/${WS}/backends/file/workspace%3Ahome`;
const put1 = await call('PUT', `${B}/objects/UI/a.txt`, { token: T, raw: true, body: 'alpha', headers: { 'content-type': 'text/plain', 'if-none-match': '*', 'x-canvas-origin': 'dev1', 'x-canvas-mtime': '1700000000000' } });
ok('PUT new → 201', put1.status === 201, `${put1.status} ${put1.text.slice(0, 160)}`);
const sha1 = put1.json?.payload?.sha256;
ok('PUT returns sha256 + docId + seq', !!sha1 && put1.json.payload.docId != null && put1.json.payload.seq >= 1, JSON.stringify(put1.json?.payload));

const feed1 = await call('GET', `${B}/changes?since=0`, { token: T });
const entryA = (feed1.json?.payload?.changes || []).find((c) => c.key === 'UI/a.txt');
ok('changes lists put with origin', entryA?.op === 'put' && entryA?.origin === 'dev1' && entryA?.sha256 === sha1, JSON.stringify(entryA));

const put412 = await call('PUT', `${B}/objects/UI/a.txt`, { token: T, raw: true, body: 'beta', headers: { 'if-match': '"' + 'ff'.repeat(32) + '"' } });
ok('PUT stale If-Match → 412 with current', put412.status === 412 && put412.json?.code === 'PRECONDITION_FAILED' && put412.json?.payload?.current?.sha256 === sha1, `${put412.status} ${put412.text.slice(0, 160)}`);
const put2 = await call('PUT', `${B}/objects/UI/a.txt`, { token: T, raw: true, body: 'beta', headers: { 'if-match': `"${sha1}"`, 'x-canvas-origin': 'dev1' } });
ok('PUT edit → 200 with previous', put2.status === 200 && put2.json?.payload?.previous?.sha256 === sha1 && put2.json?.payload?.docId !== put1.json?.payload?.docId, `${put2.status} ${put2.text.slice(0, 160)}`);
const sha2 = put2.json?.payload?.sha256;
const docAfterEdit = put2.json?.payload?.docId;

const head = await call('HEAD', `${B}/objects/UI/a.txt`, { token: T });
ok('HEAD etag + headers', head.status === 200 && head.headers.get('etag') === `"${sha2}"` && head.headers.get('x-canvas-size') === '4', `${head.status} ${head.headers.get('etag')}`);
const range = await call('GET', `${B}/objects/UI/a.txt`, { token: T, headers: { range: 'bytes=1-2' } });
ok('GET Range → 206', range.status === 206 && range.text === 'et' && range.headers.get('content-range') === 'bytes 1-2/4', `${range.status} ${range.text}`);
const nm = await call('GET', `${B}/objects/UI/a.txt`, { token: T, headers: { 'if-none-match': `"${sha2}"` } });
ok('GET If-None-Match → 304', nm.status === 304, `${nm.status}`);

const ren = await call('POST', `${B}/objects/rename`, { token: T, body: { from: 'UI/a.txt', to: 'UI/b.txt', ifMatch: sha2, origin: 'dev1' } });
ok('rename → same doc', ren.status === 200 && ren.json?.payload?.docId === docAfterEdit, `${ren.status} ${ren.text.slice(0, 160)}`);
const feed2 = await call('GET', `${B}/changes?since=${feed1.json?.payload?.head || 0}`, { token: T });
const renEntry = (feed2.json?.payload?.changes || []).find((c) => c.op === 'rename');
ok('changes has rename with from', renEntry?.key === 'UI/b.txt' && renEntry?.from === 'UI/a.txt', JSON.stringify(renEntry));

// A file dropped on the hub's disk reaches the feed through the watcher, without origin.
if (rootPath) {
    writeFileSync(path.join(rootPath, 'dropped.txt'), 'dropped on disk');
    let found = null;
    for (let i = 0; i < 20 && !found; i += 1) {
        await sleep(500);
        const f = await call('GET', `${B}/changes?since=0`, { token: T });
        found = (f.json?.payload?.changes || []).find((c) => c.key === 'dropped.txt');
    }
    ok('on-disk drop → feed entry without origin', !!found && found.op === 'put' && !found.origin, JSON.stringify(found));
}

// Conflict inbox + resolve
const conf = await call('PUT', `${B}/objects/UI/b.txt`, { token: T, raw: true, body: 'device version', headers: { 'x-canvas-conflict-of': 'UI/b.txt', 'x-canvas-origin': 'dev1', 'x-canvas-device-name': 'laptop', 'x-canvas-base-sha256': sha1 } });
ok('conflict PUT → 201 inbox doc', conf.status === 201 && conf.json?.payload?.docId != null && conf.json?.payload?.hubDocId === docAfterEdit, `${conf.status} ${conf.text.slice(0, 200)}`);
const list1 = await call('GET', `/rest/v2/workspaces/${WS}/sync/conflicts`, { token: T });
ok('conflicts listed', list1.status === 200 && list1.json?.payload?.length === 1 && list1.json.payload[0].key === 'UI/b.txt' && list1.json.payload[0].hub?.sha256 === sha2, `${list1.status} ${JSON.stringify(list1.json?.payload?.[0])?.slice(0, 200)}`);
const res = await call('POST', `/rest/v2/workspaces/${WS}/sync/conflicts/${conf.json?.payload?.docId}/resolve`, { token: T, body: { keep: 'both' } });
ok('resolve both → conflict-copy key', res.status === 200 && /^UI\/b \(conflict from laptop \d{4}-\d{2}-\d{2} \d{4}\)\.txt$/.test(res.json?.payload?.resultKey || ''), `${res.status} ${res.text.slice(0, 200)}`);
const list2 = await call('GET', `/rest/v2/workspaces/${WS}/sync/conflicts`, { token: T });
ok('conflicts empty after resolve', list2.json?.payload?.length === 0, `${list2.json?.payload?.length}`);
const copyHead = await call('HEAD', `${B}/objects/${encodeURI(res.json?.payload?.resultKey || 'none')}`, { token: T });
ok('conflict copy readable at its key', copyHead.status === 200, `${copyHead.status}`);

const del = await call('DELETE', `${B}/objects/UI/b.txt`, { token: T, headers: { 'if-match': `"${sha2}"`, 'x-canvas-origin': 'dev1' } });
ok('DELETE → 200', del.status === 200 && del.json?.payload?.docId === docAfterEdit, `${del.status} ${del.text.slice(0, 160)}`);
const gone = await call('HEAD', `${B}/objects/UI/b.txt`, { token: T });
ok('deleted key → 404', gone.status === 404, `${gone.status}`);

// Device status report
const dev = await call('POST', '/rest/v2/auth/devices/register', { token: T, body: { deviceId: 'dev1', name: 'laptop', platform: 'linux', type: 'device' } });
const DT = dev.json?.payload?.token;
ok('device token minted', !!DT, `${dev.status}`);
const st = await call('POST', `/rest/v2/workspaces/${WS}/mirrors/dev1/status`, { token: DT, body: { client: 'fuse', path: '/home/me/Workspaces/synctest', cursor: 1, pending: 2, conflicts: 0, state: 'syncing' } });
ok('mirror status with device token', st.status === 200 && typeof st.json?.payload?.head === 'number', `${st.status} ${st.text.slice(0, 160)}`);
const wrong = await call('POST', `/rest/v2/workspaces/${WS}/mirrors/other/status`, { token: DT, body: { cursor: 1 } });
ok('device may not report for another device', wrong.status === 403, `${wrong.status}`);
const mirrors = await call('GET', `/rest/v2/workspaces/${WS}/mirrors`, { token: T });
ok('mirrors listing with lag', mirrors.status === 200 && mirrors.json?.payload?.[0]?.deviceId === 'dev1' && mirrors.json.payload[0].lag >= 1, `${mirrors.status} ${JSON.stringify(mirrors.json?.payload?.[0])?.slice(0, 200)}`);

const internal = await call('PUT', `${B}/objects/.workspace/x`, { token: T, raw: true, body: 'x' });
ok('.workspace key refused', internal.status === 409 && internal.json?.code === 'KEY_INTERNAL', `${internal.status} ${internal.json?.code}`);
const dot = await call('PUT', `${B}/objects/.hidden/x`, { token: T, raw: true, body: 'x' });
ok('dotfile key refused (excluded)', dot.status === 409 && dot.json?.code === 'KEY_EXCLUDED', `${dot.status} ${dot.json?.code}`);
const trav = await call('PUT', `${B}/objects/%2e%2e/x`, { token: T, raw: true, body: 'x' });
ok('traversal key refused (400 by us or 404 by the router)', trav.status === 400 || trav.status === 404, `${trav.status} ${trav.json?.code}`);
const stale = await call('GET', `${B}/changes?since=0&limit=1`, { token: T });
ok('changes paging cursor', stale.status === 200 && stale.json?.payload?.changes?.length === 1 && stale.json.payload.cursor >= 1, `${stale.status}`);

for (const [s, name, detail] of results) console.log(`${s}  ${name}${s === 'FAIL' ? '  — ' + detail : ''}`);
const fails = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
