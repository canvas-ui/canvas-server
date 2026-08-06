# Contributing to Canvas

Contributions are welcome — bug reports, fixes, tests especially. Canvas is a
work in progress and the parts that get used are the parts that get good.

## Before you open a pull request

**You will be asked to sign the [CLA](CLA.md).** One-time, covers all your
future contributions to every Canvas repository. Comment on your first pull
request with:

```
I have read the CLA document and I hereby sign the CLA.
```

If you are contributing on behalf of an employer, make sure whoever can bind
them has agreed — see the CLA's section 6.

## Why a CLA and not just a DCO

Canvas is dual-licensed: AGPL-3.0-or-later for everyone, and a commercial
licence for those who cannot accept copyleft (see [COMMERCIAL.md](COMMERCIAL.md)).
The second option only exists while the copyright holder actually has the right
to license the whole codebase under terms other than the AGPL.

A Developer Certificate of Origin does not provide that. A DCO certifies where
your code came from and that you may submit it — it grants no rights beyond the
project's existing licence. If contributions arrived under a DCO alone, every
one of them would be a permanent veto over commercial licensing, and the option
would quietly disappear as the project grew.

The CLA is the narrowest instrument that keeps that door open. **You keep
copyright in your contribution.** It is a licence grant, not an assignment: you
can relicense your own work elsewhere, reuse it, or publish it independently.

The reciprocal commitment is in section 4 of the CLA: every contribution stays
available under the AGPL. Commercial licensing cannot be used to take the open
version away.

## Practical notes

- **Discuss large changes first.** Open an issue before a big refactor.
- **Match the surrounding code.** Comment density and naming vary by module;
  follow the file you are in.
- **Run the checks:** `npm run lint` and `npm test`.
- **Submodules are separate repositories.** SynapsD, StoreD, the web UI, the CLI
  and the clients each live in their own repo under
  [github.com/canvas-ui](https://github.com/canvas-ui) — open the pull request
  against the repository the code lives in, not against `canvas-server`.
- **Don't remove the source notices.** The `X-Source-Code` header and the
  licence fields in `/rest/v2/ping` implement AGPL §13 and are required to stay.

## Reporting security issues

Please do not open a public issue for a vulnerability. See
[docs/SECURITY.md](docs/SECURITY.md), or email **me@idnc.sk** directly.
