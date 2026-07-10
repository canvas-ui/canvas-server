// Example (disabled), stage 2 of 2: image files landing in /to-sort get
// categorized by a vision-capable agent (e.g. a qwen-VL backed agent) into
// your existing tree paths — interior shots to /home/interior-ideas, recipes
// to /cooking, and so on. Pairs with example-pinterest-downloader.js (stage 1)
// but works for any image inserted into /to-sort. Enable by renaming to
// `image-categorizer.js`; set AGENT to a vision-capable agent bound to this
// workspace so its canvas_* tools can fetch the image and link documents.

const AGENT = 'vision';
const FALLBACK_PATH = '/to-sort/unsure';

// One agent run per sync burst, not one per image.
export const debounce = 3000;

// Stage 1 (pinterest-downloader) inserts the files with origin:'hook' — this
// hook must opt into automation-caused events to see them. The maxDepth
// ceiling still bounds the chain.
export const cascade = true;

export default async function hook({ payloads, classify, workspace, agent, logger }) {
  const ids = payloads
    .filter((p) => {
      const c = classify(p);
      return c.isFile() && c.isImage() && c.inPath('/to-sort');
    })
    .flatMap((p) => (p?.document?.id != null ? [p.document.id] : []));
  if (ids.length === 0) { return; }

  const treePaths = (await workspace.listTrees?.('context'))?.map((t) => t.path) || [];

  const reply = await agent(AGENT,
    `${ids.length} new image(s) landed in /to-sort (document ids: ${ids.join(', ')}).\n` +
    `Existing context paths:\n${treePaths.join('\n')}\n\n` +
    `For each image: look at it, pick the best-fitting existing path and link ` +
    `the document there, then remove it from /to-sort. If nothing fits, link it ` +
    `to ${FALLBACK_PATH} instead. Reply with one line per image: id -> path.`,
  );

  logger.debug(`image-categorizer: ${AGENT} handled ${ids.length} image(s): ${reply?.slice(0, 120) || 'no reply'}`);
}
