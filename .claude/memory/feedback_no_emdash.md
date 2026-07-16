---
name: feedback_no_emdash
description: "Use plain hyphens, never em/en dashes, in code, UI copy and comments"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5c2068e7-a25b-4642-940f-1b7de3efde97
---

Never use em dashes (—) or en dashes (–) in anything written into the repo: user-facing UI copy, code comments, docs, commit messages. Use a plain hyphen (-), or reword the sentence.

**Why:** User asked for this explicitly on the update maintenance page ("remove the emdash and use normal dash"). It reads as machine-written and is inconsistent with the rest of the codebase's ASCII-only style.

**How to apply:** Prefer rewording over a bare hyphen swap when the dash was joining two clauses (a comma or a period usually reads better). Don't retro-fix pre-existing dashes in code you aren't otherwise touching. See [[feedback_no_commits]] for the related rule that the user handles commits.
