// Reference hook: every value the context hands a handler. Disabled by the
// `example-` prefix (the engine skips `example-*`, `disabled-*` and `_*` files;
// the webui toggle renames). Copy it to `{event}.js` or `{event}/<name>.js` to make it fire.
//
// Optional: `export const debounce = 2000;` coalesces a burst of events into a
// single run carrying all of them in `payloads` (handy when the app inserts N
// documents as singletons instead of one batch event).
//
// Simple match→action automations need no JS at all: drop declarative rules
// into `rules.json` (or `rules/*.json`) — see `example-rules.json` for the format.

export default async function hook({
  _event,          // { name, workspaceId, payload, timestamp, payloads? }
  eventName,      // string, e.g. 'document.inserted'
  payload,        // raw event payload (last one for a debounced burst)
  _payloads,       // array of payloads; [payload] unless debounced
  workspace,      // workspace instance (workspace.link, .getContextTreeSelector, ...)
  _db,             // SynapsD instance when the workspace is active, else null
  _tree,           // default context tree when active, else null
  logger,
  _emit,           // emit(name, payload) -> re-emit a workspace event
  _insert,         // insert(document, options)
  _update,         // update(id, document, options)
  _remove,         // remove(id, options) -> unlink
  _deleteDocument, // deleteDocument(id) -> hard delete
  _get,            // get(id, { parse: true })
  _list,           // list(spec)
  _find,           // find(spec) -> search
  _link,           // link(documentId, contextSelector | [selectors])
  _agent,          // agent(slug, prompt, options) -> assistant text reply
  _notify,         // notify(message, { channel? }) -> message the workspace owner
  _classify,       // classify() -> classification of the event's document:
                  //   c.isTab()/isEmail()/isFile()/isNote(), c.isLink()/isYoutube()/
                  //   isArxiv()/isImageUrl(), c.isImage()/isPdf()/mimeMatches('image/*'),
                  //   c.inPath('/to-sort'), c.url/host/from/subject/paths
                  // classify(otherPayload) for debounced bursts, classify(doc) for
                  // documents fetched via get().
}) {
  logger.debug(`Hook fired: ${eventName} in workspace ${workspace.id}`);

  return {
    ok: true,
    eventName,
    documentId: payload?.document?.id ?? payload?.id ?? null,
  };
}
