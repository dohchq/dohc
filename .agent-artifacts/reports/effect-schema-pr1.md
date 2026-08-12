# Effect Schema PR 1 report

## Baseline and sources

This branch starts at `f6473614b5f9fe523eae2b2715c2686ff8b1469f`.
The original spec targeted an older `main`, so the file and consumer inventory
was repeated before implementation.

- Effect is pinned to `effect@4.0.0-beta.107` in the two packages that call it
  at runtime.
- Effect source: <https://github.com/Effect-TS/effect.git> at
  `3c495ae7c96d43bfc3b8020250562a194c2c895e`, the beta.107 tag.
- t3code reference: <https://github.com/pingdotgg/t3code.git> at
  `e4abc31f1e3f930e521a5bb62b38a9c5b28d8fb1`.

Every Effect API used here was checked against that beta.107 source. In this
version, `Schema.decodeUnknownResult` returns `Result`, not `Either`.

## Conversion

All three Zod-backed contract modules now use Effect Schema:

- `chatIdentity.ts`: trimming, non-empty, maximum-length, and control-character
  checks for `PreferredName`.
- `domain.ts`: identifiers, paths, atom and asset kinds, and `WorkspaceFile`.
- `workspaceSettings.ts`: strict nested settings, old-file defaults, the
  exported type, and the engine-setting verdict.

`baseSchemas.ts` contains the one repeated schema definition:
`NonEmptyString`. The implementation uses built-in `Schema.Trim`,
`Schema.NonEmptyString`, `Schema.Finite`, and the official
`Struct.map(Schema.mutableKey)` pattern. It does not wrap Effect in a Zod-shaped
API.

Three small, Effect-free value modules keep Effect out of restricted bundles:

- `chatIdentityValues.ts` owns the preferred-name limit, predicate, and display
  helpers used by renderer and CLI code.
- `workspaceSettingsValues.ts` owns settings limits, literal tuples, and
  defaults used by the Effect contract and the existing IPC Zod mirror.
- `domainValues.ts` owns the site-source extension expression used by
  `workspace-core` and renderer code.

These files split existing values from validators. They do not add a generic
abstraction or compatibility layer. The production Electron build rejects any
future `effect` or `effect/*` import from preload or renderer code.

### Runtime consumers

| Consumer | Result |
| --- | --- |
| `apps/desktop/src/workspaces/workspaceSettingsFile.ts` | Main-process file reads and writes decode through the canonical Effect schema. One sync decoder serves both paths. |
| `packages/mcp/src/tools.ts` | Continues to call the canonical `workspaceEngineSetting` helper. |
| `apps/desktop/src/workspaces/workspaceSettings.ts` | Keeps the Zod IPC schema required by `bridgeContract.ts`, but imports every shared value from the Effect-free values module and checks its output type against the canonical type. |
| `apps/desktop/src/settings/userSettings.ts` | Keeps the Zod IPC field, imports the preferred-name predicate and limit from the Effect-free values module, and checks the field type against `PreferredName`. |
| Renderer and CLI identity call sites | Import display helpers from `chat-identity-values`; they do not load Effect. |
| `packages/workspace-core/src/paths.ts` | Imports the regular expression from `domain-values`; renderer consumers do not load the Effect-backed domain module. |

`apps/desktop/src/ipc/bridgeContract.ts` remains unchanged. It composes the
local workspace settings Zod schema with `.shape`, `.partial()`, and
`.removeDefault()`, so replacing that mirror would expand this PR into the
240-call-site IPC boundary. `@dohc/sdk` remains unchanged and Effect-free.

## Behavior and messages

The conversion preserves mutable exported object types, old-file defaults,
strict excess-property rejection, explicit engine opt-out behavior,
preferred-name normalization, and path reasons. `WorkspaceFile.updatedAt`
uses `Schema.Finite` so it still rejects `NaN`, `Infinity`, and `-Infinity` as
Zod did.

The error carrier changed from Zod issues to Effect schema failures. The main
message changes are:

| Constraint | Before | After |
| --- | --- | --- |
| Shared minimum of one character | `Too small: expected string to have >=1 characters` | `String must contain at least 1 character.` plus an Effect path when nested |
| Preferred-name maximum | Zod's generic 80-character message | `Names must contain 80 characters or fewer.` |
| Driver ID maximum | Zod's generic 120-character message | `Default driver IDs must contain 120 characters or fewer.` plus path |
| Model maximum | Zod's generic 200-character message | `Default models must contain 200 characters or fewer.` plus path |
| Attachment folder maximum | Zod's generic 100-character message | `Attachment folder names must contain 100 characters or fewer.` plus path |
| Excess property | `Unrecognized key: "token"` | `Expected no excess property` plus path |
| Wrong primitive or literal | Zod's invalid-input text | Effect's `Expected ...` text plus path |
| Missing key | Zod's invalid-input text | `Missing key` plus path |

These reason strings remain unchanged and have direct tests:

- `Enter the name your agent should use.`
- `Names cannot contain control characters.`
- `workspace paths are relative`
- `workspace paths cannot contain ..`
- `Unknown atom kind: <value>. Valid kinds: <kinds>`

## Bundle evidence

Production builds were compared with the exact `main` baseline.

| Artifact | `main` | Effect branch | Difference |
| --- | ---: | ---: | ---: |
| Packaged CLI | 168.20 kB, 34.09 kB gzip | 167.85 kB, 33.89 kB gzip | -0.35 kB, -0.20 kB gzip |
| Electron main | 1,369.22 kB | 1,371.62 kB | +2.40 kB |
| Preload | 228.07 kB | 227.83 kB | -0.24 kB |
| Main renderer chunk | 1,786.86 kB | 1,786.50 kB | -0.36 kB |

Renderer module count remains 4,568. Renderer and preload source maps contain
zero Effect modules. The production Vite guard also makes an Effect import a
build error on either surface.

## Gate results

The workflow filters select both JavaScript and Rust because the dependency
lockfile changed.

JavaScript gate:

```text
cargo build -p dohc-workspace-engine --bin dohc-workspace-engine: PASS
pnpm run typecheck: PASS (19 workspace projects)
pnpm run test: PASS
workspace-contracts: 5 files, 28 tests passed
workspace-auth: 2 files, 9 Postgres-backed tests passed
desktop: 232 files passed, 2 skipped; 3,897 tests passed, 8 skipped
```

The run set `DOHC_REQUIRE_ENGINE_E2E=1` and `DOHC_REQUIRE_POSTGRES=1`.
Postgres 17 was healthy on port 54329. The task reused that service and did not
stop a container it did not start.

Canonical Rust summary:

```text
PASS tree provenance
PASS native target
PASS fixture drift
PASS fmt --check
PASS clippy -D warnings
PASS build --workspace
PASS test --workspace
PASS test collab crash tier
PASS cargo-deny
PASS cargo-audit
PASS scratch leak
```

Focused production verification also passed:

- workspace-contracts typecheck and 28 tests;
- desktop typecheck and 42 focused settings/bundle tests;
- SDK build;
- packaged CLI build;
- Electron main, preload, and renderer production build with source maps.

## Size

`packages/workspace-contracts/src` changed from 4,356 to 4,615 lines: +259.
Production code accounts for +78 lines; tests account for +181. The production
growth is the Effect conversion plus the three boundary-safe value files. The
test growth pins structured failures, strictness, defaults, mutability, and
non-finite timestamp rejection.

## Deviations

1. The branch uses current `main` at `f6473614`, not the older snapshot in the
   spec.
2. Beta.107 uses `Result` for safe decode.
3. `pnpm-workspace.yaml` explicitly denies the optional
   `msgpackr-extract` build. Effect's dependency graph can use the JavaScript
   fallback, so this avoids adding an unrelated native build.
4. The boundary requires three Effect-free value files in addition to the one
   shared schema file. Without them, Effect entered renderer, preload, and CLI
   bundles. The first build measurement showed +279.34 kB in the renderer and
   +234.13 kB in the CLI before this split.
5. The desktop keeps local Zod only at the existing IPC boundary. The main
   file validator and MCP verdict use the canonical Effect schema.

There is no compatibility shim, `any`, TypeScript suppression, compile-contract
edit, SDK change, or engine-client wire-contract conversion.

## Draft PR body

> Written by Codex.

### What changed

- Replaced every Zod schema in `@dohc/workspace-contracts` with Effect Schema
  on exact `effect@4.0.0-beta.107`.
- Preserved exported types, mutability, strict settings, defaults, path rules,
  and validation limits.
- Kept Effect out of renderer, preload, CLI, and SDK surfaces with small plain
  value modules and an enforced Electron build boundary.
- Added focused coverage for structured failures, non-finite timestamps,
  defaults, bounds, and mutable decoded values.

### Why

This is the first staged Effect adoption slice. The contract package now gets
runtime validation, codecs, and exported types from the same definitions
without committing the larger engine-client wire surface.

### Gates

- JavaScript workflow job: passed with Postgres and engine E2E required.
- Canonical Rust workflow job: every required summary row passed.
- Production SDK, CLI, and Electron builds: passed. Effect is absent from
  renderer and preload source maps.

### Follow-up boundary

This PR does not convert `packages/workspace-engine-client`. That larger wire
contract remains a separate decision after this idiom is reviewed in isolation.
