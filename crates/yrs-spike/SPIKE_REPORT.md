# YRS-SPIKE — yrs/Yjs interoperability spike report

Program context: `docs/superpowers/plans/2026-07-16-dohc-rust-engine-rewrite.md`,
section "Y.Doc: week-one spike and design". This spike is the rewrite
program's **sole abort criterion**.

## Verdict: PASS (with four mandatory R11 caveats)

The Rust `yrs` crate round-trips dohc's real Yjs documents with full
content-level fidelity — converged doc JSON (maps, text deltas with
formatting attributes, the full ProseMirror XmlFragment tree) AND markdown
projection, in both directions — **provided** the caveats below are honored.
Three of the four were caught only because the harness ran adversarial
non-ASCII/fault input; all have cheap, mechanical mitigations. R11a may
start.

**Fault model.** The malformed-input coverage in this spike is
**truncation-only** (prefix cuts of genuine updates, exhaustive per-cut in
the pinned probe, randomized in the fuzz). Arbitrary-byte / bit-flip /
adversarially crafted update robustness is NOT covered here and is future
`cargo-fuzz` work for R11 — "rejected cleanly" claims below are scoped to
truncation.

## Pinned interop pair

| side | package | version | where pinned |
| ---- | ------- | ------- | ------------ |
| TypeScript | `yjs` | **13.6.30** | `pnpm-lock.yaml`; `crates/yrs-spike/scripts/package.json` pins `"yjs": "13.6.30"` exactly |
| Rust | `yrs` | **0.27.3** | `crates/yrs-spike/Cargo.toml` pins `yrs = "=0.27.3"` |

Treat these as one audited unit: a lone upgrade of either side can silently
reopen interop divergence. Any bump must re-run this harness (fidelity +
fuzz) before landing.

## Criterion results

### Criterion 1 — fidelity corpus through yrs: PASS

Harness: `scripts/fidelity.ts` + `src/main.rs`. **23/23 docs pass** —
14 synthetic corpus docs (the `ydocFidelity.test.ts` structures plus
unicode/CJK/emoji/RTL, deep nesting, typed frontmatter scalars, a 40-section
document, plaintext docs, and two committed **multi-update incremental
lineages** — 13 captured update blobs each — so the reverse-order/pending-
update path runs on every fresh checkout without harvested fixtures) and
**9 harvested real dogfood docs (163 durable updates + 9 snapshots)**.
Certification runs pass `--require-harvested`, which exits nonzero when the
real-lineage corpus is absent; without the flag a missing corpus prints a
loud NOT-EXERCISED warning. Any `undeclaredRoot` (a root outside the shared
dohc schema, whose contents the comparison would never read) is a hard
failure on either side. Per doc, all of the following hold:

- JS→Rust: yrs applies the JS-encoded update log **in order and in reverse
  order** (exercising the pending-update store) and its independently
  computed content JSON equals the Yjs view.
- Rust→JS: a fresh Y.Doc built purely from yrs's full-state re-encode has
  identical content JSON **and identical markdown projection**.
- Round trip closes: re-encoding that doc back into a fresh yrs doc matches.
- State vectors agree semantically; cross diffs are no-ops.
- `Update::merge_updates` of the whole log reconstructs identical content
  and identical markdown (compaction analog).
- Post-projection schema normalization lands identically on both lineages.

Three deterministic probes run before the corpus and pin the interop edges
(each fails loudly if a future yjs/yrs pair changes behavior):

- **surrogate probe** — a surrogate-pair-splitting insert is sanitized to
  U+FFFD by yjs and yrs agrees byte-for-byte;
- **bytes-mode probe** — `OffsetKind::Bytes` positional divergence and the
  mid-char-offset panic (see caveat 1);
- **truncation-atomicity probe** — every prefix cut of a multi-transaction
  update against both sides (see caveat 4).

The markdown-order caveat classifier admits a mismatch as "nested
frontmatter key order" only when the bodies are byte-identical AND both
YAML frontmatters parse deep-equal — anything else fails.

Comparison is content-level (canonical JSON of maps, XmlElement trees with
attributes, text deltas with mark attributes), not state vectors. One root
fact both sides must share: **the Yjs v1 wire format does not carry
root-type kinds** — a root's kind (Map/Text/XmlFragment) is defined by typed
API access, so the Rust engine reads roots through the same declared dohc
schema the TS engine uses (`frontmatter`/`meta` maps, `body` XmlFragment,
`plainText` text).

### Criterion 2 — seeded alternating-driver fuzz: PASS

Harness: `scripts/fuzz.ts` (the permanent R11 regression harness;
re-runnable with `--seeds N --start S`; `--strict` promotes fault-injection
caveats to hard failures and is REQUIRED for certification). Deterministic
by construction: one PRNG drives every choice and every item — including
the base lineage — is minted under fixed, seed-derived client ids (the seed
content is rebuilt on a fixed-clientID doc; projection-helper docs mint
random ids). Review-batch fix worth knowing: the harness protocol
previously dropped the `clientId`/`offsetKind` fields silently (serde's
`rename_all` renames enum variants, not fields), so pre-batch Rust client
ids were random; correctness was unaffected, replay determinism now holds
by construction. Each seed runs a **plaintext** doc (root Y.Text) and a
**richdoc** (ProseMirror XmlFragment: paragraph inserts/deletes, formatted
XmlText inserts with bold/italic marks) with edits alternating between the
Yjs driver and the yrs driver; delivery is randomly ordered, duplicated, and
fault-injected with truncated updates; some rounds sync via state-vector
diffs instead of raw update delivery. Every run must land Rust-side edits
(a run where all yrs edits skipped fails; non-editable random targets fall
back to a guaranteed yrs paragraph insert), and only the harness's typed
`not-editable:` rejection may skip an edit — any other Rust error fails the
run.

**Result: 500/500 seeds passed under `--strict` (= 1,000 doc runs).**
Totals: 7,507 JS edits, 7,519 Rust edits, 28,200 deliveries, 5,665
duplicate deliveries, 2,041 truncated-update injections (zero accepted by
either side; fault model is truncation-only — see above), 67 yjs
partial-prefix applications on rejected truncations (all recovered — see
caveat 4; zero corruption), 3,511 state-vector sync exchanges. End-state
checks per run: canonical content equality, no undeclared roots, semantic
state-vector equality, identical markdown projection, `merge_updates`
reconstruction, full-state re-encode reconstruction, and idempotent
re-apply of already-integrated updates on both sides.

### Criterion 3 — real durable-update fixtures: DONE (harvested)

Harvested from a **copy** of the founder's dogfood
`~/dohc/personal/.dohc/engine/engine.db` (copied to scratchpad,
`PRAGMA integrity_check` = ok on the copy, live DB never opened): 9
`ydoc_docs` lineages, 9 snapshots, 163 trailing updates, all content-kind
richdoc, extracted blob-by-blob via `scripts/harvest.mjs`. Fixtures live in
`fixtures/harvested/` which is **gitignored** (they can contain personal
content and stay local); the harness runs the synthetic corpus alone when
they are absent and prints a note. Re-harvest anytime with
`node scripts/harvest.mjs <path-to-copied-engine.db>`.

### Criterion 4 — state vectors, compaction, lineage/echo analysis: PASS

- **State vectors across alternating JS/Rust edits**: exchanged and
  semantically compared 3,508 times inside the fuzz plus once per fidelity
  doc; yrs `StateVector` decode/encode agrees with `Y.encodeStateVector` /
  `Y.decodeStateVector` in both directions (compare decoded maps, not raw
  bytes — entry order within the encoded map is not guaranteed identical).
- **Snapshot/compaction without convergence change**: both compaction
  primitives verified per doc/run — `Update::merge_updates` over the full
  update log, and full-state re-encode
  (`encode_state_as_update_v1(&StateVector::default())`). Both reconstruct
  byte-identical projections and identical content. This is exactly the
  shape `ydocEngineDriver.compact()` needs (fold log → snapshot row).
- **Base-once lineage**: nothing in yrs changes the analysis in
  `ydocReplication.test.ts` — two independent seeds still mint different
  item ids and would fork a lineage. The Rust cache must preserve the
  driver's base-once/resume discipline; the update stream itself is
  implementation-agnostic (yrs consumes the TS-minted base + deltas
  unchanged, proven by the harvested lineages).
- **Origin/echo-suppression**: Yjs transaction origins are a local API
  construct and are **not present in the wire format** — nothing for Rust to
  preserve or corrupt. The adapter-layer design (reserved
  `REMOTE_YDOC_APPLY_ORIGIN`, idempotency keys, sequence metadata) lives
  entirely in TS; the CRDT-level guarantee Rust relies on — re-applying an
  already-integrated update is a strict no-op — was mechanically verified on
  both sides in every fuzz run (5,131 duplicates + 3 forced re-applies per
  run).

## Mandatory caveats for R11 (all cheap, all mechanical)

1. **`OffsetKind::Utf16` is required — yrs defaults are unsafe against Yjs
   peers.** yrs `Options::default()` uses `OffsetKind::Bytes` (UTF-8 byte
   offsets); Yjs measures text in UTF-16 code units. The failure is
   **probabilistic under fuzzing, not "any non-ASCII text"**: byte and
   UTF-16 offsets coincide for ASCII and for boundary-aligned positions, so
   many seeds pass under Bytes (independent review confirmed seeds 1–3 pass;
   the pre-fix fuzz diverged at seed 9 with emoji/CJK content and later
   crashed Yjs's struct store — `findIndexSS: Unexpected case` — while
   re-applying updates). The pinned `bytes-mode probe` in `fidelity.ts`
   demonstrates two DETERMINISTIC manifestations with emoji content (4
   UTF-8 bytes / 2 UTF-16 units): (a) the same insert request lands at a
   different document position under Bytes than under Utf16, and (b) a
   UTF-16-valid offset that is byte-invalid (mid-char) **panics yrs
   outright** (`yrs-0.27.3/src/block.rs:1613: attempt to subtract with
   overflow`), killing the process. Every Rust doc that exchanges updates
   with Yjs must be constructed with `OffsetKind::Utf16`; R11 code review
   must treat a default-constructed `Doc` touching wire updates as a
   blocker.

2. **Nested `Any::Map` key order is not preserved (and is nondeterministic
   per process) through a yrs re-encode.** Yjs preserves JS-object insertion
   order for plain-object values (e.g. a nested frontmatter map); yrs stores
   `Any::Map` as `std::collections::HashMap`, so a re-encode emits nested
   entries in random per-process order. Convergence and semantic content are
   unaffected (verified); the visible surfaces are (a) YAML key order of
   **nested** frontmatter objects in the markdown projection (top-level keys
   are already sorted by `orderFrontmatter`), and (b) **byte** stability of
   re-encoded snapshot blobs — two compactions of identical state can hash
   differently, weakening content-addressed dedup (correctness unaffected).
   Remediation before cutover: make `yDocToMarkdown` sort nested frontmatter
   map keys (small TS change, deterministic on both sides), and don't assume
   snapshot-blob byte identity across processes. The harvested dogfood corpus
   contains no nested frontmatter objects today.

3. **Well-formed UTF-16 at the adapter boundary.** yjs 13.6.30 sanitizes
   surrogate-pair-splitting inserts to U+FFFD at insert time, and yrs agrees
   exactly (pinned by the surrogate probe in `fidelity.ts`). But JS strings
   can still hold lone surrogates, and Rust strings cannot represent them at
   all — the R11 TS adapter should validate `isWellFormed()` on text it
   journals so no future yjs behavior change can smuggle a lone surrogate
   into a lineage a Rust peer must replay.

4. **yjs `applyUpdate` is NOT atomic on malformed input; yrs is.** NEW
   FINDING from the review batch's fault-injection hardening: when yjs
   rejects (throws on) a truncated update, it can leave a
   **partially-integrated prefix** of the real items in the doc (readUpdate
   integrates structs while decoding). yrs decodes the full update before
   applying, so a yrs rejection is state-unchanged — pinned mechanically by
   the truncation-atomicity probe (every prefix cut of a multi-transaction
   update: 0 cuts accepted by either side, yrs content byte-unchanged across
   all rejected cuts, yjs left a partial prefix on some cuts). The pinned
   recovery invariant: the partial prefix **always converges once the
   genuine update is delivered** (0 permanent divergences across every probe
   cut and all 67 fuzz occurrences). R11 consequence: the TS adapter must
   treat an `applyUpdate` exception as "doc may hold a partial prefix" — 
   safe under dohc's durable update log (the full update is re-delivered),
   but never assume state-unchanged after a failed apply, and never journal
   bytes that failed validation.

Two engine-side observations recorded while building the harness (not yrs
issues): `yDocToMarkdown` is **not read-only** — y-prosemirror's
`createNodeFromYElement` deletes PM-schema-invalid elements (e.g. the empty
`listItem` present in two real dogfood docs) from the Y.Doc as a projection
side effect; and that normalization lands identically whichever side's bytes
seeded the doc (checked per fidelity doc). R11's settle path must assume
projection can mutate the live doc (it already does under the TS engine —
the mutation journals as ordinary updates).

## How to re-run

Dev runs (Node >= 22.13 required for `node:sqlite` in harvest.mjs; the
scripts always `cargo build` before spawning so a stale binary can never
certify):

```
pnpm install --filter @dohc/yrs-spike-scripts...
node crates/yrs-spike/scripts/harvest.mjs <path-to-COPIED-engine.db>   # optional
pnpm --filter @dohc/yrs-spike-scripts fidelity
pnpm --filter @dohc/yrs-spike-scripts fuzz -- --seeds 500
```

**Certification** (what this report's numbers come from) requires the
harvested corpus and strict fault handling:

```
pnpm --filter @dohc/yrs-spike-scripts fidelity -- --require-harvested
pnpm --filter @dohc/yrs-spike-scripts fuzz -- --seeds 500 --strict
```

A failing fuzz seed replays exactly: `... fuzz -- --seeds 1 --start <seed> --strict`.

## Harness inventory

- `src/main.rs` — yrs stdio JSON harness (apply/diff/state/content/merge +
  yrs-driven text/XML edits returning the exact encoded delta; typed
  `not-editable:` rejections; optional Bytes-mode doc construction used
  ONLY by the pinned divergence probe). `#![forbid(unsafe_code)]` via
  `[lints.rust] unsafe_code = "forbid"`.
- `scripts/rustPeer.ts` — protocol client. Always rebuilds the harness
  before first spawn; per-request timeout; child exit/error and malformed
  stdout lines reject all pending requests (a dead harness fails runs, it
  never hangs them); relative `CARGO_TARGET_DIR` resolves against the crate
  dir, matching cargo.
- `scripts/canonical.ts` — the shared canonical content JSON both sides
  compute independently, plus normalization (key sort, adjacent-run merge),
  undeclared-root detection, and diff reporting.
- `scripts/corpus.ts`, `scripts/fidelity.ts` — criterion 1 + the three
  pinned probes (surrogate, bytes-mode, truncation-atomicity).
- `scripts/fuzz.ts` — criteria 2/4; the permanent R11 regression harness.
- `scripts/harvest.mjs` — fixture extraction from a copied engine.db.
  Refuses paths that RESOLVE to a live workspace DB via
  `realpathSync.native` (GetFinalPathNameByHandle: symlinks, junctions, AND
  Windows 8.3 short-name aliases — JS `realpathSync` resolves links but
  does NOT expand 8.3 aliases); validates the source before touching the
  existing corpus (stages to a temp dir, swaps in on success); fixtures
  stay local.
