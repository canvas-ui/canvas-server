'use strict';

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getFetcher, listKinds, resolveKind, drivers, BaseFetcher } from '../../../../../src/core/workspace/services/fetchers/index.js';

describe('fetcher registry', () => {
    test('every driver declares a unique kind and extends BaseFetcher', () => {
        const kinds = drivers.map((d) => d.kind);
        assert.deepEqual(kinds, [...new Set(kinds)]);
        for (const d of drivers) {
            assert.ok(d.prototype instanceof BaseFetcher, `${d.name} extends BaseFetcher`);
            assert.ok(['file', 'tree'].includes(d.layout), `${d.kind} layout`);
        }
        assert.equal(drivers.filter((d) => d.fallback).length, 1);
        assert.deepEqual(listKinds(), ['file', 'video', 'page', 'website']);
    });

    test('aliases resolve to their driver, unknown kinds do not', () => {
        assert.equal(getFetcher('image').kind, 'file');
        assert.equal(getFetcher('arxiv').kind, 'file');
        assert.equal(getFetcher('VIDEO').kind, 'video');
        assert.equal(getFetcher('nope'), null);
    });

    test('resolveKind honours explicit aliases and falls back to page', async () => {
        assert.equal(await resolveKind('https://x.com/whatever', 'image'), 'file');
        assert.equal(await resolveKind('https://x.com/whatever', 'bogus', async () => null), 'page');
        assert.equal(getFetcher('file').resolveUrl('https://arxiv.org/abs/2401.00001'), 'https://arxiv.org/pdf/2401.00001.pdf');
        assert.equal(getFetcher('page').resolveUrl('https://x.com/a'), 'https://x.com/a');
    });
});
