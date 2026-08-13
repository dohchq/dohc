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
2. **One door to the engine — as the supported path, not an enforced
   boundary.** The SDK's engine operations all go through the daemon RPC.
   A full-trust plugin can still import `node:fs` and write workspace
   files raw; we do not pretend otherwise. Such writes take the
   outside-edit path: the capture watcher records them as moments without
   plugin attribution, and settlement treats them like any external edit.
   The door is where attribution, gates, and future guardrails live —
   plugins that bypass it lose those benefits, not their ability to run.
3. **Full trust, no permission sandbox.** Ice's explicit call (2026-07-28):
   like VS Code and Obsidian, plugins run with full power. No permission
   prompts. The engine's own review gates and locks still apply to
   workspace writes, because they apply to every caller of the door.
4. **Forkable in place.** Plugins install as readable source in the
   workspace. A user's agent edits them directly. A modified plugin is
   marked as the user's and stops auto-updating; the agent merges upstream
   releases on request. When the update mechanism ships (post-milestone),
   it must include the reverse transitions: reset-to-upstream and
   resume-updates, so forking is never a one-way door.
5. **Engine powers are incentives, not requirements.** A plugin may use
   zero dohc features. When it wants storage, search, sync, or documents,
   it asks the engine and inherits capture, history, and gates.

## Architecture

Three pieces. The engine stays the core.

- **Plugin host** — one Electron `utilityProcess` **per plugin**, spawned
  by `apps/desktop`, speaking JSON-RPC 2.0 message objects over the
  `utilityProcess` MessagePort (`postMessage`/`parentPort`; a
  `UtilityProcess` has no writable stdin, so stdio framing cannot work —
  its piped stdout/stderr serve only the plugin log buffer). The agent
  drivers' `JsonRpcTransport` supplies the request/response semantics
  behind a process seam; tests bind the same seam to a plain Node child.
  A plain Node child is unshippable: packaged builds fuse `runAsNode` off
  and end users have no system Node; `utilityProcess` ships Node inside
  the app. Per-plugin processes are what make "a crash kills only that
  plugin" true. The host contract also owns two hard edges:
  - **Descendant teardown.** Disposal must terminate the plugin's whole
    process tree cross-platform (the existing tree-kill covers Windows
    only; POSIX needs process-group kill), and a crashed host's orphans
    must be recovered — a wrapper plugin like t3 leaves a server holding
    ports otherwise.
  - **Generation-guarded registration.** Activation results carry the
    workspace and a host generation; stale registrations arriving after a
    workspace switch or reload are rejected, per the repo's async-guard
    invariant.
  - **Bounded activation.** Activation has a deadline; a hung or failed
    activation is disposed and counts toward the crash-loop auto-disable
    like a crash. App and workspace startup never await plugin
    activation, so no plugin can wedge startup.
  The host is a client of the daemon RPC, same as the desktop app.
- **`@dohc/sdk`** — the existing package (`packages/sdk`), extended. Today
  it serves sandboxed site previews over a postMessage transport. Plugins
  reuse its API and add a Node transport for the host side, plus
  contribution registration (panels, commands, agent tools). One SDK, one
  API, two transports. A plugin is SDK code plus a manifest.
- **Panels** — sandboxed iframes in the renderer, reusing the site-preview
  surface (`SitePreviewPage.tsx` sandbox + `siteSdkHost` authority). Plugin
  UI never runs in the app's own renderer context. Wrapper plugins whose
  embedded app needs its own cookie/storage context (the t3 spike proved
  its SameSite session cookie breaks in a third-party iframe) get a
  hardened guest WebContents with a per-workspace session partition
  instead — a PR3 surface, not part of PR1b's generic panel.

Language split: anything that must be true (history, atomicity, replication,
gates) is Rust below the daemon RPC. The host, SDK, pipeline, and plugins
are TypeScript above it.

## Decisions of record

| Decision | Choice | Date |
| --- | --- | --- |
| Plugin location | Per-workspace, in `plugins/` | 2026-07-29 |
| Distribution format | Readable source + lockfile; dohc installs deps and bundles on install | 2026-07-29 |
| First plugin | t3 code (wraps the published `t3` npm package; MIT). Surveyed source: https://github.com/pingdotgg/t3code at `6bc6cb6be4ebecd5bd7a3b7b88f07cb61815ded5` (cloned in `.agent-sources/pingdotgg/t3code`). The spike pins the exact npm package version. | 2026-07-29 |
| Publishing | Registry publish requires a free dohc cloud account (namespaced, signed releases). Install and sideload need no account, ever. | 2026-08-05 |
| Wrapper-plugin updates | Author's agent watches upstream, bumps the pinned dependency, tests, republishes. Pristine installs auto-update; forks pause. | 2026-08-05 |
| Open source | Entire codebase opens at MVP launch. Cloud layer licensed against commercial rehosting. Register the trademark first. | 2026-07-29 |

Constraints these choices create:

- The engine's capture floor excludes `node_modules` at any depth. The
  lockfile is therefore what makes a reverted plugin rebuildable. The
  install pipeline must treat "restore source, reinstall, rebuild" as the
  recovery path. **Open risk:** text files over the 128 KiB capture cap
  are not versioned, and real lockfiles can exceed it. PR2 must measure
  representative plugin lockfiles; if healthy ones exceed the cap, the
  cap fix moves into this milestone instead of waiting for versioning
  stage 2.
- **Attribution is recorded, never required.** Plugin and agent writes
  through the door get stamped (author, session, gate). Outside edits are
  captured as anonymous moments. Nothing is ever refused for lacking
  identity. Do not let any future change make attribution a write
  precondition. The engine already carries the shape: `MomentAuthor`.
  But the `capture.setAuthor` slot is workspace-ambient — the capture
  driver holds one mutable author sampled at capture time
  (`crates/dohc-workspace-engine/src/lib.rs:3560`), so concurrent plugin
  sessions cannot share it. Plugin writes carry `MomentAuthor` on each
  operation — and **the host derives and stamps it**; author fields
  supplied by plugin code are ignored. The daemon shape-checks but does
  not authenticate authors (`validated_author`), so a full-trust plugin
  that bypasses the SDK can forge history the same way any local process
  can; that is the stated full-trust trade, not a gap the SDK path
  shares.
- The install/build pipeline (PR2) has partial precedents: sites
  detection/config parsing (`packages/workspace-core/src/sites.ts`) and
  build/preview execution (`apps/desktop/src/workspaces/siteRunner.ts`).
  Nothing in the repo installs dependencies today — that part of PR2 is
  genuinely new. Generated bundles go under an engine-excluded path
  (`.dohc/plugins/`), never inside the captured `plugins/` tree, so
  builds are not versioned, synced, or watcher-looped.

## Build plan

Spike first, then three stacked PRs, each independently green.

- **Spike (no PR):** prove the published `t3` package can be spawned as a
  child process, its served UI loads in a sandboxed iframe (the same
  surface PR1 ships), and a session round-trips. Output: the bridge
  contract for PR3, including the pinned package version.
- **PR1a — host + manifest + SDK Node transport.** Host lifecycle (one
  `utilityProcess` per plugin, `disabled` flag, crash-loop auto-disable,
  descendant teardown, generation guard), `dohc-plugin.json` format, the
  `@dohc/sdk/node` transport, and a hello-plugin fixture activating end
  to end. No renderer surface. Sets the contracts; heavyweight review.
- **PR1b — panel surface.** The sandboxed-iframe panel page, the
  `dohc://plugin-panel/` tab kind, and the main-owned panel SDK
  authority, on PR1a's contribution registry. Split from PR1a because
  the measured combined scope (~5–8k lines) is past where review
  quality holds.
- **PR2 — install/build pipeline.** `plugins/` source + lockfile → dep
  install + esbuild bundle → hot reload on change. Ships the visible
  reverse paths: disable, re-enable, and uninstall for any installed
  plugin — re-enable is the reverse of auto-disable; uninstall is not.
  (PR1a's host already honors a `disabled` flag and auto-disables a
  plugin that crash-loops, so a broken plugin can never wedge app
  startup.) Packaged installs have no system Node, so dependency
  install runs pnpm's standalone script under a `utilityProcess`; this
  path must be exercised in the fused packaged environment, not only in
  dev.
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
