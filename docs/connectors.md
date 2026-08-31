# Connectors — GitHub / Slack / Google Calendar / MS Teams

Status: v2 (2026-08-31). Read-only mirrors by default; write-back is wired
into the ordinary document lifecycle for backends that opt in.

## Adding a connector

Two steps, and nothing else in the codebase changes:

1. `services/connectors/drivers/<name>/index.js` — a class extending
   `BaseConnector` that declares its statics and implements the inbound verbs.
2. add the class to the array in `services/connectors/drivers/index.js`.

```
services/connectors/
  BaseConnector.js     the contract + capability/secret/form declarations
  drivers/index.js     the registration list
  registry.js          derives driver keys, provenance schemes, secret keys
                       and the settings form spec from the classes' statics
  ConnectorIndex.js    driver-agnostic runtime: poll loop, cursors, backoff,
                       ingest, deletion-sync, write-back dispatch
  drivers/<name>/      one folder per driver
```

The registry is the single source of truth: `CONNECTOR_DRIVERS`,
`CONNECTOR_SCHEMES`, redaction and `GET /workspaces/:id/backends/drivers`
(the settings-UI catalogue: label, icon, capabilities, config fields) all come
off the driver class. A new driver reaches the API and the UI without a second
edit anywhere.

Statics a driver declares: `driver`, `label`, `icon`, `blurb`,
`provenanceScheme`, `configFields` (with `secret: true` where applicable) and
`supports = { prune, create, update, delete }`. Every verb a driver does not
opt into gets BaseConnector's `ConnectorNotSupportedError`, so nothing has to
duck-type methods.

## Model

Same contract as the IMAP mail service: **bytes/state live outside Canvas — we
index and sync only.** Every connector is a *backend* in `config/stored.json`
(`backends` map, keyed `<driver>:<address>`), surfaced through the unified
`/workspaces/:id/backends/:driver` facade and mirrored into the backends tree
under the anchor-first grammar:

```
/github/<address>/<owner>/<repo>       issues  → data/schema/task
/slack/<address>/<channel>             msgs    → data/schema/message  (data.platform: 'slack')
/gcal/<address>/<calendar>             events  → data/schema/event/calendar
/caldav/<address>/<calendar>           events  → data/schema/event/calendar
/teams/<address>/<team>/<channel>      msgs    → data/schema/message  (data.platform: 'teams')
```

**Write-back (readOnly: false):** connectors are read-only mirrors by
default; flipping `readOnly: false` enables managing the remote FROM Canvas.
The remote operation always runs FIRST; the driver's returned mirror
re-ingests through the normal pipeline (same identity checksum → upsert), so
Canvas reflects the remote's post-operation state.

Updates need no special route: **an ordinary document update writes through to
the source.** `Workspace.put`/`putMany` check whether the document being
updated carries a connector provenance location on a backend that can write,
and if so send the change to the driver instead of the local mirror (see
`#connectorWriteThrough`). That is what makes editing a synced task reach
GitHub from every surface — webui, REST, agent tools, FUSE — rather than only
from a connector-specific call. Explicit creation and deletion still go
through the backends facade: POST / DELETE on
`/backends/:driver/:address/…/documents` (deleting a Canvas document does NOT
delete the remote; that stays a deliberate act).

Two rules make the fall-through safe:

- A read-only (or unresolvable) backend falls through to a plain local write,
  exactly as before — but the document keeps its **identity checksum**
  (sha256 of the provenance URL). Without that re-stamping, a local edit
  replaces it with a content checksum, the next sync no longer recognises the
  document, and the mirror **forks into a duplicate**. The local edit then
  simply loses to the source at the next poll, which is the honest outcome for
  something the user cannot write to.
- Once the write-through path is taken, a driver error propagates. An edit
  that silently landed only locally is worse than a visible failure.

Per driver:

- **github** (needs a PAT with repo scope): create issue from a task payload;
  update maps task status → issue state (completed → closed, cancelled →
  closed/not_planned, else open) plus title/description/labels; **delete
  closes as not_planned** — GitHub's REST API cannot delete issues, so the
  local mirror stays as the archive (status: cancelled).
- **caldav**: create VEVENT (`If-None-Match: *`, never overwrites); delete
  resolves the resource by UID (resource name ≠ UID) and DELETEs it — the
  local mirror is dropped too.

The `caldav` driver talks to ANY RFC 4791 endpoint (GroupOffice, Nextcloud,
Radicale, SOGo, …): config `url` (calendar home or one collection), basic
auth, optional calendar list, and `readOnly` (default **true**). With
`readOnly: false` the backend supports **write-back**: `POST
/backends/caldav/<addr>/containers/<calendar>/documents` creates the VEVENT
remotely first (`If-None-Match: *`, never overwrites), then mirrors it into
the index — so an event-creation UI can offer "which calendar?" from the
containers listing (each carries `writable`). Sync uses RFC 6578
sync-collection tokens (fallback: windowed calendar-query; upsert identity
makes re-runs harmless). Recurring series stay as RRULE masters — synapsd
≥3.4 expands them into multi-position `events` timelines.

`<address>` is a user-chosen account label (defaults: github owner, slack team,
google account email, MS tenant) — it names the auth scope, like an imap
account.

## Document contract

Every synced document carries:

- **`locations`** — `[{url: <provenance>, metadata: {provenance: true}}, {url: <https permalink>}]`.
  Provenance schemes: `gh://owner/repo/issues/N`, `slack://team/channel/ts`,
  `gcal://calendarId/eventId`, `msteams://teamId/channelId/messageId`.
- **`checksumArray: ['sha256/<sha256(provenanceUrl)>']`** — the *identity
  checksum*. Remote objects are MUTABLE (unlike email raw bytes), so identity
  must be the remote id, not the content hash. synapsd's insert dedups by
  primary checksum and *preserves an explicitly supplied checksumArray on
  update*, so a re-sync of a changed issue/event/message **upserts** the same
  document instead of duplicating it — with zero side-car state.
- **`metadata.source`** = driver, **`metadata.remoteId`**, `metadata.remoteUpdatedAt`.
- Filed **only** into the backends tree (`context: null` + directory selector),
  exactly like imap.

## Sync

Poll-based (no inbound webhooks — outbound HTTPS to fixed API hosts only, per
the attack-surface stance). Per-backend poll loop with error backoff; cursors
persisted per container in the backend's stored.json entry
(`cursors: {<containerId>: <cursor>}`) only after a successful put — a failed
index never advances the cursor (imap contract).

| driver | cursor                       | initial sync                  |
|--------|------------------------------|-------------------------------|
| github | max `updated_at` (ISO)       | `since` epoch → full history  |
| slack  | latest message `ts`          | `initialSyncDays` window      |
| gcal   | `nextSyncToken` (410 → full) | `timeMin = now - initialSyncDays` |
| caldav | DAV sync-token (reject → full) | `initialSyncDays` calendar-query |
| teams  | max `lastModifiedDateTime`   | `initialSyncDays` window      |

All drivers use plain `fetch` — no new SDK dependencies.

## Auth (per backend config)

- **github**: `token` (PAT, optional — public repos sync unauthenticated at 60 req/h).
- **slack**: `token` (bot `xoxb-`/user `xoxp-`; scopes `channels:history`,
  `channels:read`, plus `groups:*` for private channels).
- **gcal**: `clientId`, `clientSecret`, `refreshToken` (offline-access OAuth app;
  refresh-token grant, access token cached until expiry).
- **teams**: `tenantId`, `clientId`, `clientSecret` (app-only client-credentials
  grant against `graph.microsoft.com/.default`; needs admin-consented
  `ChannelMessage.Read.All`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`).

## Deletion / destroy

Connector locations are **not deletable** in v1 — Destroy degrades to a
reference drop (same policy as read-only backends).

**Source → Canvas deletion-sync (`pruneRemoved: true`, opt-in per backend).**
After each clean container sync, drivers that can FULLY traverse the source
(`listIdentities(container)` → every current provenance URL; github so far)
compare that listing against the indexed mirror. Docs whose remote object is
gone are handed to the stored index's orphan-not-delete machinery
(`reconcileRemovedLocations`): locations dropped, backends-mirror paths
unticked, empty locations + `orphanedAt` stamped (which is what ticks
`feature/orphaned`) — curated placements
survive, and the doc is purged later by orphan retention GC (Settings >
Database). Guard rails: any traversal error skips the prune (a partial
listing must never masquerade as complete); only docs whose identity checksum
derives from their provenance URL are touched; an empty source listing
against a non-empty mirror is refused.

## Field mapping highlights

- **GitHub issue → Task**: `state: closed` → `completed`
  (`state_reason: not_planned` → `cancelled`), open+assignees → `in-progress`,
  else `pending`; `milestone.due_on` → `dueDate`; `closed_at` → `completedAt`;
  labels/repo/number/author/htmlUrl pass through in `data`. PRs are skipped.
- **GCal event → Event**: schema `data/schema/event/calendar`; `start.dateTime|date` → `start`
  (all-day dates become `T00:00:00Z` + `allDay: true`); first `RRULE:` line →
  `data.recurrence` (envelope model — synapsd never expands series);
  `status: cancelled` instances are skipped.
- **Slack / Teams message → Message**: text, sender, channel, platform,
  timestamp, threadId/replyCount, reactions/mentions — matching the Message
  schema's checksumFields, but identity still comes from the provenance URL.

## Not covered yet (deliberate)

Write-back for slack/gcal/teams (post message, RSVP), webhook/event push, GH issue
comments as child docs, Slack threads expansion, deletion-sync for
slack/gcal/caldav/teams (needs per-driver `listIdentities`; github shipped),
WhatsApp (device-side concern — canvas-edge, not a server connector).

Also still open on the GitHub driver specifically:

- **Projects v2 status columns.** `status` maps onto open/closed +
  `state_reason` only; a board column is a Projects v2 field and needs the
  GraphQL API.
- **Assignees, milestone and due date are read-in, never written back** — the
  update patch carries title/description/status/labels.
- **No conflict detection.** The cursor is the remote `updated_at`, so a
  remote edit made between two local ones overwrites without a signal. Last
  write wins, quietly.
- **caldav has no `updateDocument`** — create and delete only, so editing a
  synced event falls through to a local write.
