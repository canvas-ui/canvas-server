// Reference hook: every value the context hands a handler. Disabled by the
// leading underscore (the webui toggle adds/strips it; the engine skips `_*`).
// Copy it to `{event}.js` or `{event}/<name>.js` to make it fire.
//
// Optional: `export const debounce = 2000;` coalesces a burst of events into a
// single run carrying all of them in `payloads` (handy when the app inserts N
// documents as singletons instead of one batch event).

export default async function hook({
  event,          // { name, workspaceId, payload, timestamp, payloads? }
  eventName,      // string, e.g. 'document.inserted'
  payload,        // raw event payload (last one for a debounced burst)
  payloads,       // array of payloads; [payload] unless debounced
  workspace,      // workspace instance (workspace.link, .getContextTreeSelector, ...)
  db,             // SynapsD instance when the workspace is active, else null
  tree,           // default context tree when active, else null
  logger,
  emit,           // emit(name, payload) -> re-emit a workspace event
  insert,         // insert(document, options)
  update,         // update(id, document, options)
  remove,         // remove(id, options) -> unlink
  deleteDocument, // deleteDocument(id) -> hard delete
  get,            // get(id, { parse: true })
  list,           // list(spec)
  find,           // find(spec) -> search
  link,           // link(documentId, contextSelector | [selectors])
  agent,          // agent(slug, prompt, options) -> assistant text reply
}) {
  logger.debug(`Hook fired: ${eventName} in workspace ${workspace.id}`);

  return {
    ok: true,
    eventName,
    documentId: payload?.document?.id ?? payload?.id ?? null,
  };
}
