'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildDeviceFeatureTags,
    stripDeviceFeatureTags,
    normalizeDeviceOs,
} from '../../src/utils/device-features.js';

describe('device feature tags', () => {

    it('normalizes OS aliases the way synapsd does', () => {
        // MUST stay in sync with synapsd src/utils/device-facets.js — a divergence
        // puts the same machine's Device-doc tag and its derived tag in different
        // bitmaps.
        assert.equal(normalizeDeviceOs('win32'), 'windows');
        assert.equal(normalizeDeviceOs('darwin'), 'mac');
        assert.equal(normalizeDeviceOs('osx'), 'mac');
        assert.equal(normalizeDeviceOs('linux'), 'linux');
        assert.equal(normalizeDeviceOs(''), null);
    });

    it('buildDeviceFeatureTags emits the full set for a Device DOCUMENT', () => {
        // Its one caller is core/device/Registry.js, tagging a Device document
        // with its own identity — self-referential, so os/type belong.
        const tags = buildDeviceFeatureTags({ deviceId: 'foo', deviceOs: 'win32', deviceType: 'laptop' });
        assert.deepEqual(tags, ['device/id/foo', 'device/os/windows', 'device/type/laptop']);
    });

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
