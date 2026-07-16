---
name: project-client-spec
description: Shared on-device data layout spec for all Canvas clients (cli/fuse/desktop/shell)
metadata: 
  node_type: memory
  type: project
  originSessionId: 9ae0bacc-e12a-4d61-86ce-e1b04eef7fb8
---

docs/client-spec.md (draft v0.1, written 2026-06-13) — single source of truth for how every Canvas client stores data on a device. Driver: a device talks to N remotes, so all device-local state mirroring a remote must be namespaced by remote or it collides (the redb lock bug was the symptom).

Core model: one root $CANVAS_HOME (default ~/.canvas, overridable) + manifest.json {version}. Four lifecycle axes: config (durable, hand-editable), cache (server-reconstructible, wipeable), state (device-authoritative, not re-fetchable), var (ephemeral: log/run). var is a SIBLING of cache, never nested. Everything that belongs to a remote lives under remotes/<key>/{cache,state,index}/ — NO global tier for workspaces/contexts/agents/roles (fixed the draft's duplication where they appeared both top-level and under cache).

Remote key = exact remotes.json object key (e.g. idnc_sk@canvas), sanitized: keep [A-Za-z0-9._@-], else _, trim ._, empty→default. No --remote → derive from server URL host. This key joins config→cache→state.

Sockets: $XDG_RUNTIME_DIR/canvas else $CANVAS_HOME/var/run (creator owns stale cleanup). Logs always var/log.

Ownership: remotes.json writer = canvas-cli (or future local daemon); others read-only or flock. device.json = shared device identity; per-remote device tokens stay in remotes.json.

Rollout: canvas-fuse = reference impl (runtime::mount_data_dir). Plan: extract canvas-paths Rust crate (fuse+desktop share), node module for cli, bash funcs for shell. canvas-fuse CURRENTLY uses interim path ~/.canvas/<remote>/fuse/contexts/<ctx>/names.redb — spec target is ~/.canvas/remotes/<remote>/state/contexts/<ctx>/names.redb; NOT yet aligned (migration pending).

Open questions in spec §10: local daemon as single remotes.json writer/socket owner? device id shared vs per-remote (leaning shared)? cache TTL/eviction vs wipe-only?

Related: [[project-canvas-fuse]], [[project-note-title-and-ci]]
