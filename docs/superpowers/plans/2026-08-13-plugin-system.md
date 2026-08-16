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

## The manifest

`dohc-plugin.json` is the whole declaration. Every field except `version`,
`name`, and `entry` is optional, and every surface falls back on its own when
one is absent — a plugin that declares nothing still installs, runs, and gets
a row.

| Field | Shape | Bound |
| --- | --- | --- |
| `version` | `1` | The only accepted value |
| `name` | npm package name | 214 chars |
| `displayName` | What to call the plugin on screen | 120 chars |
| `description` | One line: what the plugin does | 280 chars |
| `publisher` | Who publishes it | 120 chars |
| `icon` | Plugin-root-relative `.png` or `.svg` | 1,024-char path |
| `entry` | Plugin-root-relative module | 1,024-char path |
| `panels` | `{ id, title, entry }` | 100 entries |
| `commands` | `{ id, title }` | 200 entries |
| `webApps` | `{ id, title }` | 100 entries |
| `allowSkippedScripts` | `true`, or npm package names | 300 names |

Two rules the bounds follow. Ids and titles are unique within their array.
Every path is refused if it is absolute, carries a `..` segment, or holds a
NUL byte — the manifest cannot name a file outside the plugin's own folder.

These per-field bounds do not sum to the reader's 256 KiB file cap, and are
not meant to. `readPluginManifestFile` checks the file's size before it parses
anything, so a manifest at every bound at once is refused by size with the cap
named. Each bound only has to be right for its own field.

The icon is checked twice, because the schema can only read the path. The
manifest must name a `.png` or `.svg` inside the plugin root; discovery then
confirms the file is really there, is a real file rather than a link or a
directory, and is 512 KiB or smaller — an order of magnitude above the largest
icon measured (t3's own logo is 1 KiB). An icon that fails any of those checks
is reported as a diagnostic and simply not advertised. The plugin stays valid
and its row falls back to the glyph tile, because an icon is decoration and
decoration must never cost a reader a row.

## Design rules

1. **Plugins are code, not prompts.** TypeScript against one SDK. Skills and
   templates remain content a plugin may carry, never the mechanism.
2. **One door to the engine — as the supported path, not an enforced
   boundary.** The SDK's engine operations all go through the daemon RPC.
   A full-trust plugin can still import `node:fs` and write workspace
   files raw; we do not pretend otherwise. Such writes take the
   outside-edit path: the capture watcher records them as moments carrying
   whatever ambient attribution the workspace currently has — anonymous
   usually, but a running agent's identity if one is active, since the
   watcher cannot distinguish write sources. That misattribution risk is
   part of the stated full-trust trade; the SDK path is how a plugin's
   writes are attributed correctly.
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
  - **Bounded activation.** Activation has a 30-second deadline — set
    beyond the spike's measured healthy range (t3's server start, the
    heaviest activation observed, took 4.5–7.4 s warm; the deadline
    leaves 4× headroom, and activation is documented as not the place
    to await long-running service readiness). A hung or failed
    activation is disposed and counts toward the crash-loop
    auto-disable like a crash. App and workspace startup never await
    plugin activation, so no plugin can wedge startup. Re-measure when
    PR3's real activation lands.
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
  hardened, main-process-owned `WebContentsView` (never a renderer
  `webview` tag, whose embedder API would hand a compromised renderer
  `executeJavaScript` on the authenticated guest) with a
  per-workspace-per-plugin session partition instead — per plugin because cookies scope by host, not
  port, so two loopback-served plugins in one partition could read each
  other's sessions. A PR3 surface, not part of PR1b's generic panel.
  Site discovery must also exclude `plugins/` roots
  (`discoverSites` currently would promote a plugin's panel code to a
  workspace site) — lands with PR1b/PR2.

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

- **Executed code is device-approved, not just workspace-synced.** The
  `plugins/` tree is workspace content, so once sync exists (#356), a
  collaborator's edit to plugin source would otherwise execute
  full-trust on every member's machine via hot reload. Each device
  therefore records the approved content hash of every enabled plugin
  in per-workspace state under the app's own `userData` — outside the
  workspace folder entirely, because a Dropbox/OneDrive mirror or a
  git-tracked `.dohc` could otherwise deliver plugin source and its
  forged approval together. A hash
  the device has not approved does not execute: the plugin is held
  disabled until the local user approves the change. Approval and build
  read the same bytes — the pipeline copies source to an engine-excluded
  snapshot, hashes the snapshot, and builds from it, never from the live
  mutable tree, so a sync arriving mid-build cannot slip unapproved
  bytes under an approved hash. Dependencies that point outside the
  snapshot (`file:`/`link:`) are refused at install time — code the hash
  does not bind does not install — and source trees containing symlinks
  or junctions that escape the snapshot are refused the same way. The
  auto-approve predicate is **attribution through the door, not
  topology**: a hash change auto-approves only when every constituent
  moment was door-written (per-operation authored — the user's editor
  session, their agent, the SDK). Watcher-captured disk changes never
  auto-approve, whatever ambient author they carry — the ambient slot
  stamps whole watcher batches, so a git pull settling during an agent
  run would otherwise inherit that agent's identity and self-approve. A
  disk-only out-of-band change — dohc sync later, but equally a git
  pull or Dropbox delivery today — prompts before it executes, because
  "no dohc sync peers" never meant "no way for remote bytes to
  arrive." Writes arriving through the site SDK never
  auto-approve, and `siteSdkHost` refuses writes under `plugins/`
  outright (as it already refuses database files and canonical
  Markdown) — otherwise a sandboxed site could write plugin source and
  escalate to full-trust execution. This gate is a hard precondition
  for shipping plugin sync, not an optional hardening.

- The engine's capture floor excludes `node_modules` at any depth. The
  lockfile is therefore what makes a reverted plugin rebuildable. The
  install pipeline must treat "restore source, reinstall, rebuild" as the
  recovery path. **Open risk:** text files over the 128 KiB capture cap
  are not versioned, and real lockfiles can exceed it. PR2 must measure
  representative plugin lockfiles; if healthy ones exceed the cap, the
  cap fix moves into this milestone instead of waiting for versioning
  stage 2.
- **Attribution is recorded, never required.** Plugin and agent writes
  through the door get stamped (author, session, gate). Outside edits
  are still captured — with the workspace's ambient attribution at
  capture time (anonymous, or a running agent's; see design rule 2).
  Nothing is ever refused for lacking identity. Do not let any future
  change make attribution a write precondition.
  The engine already carries the shape: `MomentAuthor`.
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
  genuinely new. Snapshots, installed dependencies, and generated
  bundles all live under the app's `userData` beside the device state —
  never anywhere in the workspace folder, engine-excluded or not,
  because anything inside the workspace can be replaced by a
  git/Dropbox mirror, and a mirror-writable bundle would bypass source
  hashing entirely. The workspace holds exactly what is shared: source
  and lockfile.

## Build plan

Spike first, then three stacked PRs, each independently green.

- **Spike (done 2026-08-13):** proved `t3@0.0.33` spawns, serves its UI
  at a loopback origin, and completes a real Codex session through its
  authenticated protocol — and determined that its SameSite session
  cookie breaks in a third-party iframe, so PR3 embeds it in a guest
  WebContents instead. The durable bridge contract (spawn, readiness,
  teardown, redaction) is tracked at
  [`2026-08-13-t3-spike-report.md`](2026-08-13-t3-spike-report.md); raw
  probe evidence stays in the untracked
  `.agent-artifacts/references/t3-spike/`.
- **PR1a — host + manifest + SDK Node transport.** Host lifecycle (one
  `utilityProcess` per plugin, `disabled` flag, crash-loop auto-disable,
  descendant teardown, generation guard), `dohc-plugin.json` format, the
  `@dohc/sdk/node` transport, and a hello-plugin fixture activating end
  to end. No renderer surface. Sets the contracts; heavyweight review.
- **PR1b — panel surface.** The sandboxed-iframe panel page, the
  `dohc://plugin-panel/` tab kind, and the main-owned panel SDK
  authority, on PR1a's contribution registry. Panel requests route
  through the plugin SDK router (plugin-attributed, per-operation
  authors), never bare `siteSdkHost` — a panel write must carry its
  plugin's identity, not a site's. Split from PR1a because
  the measured combined scope (~5–8k lines) is past where review
  quality holds.
- **PR2 — install/build pipeline.** `plugins/` source + lockfile → dep
  install + esbuild bundle → hot reload on change. Ships the visible
  reverse paths: disable, re-enable, and uninstall for any installed
  plugin — re-enable is the reverse of auto-disable; uninstall is not.
  Uninstalling a user-modified plugin warns before it runs that the
  edited source is deleted and recoverable only file-by-file from
  history until folder restore ships (versioning stage 2). The moment
  log retains captured files — but text over 128 KiB and binaries over
  5 MiB are never captured, so the warning must name any such files as
  genuinely unrecoverable, per the irreversible-change invariant.
  (PR1a's host already honors a `disabled` flag and auto-disables a
  plugin that crash-loops, so a broken plugin can never wedge app
  startup.) Packaged installs have no system Node, so dependency
  install runs pnpm's standalone script under a `utilityProcess`, with
  `--ignore-scripts` and `--ignore-workspace` (without the latter, a
  dohc workspace that is itself a pnpm monorepo absorbs the plugin into
  its own workspace instead of installing from the plugin's lockfile)
  and `--frozen-lockfile` (a manifest/lockfile mismatch fails the
  install; it never resolves a graph nobody reviewed) —
  lifecycle scripts would need a real `node` and are also npm's main
  attack surface, so dependencies that require install scripts are
  unsupported until a shipped-Node decision is made. `--ignore-scripts`
  skips silently, so after install the pipeline scans for any lifecycle
  script pnpm skipped — in every installed package and in the plugin
  root itself, whatever the hook's name — and fails the plugin build
  naming each one, an error an author's agent can act on. An author who
  knows a dependency ships usable prebuilt output can assert it in the
  manifest (`allowSkippedScripts`), which converts that package's
  failure to a named warning — the override is the measured escape
  valve the rejection rule requires.
  Plugins distribute `pnpm-lock.yaml` (the lockfile pnpm actually
  reads); a plugin authored with npm runs `pnpm import` before
  publishing. Plugin child processes (a
  wrapper's server, like t3's) never spawn `node` themselves; the SDK
  brokers them as host-spawned `utilityProcess` instances. Exercise all
  of this in the fused packaged environment, not only in dev.
- **PR3 — the t3 code plugin.** Manifest + glue over the spike's bridge
  contract.

## Not in this milestone

- The store, registry, signing, and hosted execution (cloud; phase 3).
- Agent tools over MCP (contribution point ships in the manifest shape, but
  wiring to agents comes after PR3). That milestone must resolve one open
  invariant question before shipping: an agent invoking a plugin tool that
  writes via `node:fs` would bypass the locks and gates the agent itself
  is bound by — tool-invoked writes need a routing or declaration answer.
- Versioning stage 2 (changesets, folder and point-in-time restore,
  rename-safe restore, the 128 KiB capture-cap fix). It is the feature
  plugin forking leans on, and it is Rust engine work sequenced after the
  current sync program settles.
- Global installs with workspace overrides. Per-workspace only until real
  use proves the duplication costs more than the simplicity buys.
