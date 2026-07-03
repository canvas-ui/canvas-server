// Example (disabled): watch incoming emails for a subject marker, ask an agent
// to assess them in context, and push the verdict to you over a messaging
// channel (WhatsApp/Slack — configure via PUT /rest/v2/messaging/bindings).
// Enable by renaming to `ticket-notify.js` and adjusting RULES.

const RULES = [
  {
    // Trigger: email subject contains this marker
    subject: 'MSFT-TICKET-1234',
    // Agent (slug or id) that should assess the hit — bind it to this
    // workspace first (PUT /rest/v2/agents/<agent>/access) so it can use its
    // canvas_* tools to read surrounding context.
    agent: 'assistant',
    // Extra context the agent should consider (workspace path)
    contextPath: '/projects/foo/bar',
    // Where to notify: 'whatsapp' | 'slack' | omit for the user's default
    channel: 'whatsapp',
    prompt: (doc, rule) =>
      `An email just arrived with subject "${doc.data?.subject}" from "${doc.data?.from}".\n` +
      `Given the context information under ${rule.contextPath}, check whether the ticket ` +
      `${rule.subject} finally got resolved. Reply with a short verdict; if it is resolved, ` +
      `start your reply with RESOLVED.`,
  },
];

// Coalesce mail-sync bursts: one run per event burst instead of one per message.
export const debounce = 2000;

export default async function hook({ payloads, agent, notify, logger }) {
  for (const payload of payloads) {
    const doc = payload?.document;
    if (!doc?.id || !doc.schema?.includes('email')) { continue; }

    const subject = String(doc.data?.subject || '');
    for (const rule of RULES) {
      if (!subject.toLowerCase().includes(rule.subject.toLowerCase())) { continue; }

      logger.debug(`ticket-notify: subject hit "${rule.subject}" on doc ${doc.id}`);
      const reply = await agent(rule.agent, rule.prompt(doc, rule));
      if (!reply) {
        logger.debug('ticket-notify: agent unavailable or failed, skipping notify');
        continue;
      }

      await notify(`[canvas] ${rule.subject}: ${reply}`, rule.channel ? { channel: rule.channel } : {});
    }
  }
}
