# yrs-interop: yrs and Yjs interoperability harness

Reader: anyone bumping `yjs` or `yrs`, or changing how the engine constructs or re-encodes a Y.Doc.

This crate and its `scripts/` directory hold the harness that proved the Rust `yrs` crate round-trips dohc's Yjs documents with full content fidelity, and the regression tests for the vendored `yrs` patch (`vendor/yrs-0.27.3/DOHC-PATCH.md`). The canonical Rust gate builds and tests it with the rest of the workspace. The four caveats below are enforced in `crates/dohc-engine-collab/src/ydoc.rs`.

## Pinned interop pair

| side | package | version | where pinned |
| ---- | ------- | ------- | ------------ |
| TypeScript | `yjs` | 13.6.30 | `crates/yrs-interop/scripts/package.json` pins `"yjs": "13.6.30"` exactly |
| Rust | `yrs` | 0.27.3 | `crates/yrs-interop/Cargo.toml` pins `yrs = "=0.27.3"` |

Treat these as one audited unit. A lone upgrade of either side can silently reopen interop divergence. Any bump must re-run the fidelity and fuzz harnesses before landing.

## Caveats every Y.Doc consumer must honor

1. **`OffsetKind::Utf16` is required.** yrs defaults to `OffsetKind::Bytes`; Yjs measures text in UTF-16 code units. Byte and UTF-16 offsets coincide for ASCII, so the failure appears only under non-ASCII content. The pinned bytes-mode probe in `scripts/fidelity.ts` shows two deterministic manifestations with emoji: the same insert lands at a different position, and a UTF-16-valid but byte-invalid offset panics yrs (`block.rs: attempt to subtract with overflow`). A default-constructed `Doc` touching wire updates is a review blocker.

2. **Nested `Any::Map` key order is not preserved through a yrs re-encode.** Yjs preserves insertion order for nested plain objects; yrs stores `Any::Map` as a `HashMap`, so a re-encode emits nested entries in per-process random order. Convergence and semantic content are unaffected. Visible effects: YAML key order of nested frontmatter objects in the Markdown projection, and byte instability of re-encoded snapshot blobs. Sort nested frontmatter keys at projection time and never assume snapshot-blob byte identity across processes.

3. **Well-formed UTF-16 at the adapter boundary.** yjs 13.6.30 sanitizes surrogate-splitting inserts to U+FFFD and yrs agrees exactly (pinned by the surrogate probe). JS strings can still hold lone surrogates, which Rust strings cannot represent. Validate `isWellFormed()` on text before journaling it so a future yjs behavior change cannot put a lone surrogate into a lineage a Rust peer must replay.

4. **yjs `applyUpdate` is not atomic on malformed input; yrs is.** When yjs throws on a truncated update it can leave a partially integrated prefix in the doc. yrs decodes the whole update before applying, so a yrs rejection leaves state unchanged (pinned by the truncation-atomicity probe at CRDT-state level). The partial prefix always converges once the genuine update arrives. Treat an `applyUpdate` exception as "the doc may hold a partial prefix": safe under the durable update log, but never assume state is unchanged after a failed apply, and never journal bytes that failed validation.

The fault model covered here is truncation only: prefix cuts of genuine updates. Arbitrary-byte and bit-flip robustness is not covered by this harness.

One engine-side observation: `yDocToMarkdown` is not read-only. y-prosemirror's `createNodeFromYElement` deletes schema-invalid elements from the Y.Doc as a projection side effect, and that normalization lands identically whichever side's bytes seeded the doc. The settle path must assume projection can mutate the live doc.

## Run the harness

The scripts always `cargo build` before spawning the Rust peer, so a stale binary can never certify.

```
pnpm install --filter @dohc/yrs-interop-scripts...
pnpm --filter @dohc/yrs-interop-scripts fidelity
pnpm --filter @dohc/yrs-interop-scripts fuzz -- --seeds 500 --strict
```

`--strict` promotes fault-injection caveats to hard failures and is required for certification. A failing fuzz seed replays exactly with `fuzz -- --seeds 1 --start <seed> --strict`.

The fidelity run accepts an optional corpus harvested from a copied `engine.db` (`node scripts/harvest.mjs <path-to-copied-engine.db>`, Node 22.13 or newer for `node:sqlite`). Harvested fixtures live in the gitignored `fixtures/harvested/` and stay local because they can contain personal content. `--require-harvested` fails when that corpus is absent or degenerate; without it the synthetic corpus runs alone and prints a note.

## Harness inventory

- `src/main.rs`: yrs stdio JSON harness (apply, diff, state, content, merge, plus yrs-driven text and XML edits returning the exact encoded delta). Bytes-mode doc construction exists only for the pinned divergence probe.
- `scripts/rustPeer.ts`: protocol client. Rebuilds the harness before first spawn; a dead harness fails runs instead of hanging them.
- `scripts/canonical.ts`: the canonical content JSON both sides compute independently, normalization, undeclared-root detection, and diff reporting.
- `scripts/corpus.ts` and `scripts/fidelity.ts`: the fidelity corpus and the three pinned probes (surrogate, bytes-mode, truncation-atomicity).
- `scripts/fuzz.ts`: the seeded alternating-driver fuzz. One PRNG drives every choice, so any seed replays deterministically.
- `scripts/harvest.mjs`: fixture extraction from a copied engine.db. Refuses paths that resolve to a live workspace DB.
- `tests/`: regression tests for the vendored yrs patch.
