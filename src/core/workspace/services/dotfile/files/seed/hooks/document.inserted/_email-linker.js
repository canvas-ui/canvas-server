// Example (disabled): file incoming emails into context paths by sender/subject.
// This replaces the old built-in "linker" system hook - the same behaviour, but
// now plain, editable rules you own. Enable by renaming to `email-linker.js`.

const RULES = [
  { from: 'foo@bar.baz', subject: 'dc migration', paths: ['/projects/dc-migration'] },
  { from: 'bar@baf.baz', paths: ['/to-read', '/something/else'], tags: ['custom/tag/urgent'] },
];

function matches(rule, data) {
  const from = String(data?.from || '').toLowerCase();
  const subject = String(data?.subject || '').toLowerCase();
  if (rule.from && !from.includes(rule.from.toLowerCase())) { return false; }
  if (rule.subject && !subject.includes(rule.subject.toLowerCase())) { return false; }
  return true;
}

export default async function hook({ payload, workspace, logger }) {
  const doc = payload?.document;
  if (!doc?.id || !doc.schema?.includes('email')) { return; }

  for (const rule of RULES) {
    if (!matches(rule, doc.data)) { continue; }
    for (const targetPath of rule.paths || []) {
      await workspace.link(doc.id, {
        context: workspace.getContextTreeSelector(targetPath),
        features: rule.tags || [],
        emitEvent: false,
      });
      logger.debug(`email-linker: linked ${doc.id} -> ${targetPath}`);
    }
  }
}
