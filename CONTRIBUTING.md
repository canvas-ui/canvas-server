# Contributing to Canvas

Contributions are welcome, and bug reports, fixes and tests especially. Canvas
is a work in progress, and the parts that get used are the parts that get good.

## Before you open a pull request

**You will be asked to sign the [CLA](CLA.md).** It is a one-time thing and
covers all your future contributions to the dual-licensed Canvas repositories:
`canvas-server`, `canvas-synapsd`, `canvas-stored`, `canvas-neurald` and
`canvas-web`. Comment on your first pull request with:

```
I have read the CLA document and I hereby sign the CLA.
```

If you are contributing on behalf of an employer, make sure whoever can bind
them has agreed. See section 6 of the CLA.

## Why a CLA and not just a DCO

Those repositories are dual-licensed: AGPL-3.0-or-later for everyone, plus a
commercial licence for those who cannot accept copyleft (see
[COMMERCIAL.md](COMMERCIAL.md)). The second option exists only while the
copyright holder actually has the right to license the whole codebase under
terms other than the AGPL.

A Developer Certificate of Origin does not provide that right. A DCO certifies
where your code came from and that you may submit it. It grants nothing beyond
the project's existing licence. If contributions arrived under a DCO alone, each
one would become a permanent veto over commercial licensing, and the option
would quietly disappear as the project grew.

The CLA is the narrowest instrument that keeps that door open. **You keep
copyright in your contribution.** It is a licence grant rather than an
assignment, so you can relicense your own work elsewhere, reuse it, or publish
it independently.

Section 4 of the CLA is the commitment in the other direction: every
contribution stays available under the AGPL. Commercial licensing cannot be used
to take the open version away.

## The clients ask for no CLA

`canvas-cli`, `canvas-shell`, `canvas-fuse`, `canvas-desktop` and
`canvas-browser-extensions` are AGPL-only. Nothing there is ever sublicensed, so
there is nothing a CLA would need to grant, and a DCO sign-off (`git commit -s`)
is all those repositories ask for.

If the CLA is what stops you, contribute there instead. The clients are the
parts users touch first, and they are where help is most useful right now.

## Practical notes

- **Discuss large changes first.** Open an issue before a big refactor.
- **Match the surrounding code.** Comment density and naming vary by module, so
  follow the file you are in.
- **Run the checks:** `npm run lint` and `npm test`.
- **Submodules are separate repositories.** SynapsD, StoreD, the web UI, the CLI
  and the other clients each live in their own repo under
  [github.com/canvas-ui](https://github.com/canvas-ui). Open the pull request
  against the repository the code lives in, not against `canvas-server`.
- **Leave the source notices alone.** The `X-Source-Code` header and the licence
  fields in `/rest/v2/ping` implement section 13 of the AGPL and need to stay.

## Reporting security issues

Please do not open a public issue for a vulnerability. See
[docs/SECURITY.md](docs/SECURITY.md), or email **security@augmentd.eu** directly.

Questions about contributing: **contrib@augmentd.eu**
