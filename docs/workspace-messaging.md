# Workspace messaging

Canvas offers one workspace API for text messages and replies, with SMTP, Slack
and personal WhatsApp adapters. The document viewer has a **Reply** action; the
workspace header has **Message** for a new conversation. Drafts persist on the
current browser/device. Sending requires connectivity and an explicit Send;
reconnecting does not automatically deliver drafts.

## Email / IMAP

Edit the account in workspace settings and enable **SMTP sending**. IMAP reads
mail; SMTP sends it. Supply SMTP host, port, authentication and From identity.
Port 587 requires STARTTLS; implicit TLS normally uses port 465. SMTP credentials
are separate from IMAP credentials. Leaving an existing password blank preserves
it. The SMTP server must permit the configured From identity.

Replies preserve Message-ID, In-Reply-To and References. Reply all excludes the
configured sender address and does not inherit Bcc. Explicit Bcc recipients are
used only in the SMTP envelope, never in the transmitted or archived MIME.

Accepted messages are indexed locally under the account's Sent folder. Enable
**Save a copy in the IMAP Sent folder** only when the provider does not already
save sent mail. Sent-folder append or local-index errors appear as warnings;
they must not cause another delivery attempt. Incoming Sent copies with added
provider headers retain the outgoing document ID when account, Message-ID and
message content match. Subscribe to the provider's Sent folder to synchronize
its server copy.

## Slack

In workspace settings, add or edit the Slack connector and provide the installed
app's bot/user token. Select the conversation names or IDs the connector should
read and send into. Enable **Allow sending from Canvas**.

Typical scopes: `channels:read`, `channels:history`, `groups:read`,
`groups:history`, and `chat:write`. Invite the app to the relevant channels.
Optional **Include direct messages** additionally needs `im:read`, `im:history`,
`mpim:read`, and `mpim:history`. Access also depends on the token type and Slack's
conversation permissions. Sending uses the token's identity, usually the app's
bot. It does not impersonate the current Canvas user.

Replies use the original Slack thread root. Sending is restricted to configured
conversations. Incoming history uses the existing polling connector: replies on
older roots can be missed by incremental history polling, and large history
backfills remain limited by its existing pagination behavior. This release does
not add Slack Events API subscriptions.

## WhatsApp (Baileys linked device)

Add a **WhatsApp (linked device)** connector, assign an account label, and save.
Open its pairing/status panel; scan the QR using WhatsApp's Linked devices menu.
The panel lists discovered conversation IDs. Copy the desired IDs into the
connector's conversation list, save, and enable sending if wanted. **Pair again**
resets the local session and starts a new QR pairing. Disabled/removed connectors
stop their socket; disconnects otherwise reconnect with backoff.

This is a personal linked-device connector using pinned Baileys 7.0.0-rc14,
separate from the existing WhatsApp Business notification adapter. Credentials
and Signal keys are stored atomically under the workspace's `var/whatsapp`
directory with restricted permissions, outside API-visible account config.
Only user administrators can access pairing or alter messaging accounts.

Selected chats are indexed from live events and history delivered by the linked
device. This is not a complete historical archive: messages received before a
chat was selected are not automatically replayed. Text, media captions and
document filenames are indexed; media bytes, reactions, edits and deletions are
not synchronized in this first version. Outgoing messages are text-only; replies
quote the locally retained original message. Pairing and live interoperability
need validation against the deployed account and WhatsApp client.

## API and agents

All endpoints are under `/rest/v2/workspaces/:id/messages`:

- `GET /accounts`: discover accounts and sending/agent permissions.
- `GET /reply-target/:docId`: resolve account and email reply recipients.
- `POST /send`: send text or reply to an existing message document.
- `GET /outbox/:requestId`: inspect your own previous attempt without delivery.
- `GET /whatsapp/:address/connection`: administrator pairing/status.
- `DELETE /whatsapp/:address/connection`: administrator session reset.

New email request:

```json
{
  "requestId": "db4ad024-c59c-4249-972f-b2a978e69a44",
  "driver": "imap",
  "address": "me@example.org",
  "to": ["recipient@example.org"],
  "subject": "Follow-up",
  "text": "Hello from Canvas"
}
```

For a new Slack/WhatsApp message, use the respective driver, account label and
`target` conversation name/ID instead of email recipients/subject. For a reply,
send `requestId`, `replyToDocumentId` and `text`; Canvas resolves account and
thread. Email also supports `replyAll`, `to`, `cc` and `bcc`.

Sending requires workspace write access and the account's sending opt-in.
Agents additionally require **Allow agents with workspace write access to send**.
Path-bound agents may reply only to documents visible in their context scope.
Workspace/document share tokens cannot send, inspect outbox receipts, change
messaging account configuration or pair devices. Workspace members with write
access can send using enabled account identities; configuration is admin-only.

Agent tools: `canvas_message_accounts`, `canvas_send_message`,
`canvas_message_status`. The send tool instructs agents to obtain user
authorization for external communication; account opt-in is not per-message
human approval enforcement.

Use a stable, unique requestId for each intended send. Reusing it with unchanged
content cannot invoke delivery again after the durable send reservation. A
provider timeout/crash leaves `unknown`; check the actual conversation before
starting another send. This is a duplicate-send fence, not an automatic retry
queue or an exactly-once delivery guarantee. `accepted` means provider acceptance,
not recipient delivery. SMTP can report partial acceptance with `rejected`
recipients. Unknown results deliberately remain unresolved until checked by a
person/agent; there is no background receipt reconciliation yet.

## Validation

Automated tests cover RFC reply addressing/thread headers, Bcc isolation, SMTP
TLS options and partial acceptance, concurrent/idempotent sends, uncertain
results, token permissions, sent-copy reconciliation, Slack thread routing,
WhatsApp quoted replies and persisted Signal keys. Provider delivery is mocked;
no automated test sends messages to real recipients.
