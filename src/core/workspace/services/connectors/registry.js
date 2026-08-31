'use strict';

/**
 * Connector registry — the single source of truth for "what drivers exist".
 *
 * Everything here is derived from the driver classes' statics (see
 * BaseConnector), so a new connector never needs a second edit in a lookup
 * table somewhere else. The scheme map in particular is load-bearing: it is
 * how a stored document finds its way back to the source it mirrors.
 */

import BaseConnector from './BaseConnector.js';
import { CONNECTOR_CLASSES } from './drivers/index.js';

const DRIVERS = new Map();
const BY_SCHEME = new Map();

for (const Driver of CONNECTOR_CLASSES) {
    if (!(Driver.prototype instanceof BaseConnector)) {
        throw new Error(`Connector ${Driver.name} must extend BaseConnector`);
    }
    if (DRIVERS.has(Driver.driver)) {
        throw new Error(`Duplicate connector driver key: ${Driver.driver}`);
    }
    if (BY_SCHEME.has(Driver.provenanceScheme)) {
        throw new Error(`Duplicate connector provenance scheme: ${Driver.provenanceScheme}`);
    }
    DRIVERS.set(Driver.driver, Driver);
    BY_SCHEME.set(Driver.provenanceScheme, Driver.driver);
}

export const CONNECTOR_DRIVERS = [...DRIVERS.keys()];

/** driver -> provenance scheme (kept for callers that resolve URLs by driver). */
export const CONNECTOR_SCHEMES = Object.fromEntries(
    [...DRIVERS.values()].map((Driver) => [Driver.driver, Driver.provenanceScheme]),
);

export function isConnectorDriver(driver) {
    return DRIVERS.has(driver);
}

export function getConnectorDriver(driver) {
    return DRIVERS.get(driver) || null;
}

/**
 * Reverse routing: `gh://owner/repo/issues/7` -> 'github'. Returns null for
 * any URL that is not a connector provenance URL, which is how the document
 * write path tells a mirrored document from an ordinary one.
 */
export function connectorDriverForProvenanceUrl(url) {
    if (typeof url !== 'string') return null;
    const separator = url.indexOf('://');
    if (separator <= 0) return null;
    return BY_SCHEME.get(url.slice(0, separator)) || null;
}

/** Secret config keys for a driver (redaction + keep-what-is-stored merge). */
export function connectorSecretKeys(driver) {
    const Driver = DRIVERS.get(driver);
    return Driver ? Driver.secretKeys() : [];
}

/** Every secret key across every driver — used by the generic config merge. */
export const ALL_SECRET_KEYS = [...new Set(
    [...DRIVERS.values()].flatMap((Driver) => Driver.secretKeys()),
)];

/** Form/capability spec for the settings UI. */
export function describeConnectorDrivers() {
    return [...DRIVERS.values()].map((Driver) => Driver.describe());
}
