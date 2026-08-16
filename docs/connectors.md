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
/teams/<address>/<team>/<channel>      msgs    → data/schema/message  (data.platform: 'teams')
```

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

Write-back verbs (close issue, RSVP, post message), webhook/event push, GH issue
comments as child docs, Slack threads expansion, remote-deletion propagation,
WhatsApp (device-side concern — canvas-edge, not a server connector).
