import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Example (disabled): files dropped into the workspace land in the `/.backends`
// directory tree ("/.incoming" in older builds). If a file has a sidecar
// `.<name>.metadata.json` (hidden, so it is not auto-indexed) listing target
// paths, link the file to those virtual paths and remove the sidecar. Pairs
// with any downloader hook that writes the sidecar (youtube, image-url,
// pinterest) — enable this one alongside them by renaming to
// `incoming-metadata-linker.js`.

function locationFilePath(doc) {
    for (const loc of doc?.locations || []) {
        const url = typeof loc === 'string' ? loc : loc?.url;
        if (url && url.startsWith('file://')) {
            try { return fileURLToPath(url); } catch { /* ignore */ }
        }
    }
    return null;
}

function incomingPaths(payload) {
    const dir = payload?.directory;
    if (!dir) { return []; }
    if (Array.isArray(dir.paths)) { return dir.paths; }
    if (dir.path) { return [dir.path]; }
    return [];
}

export default async function run({ payload, workspace, get, logger }) {
    // Match both roots: workspaces seeded before the /.backends rename keep this
    // hook file, and old ones may still emit /.incoming paths mid-migration.
    const landedInBackends = incomingPaths(payload)
        .some((p) => String(p).includes('/.backends') || String(p).includes('/.incoming'));
    if (!landedInBackends) { return; }

    const ids = payload?.ids || (payload?.id != null ? [payload.id] : []);
    for (const id of ids) {
        try {
            const doc = await get(id, { parse: true });
            const realPath = locationFilePath(doc);
            if (!realPath) { continue; }

            const metaPath = path.join(path.dirname(realPath), `.${path.basename(realPath)}.metadata.json`);
            let meta;
            try {
                meta = JSON.parse(await readFile(metaPath, 'utf8'));
            } catch {
                continue; // no sidecar for this file
            }

            const targetPaths = Array.isArray(meta?.paths) ? meta.paths.filter(Boolean) : [];
            for (const targetPath of targetPaths) {
                await workspace.link(id, {
                    context: workspace.getContextTreeSelector(targetPath),
                    emitEvent: true,
                });
            }

            await rm(metaPath, { force: true });
            logger.debug(`incoming-metadata-linker: linked doc ${id} to ${targetPaths.length} path(s)`);
        } catch (err) {
            logger.debug(`incoming-metadata-linker: ${err.message}`);
        }
    }
}
