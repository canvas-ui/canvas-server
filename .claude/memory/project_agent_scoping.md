---
name: project-agent-scoping
description: "Agent pipeline extension — canvas-agent-* tokens, workspace/path/context bindings, canvas tools, messaging service (implemented 2026-07-02)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 87724821-8838-49f1-b9cb-aaf03216ea06
---

Implemented (2026-07-02, dev branch, uncommitted): scoped agent principals + messaging.

**Design decisions:**
- Agent binding stored in `agent.json` top-level `access: { binding: {type: workspace|path|context, workspace, path, context}, permissions: [read|write], tokenHash }`. Unbound agent (no `access`) = legacy behavior, no canvas tools. Enforced scope always resolves to `{workspaceId, basePath}`; context bindings re-resolve LIVE at token verification (follow moved contexts).
- `canvas-agent-*` token: one active per agent, sha256 hash in agents jim index, `#tokenIndex` Map for verification (src/core/agent/lib/AgentTokens.js). Plaintext only in `{agentDir}/runtime/canvas.env` (0600) — the canvas-edge injection contract (CANVAS_URL/TOKEN/AGENT_ID/WORKSPACE/BASE_PATH).
- Agent canvas tools (canvas_find/get/insert/tree/notify, src/core/agent/tools/) call own REST over loopback with agent token — single enforcement path, container-identical for canvas-edge.
- Enforcement: verifyApiToken branch (strategies.js) → resourceToken.type='agent'; agent branch in workspace-acl BEFORE owner check (agent's request.user IS owner!); `enforceAgentBinding` preHandler on all workspace routes clamps paths (src/transports/middleware/agent-acl.js, clampPathToBase: '/' aliases to basePath because route schemas default context to '/'); `rejectAgentTokens` on contexts/admin/roles/role-templates/agents/messaging-bindings routes.
- Messaging service (src/services/messaging/, embedd pattern): console/slack/whatsapp-cloud adapters, notify(userId, msg, {channel}), bindings in jim index 'messaging'. Hook context gained `notify()` next to `agent()`. ChatRouter (router.js): link-code claim flow (`link <code>` DM), peer binding `peer:<channel>:<senderId>` → {userId, agentId}, media→pi images. Slack inbound = Socket Mode (needs SLACK_APP_TOKEN xapp-*), WhatsApp inbound = Cloud webhook /rest/v2/messaging/webhooks/whatsapp (WHATSAPP_VERIFY_TOKEN).
- Canvas skill (runtime/skills/canvas-tools/SKILL.md) server-managed from binding, filtered out of user config on read-back (files.js CANVAS_SKILL_NAME).

**By design (user-confirmed 2026-07-02):** by-id/by-hash doc reads are workspace-wide for path-bound agents — direct document retrieval routes, intentionally not path-clamped. Path clamp applies to list/search/insert/tree-path inputs only.

**Deferred:** tree read returns full workspace tree (tool extracts subtree client-side); speech/WebRTC = future voice adapter on same seam; Baileys WhatsApp variant; per-thread channel sessions; streaming replies to channels; canvas-edge runtime itself; agent autoregistration.

**Env vars:** SLACK_BOT_TOKEN, SLACK_APP_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_VERIFY_TOKEN, CANVAS_MESSAGING_ENABLED.

Related: [[project-mvp-scope]], [[feedback-dev-server]]
