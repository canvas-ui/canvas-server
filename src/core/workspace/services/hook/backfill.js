// Discover the same subtree a rule's segment-bounded path matcher accepts.
// Directory membership is node-exact unless recursive is explicitly requested.
export async function discoverBackfillDocuments(workspace, { paths = [], schemas = [], limit = 100, offset = 0 } = {}) {
    const selectors = paths.length ? paths.map((raw) => {
        const value = String(raw || '');
        const qualifier = value.match(/^([A-Za-z][\w-]*):(?=\/|$)/);
        const tree = qualifier ? (({ ctx: 'context', dir: 'directory' })[qualifier[1]] || qualifier[1]) : 'context';
        const path = (qualifier ? value.slice(qualifier[0].length) : value) || '/';
        return tree === 'context' ? { context: path } : { directory: { tree, path, recursive: true } };
    }) : [{}];
    const featureSets = schemas.length ? schemas.map((key) => [key]) : [null];
    const single = selectors.length * featureSets.length === 1;
    const seen = new Map();
    for (const selector of selectors) {
        for (const features of featureSets) {
            const batch = await workspace.list({
                ...selector, ...(features ? { features } : {}),
                applyCanvasQuerySpec: false, order: 'asc',
                limit: single ? limit + 1 : offset + limit + 1,
                offset: single ? offset : 0,
            });
            if (batch?.error) throw new Error(String(batch.error));
            for (const doc of (Array.isArray(batch) ? batch : batch?.data || [])) {
                if (doc?.id != null) seen.set(doc.id, doc);
            }
        }
    }
    const ordered = [...seen.values()].sort((a, b) => a.id - b.id);
    const page = single ? ordered : ordered.slice(offset);
    return { docs: page.slice(0, limit), nextOffset: page.length > limit ? offset + limit : null };
}
