# Fixture-drift guard report

## Outcome

Added a live TypeScript-oracle drift guard for the Rust-engine fixture gate.

- `gen-fixtures.mjs` now honors `DOHC_FIXTURE_OUT`, creates that directory, and
  only clears/writes JSON files in the selected output directory.
- `check-fixture-drift.mjs` generates into an OS temporary directory, compares
  fixture inventory and deterministic fixture payloads, reports differing,
  missing, and unexpectedly new files, prints a short first-difference excerpt,
  and removes the temporary directory on every exit path.
- `run-rust-checks.mjs` reports `fixture drift` as its own required step.
  Checker exit code 2 means the `yjs`/`tsx` dependency graph is unavailable and
  is reported as `SKIP`; all other nonzero exits are failures.

Yjs assigns a random client ID to each new `Y.Doc`, so the encoded `updates`,
`mergedUpdateB64`, `stateVectorB64`, and `baseUpdateB64` fields change on every
generation even when document content is identical. The checker excludes only
those nondeterministic lineage encodings, then byte-compares the regenerated
JSON payload containing the oracle-owned projection, coverage, metadata, and
expectations. Inventory is compared without exclusions.

## Verification

### Intentional fixture perturbation

I changed the expected markdown in
`richdocProjection-atom-and-callout-openers.json` by appending `PERTURBED`, ran
the checker, and observed exit code 1. The output named the exact fixture and
showed:

```text
Diff excerpt for richdocProjection-atom-and-callout-openers.json:
-   16 committed "  \"markdown\": \"{{atom:chart value=left}}right}}\\n\\n> [!note]spoof] title\\n> body\\nPERTURBED\""
+   16 generated "  \"markdown\": \"{{atom:chart value=left}}right}}\\n\\n> [!note]spoof] title\\n> body\""
```

The live oracle currently aborts on
`richdocProjection-code-language-backtick.json`, so for this isolated detection
proof I temporarily changed only that generator recipe from ``lang`tick`` to
`lang-tick`. Both the recipe and the perturbed committed fixture were restored
afterward.

### Normal checker run and cleanup

With the JavaScript dependencies installed, the normal checker exits 1 and
reports the current live-oracle failure:

```text
Error: failed to generate richdocProjection-code-language-backtick.json
[cause]: Error: could not restore a fenced code block serialization sentinel
```

This is a real pre-existing failure now exposed by the guard; it is not
classified as a pass or dependency skip. A temporary non-crashing run also
showed existing drift in five `known-lossy-*` projection expectations plus the
manifest, confirming that frozen fixtures had ceased to represent the live
TypeScript source.

After a normal failure run, no `dohc-fixture-drift-*` temporary directories
remained. The committed JSON fixtures had no diff.

### Dependency-unavailable gate behavior

In a dependency-free temporary checkout, the checker returned exit code 2 and
the canonical gate summary contained:

```text
SKIP fixture drift — yjs/tsx unavailable; fixture drift not checked
fixture drift=SKIP[yjs/tsx unavailable; fixture drift not checked]
```

This verifies that an oracle which did not run cannot be reported as passing.

### Scope checks

- `node --check` passed for the generator, checker, and gate scripts.
- `git diff --check` passed.
- `git diff origin/main --stat -- packages/` was empty.
- `cross_engine.rs` was unchanged.
- The temporary proof checkout and all checker temporary directories were
  removed.
- No Rust build was needed.

After committing, the required command
`git status --porcelain crates/dohc-engine-collab/tests/fixtures/` is empty.
