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
| `pluginVersion` | What the plugin calls this build | 40 chars |
| `repository` | Where the source lives, `https://` only | 2,048 chars |
| `issues` | Where to report a problem, `https://` only | 2,048 chars |
| `license` | Licence name, SPDX id, or `https://` URL | 120 chars |
| `icon` | Plugin-root-relative `.png` or `.svg` | 1,024-char path |
| `entry` | Plugin-root-relative module | 1,024-char path |
| `panels` | `{ id, title, entry, placement?, icon? }` | 100 entries, 4 in the rail |
| `commands` | `{ id, title }` | 200 entries |
| `webApps` | `{ id, title, instanced? }` | 100 entries |
| `drivers` | `{ id, displayName }` | 8 entries |
| `settings` | `{ key, type, label, description?, default, options? }` | 20 entries |
| `allowSkippedScripts` | `true`, or npm package names | 300 names |

A `panels` entry contributes one panel: a sandboxed page the plugin serves,
carrying that plugin's SDK authority. `placement` says where it shows.

- `placement: "editor"` (the default) opens the panel as an editor tab.
- `placement: "view"` gives the panel a button in the activity bar, dohc's
  leftmost rail, and renders it in the side panel beside the explorer, the
  graph, and history. This is how a plugin owns a place in the workbench
  rather than a tab someone has to open.

The two are exclusive. A running panel is keyed by workspace, plugin, and
panel id, and starting a second one stops the first, so one panel cannot hold
both places at once. A plugin that wants a view and a tab declares two panels.

A view's button draws the panel's `icon`, then the plugin's own `icon`, then
the glyph every plugin without one already shows. Icons are plugin-root
relative `.png` or `.svg` files, served like any other workspace file.

At most four panels per plugin may take `placement: "view"`. The bound is the
rail's: at the smallest window dohc opens, the rail shows eleven buttons and
six are dohc's own, so four leaves a plugin unable to fill the rail by itself.
Past what one window shows, the rail scrolls — no contribution is refused for
lack of room.

The view id is `plugin-view:<plugin>/<panel>`, and the selected view persists
with the rest of the workbench. A view whose plugin is turned off keeps its
place: the side panel names the plugin to turn back on, and enabling it brings
the view back. A view whose plugin is uninstalled is gone, and the selection
goes with it — the workbench falls back to the explorer. Only a loaded plugin
list can say a plugin is gone, so a restart never drops a view while the list
is still arriving.

A `webApps` entry contributes one embedded web app, shown in a hardened
main-process guest over a loopback origin the running plugin supplies. It opens
in one of two shapes, and `instanced` says which:

- `instanced: false` (the default) opens one tab for the whole plugin. The
  plugin's page in dohc offers an Open button for it.
- `instanced: true` opens one tab per runtime instance — one preview per site,
  for example. The open carries an **instance key**: a string of at most 512
  characters that dohc treats as opaque and hands back to `startWebApp`, so the
  plugin can serve a different origin for each instance. The tab is keyed by it
  (`dohc://plugin-web/<plugin>/<webApp>/<instance>`), which makes each instance
  its own tab, its own guest, and its own origin lock. `stopWebApp` names one
  instance and must leave the others running.

dohc has no idea what an instance is, so only the plugin can name one: a
per-instance web app is opened from the plugin's own panel with
`dohc.ui.openWebApp(webAppId, instanceKey)`, and the plugin's page offers no
Open button for it. At most 20 instances of one web app run at once, because
each one is a live guest process behind a server the plugin spawned.

Every instance of one plugin shares that plugin's storage partition. The
partition exists to keep plugins out of each other's cookie jar, and every
instance here is the same plugin's own server under the same plugin's
authority — so uninstall still clears one partition and clears them all.

A `drivers` entry contributes one agent driver: a harness dohc can talk to,
which joins the driver registry beside the ones dohc ships and appears in the
same probe list. A driver id also has to name its driver inside
`agents.defaultDriverId`, so it takes that setting's own bound and charset:
120 characters of letters, digits, `.`, `_`, and `-`, starting with a letter or
a digit. Activation must register exactly the driver ids the manifest declares
— a declared driver that never registers would be a probe row nothing can
answer. One workspace holds at most 16 plugin drivers in total; the
registration past that is refused, with the cap named, rather than the whole
list broken. dohc keeps the harness's process tree under its own control: the
harness runs as a brokered child of the plugin's spawn, and stopping the plugin
takes the tree down without asking the driver.

Two rules the bounds follow. Ids and titles are unique within their array.
Every path is refused if it is absolute, carries a `..` segment, or holds a
NUL byte — the manifest cannot name a file outside the plugin's own folder.

These per-field bounds do not sum to the reader's 256 KiB file cap, and are
not meant to. `readPluginManifestFile` checks the file's size before it parses
anything, so a manifest at every bound at once is refused by size with the cap
named. Each bound only has to be right for its own field.

### What the details page shows

The plugin's page carries a right rail of what dohc knows about the plugin as
an installation: its identifier, the version it calls this build, the content
hash of the source the user approved, what it takes up on disk, and links to
its source, its issues, and its licence.

Every row appears only where its fact exists, and a section with no rows
prints no heading. This is the whole rule, and it is what keeps the rail
honest: dohc has no marketplace, so it has no publish date, no update date, no
rating, no install count, and no category to put a plugin in. VS Code's rail
shows all of those. Inventing any of them would be the one thing a reference
surface must never do.

Two of these rows are dohc's own, and a marketplace could not print them.
**Approved source** is the content hash the user approved, which is dohc's
version-of-record for what actually runs — `pluginVersion` is a string the
author chose and dohc never compares it to anything. **Installed size** and
**Stored data** are measured on request rather than recorded, by the same walk
the uninstall preflight uses, so the rail and the uninstall dialog can never
report different bytes for the same directory.

There are no install or approval timestamps, because the pipeline records
none. `PluginRecord` holds five fields and not one of them is a time. A "last
updated" row would have to be invented, so there is not one.

`pluginVersion`, `repository`, `issues`, and `license` are display only.
`repository` and `issues` are `https://` only and capped at exactly the length
the audited external-open path accepts, so a manifest can never declare a link
that every click refuses.

### Settings

A plugin declares what the user may set, and dohc renders it. `type` is
`string`, `boolean`, `number`, or `select`; a `select` carries 1–8 `options`
and its `default` must be one of them. Keys are unique, a `default` is
required, and its type has to match the setting it belongs to — the schema is
a union on `type`, so nothing downstream checks that a boolean setting shipped
a string default.

Answers live in the workspace as text, one file for every plugin, keyed by
plugin id:

```
.dohc/plugin-settings.local.json
{ "t3-code": { "port": 4317 } }
```

One file rather than one per plugin, because that is what a reader wants open
when they ask what this workspace has been told. This is data the user typed,
which is why it lives in the workspace at all — plugin **code** and its build
output stay outside it (see the device-approval constraint above), and nothing
here executes.

The manifest is what gives a stored value meaning, and it is checked on both
sides of the file. A value is refused on write unless the plugin declares that
key at that type. On read, a value that no longer fits its declaration — a
manifest changed under a file written for an older one — falls back to the
declared default instead of reaching the plugin, and a key no plugin declares
is dropped. So a settings file edited by hand, or arriving over sync, can only
ever set a setting some plugin actually asked for.

The plugin sees only its own entry. Every settings call names a plugin, and
only a plugin this workspace discovered has declarations to answer with.

The SDK surface is two members, `ctx.settings.get()` and
`ctx.settings.onChange(listener)`. The host sends the resolved values with
`plugin.activate`, so a plugin never starts without its settings and never has
to ask; on every change it sends `plugin.settingsChanged`. That is a request
like every other host-to-plugin message rather than a new notification path —
the reply tells the host the plugin took the change, and the host does not
wait on it, because a slow plugin must never hold up a save the user already
made. A plugin that is not running needs no telling: it reads the new values
from its next activation.

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
- **Theme tokens** — a panel runs on its own loopback origin, so the app's
  stylesheet never reaches it and the host cannot touch its document. dohc
  sends the tokens instead: the renderer answers `ui.theme` with the palette
  that is on screen, then pushes a `dohc:theme:v1` message whenever the user
  changes theme, density, or reduced motion. `dohc.ui.applyTheme()` writes
  them onto the panel's `<html>` and keeps following, so panel CSS names
  colors the way dohc's own stylesheet does — `var(--dohc-ink)`.

  The payload is built from `renderer/tokens.ts`, which `tokens.test.ts`
  already holds byte-identical to `styles.css`, so a panel and the app
  cannot show different colors for the same token. Theme is styling data:
  it grants no authority, gates on no capability, and a panel that ignores
  it is unaffected. Plugin **web apps** get nothing here — they render a
  server the plugin spawned, over a `WebContentsView` with no bridge at
  all, so there is no channel to send tokens on.

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
| Agent drivers | Core calls plugins: a `drivers` contribution behind dohc's own driver registry, with no plugin-to-chat SDK. The start input's `permissionPolicy` stays a main-process function that no plugin sees. | 2026-08-17 |
| Workspace agent settings | `agents.defaultDriverId` chooses the driver a workspace uses; `agents.defaultModel` starts its sessions. Both were declared and unread until the driver contribution gave them a reader. | 2026-08-17 |
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
