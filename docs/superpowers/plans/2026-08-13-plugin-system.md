# Plugin system: design and build plan

Decided by Ice with Fable, 2026-07-28 through 2026-08-13. This document is
the record of those decisions and the build plan for the first milestone.
The full illustrated pitch lives in the design artifact (private); this file
is the engineering source of truth.

## What a plugin is

A plugin is a TypeScript program installed into a workspace. It runs in a
plugin host process and talks to the dohc engine through `@dohc/sdk`. A
manifest (`dohc-plugin.json`) declares what it contributes.

A plugin can contribute anything: panels, views, commands, whole apps, and —
if the author chooses — tools for the user's agents. No contribution type is
required. Do not frame plugins as "for the human" plus "for the agents";
Ice rejected that framing. Agent tools are one optional contribution among
many.

## Design rules

1. **Plugins are code, not prompts.** TypeScript against one SDK. Skills and
   templates remain content a plugin may carry, never the mechanism.
2. **One door to the engine.** Plugins never touch storage, sync, Y.Docs, or
   review gates directly. Every engine interaction goes through the daemon
   RPC via `@dohc/sdk`. This is the seam where guardrails could land later
   without breaking plugins.
3. **Full trust, no permission sandbox.** Ice's explicit call (2026-07-28):
   like VS Code and Obsidian, plugins run with full power. No permission
   prompts. The engine's own review gates and locks still apply to
   workspace writes, because they apply to every caller of the door.
4. **Forkable in place.** Plugins install as readable source in the
   workspace. A user's agent edits them directly. A modified plugin is
   marked as the user's and stops auto-updating; the agent merges upstream
   releases on request.
5. **Engine powers are incentives, not requirements.** A plugin may use
   zero dohc features. When it wants storage, search, sync, or documents,
   it asks the engine and inherits capture, history, and gates.

## Architecture

Three pieces. The engine stays the core.

- **Plugin host** — a Node `utilityProcess` in `apps/desktop`. Runs each
  plugin's entry module. A plugin crash kills only that plugin. The host is
  a client of the daemon RPC, same as the desktop app.
- **`@dohc/sdk`** — a new workspace package: a typed wrapper over the daemon
  RPC plus host-side contribution registration (panels, commands, agent
  tools). One SDK for the app, plugins, and outside tools. A plugin is SDK
  code plus a manifest.
- **Panels** — sandboxed webviews in the renderer. Plugin UI never runs in
  the app's own renderer context.

Language split: anything that must be true (history, atomicity, replication,
gates) is Rust below the daemon RPC. The host, SDK, pipeline, and plugins
are TypeScript above it.

## Decisions of record

| Decision | Choice | Date |
| --- | --- | --- |
| Plugin location | Per-workspace, in `plugins/` | 2026-07-29 |
| Distribution format | Readable source + lockfile; dohc installs deps and bundles on install | 2026-07-29 |
| First plugin | t3 code (wraps the published `t3` npm package; MIT) | 2026-07-29 |
| Publishing | Registry publish requires a free dohc cloud account (namespaced, signed releases). Install and sideload need no account, ever. | 2026-08-05 |
| Wrapper-plugin updates | Author's agent watches upstream, bumps the pinned dependency, tests, republishes. Pristine installs auto-update; forks pause. | 2026-08-05 |
| Open source | Entire codebase opens at MVP launch. Cloud layer licensed against commercial rehosting. Register the trademark first. | 2026-07-29 |

Constraints these choices create:

- The engine's capture floor excludes `node_modules` at any depth. The
  lockfile is therefore what makes a reverted plugin rebuildable. The
  install pipeline must treat "restore source, reinstall, rebuild" as the
  recovery path.
- **Attribution is recorded, never required.** Plugin and agent writes
  through the door get stamped (author, session, gate). Outside edits are
  captured as anonymous moments. Nothing is ever refused for lacking
  identity. Do not let any future change make attribution a write
  precondition.

## Build plan

Spike first, then three stacked PRs, each independently green.

- **Spike (no PR):** prove the published `t3` package can be spawned as a
  child process, served UI embeds in a sandboxed webview, and a session
  round-trips. Output: the bridge contract for PR3.
- **PR1 — host + manifest + minimal SDK.** `utilityProcess` host lifecycle,
  `dohc-plugin.json` format, panel webview surface, skeletal `@dohc/sdk`
  (panels + commands), and a hello-plugin test fixture that exercises the
  host end to end. This PR sets the contracts; it gets the heavyweight
  review.
- **PR2 — install/build pipeline.** `plugins/` source + lockfile → dep
  install + esbuild bundle → hot reload on change.
- **PR3 — the t3 code plugin.** Manifest + glue over the spike's bridge
  contract.

## Not in this milestone

- The store, registry, signing, and hosted execution (cloud; phase 3).
- Agent tools over MCP (contribution point ships in the manifest shape, but
  wiring to agents comes after PR3).
- Versioning stage 2 (changesets, folder and point-in-time restore,
  rename-safe restore, the 128 KiB capture-cap fix). It is the feature
  plugin forking leans on, and it is Rust engine work sequenced after the
  current sync program settles.
- Global installs with workspace overrides. Per-workspace only until real
  use proves the duplication costs more than the simplicity buys.
