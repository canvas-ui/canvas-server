'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stripDeviceFeatureTags } from '../../src/utils/device-features.js';

describe('device feature tags', () => {

    // This module used to also BUILD device tags, duplicating synapsd's
    // normalization so the two could disagree about the same machine. It no
    // longer does: a Device document's own keys are derived by the engine from
    // the row (Device.getFeatureBitmapArray), so there is one implementation and
    // nothing here to keep in sync. What remains is the write-path policy.

    it('strips engine-owned device/* from a client-supplied array', () => {
        // device/* is DERIVED by synapsd from locations. A client-asserted value
        // would be indistinguishable from a derived one and immune to cleanup.
        const kept = stripDeviceFeatureTags([
            'device/id/someone-else', 'device/os/linux', 'device/type/server', 'tag/report',
        ]);
        assert.deepEqual(kept, ['tag/report']);
    });

    it('leaves the whole client/* namespace alone — it is optional and consumer-owned', () => {
        // Nothing is mandated or injected: the browser extension opts into
        // client/app/* on its own terms, and an app may or may not record client
        // OS/platform. That is the consumer's call, not the server's.
        const features = [
            'client/app/firefox',
            'client/device/os/windows',
            'client/device/platform/x64',
            'client/device/id/foo',
            'tag/keep',
        ];
        assert.deepEqual(stripDeviceFeatureTags(features), features);
    });

    it('injects nothing — a write with no features stays empty', () => {
        // The server never asserts presence on a document's behalf; presence
        // comes from file://<deviceId>/<path> locations and is derived.
        assert.deepEqual(stripDeviceFeatureTags([]), []);
        assert.deepEqual(stripDeviceFeatureTags(['tag/only']), ['tag/only']);
    });

    it('ignores non-string entries', () => {
        assert.deepEqual(stripDeviceFeatureTags(['tag/a', null, 42, undefined]), ['tag/a']);
    });
});
