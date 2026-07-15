'use strict';

/**
 * Provenance-ranked reconciliation for `metadata.geo`.
 *
 * Geo reaches a document from three places that legitimately disagree:
 *   - `exif`   — where the photo was TAKEN (the camera's own fix)
 *   - `device` — where the client was when it CREATED/uploaded the doc
 *   - `manual` — a human placing or correcting the pin
 *
 * Import a Tatras photo from your couch and device geo is simply wrong, so EXIF
 * outranks it. Manual sits on top: once a human has fixed a bad fix, re-indexing
 * the file must not silently revert it to the camera's coordinates.
 *
 * Rank — not write order — decides the winner, which makes re-upserts idempotent
 * instead of last-writer-wins.
 */

export const GEO_SOURCES = ['device', 'exif', 'manual'];

const GEO_RANK = { device: 1, exif: 2, manual: 3 };

// Docs written before provenance existed carry a bare {lat,lon} with no source.
// They rank below every known source (so a real EXIF read upgrades them) but
// still beat having no geo at all.
function rankOf(geo) {
    return GEO_RANK[geo?.source] ?? 0;
}

/**
 * A geo object is usable only with finite, in-range coordinates.
 * Exact (0,0) is rejected: `Number(null)` is 0 and `Number.isFinite(0)` is true,
 * so a `{ lat: null, lon: null }` record would otherwise land on "Null Island"
 * off the Gulf of Guinea and be indexed there. That is sentinel data, not a fix.
 */
export function isValidGeo(geo) {
    if (!geo || typeof geo !== 'object') { return false; }
    const lat = Number(geo.lat);
    const lon = Number(geo.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { return false; }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) { return false; }
    return !(lat === 0 && lon === 0);
}

/**
 * Coerce to the canonical { lat, lon, alt?, accuracy?, source? } shape, dropping
 * anything unusable. Returns null when the input isn't a real location.
 */
export function normalizeGeo(geo, defaultSource = null) {
    if (!isValidGeo(geo)) { return null; }
    const out = { lat: Number(geo.lat), lon: Number(geo.lon) };
    if (Number.isFinite(Number(geo.alt))) { out.alt = Number(geo.alt); }
    // accuracy = horizontal radius in metres (EXIF GPSHPositioningError, or the
    // Geolocation API's coords.accuracy). Negative values are meaningless.
    if (Number.isFinite(Number(geo.accuracy)) && Number(geo.accuracy) >= 0) { out.accuracy = Number(geo.accuracy); }
    const source = typeof geo.source === 'string' ? geo.source : defaultSource;
    if (source && GEO_SOURCES.includes(source)) { out.source = source; }
    return out;
}

/**
 * Pick the winner between an existing and an incoming geo. Returns the
 * normalized winner, or null when neither is usable (callers should then drop
 * `metadata.geo` entirely rather than persist sentinel coordinates).
 *
 * Equal rank -> incoming wins, so re-extracting the same source refreshes it.
 */
export function pickGeo(existing, incoming, { incomingSource = null, existingSource = null } = {}) {
    const a = normalizeGeo(existing, existingSource);
    const b = normalizeGeo(incoming, incomingSource);
    if (!a) { return b; }
    if (!b) { return a; }
    return rankOf(b) >= rankOf(a) ? b : a;
}

export default { GEO_SOURCES, isValidGeo, normalizeGeo, pickGeo };
