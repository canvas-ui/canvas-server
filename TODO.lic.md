# Licensing groundwork — what is done, what is left

Status of the move to explicit dual licensing (AGPL-3.0-or-later + commercial).
Everything in **canvas-server** is done; the submodules are separate repositories
and need the same treatment.

Copyright holder: **Jozef Melich**.
Commercial licensing entity: **Augmentd s.r.o.** (IČO 45331936), under licence
from the copyright holder.

---

## Done — canvas-server

- `NOTICE` — copyright, network-use clause, component inventory, commercial contact
- `COMMERCIAL.md` — the dual-licensing offer
- `CONTRIBUTING.md` + `CLA.md` — contribution policy and the CLA that keeps
  commercial licensing possible
- `README.md` — Licence section
- Licence metadata fixed: `embedd` (was **ISC**), `messaging`, `voice`,
  `core/agent` (all had none); `LICENSE` file added to `embedd`
- `repository` / `homepage` / `bugs` added to the root manifest
- **AGPL §13 source offer implemented and verified:**
  - `X-Source-Code` header on every response (`src/transports/index.js`)
  - `sourceUrl` / `commit` / `license` in `GET /rest/v2/ping`
  - `CANVAS_SOURCE_URL` / `CANVAS_SOURCE_COMMIT` overrides for forks and for
    builds without git metadata; commit baked into the image via build args
  - fixed a real bug on the way: `/ping` and `/rest/v2/ping` reported
    `undefined` for name and version on every deployment that did **not** start
    via an npm script — i.e. the container and the systemd unit in the README

---

## Left to do

### 1. Per-repository fixes

Each submodule is its own repo and needs its own commit. Copy `NOTICE`,
`COMMERCIAL.md`, `CONTRIBUTING.md` and `CLA.md` from here into each, adjusting
the component list in `NOTICE`.

| Repository | LICENSE file | Manifest `license` | Action |
|---|---|---|---|
| **canvas-synapsd** | ❌ **missing entirely** | ✅ AGPL | **Add `LICENSE`.** Highest priority — the most valuable component in the project has no licence text at all, only a manifest field |
| **canvas-neurald** | ✅ AGPL | ❌ says **ISC** | Fix `package.json` — it contradicts its own LICENSE file |
| **canvas-fuse** | ✅ AGPL | ❌ none in `Cargo.toml` | Add `license = "AGPL-3.0-or-later"` |
| **canvas-web** | ✅ AGPL | ❌ no field | Add `"license": "AGPL-3.0-or-later"` |
| **canvas-desktop** | ✅ AGPL | ❌ no field | Add `"license": "AGPL-3.0-or-later"` |
| **canvas-stored** | ✅ AGPL | ✅ AGPL | `NOTICE` only |
| **canvas-cli** | ✅ AGPL | ✅ AGPL | `NOTICE` only |
| **canvas-shell** | ✅ AGPL | — no manifest | `NOTICE` only |
| **canvas-browser-extensions** | ✅ AGPL | ✅ AGPL | `NOTICE` only |

A contradictory or absent licence is the single most useful thing a
non-complying user can point at. Until these are fixed, "we understood that
component was permissively licensed" is a defence that partly works.

### 2. Contributor rights — the one real gap

`canvas-server` is clean: every commit is yours, so it can be dual-licensed
today with no one else's agreement. Two repositories are not:

- **canvas-web** — Levan Tarbor (`tarborlevan@gmail.com`), 12 commits
- **canvas-browser-extensions** — Levan Tarbor, ~51 commits

(`melichj` is you, so it needs nothing.)

You said this was paid Upwork work commissioned by the company. Upwork's default
service contract assigns work product to the **client on payment** — but the
client there was **Augmentd s.r.o.**, whereas copyright in everything else is
held by **you personally**. So those two repositories likely have a *different*
copyright holder from the rest of the project, in the opposite direction to the
Melich → Augmentd licence.

That is worth closing properly, in either direction:

- have **Augmentd s.r.o. assign** Tarbor's contributions to you, so one holder
  covers everything; **or**
- have **Tarbor sign the CLA** retroactively, which grants the sublicensing right
  regardless of who holds the copyright.

Do both if it is easy — they are cheap now and expensive later. Also confirm
which Upwork contract terms were actually used; if it was not the default
agreement with its IP-assignment clause, the assignment may not have happened at
all.

### 3. Web UI — the human-readable half of §13

The server side is done, but the AGPL's own guidance (and the plain reading of
§13) is that a web application should offer users a visible route to the source.
In **canvas-web**, add a "Source" link — footer, About dialog, or both — fed
from `GET /rest/v2/ping` (`sourceUrl`, `version`, `commit`). The
`X-Source-Code` header is already CORS-exposed, so the UI can read it off any
response instead if that is easier.

Do this on the **public share pages** (`/pub/c/:id`) especially: those are the
surface anonymous network users actually reach, so they are where the obligation
bites hardest and where a link doubles as attribution.

### 4. Get the legal text reviewed

`CLA.md` and `COMMERCIAL.md` are drafted to be sane and readable, not
lawyer-vetted. Before anyone signs, have Slovak counsel check:

- the CLA's sublicensing grant (§2) — it is the clause the whole commercial
  option rests on
- the governing-law and severability clauses
- how the Melich → Augmentd licence is papered, and whether Augmentd's right to
  issue commercial sublicences is written down anywhere other than `NOTICE`
- the actual commercial licence agreement — `COMMERCIAL.md` is deliberately an
  invitation to negotiate, not an offer capable of acceptance. You still need
  the real thing to sign.

### 5. Copyright year

`NOTICE` and `README.md` say **2026**, which is all this shallow clone can
prove — its history starts 2026-08-03. If the project was first published
earlier, widen it (`2019-2026`, or whatever the true first-publication year is)
across every repository. Understating it costs you nothing legally but misstates
the record.

### 6. Tag a release

No tags on canvas-server, canvas-synapsd or canvas-web (canvas-cli has 5).
Enterprise deals are signed against a version, not a branch — MBAG will ask
which version they are licensing, and "main as of Tuesday" is not an answer.
Tag `v2.2.0` at minimum.

### 7. Trademark

AGPL grants no trademark rights, which normally makes the name the cheapest
lever a solo maintainer has: a fork may use the code but not the name. "Canvas"
is weak for this — generic, and Instructure's Canvas LMS is already there.
**SynapsD** is distinctive and defensible, and is the component with the most
work in it. If you want a name-based lever, register that one.

---

## Unrelated defect noticed

`package.json` declares the workspace `packages/api-client`, but neither
`packages/` nor that directory exists. npm tolerates it silently. Left alone in
case it is about to be added — remove the entry if not.

---

## On the New Zealand deployment

Order matters. Do not open the conversation until steps 1–3 are done: the
argument is much weaker while SynapsD ships with no LICENSE file and neurald
claims ISC.

1. **Fix the metadata** (steps 1–3 above), so the licensing position is
   unambiguous on the day it is quoted.
2. **Publish `COMMERCIAL.md`**, so a door exists. You cannot sell an exemption
   that has never been offered — part of why this happened at all.
3. **Then write to them.** State plainly that the server runtime and SynapsD are
   AGPL-3.0-or-later, that §13 applies to a hosted product, and ask for the
   corresponding source of their modifications. Friendly tone, but in writing and
   dated — under §8 rights terminate on violation, and the timeline matters if it
   ever escalates.
4. **Check their deployment first.** `curl -sI <their-host>` and
   `curl -s <their-host>/rest/v2/ping` — once they deploy any build carrying the
   §13 work above, whether the header is present, absent or repointed tells you
   what you are dealing with before you say a word.

Realistic outcomes: they publish their changes, they buy a licence, or they walk.
All three are acceptable. Do not threaten litigation you will not fund —
cross-border enforcement against a small foreign startup costs more than they
would ever pay.

The best outcome is the one you actually want: a paying design partner running
Canvas under production load. That is a better SynapsD test bed than anyone you
will recruit for free, and it turns the licence conversation into a commercial
one instead of a grievance.
