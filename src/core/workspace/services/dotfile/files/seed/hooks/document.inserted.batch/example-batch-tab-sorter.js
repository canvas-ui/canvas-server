// Example (disabled): handle a whole batch of documents inserted in one go —
// the browser extension syncing N open tabs is the classic case. The batch
// event carries `{ ids, count, context, directory }` (no full documents), so
// fetch each doc with get() and classify(doc) to branch on content.
//
// This example sorts a synced tab batch: YouTube links to /media/youtube,
// arXiv papers to /papers, and (optionally) hands whatever is left in
// /to-sort to an agent — once, for the whole batch, no debounce needed.
// Enable by renaming to `batch-tab-sorter.js`.

const SORT_AGENT = null; // set to an agent slug (e.g. 'lucy') to enable the hand-off

export default async function hook({ payload, classify, get, workspace, agent, logger }) {
  const ids = payload?.ids || [];
  if (ids.length === 0) { return; }

  // Where did the batch land? classify(payload) reads paths off the batch
  // payload's context/directory specs even without a document.
  const landedInToSort = classify(payload).inPath('/to-sort');
  logger.debug(`batch-tab-sorter: ${ids.length} doc(s) inserted${landedInToSort ? ' in /to-sort' : ''}`);

  const leftovers = [];
  for (const id of ids) {
    const doc = await get(id).catch(() => null);
    if (!doc) { continue; }
    const c = classify(doc);

    let targetPath = null;
    if (c.isYoutube()) { targetPath = '/media/youtube'; }
    else if (c.isArxiv()) { targetPath = '/papers'; }

    if (targetPath) {
      await workspace.link(id, {
        context: workspace.getContextTreeSelector(targetPath),
        emitEvent: false,
      });
      logger.debug(`batch-tab-sorter: ${id} -> ${targetPath}`);
    } else {
      leftovers.push(id);
    }
  }

  if (SORT_AGENT && landedInToSort && leftovers.length > 0) {
    const treePaths = (await workspace.listTrees?.('context'))?.map((t) => t.path) || [];
    await agent(SORT_AGENT,
      `${leftovers.length} freshly synced document(s) need sorting (ids: ${leftovers.join(', ')}).\n` +
      `Existing context paths:\n${treePaths.join('\n')}\n\n` +
      `Categorize each one, link it to the best path, and remove it from /to-sort.`,
    );
  }
}
