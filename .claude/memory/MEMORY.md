# Memory Index

Repo-local auto-memory (migrated from device-local store 2026-07-16, triaged: completed-work journals dropped, pending items promoted to TODO.md).

## Behavior / workflow
- [feedback_no_commits.md](feedback_no_commits.md) — NEVER commit/push; user scripts manage submodule commits
- [feedback_no_emdash.md](feedback_no_emdash.md) — plain hyphens only, no em/en dashes in repo text
- [feedback_dev_server.md](feedback_dev_server.md) — local canvas-server restart allowed (npm run dev); pkill gotchas
- [feedback_url_design.md](feedback_url_design.md) — UI URLs mirror REST API paths; no type-specific query cruft
- [feedback_version_bumps.md](feedback_version_bumps.md) — always semver-bump the touched component(s); scope decides patch/minor/major
- [project_architecture_conventions.md](project_architecture_conventions.md) — consumer-agnostic synapsd, lib/ injection, post-commit bitmap deferral, checksum identity, putMany mutation pitfall
- [project_dependency_constraints.md](project_dependency_constraints.md) — fastembed needs tar 6 (never global tar override); scoped-only semver overrides; deferred fastify/pi vulns

## Data model / synapsd
- [project_storage_url_scheme.md](project_storage_url_scheme.md) — unified storage URLs: stored:// + file://, NO workspace:// scheme
- [project_device_addressing.md](project_device_addressing.md) — device URL scheme (uuid canonical, user@host alias)
- [project_locations_device_bitmaps.md](project_locations_device_bitmaps.md) — flat locations[] {url}; device/id presence bitmaps from file:// locations
- [project_declarative_features.md](project_declarative_features.md) — metadata.features is declarative, bitmaps follow 1:1
- [project_schema_refactor.md](project_schema_refactor.md) — BaseDocument v3 design (NOT implemented); ⚠️ Lance dim mismatch silently drops the table
- [project_layerindex_naming.md](project_layerindex_naming.md) — LayerIndex name-uniqueness collisions/silent type upgrades; refactor deferred (in TODO.md)
- [project_s2_geo_and_todo.md](project_s2_geo_and_todo.md) — S2 GeoIndex (single BSI, geo: filters) + Todo v2.1 (status enum, tasks timeline, t:<any>:today)
- [project_geo_provenance.md](project_geo_provenance.md) — geo.source/accuracy, manual>exif>device precedence, Null Island guard
- [project_document_comment_field.md](project_document_comment_field.md) — user comment field: FTS + reserved -1 vector chunk + feature/has-comment bitmap

## Search / embedding
- [project_synapsd_search_ranking.md](project_synapsd_search_ranking.md) — ngram tokenizer, weighted RRF, cosine floor 0.35 (retune pending), reindex endpoints
- [project_image_clip_search.md](project_image_clip_search.md) — CLIP/SigLIP: forked-child ORT isolation, lockfile/deploy discipline
- [project_vector_query_timeout_rootcause.md](project_vector_query_timeout_rootcause.md) — CLIP serialization, L2-metric ANN bug (image space annIndex:false), Lance fragmentation
- [project_compound_query_design.md](project_compound_query_design.md) — compound queries: OR/AND of chains (API-only), UI refine-only chips
- [project_synapsd_query_session.md](project_synapsd_query_session.md) — QuerySession = dead code staged for canvas-agentd; resolveCandidates/searchRefined facts
- [project_search_ops_notes.md](project_search_ops_notes.md) — per-modality admin ops, bitmap cache unbounded, perf-bench principle
- [reference_lancedb_multivector.md](reference_lancedb_multivector.md) — LanceDB native multivector/MaxSim (ColBERT) reference
- [reference_local_ollama.md](reference_local_ollama.md) — local Ollama 127.0.0.1:11434 embedding models

## Workspace / backends
- [project_workspace_data_backends.md](project_workspace_data_backends.md) — 2 default backends: workspace:home (file) + workspace:data (cacache)
- [project_backends_tree_refactor.md](project_backends_tree_refactor.md) — 3rd "backends" tree, /<driver>/<address> paths, linkContextRoot, blob cascade
- [project_fs_backends.md](project_fs_backends.md) — fs local-folder backends: file://<deviceId> twins, streaming resync, skeleton mirror
- [project_media_streaming.md](project_media_streaming.md) — HTTP Range/206 on /content + media-cookie auth for <video> src

## Web UI
- [project_toolbox_experimental.md](project_toolbox_experimental.md) — toolbox: top bar, resizable panel, client-side Map tab
- [project_timeline_revamp.md](project_timeline_revamp.md) — histogram endpoint + density rail, quick-filter matrix, calendar picker, multi-range; dataset tag design (in TODO.md)
- [project_canvas_widgets.md](project_canvas_widgets.md) — widget registry, fetchDocuments injection, readOnly/public-share gotchas, querySpec composition
- [project_canvas_live_filters.md](project_canvas_live_filters.md) — live canvas filter preview via applyCanvasSpec=false
- [project_context_binding.md](project_context_binding.md) — contexts = server-enforced filter bindings; applyContextSpec bypass
- [project_user_webui_config.md](project_user_webui_config.md) — per-user webui.json store + home canvas pinning; CanvasGrid gotchas
- [project_ui_color_language.md](project_ui_color_language.md) — color = first-class UI cue; DocumentIcon schema→hue registry

## Clients / agents
- [project_client_spec.md](project_client_spec.md) — docs/client-spec.md: shared on-device data layout (remote-namespaced)
- [project_canvas_fuse.md](project_canvas_fuse.md) — canvas-fuse decisions + FUSE/transport gotchas (condensed)
- [project_browser_ext_tree_picker.md](project_browser_ext_tree_picker.md) — browser ext tree selection (settings-based, tree TYPE NAME resolution)
- [project_cli_add_vs_insert.md](project_cli_add_vs_insert.md) — CLI verbs: add/upload = bytes (stored://), index = in place (file://)
- [project_agent_scoping.md](project_agent_scoping.md) — canvas-agent-* tokens, bindings, canvas tools, messaging channels
- [project_voice_agent.md](project_voice_agent.md) — voice agent: STT/TTS service (OpenAI audio dialect), env vars
