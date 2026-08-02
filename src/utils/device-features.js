'use strict';

/**
 * Device feature tags.
 *
 * THE RULE: `device/*` means **PRESENT ON**, never "written by".
 *
 * The project is roaming-profile centric — `deviceId` exists to answer "which
 * machine did I leave customer-foo.xlsx on". Presence is therefore DERIVED, by
 * synapsd, from a document's `locations[]`: a client that registers (or maps to)
 * a device and indexes a local file writes `file://<deviceId>/<path>` (or
 * `file://<deviceAlias>/<path>`), and `device/id/*`, `device/os/*` and
 * `device/type/*` all fall out of that — the last two by resolving the device id
 * through its own `data/abstraction/device` document.
 *
 * Consequences:
 *
 *  - **The server asserts nothing on a document's behalf.** A document is on a
 *    device because its locations say so, not because of who POSTed it.
 *  - **Clients must not assert `device/*`** — those keys are engine-owned, and a
 *    client-supplied value would be indistinguishable from a derived one while
 *    being immune to cleanup (synapsd's #removeStaleDeviceMembership never
 *    unticks a tag the caller asserted in the same write).
 *  - **`client/*` is the consumer's own namespace and is entirely optional.** An
 *    application MAY tag what it likes on insert — `client/app/firefox`,
 *    `client/device/os/windows`, `client/device/platform/*` — and nothing here
 *    mandates or injects it. The browser extension already works this way
 *    (tab-manager.js pushes `client/app/*` when it feels like it). Whether that
 *    provenance is worth recording is the consumer's call, not the server's.
 */

// Engine-owned: derived by synapsd from `locations[]`. Stripped from any
// client-supplied feature array so an asserted value can never masquerade as
// (or outlive) a derived one.
export const ENGINE_DEVICE_PREFIXES = ['device/'];

export function normalizeDeviceOs(value) {
  const input = String(value || '').trim().toLowerCase();
  if (!input) { return null; }
  if (input === 'darwin' || input === 'macos' || input === 'osx') { return 'mac'; }
  if (input === 'win32' || input === 'win' || input === 'windows_nt') { return 'windows'; }
  if (input === 'linux' || input === 'mac' || input === 'windows') { return input; }
  if (input === 'android' || input === 'ios' || input === 'server' || input === 'container') { return input; }
  return input;
}

export function normalizeDeviceType(value) {
  const input = String(value || '').trim().toLowerCase();
  return input || null;
}

/**
 * Build the full identity tag set for a DEVICE DOCUMENT.
 *
 * Only caller: core/device/Registry.js. This is self-referential — the record
 * for device foo describes foo, so it legitimately carries foo's own id, os and
 * type, and it is what makes "show me my Windows devices" resolvable. Do NOT
 * use it to tag ordinary documents; that is the "written by" mistake.
 *
 * @param {{deviceId:string, deviceOs?:string, platform?:string, os?:string, deviceType?:string, type?:string}} device
 * @returns {string[]}
 */
export function buildDeviceFeatureTags(device = {}) {
  const tags = [];
  const deviceId = String(device.deviceId || '').trim();
  const deviceOs = normalizeDeviceOs(device.deviceOs || device.platform || device.os);
  const deviceType = normalizeDeviceType(device.deviceType || device.type);

  if (deviceId) { tags.push(`device/id/${deviceId}`); }
  if (deviceOs) { tags.push(`device/os/${deviceOs}`); }
  if (deviceType) { tags.push(`device/type/${deviceType}`); }

  return Array.from(new Set(tags));
}

/**
 * Drop engine-owned `device/*` keys from a client-supplied feature array.
 *
 * This is the whole of the write-path policy: strip what the engine owns, keep
 * everything else verbatim — including the entire `client/*` namespace, which
 * consumers populate (or don't) as they see fit.
 *
 * @param {string[]} featureArray
 * @returns {string[]}
 */
export function stripDeviceFeatureTags(featureArray = []) {
  return (Array.isArray(featureArray) ? featureArray : []).filter((feature) =>
    typeof feature === 'string' &&
    !ENGINE_DEVICE_PREFIXES.some((prefix) => feature.startsWith(prefix))
  );
}
