'use strict';

/**
 * BaseConnector
 *
 * The contract every connector driver implements. Adding a connector is two
 * steps and nothing else:
 *
 *   1. `drivers/<name>/index.js` — a class extending BaseConnector that
 *      declares its statics and implements the inbound verbs.
 *   2. add it to the array in `drivers/index.js`.
 *
 * The registry derives everything else from the statics: the driver list, the
 * provenance-scheme map (used to route a document back to its source), the
 * secret keys that get redacted in API responses, and the config field spec
 * the settings UI renders. Nothing about a driver is repeated anywhere else.
 *
 * ── Inbound (required) ──
 *   test()                          credentials/reachability probe
 *   listContainers()                repos / calendars / channels — { id, name, writable }
 *   fetchChanges(container, cursor)  → { documents, nextCursor, done }
 *
 * ── Inbound (opt-in, `static supports.prune`) ──
 *   listIdentities(container)       every provenance URL currently in the
 *                                   source, for deletion-sync. Must throw
 *                                   rather than return a partial listing.
 *
 * ── Outbound / write-back (opt-in, `static supports.{create,update,delete}`) ──
 *   createDocument(container, payload)
 *   updateDocument(container, provenanceUrl, patch)
 *   deleteDocument(container, provenanceUrl)
 *   containerIdFromProvenance(url)  which container a provenance URL belongs to
 *
 * Every write verb is remote-first: mutate the source, then return
 * `{ document }` built from the source's own response so the runtime can
 * re-ingest it. The identity checksum is derived from the provenance URL, so
 * that re-ingest is always an upsert of the same document.
 */

/** Thrown by any verb a driver has not opted into. Carries a code so the
 *  transport can answer 501 rather than a generic 500. */
export class ConnectorNotSupportedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConnectorNotSupportedError';
        this.code = 'ECONNECTORUNSUPPORTED';
    }
}

export default class BaseConnector {
    // ── Declarative identity (the registry reads these) ──────────────────────

    /** Driver key: the stored.json prefix, API path segment and tree anchor. */
    static driver = null;
    /** Human label + icon + one-liner for the settings UI. */
    static label = null;
    static icon = null;
    static blurb = '';
    /** Provenance URL scheme, without '://'. Must be unique across drivers. */
    static provenanceScheme = null;

    /**
     * Config form spec, served to the UI so connector settings need no
     * client-side per-driver code. Fields:
     *   { key, label, placeholder?, required?, list?, secret?, type? }
     * `secret: true` also drives redaction and the keep-what-is-stored merge.
     */
    static configFields = [];

    /** Opt-in verbs. A driver that leaves one false gets the base's throw. */
    static supports = { prune: false, create: false, update: false, delete: false };

    constructor(address, config = {}, { logger } = {}) {
        const Driver = new.target;
        if (Driver === BaseConnector) throw new Error('BaseConnector is abstract');
        if (!Driver.driver) throw new Error(`${Driver.name} must declare a static driver`);
        if (!Driver.provenanceScheme) throw new Error(`${Driver.name} must declare a static provenanceScheme`);
        this.address = address;
        this.config = config;
        this.logger = logger || console;
    }

    get driver() { return this.constructor.driver; }
    get scheme() { return this.constructor.provenanceScheme; }
    get supports() { return this.constructor.supports; }

    /**
     * Write-back gate. Read-only is the default for every connector — a
     * backend must opt out explicitly. Drivers that additionally need a
     * credential (GitHub needs a PAT) narrow this.
     */
    get canWrite() { return this.config.readOnly === false; }

    /** Capability descriptor surfaced on the backend API. */
    capabilities() {
        const supports = this.supports;
        const write = Boolean(this.canWrite);
        return {
            sync: true,
            test: true,
            containers: true,
            mutableContainers: false,
            deleteObject: false,
            prune: supports.prune === true,
            write: write && supports.create === true,
            update: write && supports.update === true,
            delete: write && supports.delete === true,
        };
    }

    /** Config keys holding secrets — redacted on read, preserved on patch. */
    static secretKeys() {
        return this.configFields.filter((field) => field.secret).map((field) => field.key);
    }

    /** The settings-UI descriptor. Pure statics, no instance needed. */
    static describe() {
        return {
            driver: this.driver,
            label: this.label || this.driver,
            icon: this.icon || null,
            blurb: this.blurb || '',
            scheme: this.provenanceScheme,
            supports: { ...this.supports },
            fields: this.configFields.map((field) => ({ ...field })),
        };
    }

    // ── Inbound ──────────────────────────────────────────────────────────────

    async test() {
        throw new ConnectorNotSupportedError(`${this.driver}: test() not implemented`);
    }

    async listContainers() {
        throw new ConnectorNotSupportedError(`${this.driver}: listContainers() not implemented`);
    }

    async fetchChanges(_container, _cursor) {
        throw new ConnectorNotSupportedError(`${this.driver}: fetchChanges() not implemented`);
    }

    async listIdentities(_container) {
        throw new ConnectorNotSupportedError(`${this.driver} cannot enumerate its source (no deletion-sync)`);
    }

    // ── Outbound ─────────────────────────────────────────────────────────────

    async createDocument(_container, _payload) {
        throw new ConnectorNotSupportedError(`${this.driver} does not support creating remote objects`);
    }

    async updateDocument(_container, _provenanceUrl, _patch) {
        throw new ConnectorNotSupportedError(`${this.driver} does not support updating remote objects`);
    }

    async deleteDocument(_container, _provenanceUrl) {
        throw new ConnectorNotSupportedError(`${this.driver} does not support deleting remote objects`);
    }

    /**
     * Which container owns a provenance URL. `null` means "cannot tell" — the
     * runtime then requires an explicit container and never assumes.
     */
    containerIdFromProvenance(_provenanceUrl) { return null; }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** `gh://owner/repo/issues/12` from ('owner/repo', 'issues', 12). */
    provenance(...segments) {
        return `${this.scheme}://${segments.map((s) => String(s)).join('/')}`;
    }

    /**
     * Build an ingest spec. The provenance location carries the marker the
     * runtime keys identity off; `links` are informational (an issue's
     * html_url, an event's web link) and never treated as identity.
     */
    document({ schema, data, metadata = {}, provenanceUrl, links = [], containerSegment }) {
        if (!provenanceUrl) throw new Error(`${this.driver}: document() requires a provenanceUrl`);
        return {
            schema,
            data,
            metadata,
            locations: [
                { url: provenanceUrl, metadata: { provenance: true } },
                ...links.filter(Boolean).map((url) => ({ url, metadata: {} })),
            ],
            containerSegment,
        };
    }
}
