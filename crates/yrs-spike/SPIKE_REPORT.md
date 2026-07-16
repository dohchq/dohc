# YRS-SPIKE — yrs/Yjs interoperability spike report

Program context: `docs/superpowers/plans/2026-07-16-dohc-rust-engine-rewrite.md`,
section "Y.Doc: week-one spike and design". This spike is the rewrite
program's **sole abort criterion**.

## Verdict: PASS (with three mandatory R11 caveats)

The Rust `yrs` crate round-trips dohc's real Yjs documents with full
content-level fidelity — converged doc JSON (maps, text deltas with
formatting attributes, the full ProseMirror XmlFragment tree) AND markdown
projection, in both directions — **provided** the caveats below are honored.
Two of them were caught only because the fuzz ran adversarial non-ASCII
input; both have cheap, mechanical mitigations. R11a may start.

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

Harness: `scripts/fidelity.ts` + `src/main.rs`. **21/21 docs pass** —
12 synthetic corpus docs (the `ydocFidelity.test.ts` structures plus
unicode/CJK/emoji/RTL, deep nesting, typed frontmatter scalars, a 40-section
document, plaintext docs) and **9 harvested real dogfood docs (163 durable
updates + 9 snapshots)**. Per doc, all of the following hold:

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

Comparison is content-level (canonical JSON of maps, XmlElement trees with
attributes, text deltas with mark attributes), not state vectors. One root
fact both sides must share: **the Yjs v1 wire format does not carry
root-type kinds** — a root's kind (Map/Text/XmlFragment) is defined by typed
API access, so the Rust engine reads roots through the same declared dohc
schema the TS engine uses (`frontmatter`/`meta` maps, `body` XmlFragment,
`plainText` text).

### Criterion 2 — seeded alternating-driver fuzz: PASS

Harness: `scripts/fuzz.ts` (the permanent R11 regression harness;
re-runnable with `--seeds N --start S`, fixed client ids per seed, one PRNG
drives every choice). Each seed runs a **plaintext** doc (root Y.Text) and a
**richdoc** (ProseMirror XmlFragment: paragraph inserts/deletes, formatted
XmlText inserts with bold/italic marks) with edits alternating between the
Yjs driver and the yrs driver; delivery is randomly ordered, duplicated, and
adversarially truncated; some rounds sync via state-vector diffs instead of
raw update delivery.

**Result: 500/500 seeds passed (= 1,000 doc runs).** Totals: 7,519 JS edits,
5,906 Rust edits, 25,532 deliveries, 5,131 duplicate deliveries, 1,742
truncated-update injections (every one rejected cleanly by both sides, no
state corruption), 3,508 state-vector sync exchanges. End-state checks per
run: canonical content equality, semantic state-vector equality, identical
markdown projection, `merge_updates` reconstruction, full-state re-encode
reconstruction, and idempotent re-apply of already-integrated updates on
both sides.

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

1. **`OffsetKind::Utf16` is required — yrs defaults are wire-UNSAFE.**
   yrs `Options::default()` uses `OffsetKind::Bytes` (UTF-8 byte offsets).
   Yjs measures text in UTF-16 code units. On non-ASCII text a byte-offset
   doc desyncs item lengths — and therefore CRDT clocks — against Yjs peers:
   the pre-fix fuzz (seed 9, emoji/CJK content) produced genuine content
   divergence and a downstream **hard crash in Yjs's struct store**
   (`findIndexSS: Unexpected case`) while re-applying updates. Every Rust
   doc that exchanges updates with Yjs must be constructed with
   `OffsetKind::Utf16`. The harness pins this; R11 code review must treat a
   default-constructed `Doc` touching wire updates as a blocker.

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

Two engine-side observations recorded while building the harness (not yrs
issues): `yDocToMarkdown` is **not read-only** — y-prosemirror's
`createNodeFromYElement` deletes PM-schema-invalid elements (e.g. the empty
`listItem` present in two real dogfood docs) from the Y.Doc as a projection
side effect; and that normalization lands identically whichever side's bytes
seeded the doc (checked per fidelity doc). R11's settle path must assume
projection can mutate the live doc (it already does under the TS engine —
the mutation journals as ordinary updates).

## How to re-run

```
cargo build --manifest-path crates/yrs-spike/Cargo.toml
pnpm install --filter @dohc/yrs-spike-scripts...
node crates/yrs-spike/scripts/harvest.mjs <path-to-COPIED-engine.db>   # optional
pnpm --filter @dohc/yrs-spike-scripts fidelity
pnpm --filter @dohc/yrs-spike-scripts fuzz -- --seeds 500
```

A failing fuzz seed replays exactly: `... fuzz -- --seeds 1 --start <seed>`.

## Harness inventory

- `src/main.rs` — yrs stdio JSON harness (apply/diff/state/content/merge +
  yrs-driven text/XML edits returning the exact encoded delta). `#![forbid
  (unsafe_code)]` via `[lints.rust] unsafe_code = "forbid"`.
- `scripts/rustPeer.ts` — protocol client (spawns the binary, builds it if
  missing).
- `scripts/canonical.ts` — the shared canonical content JSON both sides
  compute independently, plus normalization (key sort, adjacent-run merge)
  and diff reporting.
- `scripts/corpus.ts`, `scripts/fidelity.ts` — criterion 1 (+ probes).
- `scripts/fuzz.ts` — criteria 2/4; the permanent R11 regression harness.
- `scripts/harvest.mjs` — fixture extraction from a copied engine.db
  (refuses paths that look like a live workspace DB; fixtures stay local).
