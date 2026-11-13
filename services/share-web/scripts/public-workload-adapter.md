# Prepare selected public fixtures

This reference is for the coordinator preparing public proof after numerical selection.
The adapter does not select limits, search cases, or establish release acceptance.

From a prepared share-web checkout, run:

```powershell
node --import tsx scripts/prepare-public-workload.mjs C:/evidence/selection-pin.json C:/evidence/new-fixtures
```

Both arguments must be absolute paths. The output directory must not exist.
The first file contains a `WorkloadPin` for the selection JSON: `path`, `sha256`, and `byteLength`.
Input pins resolve relative to the selection file. Corpus blob pins resolve relative to the corpus manifest.
The adapter accepts uppercase calibration hashes and writes lowercase public hashes.

[`PublicFixtureSelection`](../src/publicWorkloadAdapter.integration-helper.ts) defines the selection's fields.
The selection states every amount and mapping, and pins every `adapterImplementationPaths` entry in that file.

The adapter copies the selected checkpoint unchanged; it does not fold suffix entries into it.
It copies all selected source bytes into the output, including suffixes and candidates.
It validates the selected cuts before it constructs fixtures, and rejects refusals and ineffective candidates.
Each wire round appends the supplied paragraphs with independent writer IDs.
The adapter does not duplicate or relabel a source delta to manufacture concurrency.

All six transition mappings are required: `restart`, `staleFrame`, `selectorDrift`, `accessChange`, `restore`, and `view`.
Every mapping needs accepted updates. Every non-View mapping needs an interrupted update.
Restart and stale-frame also need resumed updates. Restore needs only a continuation recipe and delivery ID.
Recipes have exactly `{version: 1, kind: "append-paragraph", text: "..."}`, with nonempty text.

`FixtureRenderingContext` in the same file defines the rendering context.
Each of its `images` and `links` maps associates a resolver input with its production result or `null` for refusal.
Missing resolver entries fail preparation. The production MarkdownContent component still applies its URL checks.
Preparation mounts the production editor and View components in jsdom, then records their DOM text.
This does not replace Chromium render checks in the public proof.

On success, `result.json` points to both loader-compatible manifests and the derivation receipt.
The receipt preserves source mappings, policy, context, admission evidence, generated writer IDs, and asset pins.
Restore contains no submitted candidate bytes. Native proof must derive those bytes from the actual restored document.
A failed attempt leaves its partial assets for inspection and does not write `result.json`.

The tiny unit fixtures use `purpose: "tiny-adapter-test"`. They are not admitted workloads or calibration evidence.
Selected campaigns use `purpose: "selected-public-proof"`. Both receipts keep release acceptance and browser proof false.
