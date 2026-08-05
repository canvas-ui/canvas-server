import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { displayFilename, docName, renamedRecord } from '../../../src/transports/webdav/vfs-shared.js';

/**
 * A file's bytes may be called something different at every location, so a
 * consumer needs one deterministic answer. The rule that matters most here:
 * `locations` is append-ordered and rebuilt per backend scan, so array position
 * must never decide — reading locations[0] used to make a file rename itself to
 * a content hash the moment a mirror landed in front of it.
 */

const file = (locations, extra = {}) => ({ schema: 'data/schema/file', id: 42, locations, ...extra });

describe('display filename resolution', () => {
    test('the document own name wins over every location', () => {
        const doc = file(
            [{ url: 'stored://workspace:data/abc', metadata: { filename: 'upload.jpg' } }],
            { metadata: { filename: 'holiday-2026.jpg' } },
        );
        assert.equal(displayFilename(doc), 'holiday-2026.jpg');
    });

    test('the canvas-owned copy names the file when nothing else does', () => {
        const doc = file([
            { url: 'file://device-1/home/me/DCIM/IMG_0001.jpg' },
            { url: 'stored://workspace:data/abc', metadata: { filename: 'upload.jpg' } },
        ]);
        assert.equal(displayFilename(doc), 'upload.jpg');
    });

    test('adding a mirror cannot rename the file', () => {
        const named = { url: 'stored://workspace:data/abc', metadata: { filename: 'report.pdf' } };
        const mirror = { url: 'file://nas-7/exports/scan-0001.pdf', metadata: { backend: 'nas' } };

        // Same locations, either order — and a bare stored:// key (a hash) must
        // never surface as the name.
        assert.equal(displayFilename(file([named, mirror])), 'report.pdf');
        assert.equal(displayFilename(file([mirror, named])), 'report.pdf');
    });

    test('a content hash is never a name; a real path basename is', () => {
        assert.equal(displayFilename(file([{ url: 'stored://workspace:data/deadbeefcafe' }])), null);
        assert.equal(displayFilename(file([{ url: 'file://device-1/home/me/notes.txt' }])), 'notes.txt');
    });

    test('unnamed locations fall back to a stable order, not array order', () => {
        const a = { url: 'file://a-device/one.txt' };
        const b = { url: 'file://b-device/two.txt' };
        assert.equal(displayFilename(file([a, b])), 'one.txt');
        assert.equal(displayFilename(file([b, a])), 'one.txt');
    });

    test('docName still derives a name for JSON abstractions that have none', () => {
        assert.equal(docName({ schema: 'data/schema/note', id: 3, data: { title: 'Ideas' } }), 'Ideas.md');
        assert.equal(docName({ schema: 'data/schema/file', id: 9, locations: [] }), 'file_9.json');
    });

    test('a rename is recorded where the schema keeps its name', () => {
        // core/File.js reserves `data` for JSON docs and keeps it empty.
        const renamedFile = renamedRecord(file([{ url: 'stored://workspace:data/abc' }]), 'invoice.pdf');
        assert.equal(renamedFile.metadata.filename, 'invoice.pdf');
        assert.deepEqual(renamedFile.data, undefined);

        const renamedNote = renamedRecord({ schema: 'data/schema/note', data: { title: 'x' } }, 'y.md');
        assert.equal(renamedNote.data.filename, 'y.md');
        assert.equal(renamedNote.metadata, undefined);
    });
});
