---
name: device addressing scheme
description: Two-layer device URL addressing — UUID canonical, user@hostname human-friendly
type: project
---

**Design:** Device-local files are addressed as `file://deviceId/path` in the index.

Two forms:
- Canonical (storage): `file://856f9e50-c55f-4625-afd1-360b582641ab/some/path.pdf`
- Human-friendly (display/input): `file://jdoe@myhostname/some/path.pdf`

**Implemented:**
- `GenericDevice` (lib/Generic.js): `get alias()` → `${username}@${hostname}`, `get username()`
- `DeviceRegistry` (Registry.js): stores `username`, `hostname`, `fqdn`, `alias`; derives `alias` from `username@hostname` if not supplied; added `getDeviceByAlias(userId, alias)`
- `Device` schema (abstractions/Device.js): `username`, `hostname`, `fqdn`, `alias` in data schema and FTS fields
- `path-helpers.js`: `deviceFileUrl(deviceId, localPath)` builds `file://deviceId/path`
- CLI `dot.js`: `getDeviceId()` now uses `machineIdSync(true).substr(0, 11)` matching `GenericDevice.id` on the server

**Resolution flow:** Parse `file://alias/path` → registry lookup alias → canonical `file://uuid/path` used in index.

**How to apply:** When building file:// URLs for local files, use `deviceFileUrl(deviceId, path)` from path-helpers. DeviceId should always come from the device registry, not `os.hostname()`.
