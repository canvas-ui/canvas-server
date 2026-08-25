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
 * `file://<deviceAlias>/<path>`), and `device/id/*`, `device/os/*`,
 * `device/arch/*` and `device/type/*` all fall out of that — the last three by
 * resolving the device id through its own `data/schema/device` document.
 *
 * Consequences:
 *
 *  - **The server asserts nothing on a document's behalf, including on a Device
 *    document.** A Device row's own keys are derived too, by synapsd, from the
 *    row (see Device.getFeatureBitmapArray) — which is what makes them survive a
 *    rebuild and untick when the box is upgraded. Hence this module is now
 *    strip-only; there is nothing left to build.
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
