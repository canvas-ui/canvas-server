// Example (disabled): when an arXiv paper link is indexed, ask an agent to
// summarize it and store the summary as a note on the same context path(s) as
// the paper. Enable by renaming to `arxiv-summarizer.js` and make sure the
// agent below exists and is bound to this workspace.

const AGENT = 'assistant';

export default async function hook({ classify, payload, agent, insert, logger }) {
  const c = classify();
  if (!c.isLink() || !c.isArxiv()) { return; }

  const title = payload?.document?.data?.title || c.url;
  const summary = await agent(AGENT,
    `Summarize the arXiv paper at ${c.url} (title: "${title}").\n` +
    `Cover: the problem, the approach, key results, and why it matters.\n` +
    `Reply with markdown only, no preamble.`,
  );
  if (!summary) {
    logger.debug('arxiv-summarizer: agent unavailable or failed, skipping');
    return;
  }

  // Store the summary as a note next to the paper. The note carries no URL,
  // so it can never re-trigger this hook.
  const contextPaths = payload?.context?.paths ?? payload?.context?.path ?? '/';
  const note = await insert({
    schema: 'data/abstraction/note',
    data: {
      title: `Summary: ${title}`,
      content: `# Summary: ${title}\n\nSource: ${c.url}\n\n${summary}`,
    },
  }, { context: contextPaths });

  logger.debug(`arxiv-summarizer: note ${note?.id ?? '?'} created for ${c.url}`);
}
