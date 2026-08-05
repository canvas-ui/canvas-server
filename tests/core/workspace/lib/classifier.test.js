import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDocument, SCHEMAS } from '../../../../src/core/workspace/lib/classifier.js';

const tab = (url) => ({ schema: 'data/schema/tab', data: { url, title: 't' } });
const email = (from, subject) => ({ schema: 'data/schema/message/email', data: { from, subject } });
const file = (contentType, locations = [{ url: 'stored://x' }]) => ({
    schema: 'data/schema/file',
    metadata: { contentType },
    locations,
});

describe('classifier', () => {
    test('null/absent doc classifies safely, all predicates false', () => {
        for (const c of [classifyDocument(null), classifyDocument(undefined), classifyDocument('nope')]) {
            assert.equal(c.doc, null);
            assert.equal(c.isTab(), false);
            assert.equal(c.isLink(), false);
            assert.equal(c.isText(), false);
            assert.equal(c.inPath('/to-sort'), false);
            assert.equal(c.mimeMatches('image/*'), false);
            assert.equal(c.embeddingModality(), null);
        }
    });

    test('schema predicates accept short and full names', () => {
        const c = classifyDocument(tab('https://example.com'));
        assert.equal(c.isTab(), true);
        assert.equal(c.isSchema('tab'), true);
        assert.equal(c.isSchema(SCHEMAS.tab), true);
        assert.equal(c.isEmail(), false);
        assert.equal(c.isSchema('email'), false);
    });

    test('url parsing: isLink, host, non-http rejected', () => {
        assert.equal(classifyDocument(tab('https://www.Example.com/page')).host, 'example.com');
        assert.equal(classifyDocument(tab('https://example.com')).isLink(), true);
        assert.equal(classifyDocument(tab('ftp://example.com')).isLink(), false);
        assert.equal(classifyDocument(tab('not a url')).isLink(), false);
        assert.equal(classifyDocument(email('a@b.c', 's')).isLink(), false);
    });

    test('isYoutube matches watch, short and shorts urls', () => {
        assert.equal(classifyDocument(tab('https://www.youtube.com/watch?v=abc')).isYoutube(), true);
        assert.equal(classifyDocument(tab('https://youtu.be/abc')).isYoutube(), true);
        assert.equal(classifyDocument(tab('https://youtube.com/shorts/abc')).isYoutube(), true);
        assert.equal(classifyDocument(tab('https://example.com/youtube')).isYoutube(), false);
    });

    test('isArxiv matches abs and pdf urls', () => {
        assert.equal(classifyDocument(tab('https://arxiv.org/abs/2401.12345')).isArxiv(), true);
        assert.equal(classifyDocument(tab('https://arxiv.org/pdf/2401.12345v2')).isArxiv(), true);
        assert.equal(classifyDocument(tab('https://arxiv.org/list/cs.AI/recent')).isArxiv(), false);
    });

    test('isImageUrl by pathname extension, ignores query strings', () => {
        assert.equal(classifyDocument(tab('https://x.com/a/photo.JPG?w=100')).isImageUrl(), true);
        assert.equal(classifyDocument(tab('https://x.com/a/photo.webp')).isImageUrl(), true);
        assert.equal(classifyDocument(tab('https://x.com/a/page.html')).isImageUrl(), false);
        assert.equal(classifyDocument(tab('https://x.com/a')).isImageUrl(), false);
    });

    test('hostMatches: exact and subdomain suffix', () => {
        const c = classifyDocument(tab('https://music.youtube.com/watch?v=1'));
        assert.equal(c.hostMatches('youtube.com'), true);
        assert.equal(c.hostMatches('music.youtube.com'), true);
        assert.equal(c.hostMatches('outube.com'), false);
    });

    test('urlMatches: substring case-insensitive and RegExp', () => {
        const c = classifyDocument(tab('https://example.com/Some/Path'));
        assert.equal(c.urlMatches('some/path'), true);
        assert.equal(c.urlMatches(/\/Some\//), true);
        assert.equal(c.urlMatches('other'), false);
    });

    test('email from normalization handles string and {address,name}', () => {
        assert.equal(classifyDocument(email('Foo@Bar.Baz', 's')).from, 'foo@bar.baz');
        assert.equal(classifyDocument(email({ address: 'A@B.C', name: 'A' }, 's')).from, 'a@b.c');
        assert.equal(classifyDocument(email(undefined, 's')).from, null);
    });

    test('mime predicates and mimeMatches globs', () => {
        const img = classifyDocument(file('image/png'));
        assert.equal(img.isImage(), true);
        assert.equal(img.mimeMatches('image/*'), true);
        assert.equal(img.mimeMatches('image/png'), true);
        assert.equal(img.mimeMatches('text/*'), false);
        assert.equal(img.mimeMatches(/^image\//), true);
        assert.equal(classifyDocument(file('application/pdf')).isPdf(), true);
        assert.equal(classifyDocument(file('text/markdown')).isText(), true);
        assert.equal(classifyDocument(file('video/mp4')).isVideo(), true);
        assert.equal(classifyDocument(file('audio/mpeg')).isAudio(), true);
    });

    test('note/todo/event count as text without a mime', () => {
        assert.equal(classifyDocument({ schema: 'data/schema/note', data: {} }).isText(), true);
        assert.equal(classifyDocument({ schema: 'data/schema/task', data: {} }).isText(), true);
        // Events carry inline title/description and no contentType — without this
        // they would never reach the embedder.
        assert.equal(classifyDocument({ schema: 'data/schema/event', data: {} }).isText(), true);
    });

    test('event schema is classifiable', () => {
        const ev = classifyDocument({
            schema: 'data/schema/event',
            data: { title: 'Standup', type: 'calendar', start: '2026-08-03T09:00:00.000Z' },
        });
        assert.equal(ev.isEvent(), true);
        assert.equal(ev.isSchema(SCHEMAS.event), true);
        assert.equal(ev.isTodo(), false);
        assert.equal(classifyDocument({ schema: 'data/schema/task', data: {} }).isEvent(), false);
        assert.equal(classifyDocument(null).isEvent(), false);
    });

    test('isBlob requires file schema with locations', () => {
        assert.equal(classifyDocument(file('image/png')).isBlob(), true);
        assert.equal(classifyDocument(file('image/png', [])).isBlob(), false);
        assert.equal(classifyDocument(tab('https://x.com/a.png')).isBlob(), false);
    });

    test('paths merged from context and directory specs, inPath prefix semantics', () => {
        const payload = {
            context: { paths: ['/to-sort', '/inbox'] },
            directory: { path: '/data/incoming' },
        };
        const c = classifyDocument(tab('https://example.com'), payload);
        assert.deepEqual([...c.paths].sort(), ['/data/incoming', '/inbox', '/to-sort']);
        assert.equal(c.inPath('/to-sort'), true);
        assert.equal(c.inPath('/to-sort/'), true);
        assert.equal(c.inPath('/to'), false); // no partial segment match
        assert.equal(c.inPath('/data'), true);
        assert.equal(c.inPath('/'), true);
        assert.equal(classifyDocument(tab('https://x.com')).inPath('/'), false);
    });

    test('embeddingModality mirrors resolveEmbeddingInput mime logic', () => {
        assert.equal(classifyDocument(file('image/png')).embeddingModality(), 'image');
        assert.equal(classifyDocument(file('text/plain')).embeddingModality(), 'text');
        assert.equal(classifyDocument(file('application/pdf')).embeddingModality(), null);
        assert.equal(classifyDocument(file(null)).embeddingModality(), null);
    });
});
