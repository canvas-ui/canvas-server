# Connectors — GitHub / Slack / Google Calendar / MS Teams

Status: v1 (2026-08-16). Read-only mirrors; write-back verbs are a later phase.

## Model

Same contract as the IMAP mail service: **bytes/state live outside Canvas — we
index and sync only.** Every connector is a *backend* in `config/stored.json`
(`backends` map, keyed `<driver>:<address>`), surfaced through the unified
`/workspaces/:id/backends/:driver` facade and mirrored into the backends tree
under the anchor-first grammar:

```
/github/<address>/<owner>/<repo>       issues  → data/schema/task
/slack/<address>/<channel>             msgs    → data/schema/message  (data.platform: 'slack')
/gcal/<address>/<calendar>             events  → data/schema/event    (data.type: 'calendar')
/caldav/<address>/<calendar>           events  → data/schema/event    (data.type: 'calendar')
/teams/<address>/<team>/<channel>      msgs    → data/schema/message  (data.platform: 'teams')
```

**Write-back (readOnly: false):** connectors are read-only mirrors by
default; flipping `readOnly: false` enables managing the remote FROM Canvas
through three routes on the backends facade — POST (create) / PATCH (update)
/ DELETE on `/backends/:driver/:address/…/documents`. The remote operation
always runs FIRST; the driver's returned mirror re-ingests through the
normal pipeline (same identity checksum → upsert), so Canvas reflects the
remote's post-operation state. Per driver:

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
reference drop (same policy as read-only backends). Remote deletions are not
propagated locally yet (documents persist as an archive; revisit with
write-back).

## Field mapping highlights

- **GitHub issue → Task**: `state: closed` → `completed`
  (`state_reason: not_planned` → `cancelled`), open+assignees → `in-progress`,
  else `pending`; `milestone.due_on` → `dueDate`; `closed_at` → `completedAt`;
  labels/repo/number/author/htmlUrl pass through in `data`. PRs are skipped.
- **GCal event → Event**: `type: 'calendar'`; `start.dateTime|date` → `start`
  (all-day dates become `T00:00:00Z` + `allDay: true`); first `RRULE:` line →
  `data.recurrence` (envelope model — synapsd never expands series);
  `status: cancelled` instances are skipped.
- **Slack / Teams message → Message**: text, sender, channel, platform,
  timestamp, threadId/replyCount, reactions/mentions — matching the Message
  schema's checksumFields, but identity still comes from the provenance URL.

## Not in v1 (deliberate)

Write-back for slack/gcal/teams (post message, RSVP), webhook/event push, GH issue
comments as child docs, Slack threads expansion, remote-deletion propagation,
WhatsApp (device-side concern — canvas-edge, not a server connector).
