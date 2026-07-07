// Example (disabled): file incoming emails into context paths by sender/subject.
// Enable by renaming to `email-linker.js`.
//
// Tip: simple sender/subject → path rules like these need no code at all —
// see `hooks/example-rules.json` for the declarative equivalent. Use a JS hook when
// you need logic the rule matchers can't express.

const RULES = [
  { from: 'foo@bar.baz', subject: 'dc migration', paths: ['/projects/dc-migration'] },
  { from: 'bar@baf.baz', paths: ['/to-read', '/something/else'], tags: ['custom/tag/urgent'] },
];

function matches(rule, c) {
  if (rule.from && !(c.from || '').includes(rule.from.toLowerCase())) { return false; }
  if (rule.subject && !(c.subject || '').toLowerCase().includes(rule.subject.toLowerCase())) { return false; }
  return true;
}

export default async function hook({ classify, payload, workspace, logger }) {
  const c = classify();
  const doc = payload?.document;
  if (!doc?.id || !c.isEmail()) { return; }

  for (const rule of RULES) {
    if (!matches(rule, c)) { continue; }
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
