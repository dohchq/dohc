# Testing

Run the checks from the repository root.

```bash
pnpm typecheck
pnpm test
pnpm check:debt
node tools/rust-engine-program/run-rust-checks.mjs
```

Read the Rust gate’s `== summary ==` block. Its exit code alone is not the
verdict.

The block opens with the commit the run examined and whether the tree was
dirty. Check it against the commit you meant to gate: a verdict that names a
different tree describes different code. A run whose HEAD moved mid-way
reports `tree provenance=FAIL`.

## Focused checks

```bash
pnpm --filter @dohc/desktop test
pnpm --filter @dohc/workspace-engine-client test
pnpm --filter @dohc/sync-relay test
pnpm test:desktop:e2e
```

The Electron E2E suite requires a debug workspace-engine binary. Build it with:

```bash
cargo build -p dohc-workspace-engine --bin dohc-workspace-engine
```

## Rules

- Keep authorization and workspace-isolation tests strict.
- Test behavior at the boundary that owns it.
- Do not replace engine or relay integration coverage with mocked success.
- Update sender, receiver, schema, and tests together when a wire contract
  changes.
- Add a regression test for every fixed data-loss, isolation, or stale-response
  defect.
