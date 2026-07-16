---
name: LayerIndex per-tree name uniqueness — to refactor
description: synapsd LayerIndex.getLayerByName returns by-name globally per-tree, causing collisions, silent type upgrades, and lost layers on move
type: project
originSessionId: 9c435248-6639-43ec-a61e-4df211f66c34
---
**Symptom:** Layer-name collisions silently reuse or upgrade existing layers across the tree.

Concrete repros (2026-05-06):
- Create canvas `Files` when a context layer named `files` exists → resolves to same layer (likely case-insensitive normalize).
- Create canvas `test1` while `/foo/test1` (context layer) exists → silently converts the context layer to canvas via the "upgrade leaf layer" branch in `ContextTree.insertPath`.
- Drag-drop a canvas onto a path that already has a node with the same layer name → after move, source view shows it gone (visually disappears).

**Why:** `LayerIndex.getLayerByName(name)` is keyed globally per-tree (no path scoping), and `ContextTree.insertPath` uses it to short-circuit creation when a name matches anywhere. Combined with leaf-type "auto-upgrade" logic at `ContextTree.js:475-485`, mismatched intentions silently mutate layer types.

**How to apply (deferred refactor):**
- Tree nodes already carry `layer.id`. Path resolution should walk the tree by id (parent → child id) rather than by name lookup.
- Treat name as a *label* scoped to a tree position. Two `Files` at different parents → two distinct layers.
- Layer index becomes id-keyed only; name index optional (for search).
- `insertPath` creates a fresh layer per missing segment unless the caller passes `linkLayerId`.
- Drop the silent context↔canvas type upgrade. Different leaf types = different layer + clear error if user explicitly tries to overwrite.

Until refactor lands: avoid same-name collisions in trees; if a leaf-type mismatch is detected, the server should refuse with a clear error rather than auto-upgrade.
