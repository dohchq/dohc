# Think Bigger P0R: Rust Workspace Kernel Spike

Status: ready for review
Date: 2026-06-24
Branch: `codex/think-bigger-p0r-rust-kernel`
Worktree: `/home/ice/dev/dohc-p0r-rust-kernel`

## Question

Should the Phase 0 workspace engine begin with a Rust local kernel now, or
should Phase 0 stay TypeScript while keeping Rust-ready contracts?

This spike answers a narrow slice only:

- scan a workspace root.
- skip internal workspace/tooling directories.
- hash changed candidates.
- emit structured timing and file metadata.
- compare the result with the existing TypeScript `scanWorkspaceFiles` path.

It does not introduce production runtime behavior.

## Spike Shape

Rust prototype:

- `crates/workspace-kernel-spike`
- command: `dohc-workspace-kernel-spike scan --root <workspace-root> --json`

TypeScript comparison:

- `scripts/workspace-kernel-spike/ts-scan.ts`
- imports current `packages/workspace-fs/src/scan`

Benchmark harness:

- `scripts/workspace-kernel-spike/bench.mjs`
- generates deterministic fixture files.
- builds the Rust binary in release mode.
- runs Rust and TypeScript scanners several times.
- prints JSON with min/max/average timing.

## Bridge Options

### Sidecar Daemon

Best long-term fit for watcher/reconciliation/indexing queues.

Pros:

- Keeps heavy filesystem work off Electron main/renderer threads.
- Can own crash recovery, logs, queue backpressure, and future mount support.
- Language boundary is explicit and testable over JSON-RPC or a small binary
  protocol.

Cons:

- Packaging, process supervision, updates, and logs need product-grade work.
- Authz/policy contracts must be passed in as data or queried safely; the
  daemon must not become a second policy source.

### One-Shot CLI

Best for spikes, benchmarks, and simple CI fixtures.

Pros:

- Very simple to package and test.
- Good failure isolation.
- No long-lived process lifecycle.

Cons:

- Process startup cost is wrong for hot watcher loops.
- Harder to support streaming state and cancellation.

### Localhost HTTP

Reasonable for a sidecar, but heavier than needed for local-only IPC.

Pros:

- Easy to inspect with existing tooling.
- Works across language boundaries.

Cons:

- Port binding, firewall prompts, origin/security policy, and auth token
  handling add surface area.

### JSON-RPC Over Stdio/Named Pipe

Recommended bridge candidate for the next spike step.

Pros:

- No port binding.
- Familiar from agent/MCP process patterns already in dohc.
- Easy request/response and event streaming.

Cons:

- Needs robust framing, cancellation, restart, and log correlation.

### N-API Native Module

Not recommended for Phase 0.

Pros:

- Lowest call overhead.

Cons:

- Packaging/build matrix is more fragile.
- Crashes can take down the host process.
- Harder to supervise independently.

## Initial Recommendation

Use Rust for the eventual local workspace kernel, but do not make product
semantics depend on a native bridge until P0R proves packaging and CI.

Preferred path:

1. Keep Phase 0 contracts in TypeScript/shared schemas.
2. Use the Rust spike to validate scan/hash/reconcile performance and API
   shape.
3. If packaging/CI remain boring, promote the spike to a sidecar-style kernel
   with JSON-RPC over stdio or named pipes.
4. Keep authz/effective policy as shared contracts and tests, not hidden native
   logic.

## Measurements

Commands:

```bash
cargo test --manifest-path crates/workspace-kernel-spike/Cargo.toml
node scripts/workspace-kernel-spike/bench.mjs --files 1000 --bytes-per-file 1024 --iterations 3
```

Results on the local Codex machine:

| Scanner | Files Seen | Bytes | Min | Max | Average |
| --- | ---: | ---: | ---: | ---: | ---: |
| Rust spike | 1000 | 1,028,890 | 6.80ms | 8.16ms | 7.33ms |
| Current TypeScript baseline | 1002 | 1,028,902 | 187.04ms | 193.14ms | 189.27ms |

Notes:

- The Rust spike skips `.dohc`, `.git`, and `node_modules`.
- The current TypeScript baseline calls `scanWorkspaceFiles`, which only skips
  `.dohc`; the extra two files are from `.git/config` and
  `node_modules/pkg/index.js` in the fixture.
- These are local smoke numbers, not release budgets. They are still strong
  enough to justify a real Rust kernel lane for hot local filesystem work.

## Decision

Start the workspace engine with TypeScript-owned contracts and a Rust local
kernel behind those contracts.

Do not rewrite dohc around Rust all at once. Instead:

- keep permissions, durable write contracts, event shapes, and conflict
  semantics in shared schemas and cross-language tests.
- promote Rust first for scan/hash/reconcile/indexing work where the
  performance win is obvious.
- bridge the Rust kernel through supervised JSON-RPC over stdio or named pipes,
  not direct in-process native bindings.
- require every Rust behavior that touches user data to have a TypeScript
  contract fixture and a Rust fixture using the same expected output.

This preserves dohc's "just files on your computer" philosophy while giving the
local engine enough headroom for huge workspaces, agent-heavy edits, and
Dropbox-style background reconciliation.
