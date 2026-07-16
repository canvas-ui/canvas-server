---
name: project-ui-color-language
description: UI direction — color as first-class visual cue; DocumentIcon per-schema hue registry is the seed
metadata: 
  node_type: memory
  type: project
  originSessionId: 8adafc4d-c021-4cce-b42d-802fb32ffc28
---

UI color direction (2026-07-07, from user): the web UI is deliberately black-and-white, so color is a **primary visual cue**, not decoration. User hates the old uniform blue "IE6-like" document icons (2000s link association).

Implemented seed: `src/ui/web/src/components/common/DocumentIcon.tsx` — single source of truth mapping schema→{lucide icon, vibrant hue, soft chip bg}: tab/link=sky, email=amber, note=yellow, todo=green, message=cyan, contact=orange, device=violet, application=purple, dotfile=lime, document/generic=indigo; files by mime (image=emerald, video=rose, audio=fuchsia, pdf=red, archive=stone, code=teal, text=slate). Used in common/document-list (table/list/grid), workspace/document-list, PickDocumentsCard.

**Planned (near future, per user):** vibrant colors covering larger sections of buttons and header areas; colors as visual cues for context/directory paths once the vertically+horizontally scrollable multi-context multi-focus layout lands. Keep the DocumentIcon hue map as the palette anchor when that work starts. Related: [[project-mvp-scope]].
