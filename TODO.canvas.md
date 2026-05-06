# Canvas Sharing TODO

## Public Resource Gateway

Goal: public canvas pages must serve linked resources without exposing backend storage URLs, arbitrary files, or query capability. Every public resource request must prove this chain:

`shareCode -> canvas -> visible document -> linked resource -> cached blob`

### Public URLs

- Canvas page: `/pub/c/:code`
- Resource: `/pub/c/:code/r/:documentId/:resourceIndex`

Do not mint random file URLs per object yet. Keep resource identity tied to the shared canvas and the document payload. Simple, auditable, boring. Boring is good here.

### Request Flow

1. Resolve `:code` to an active public canvas share.
2. Load the canvas view exactly like the public canvas API does.
3. Verify `:documentId` is in that canvas result set.
4. Resolve `resourceIndex` from a normalized resource manifest on that document.
5. Serve only from local `cacache` by `sha256` key in the first implementation.
6. If fetch-on-miss is added later, do it behind strict backend-specific resolvers and cache the result before returning it.

### Resource Manifest

Each document that can expose binary/media data should carry normalized resource refs:

```js
{
  resources: [
    {
      kind: 'image',
      mimeType: 'image/jpeg',
      size: 123456,
      sha256: '...',
      source: {
        backend: 's3' | 'https' | 'local' | 'smb' | 'imap',
        ref: 'opaque backend ref'
      }
    }
  ]
}
```

Public routes must ignore raw `source.ref` except through a resolver. The public API returns resource URLs, not storage URLs.

### Components

- `ResourceExtractor`: turns indexed documents into normalized `resources[]`.
- `ResourceResolver`: backend-specific fetcher that knows how to validate and fetch one opaque ref.
- `PublicResourceGateway`: Fastify route that verifies share membership, reads `cacache`, and streams bytes.

### Security Rules

- No direct `https://`, S3, SMB, local path, or IMAP URLs in public output.
- No arbitrary path, bucket, host, key, or URL parameters from the public request.
- No backend FTS or dynamic public queries for resources.
- No local filesystem reads except through cache keys.
- SSRF protection if HTTPS fetch-on-miss is ever enabled: allowlist schemes, block private IPs, cap redirects, cap size, enforce timeout.
- Cache key is content identity: `sha256`, not storage location.

### KISS First Version

Only serve already-indexed `data/abstraction/file` resources that already have a `sha256` in `cacache`.

If the blob is missing, return `404` and make the owner re-index or pre-cache. Fetch-on-miss can come later when we are less likely to accidentally publish `/etc/passwd` with a nice card layout.
