// Example (disabled): when tabs are synced into /to-sort, hand the batch to an
// agent to file them away. `debounce` coalesces a burst of singleton inserts
// into one run, so the agent is prompted once per sync, not once per tab.
//
// Enable by renaming to `to-sort-categorizer.js` (or toggle it in the webui),
// and make sure you have an agent named 'lucy'.

export const debounce = 3000;

function landedInToSort(payload) {
  const ctx = payload?.context;
  const paths = ctx?.paths || (ctx?.path ? [ctx.path] : []);
  return paths.some((p) => String(p).startsWith('/to-sort'));
}

export default async function hook({ payloads, workspace, agent, logger }) {
  const ids = payloads
    .filter(landedInToSort)
    .flatMap((p) => p?.ids || (p?.id != null ? [p.id] : []));
  if (ids.length === 0) { return; }

  const treePaths = (await workspace.listTrees?.('context'))?.map((t) => t.path) || [];

  const reply = await agent('lucy',
    `${ids.length} new tab(s) landed in /to-sort (ids: ${ids.join(', ')}).\n` +
    `Existing context paths:\n${treePaths.join('\n')}\n\n` +
    `Categorize each tab, link it to the best path, and remove it from /to-sort.`,
  );

  logger.debug(`to-sort-categorizer: lucy handled ${ids.length} tab(s): ${reply?.slice(0, 120) || 'no reply'}`);
}
