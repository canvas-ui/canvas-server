# Workspace Hooks

Workspace hooks are the automation layer of a workspace: declarative reactions to workspace events that run scripts, invoke agents, or apply built-in metadata operations. The design follows the conventions of mature hook systems (webhooks, git hooks, sieve mail filters, CI matchers) rather than inventing new semantics.

## Design principles

- **Two mechanisms, not one.** Cheap metadata routing (link, tag, move) is a different problem from arbitrary automation (shell scripts, agents). Mail systems learned this decades ago: sieve rules vs. procmail scripts. We split accordingly into **routing rules** (declarative, inline, built-in actions only) and **hooks** (async, post-commit, arbitrary execution). Conflating them forces the worst constraints of both onto each.
- **Events are facts, not commands.** Hooks consume the workspace event bus; the same bus feeds context-bound apps (browser extension, Obsidian sync). One pub/sub substrate, multiple consumer classes.
- **Declarative matchers first, code as escape hatch.** 90% of matching is "schema is X, path under Y, field matches Z" — expressible as data, testable, introspectable. A JS predicate escape hatch exists for the rest but is not the primary interface.
- **Every automated write is attributable.** All hook- and rule-originated mutations carry provenance. This is what makes loop prevention, replay, and debugging possible.
- Hidden files (dotfiles) are never auto-indexed/auto-processed and therefore never generate ingest events, regardless of location. Unchanged from before.

## Event model

Event names follow the `noun.verb` past-tense webhook convention(with their .batch versions):

```
document.inserted
document.updated
document.removed
document.linked        # gained a context path
document.unlinked
document.tagged
context.changed        # workspace context url (focus) moved — consumed by apps, rarely by hooks
workspace.mounted
```

Every event is a JSON envelope, delivered to exec hooks on stdin (env vars carry only `CANVAS_EVENT_ID`, `CANVAS_WORKSPACE`, `CANVAS_EVENT`):

```json
{
  "event": "document.inserted",
  "eventId": "evt_01J...",
  "ts": 1752134400123,
  "workspace": "universe",
  "documentId": 48213,
  "schema": "data/abstraction/tab",
  "paths": ["/to-sort"],
  "document": { "...": "full or truncated doc per hook config" },
  "provenance": {
    "origin": "user",          // user | rule | hook | agent
    "causedBy": null,          // eventId chain for automated writes
    "depth": 0                 // cascade depth
  }
}
```

`eventId` is the idempotency key. Delivery is at-least-once; hook implementations must tolerate redelivery (the runtime dedupes retries by `eventId` + hook id, but exec scripts that write outside the workspace should check it themselves).

## Routing rules (inline, declarative)

Rules run synchronously at ingest, before or immediately after commit (implementation detail; semantically atomic with the insert). They may only perform metadata operations: `link`, `unlink`, `tag`, `route` (link + remove from source path), `setField`. No exec, no agents, no network. Budget: sub-millisecond, pure functions of the document.

toml or json or yaml - whatever is the most practical more industry standard-ish

```toml
# rules.toml

[[rule]]
id = "dc-migration-mail"
match = { schema = "data/abstraction/email", "from" = "foo@bar.baz", "subject" = "~ DC Migration" }
actions = [{ link = "/projects/dc-migration" }]

[[rule]]
id = "baf-mail"
match = { schema = "data/abstraction/email", "from" = "bar@baf.baz" }
actions = [
  { link = "/path/to-read" },
  { link = "/path/something/else" },
  { tag  = "custom/tag/urgent" }
]
```

Matcher grammar: exact match by default, `~` prefix for regex, `>`/`<`/ranges for numerics, `kind`/`mime` fields available on every document (see Classification). Rules are evaluated in file order; all matching rules apply (no first-match-wins) unless a rule sets `terminal = true`.

## Hooks (async, post-commit)

Hooks are defined in `hooks/*.toml`, one or more per file. They run from a worker pool after the triggering write has committed.

```toml
[[hook]]
id      = "youtube-fetch"
on      = "document.inserted"
match   = { schema = "data/abstraction/tab", "data.url" = "~ youtube\\.com/watch|youtu\\.be/" }
run     = { exec = "git/scripts/yt-fetch.sh" }
timeout = "15m"
retries = { max = 2, backoff = "1m" }

[[hook]]
id      = "arxiv-summarize"
on      = "document.inserted"
match   = { "data.url" = "~ arxiv\\.org/(abs|pdf)/" }
run     = { agent = "summarizer", prompt = "prompts/arxiv-summary.md" }
budget  = { maxRunsPerHour = 20, maxTokensPerDay = 500000 }

[[hook]]
id      = "categorizer"
on      = "document.inserted"
match   = { path = "/to-sort/**" }
batch   = { window = "30s", maxItems = 200 }
run     = { agent = "categorizer", prompt = "prompts/categorize.md" }
cascade = false   # default; shown for clarity

[[hook]]
id      = "dc-migration-triage"
on      = "document.linked"
match   = { path = "/projects/dc-migration/**", schema = "data/abstraction/email" }
run     = { agent = "triage", prompt = "prompts/notify-if-relevant.md" }
```

### Actions

- `exec` — path relative to WORKSPACE_ROOT, must resolve inside the workspace, executable bit required. Envelope on stdin; exit 0 = success, exit 75 (EX_TEMPFAIL) = retry, anything else = permanent failure. Stdout/stderr captured into the run record.
- `agent` — invokes an agent over the agent protocol (JSON-RPC). The hook runtime mints a capability token scoped to the matched paths (the `PUT /agents/:id/access` flow, one call), passes the envelope plus rendered prompt template. Prompt templates interpolate envelope fields (`{{document.data.url}}`).
- `builtin` — the same action set as rules (`link`, `tag`, `route`, `notify`), for when you want async semantics without a script. `notify` targets: in-app, or an outbound webhook URL (Slack/Teams incoming webhooks cover the messaging cases without bespoke integrations).

### Execution semantics

- **Ordering:** per-hook serial queue by default; `concurrency = N` opt-in. No cross-hook ordering guarantees.
- **Batching:** with `batch` set, the runtime debounces matching events into a window and delivers an array envelope (`events: [...]`). This is mandatory hygiene for anything agent-backed — a browser sync dumping 40 tabs must produce one categorizer run, not 40.
- **Cascade control:** events caused by rule/hook/agent writes carry `provenance.depth + 1` and the `causedBy` chain. Hooks default to `cascade = false`, i.e. they ignore automated-origin events entirely. Setting `cascade = true` opts in, bounded by a global `maxDepth` (default 2). The yt-fetch → insert video → categorizer chain works because categorizer opts into depth-1 events or the video insert is routed via a rule; either way the loop terminates by construction.
- **Failure:** transient failures retry per config with backoff; exhausted retries land in a dead-letter state visible in the run log, optionally firing a `notify`. Failures never block ingest — the document is already committed.
- **Timeouts** are hard kills. Default 60s for exec, 10m for agent.

### Temporary/working storage

Exec hooks that produce artifacts (the yt-dlp case) download to `WORKSPACE_ROOT/var/tmp/<hookId>/<eventId>/` (runtime-provided as `CANVAS_WORK_DIR`, cleaned after success) and insert the result via canvas-cli / the client SDK, which produces a properly attributed `document.inserted` (origin=hook). Inserting through the front door — not writing files into `home/` and hoping the indexer notices — is what keeps provenance and dedup intact. The insert call should create the synapse to the source document (`--link-to <documentId>`) in the same operation.

## Classification

`isText()/isImage()/isPdf()/isLink()` should not exist as runtime methods on either layer. Content-kind detection happens **once, at ingest, in synapsd** — it owns the document and already stores schema; mime sniffing and kind derivation belong next to checksumming. The result is two indexed fields on every document:

- `mime` — sniffed/declared media type
- `kind` — coarse enum: `text | image | audio | video | pdf | link | blob | email | note | tab | ...`

Matchers filter on these fields directly (`match = { kind = "pdf" }`). The workspace layer adds nothing but sugar; if a JS predicate escape hatch ships, `doc.kind === 'image'` is already ergonomic. Single source of truth, indexable via the bitmap layer, zero per-event classification cost.

## Security model

Hook definitions and scripts live in the workspace and therefore **sync across devices**. Executing synced code is the git-hooks security problem, and the answer is the same one VS Code arrived at: per-device workspace trust. A workspace's hooks are inert on a device until the user grants trust there; new or modified `exec` hooks after the grant surface a diff prompt (hash-pinning per script). Additional containment: exec paths must resolve inside WORKSPACE_ROOT (no symlink escape), environment is sanitized to the CANVAS_* set + PATH, and agent hooks are bounded by their capability token scope and budgets rather than trust prompts. On the edge runtime, hooks run only if the workspace's trust grant is replicated to that node explicitly.

## Observability & UX

This is where hook systems live or die. Minimum viable surface:

- **Run log.** Every execution produces a run record (hook id, eventId, duration, status, exit code, stdout/stderr tail, tokens spent for agent runs). `canvas hooks runs [--hook <id>] [--failed] [--tail]`. Stored in a system context path (`/system/hooks/runs`) so it's queryable like everything else.
- **Explain.** `canvas hooks match --document <id>` — which rules and hooks would fire for this document and why (matcher-by-matcher evaluation). Answers "why didn't my hook run" without printf debugging.
- **Test & dry-run.** `canvas hooks test <hookId> --fixture tab.json [--dry-run]`. Dry-run executes matchers and renders the envelope/prompt but skips the action. Fixtures live in `.canvas/hooks/fixtures/`.
- **Replay.** `canvas hooks replay <runId>` — re-deliver the original envelope. The idempotency contract makes this safe.
- **Backfill.** `canvas hooks backfill <hookId> [--query <query>]` — run a hook against existing documents matching its matcher (or a narrower query). "Apply this new email rule to my archive" and "summarize every arxiv paper I already indexed" are the same operation. Batching and budgets apply, which is what makes backfill safe to expose at all.
- **Toggle.** `enabled = false` in config, or `canvas hooks disable <id>` (writes a device-local override, not a workspace edit — you want to mute a noisy hook on your laptop without editing shared state).
- **Recipes.** Ship the obvious ones as commented templates: media fetcher, arxiv summarizer, email router, tab categorizer. The config format above is the documentation.

## Use cases, restated

**#1 Media capture.** Tab insert matches `youtube-fetch` → script downloads to `CANVAS_WORK_DIR` → inserts video via CLI with `--link-to` source tab and path `/to-sort` → depth-1 `document.inserted` → categorizer (batched) files it into the tree, falling back to `/to-sort/unsure` per its prompt/config. Picture URLs and arxiv papers are the same shape with different matchers; arxiv additionally stores the summary as a note synapsed to the paper.

**#2 Email routing + triage.** Routing rules handle the deterministic linking/tagging inline. The triage agent hook on `document.linked` handles the judgment calls ("notify me about foo bar baz, and anything on that Intune TS case") via `notify` — in-app or Slack/Teams webhook.

**#3 Lucy / context-bound agents.** Not a hook. Lucy rides on agent access binding + the context url: `context.changed` events flow over the same bus to context-bound apps, and Lucy's queries are ordinary `query(match, spec)` calls pre-filtered by the current context url through her capability scope. The hook system's only involvement is that hooks and Lucy share the event bus and the agent protocol. Keeping this out of the hook design keeps both simpler.

## Open questions

- Rule execution point: pre-commit (document lands with final paths atomically) vs. post-commit-inline (simpler, but a document can be observed pathless for a tick). Leaning pre-commit since rules are pure and bounded.
  - Answer: Pre-commit

- Run-record storage: documents in `/system/hooks/runs` (uniform, queryable) vs. a dedicated LMDB dbi (cheaper, no schema ceremony). Retention policy needed either way.
  - Answer: Hidden system tree of type directory in the workspace DB, schema refactor should make working with schemas easier + we do need a schema for storing things like ad-hoc commands (local workspace that I want to use as my bash history) or logs(pure gedankenexperiment to stress-test the system)

- Matcher escape hatch: ship JS predicates in v1 or hold until a real matcher-grammar gap appears? Pareto says hold.
  - Answer: Probably already covered

- Whether `context.changed` belongs in the hookable event set at all, or stays app-bus-only until a concrete hook use case shows up.
  - Answer: I"d treat it the same as other events, might get useful

## Approvals: pending actions (design, v1)

> Implementation notes — aligned with the current `src/core/workspace/services/hook/` code
> (JSON rules `when`/`then`, JSONL run log under `var/hooks/`, provenance stamping).

### Concept

Any automation output that needs human sign-off becomes a **pending action**: the
handler runs its matching/reasoning as usual, but instead of executing the final
side effect it *proposes* it. Proposals queue per workspace; the review UI (and
CLI) lists them; approve executes the stored action through the exact same
execution path it would have taken originally (provenance chain preserved,
run-logged as `trigger: 'approval'`), decline archives it, amend edits the
proposed payload before approval.

Two producer surfaces, matching the two handler kinds:

1. **Declarative rules** — `"approval": true` on a rule (whole `then` block held
   as one proposal) or on an individual action (only that action held; the rest
   execute immediately).
2. **JS hooks / agent flows** — `await ctx.propose(action, { title, summary,
   editable })`, where `action` is any rule-action object (`{ action: 'link', ... }`)
   or the dedicated draft type below. This is how the secretary-agent files a
   draft reply for review.

Draft email is the first rich proposal type:

```json
{
  "action": "email.send",
  "account": "imap-mycompany",
  "draft": { "to": ["..."], "subject": "...", "body": "...", "inReplyTo": "<msgid>" },
  "sourceDocumentId": 48213
}
```

`editable` marks which JSON paths the reviewer may amend (e.g. `draft.subject`,
`draft.body`). Non-editable proposals are approve/decline only.

### Record shape & storage

`{WORKSPACE_ROOT}/var/hooks/pending.jsonl` (+ `.1` rotation), same append/query
pattern as `run-log.js`, but records are *mutable in status*: status transitions
append a superseding record with the same `actionId` (last-write-wins on read),
so the file stays append-only and crash-safe.

```json
{
  "actionId": "pa_uuid",
  "ts": "2026-07-19T...",
  "workspace": "universe",
  "status": "pending",            // pending | approved | declined | expired | failed
  "handlerType": "rule|hook",
  "handler": "invoice-router",     // rule id | hook file rel. hooks root
  "event": "document.inserted",
  "envelope": { },                 // replay envelope (doc stripped to id+schema)
  "provenance": { "origin": "rule", "causedBy": "evt_...", "depth": 1 },
  "title": "File invoice + forward to accounting",
  "summary": "email from foo@bar → Accounting/2026/07/received + resend",
  "actions": [ { "action": "link", "paths": ["..."] } ],
  "editable": ["actions.0.draft.subject", "actions.0.draft.body"],
  "decidedAt": null, "decidedBy": null, "amended": false,
  "result": null                   // run-log runId(s) after execution
}
```

Expiry: optional `ttl` per rule (default none); expired proposals surface in
history, never execute. Retention: decided records pruned with rotation.

### Lifecycle & events

- propose → workspace event `action.proposed` (drives UI live update + badge)
- approve → re-hydrate document by id, execute via `executeRuleActions`/
  `runTargeted` with the *stored* provenance (depth/causedBy intact → cascade
  guards keep working), append run-log record `trigger:'approval'`, emit
  `action.approved`; execution failure → status `failed` (re-approvable).
- decline → status update + `action.declined`. Bulk approve/decline = loop.
- amend → validate against `editable` allowlist, then approve.

### API (transport layer, next to existing hooks endpoints)

```
GET    /workspaces/:id/hooks/pending?status=pending&limit=100
GET    /workspaces/:id/hooks/pending/:actionId
POST   /workspaces/:id/hooks/pending/decisions
       { approve: [ "pa_..." | { actionId, amend: { "actions.0.draft.body": "..." } } ],
         decline: [ "pa_..." ] }   # per-entry outcomes; amend allowlisted via `editable`
```

### Review UI (v1 scope)

- Pending-actions screen per workspace: table (checkbox | title/summary |
  handler | event/doc | age), bulk Approve/Decline on selection, per-row
  actions, filter by status/handler.
- Row expand → detail pane: rendered proposal (email draft preview), inline
  editors for `editable` fields, Approve / Decline buttons.
- Live updates via the existing workspace event channel (`action.*` events);
  pending count badge in nav.
- Industry-pattern reference: PR review queues / moderation queues — optimistic
  row removal on decision, undo-toast for decline (grace period before final).

### SMTP side-quest (scoped out of v1 core, tracked)

Extend per-datasource IMAP config with optional SMTP block; `email.send`
proposal type executes through it. Sent-folder note: with a postfix/dovecot
combo the *client* appends to Sent over IMAP (dovecot does not do it for you
unless you run a submission-time sieve/LMTP trick) — so the executor must
APPEND the sent message to the configured Sent mailbox after SMTP accept.

## Feature: Workspace hook review/refine UI

As the deadline of my monthly accounting paperwork is approaching, another needed feature popped-out: we need to extend the current hook/script logic to request approvals for planned actions. This needs to be implemented for both, agentic and "classic-but-deterministic" actions, couple of examples:
- All received emails for invoice@mycompany.tld that contain a PDF should be a) stored in workspace foo at data backend home into path Accounting/YYYY/mm/received and re-sent to the invoice inbox of my accounting firm
- Basic question answering, all emails that came to hi@mycompany.com should first tick my secretary-agent to be categorized (agent runtime will use canvas-cli or MCP to do just that) - for those that can be answered directly, agent would write a draft email that would show up in my pending actions list for review/refine

Review screen design - refine if needed according to industry best practices:

- Table view of all actions
- Tickbox per line
- Action (Approve/Decline/..)
- Click to review or amend in real-time where it makes sense (emails are a good example)
  - Side-quest here, since we already have to configure imap as the data source and already have the backend in-place, we could extend the same per-data-source to configure a SMTP server. Not sure if replies/sent items are moved into Sent by the client or by the server(I always assumed it was server, if it is - postfix/dovecot kombo - then great)
