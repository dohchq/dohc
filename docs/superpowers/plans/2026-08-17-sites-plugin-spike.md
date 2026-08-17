# Spike: can Sites be rebuilt as a plugin?

Date: 2026-08-17. Read-only spike by Fable; no production code changed. Every
citation is against main at `7ac22086`. Companion to
[`2026-08-13-plugin-system.md`](2026-08-13-plugin-system.md) and the t3 spike
report.

The question Ice posed: the honest test of the plugin system is whether it can
absorb dohc's own features. Sites goes first because its shape — file
discovery, loopback preview servers, sandboxed rendering — is nearly congruent
with what the t3 plugin already needed.

## Conclusion

**Yes, with a clean seam — the missing surface is a small set of general
primitives, not a swamp.** Most of what a sites plugin needs already exists
and is merely not plumbed: the plugin SDK host routes fewer methods than the
site SDK host it wraps (no `databases.*`, no `ui.open`), and both plumb-throughs
are S-sized. The genuinely new primitives — workspace events, a
command-capable child broker, dynamic tabs over plugin-owned origins, a
design-token bridge — are M-sized and every one of them is something a user's
agent building an arbitrary app would also ask for. Two items are L and mark
the substrate line: read-only (shared-view) plugin authority, and scoped SDK
sub-grants for content a plugin itself embeds. Those two are dohc's sandbox
and sharing model showing through Sites, and they should stay substrate. The
conversion is worth doing after the S and M primitives land; it deletes a
feature-shaped subsystem and replaces it with primitives everything else can
use.

## 1. Sites, end to end

### Discovery

`discoverSites` is a pure function over a listing of workspace file paths,
with file bodies supplied only for `dohc.json` and `package.json`
(`packages/workspace-core/src/sites.ts:647-736`). Signals: an `index.html`
entry, a `dohc.json`, a `package.json` with a known web dependency
(`sites.ts:90-119`) or a web-shaped script (`sites.ts:123-135`), a framework
config file (`sites.ts:137-145`), or a `dist`/`build`/`out` output containing
`index.html` (`sites.ts:85,710-722`). Kind is `static`/`package`/`configured`
and confidence `high`/`medium`/`low` (`sites.ts:593-604`).

Two exclusions matter here. Reserved segments (`.dohc`, `.git`,
`node_modules`, caches) never form site roots (`sites.ts:147-158`), and the
workspace-root `plugins/` tree is excluded outright (`sites.ts:212-214`) — the
guard the plugin-system plan required so a plugin's panel code is never
promoted to a workspace site.

The desktop layer (`apps/desktop/src/workspaces/sitePackage.ts`) turns
discovery output into `SitePackageInfo`: it re-reads `dohc.json` commands and
refuses any that bind a non-loopback host (`sitePackage.ts:358-370`), tags
sites under `shared-with-me/<label>/` with share-mount authority
(`sitePackage.ts:79-91`), and computes a share manifest by scanning browser
files for their reference closure, capped at 100 files and 4 MiB scanned
(`sitePackage.ts:55-58,245-311`).

### The preview servers

Three modes, all owned by `apps/desktop/src/workspaces/siteRunner.ts` and run
in the main process:

- **static** — an in-process Node HTTP server on `127.0.0.1` with an
  OS-assigned port (`siteRunner.ts:151-161,184-306`). Requests are contained
  to the served root, reserved paths are refused, and the response is read
  from a single `O_NOFOLLOW` open with the win32 residuals stated in place
  (`siteRunner.ts:254-276`).
- **dev** — spawns the site's own dev command in the site root, refuses
  commands that bind beyond loopback (`siteRunner.ts:389-400`), detects the
  URL from output with ANSI stripped (`siteRunner.ts:47-54,402-405`), and
  fails after a 15 s readiness default (`siteRunner.ts:463-467`). Teardown is
  a Windows tree kill before the wrapper signal (`siteRunner.ts:519-538`).
- **build** — runs the build command with a 120 s timeout
  (`siteRunner.ts:45,568-640`), then statically serves the detected output
  (`siteRunner.ts:549-566`).

One preview per workspace+siteRoot, tracked by
`createSitePreviewLifecycle` (`sitePreviewLifecycle.ts:31-122`): remembering a
handle allow-lists its loopback origin for subframes and revokes SDK authority
on stop (`main.ts:869-873`,
`window/createMainWindow.ts:97-102`). All previews stop on quit
(`main.ts:1109-1118`) and on workspace switch (`main.ts:1120-1131,7540-7547`).

### IPC and authority

Five channels (`main.ts:6734-6867`): `listSites`, `getSitePackage`,
`startSitePreview`, `stopSitePreview`, `invokeSiteSdk`. Start requires the
sender's active workspace, refuses code-executing modes in a shared view
(`main.ts:855-867`) and for `shared-with-me` roots (`main.ts:6773-6777`), and
registers a per-preview SDK grant bound to sender, renderer generation, and
the running preview (`main.ts:6809-6817`,
`sitePreviewSdkAuthority.ts:29-57`). `invokeSiteSdk` re-authorizes on every
call (`main.ts:6844-6867`) — a payload naming a workspace is never authority.

### The site SDK host

`invokeSiteSdkHost` (`workspaces/siteSdkHost.ts:285-376`) is what a sandboxed
site can do. Its capability map (`siteSdkHost.ts:131-141`):

| Capability | Served | Notes |
| --- | --- | --- |
| `files.read` | yes | via `readWorkspaceText` |
| `files.list` | yes | 10,000-entry cap (`siteSdkHost.ts:52`) |
| `files.write` | owned + writable only | refusals below |
| `files.watch` | no | |
| `workspace.search` | yes | ripgrep, 2,000-match cap, preview-lifetime kill (`siteSdkHost.ts:53,191-250`) |
| `workspace.events` | no | |
| `databases.read` | yes | snapshot only, no SQL (`siteSdkHost.ts:336-347`) |
| `databases.edit` | owned + writable only | exactly one operation per call (`siteSdkHost.ts:259-263`) |
| `ui.open` | yes | validated target returned to the renderer, which opens the tab (`siteSdkHost.ts:366-371`, `SitePreviewPage.tsx:240-243,267`) |

`files.write` refuses three trees: anything under workspace-root `plugins/`
("sandboxed sites cannot modify source that runs with full-trust authority",
`siteSdkHost.ts:108-115`), database files and sidecars
(`siteSdkHost.ts:116-123`), and live documents (`siteSdkHost.ts:124-129`).
Shared sites get a `scopeRoot` projection: paths are mapped into the mount and
writes are refused entirely (`siteSdkHost.ts:80-97,304-306`).

### Settings

The contract defines `sites.defaultPreviewMode` over
`WORKSPACE_PREVIEW_MODES = ["auto", "static", "dev", "build"]`
(`packages/workspace-contracts/src/workspaceSettingsValues.ts:5,19-21`,
`workspaceSettings.ts:55-57`), and the desktop merges patches to it
(`apps/desktop/src/workspaces/workspaceSettings.ts:81,101`). **Nothing reads
it.** No settings UI renders it, and the preview page chooses its mode from
per-site `localStorage` plus a heuristic (dev, else build, else static)
(`renderer/SitePreviewPage.tsx:64-106`). The stored setting is write-only
today; the renderer sends a concrete `static`/`dev`/`build` over IPC and
`auto` never crosses it.

### Renderer surfaces

- **SitesView** in the activity bar (`workbenchState.ts:9-16`,
  `ActivityBar.tsx:19-35`): lists `listSites` results, shows an optimistic
  static-site fallback synthesized from the shell's file list while loading
  (`SitesView.tsx:18-53,79-82`), and opens `dohc://site/<root>` tabs
  (`workbenchState.ts:23,59-61`). A refresh button bumps a key and re-lists
  (`DesktopWorkspaceShell.tsx:2268-2273,5167-5178`) — there is no push
  refresh.
- **SitePreviewPage** as an editor tab (`DesktopWorkspaceShell.tsx:5579-5591`):
  a sandboxed iframe (`sandbox="allow-forms allow-same-origin allow-scripts"`,
  `SitePreviewPage.tsx:567-576`) whose src carries `dohcHostOrigin`
  (`sdkFrame.ts:54-64`); a postMessage bridge that checks source window and
  exact active-preview origin on both legs
  (`SitePreviewPage.tsx:218-274`); mode menu, stop, reload, open-external via
  the audited renderer bridge (`SitePreviewPage.tsx:451`), a log drawer, and
  the share flow that builds (if needed) and hands the share manifest to the
  relay share dialog (`SitePreviewPage.tsx:313-358`,
  `DesktopWorkspaceShell.tsx:5589`).

## 2. The plugin SDK as shipped

- **Manifest** (`plugins/pluginManifestSchema.ts:249-321`): `version`, npm
  `name`, `entry` required; optional metadata, `icon`, `panels` (id, title,
  entry; `:114-121`), `commands`, `webApps` (id, title only — the URL comes
  from the running plugin; `:128-140`), and up to 20 typed `settings`
  (`:146-235`).
- **Host** (`plugins/PluginHost.ts`): one process per plugin, a fresh
  `spawnId` per run for attribution (`PluginHost.ts:75-84`), a 30 s activation
  deadline (`pluginHostProtocol.ts:100`), crash-loop auto-disable at 3 fast
  failures inside 60 s (`pluginHostProtocol.ts:115-116`), settings delivered
  with `plugin.activate` and pushed on change (`PluginHost.ts:504-517,404-416`).
- **Activation context** (`packages/sdk/src/node.ts:147-165`): `pluginId`,
  `workspaceRoot`, `pluginRoot`, a durable per-workspace `stateRoot` under the
  app's own userData, the `DohcClient`, the child-process broker,
  `settings.get()/onChange()`, and `commands.register`.
- **Child processes**: the broker forks a **JavaScript module** inside the
  plugin's built root via `utilityProcess.fork`, cwd either the built root or
  the canonical workspace root (`sdk/src/node.ts:54-68`,
  `pluginChildProcessBroker.ts:265,469-472`). There is no arbitrary-command
  spawn. Exited children are retained up to 200 per activation
  (`sdk/src/node.ts:86-94`).
- **The plugin SDK host** (`plugins/pluginSdkHost.ts:119-190`) routes exactly:
  `capabilities`, `files.read`, `files.list`, `workspace.search`,
  `files.write`, and `childProcesses.*`. Writes are engine-captured with a
  host-stamped author `plugin:<id>` plus the spawn's run id
  (`pluginSdkHost.ts:158-163`, `pluginAuthoredWrite.ts:53-79`). It delegates
  reads to `invokeSiteSdkHost` with `scopeRoot: null`
  (`pluginSdkHost.ts:112-117`) — and does **not** route `databases.read`,
  `databases.edit`, or `ui.open`, which the site host it wraps serves.
- **Panels**: served from the plugin's approved snapshot — not the live tree —
  by the same `startStaticDirectoryPreview` the sites feature uses
  (`main.ts:6970-6976`), rendered in the same sandboxed-iframe shape with the
  same postMessage bridge (`PluginPanelPage.tsx:190-199,105-156`), authorized
  per sender/generation/spawn (`pluginPanelSdkAuthority.ts:29-62`,
  `main.ts:7040-7079`). Panels are editor tabs (`workbenchState.ts:24`).
- **Web apps**: a main-process `WebContentsView` guest with a hashed
  per-workspace-per-plugin partition (`pluginWebAppGuest.ts:25-34`), URL
  restricted to `http://127.0.0.1` (`:41-54`), navigation locked to that exact
  origin with popups, downloads, and permission requests denied (`:121-142`).
  `startWebApp` is on-demand with a 90 s bound; `stopWebApp` retires a spent
  pairing (`PluginHost.ts:282-351`, `pluginHostProtocol.ts:106,111`).
- **Approval pipeline** (`plugins/PluginPipeline.ts`): the device records an
  `approvedHash` per plugin (`:106`); any live-tree change that does not equal
  the approved baseline plus recorded door-written deltas holds the plugin
  disabled for approval (`:420-432,1300-1310`). Builds bind to the hash their
  caller verified (`expectedHash`, `:213-227`). Door writes through the SDK
  auto-approve because the host attributed them (`pluginAuthoredWrite.ts:70-76`);
  watcher-observed disk changes never do. The head commit (#818) removed the
  worst false hold: a live-document session with no edits no longer rewrites
  the file at settle, so opening a plugin's README no longer changes its hash
  and disables it. A converted sites plugin lives under all of this: its own
  source is hash-bound, its panels serve approved bytes, and any edit a user's
  agent makes outside the door prompts before it runs again.

## 3. Gap analysis

Every capability Sites actually uses, against today's SDK. HAS names the
route; LACKS names the missing primitive; AWKWARD is possible but
wrong-shaped.

| # | Sites capability | Status | Detail |
| --- | --- | --- | --- |
| 1 | Enumerate workspace files for discovery | HAS | `files.list`, 10,000-entry cap (`pluginSdkHost.ts:128-133`, `siteSdkHost.ts:52`). Caveat: it returns files only; the folder-signal for an empty build-output dir (`sitePackage.ts:481-483`) is invisible to it. |
| 2 | Read `dohc.json` / `package.json` bodies | HAS | `files.read`. |
| 3 | The detection logic itself | HAS | Pure TypeScript (`sites.ts:647-736`); a plugin bundles it. Cost: `@dohc/workspace-core` is not a published plugin dependency, so the copy drifts. |
| 4 | Serve static files on loopback | AWKWARD | The full-trust host can run `node:http` itself, but the containment, reserved-path, and single-open guards (`siteRunner.ts:184-306`) are not offered as a primitive — a plugin re-implements them or silently drops them. |
| 5 | Spawn dev/build commands (`pnpm dev` …) | LACKS | The broker forks JS modules only (`pluginChildProcessBroker.ts:469-472`). Direct `child_process.spawn` works under full trust but loses the broker's supervised teardown — the exact orphan problem the broker exists to prevent. Primitive: command-capable brokered spawn. |
| 6 | Show an arbitrary loopback origin as UI | LACKS | Panels serve only snapshot files; subframe origins are allow-listed solely by main for its own previews and panels (`createMainWindow.ts:97-102`). `webApps` does show a plugin-provided origin, but as static manifest ids, one guest each. Primitive: dynamic surface instances. |
| 7 | One tab per site (`dohc://site/<root>`) | LACKS | Panel and web-app tabs are keyed by manifest ids (`workbenchState.ts:24-25`); nothing mints per-instance tabs. Same primitive as #6. |
| 8 | An activity-bar view | LACKS | `VIEW_IDS` is a static union (`workbenchState.ts:9-16`). Primitive: view contribution. |
| 9 | Open a workspace path in dohc (`ui.open`) | LACKS (plumb) | Served to sites (`siteSdkHost.ts:366-371`), not routed for plugins (`pluginSdkHost.ts:119-190`); `PluginPanelPage` has no open-path handling. |
| 10 | Open a URL in the OS browser | LACKS | Sites use the renderer's audited `openLinkExternally` (`SitePreviewPage.tsx:451`); a sandboxed panel denies popups. Belongs with #9 as one navigation primitive. |
| 11 | `databases.read` / `databases.edit` | LACKS (plumb) | Served to sites (`siteSdkHost.ts:336-365`), not routed for plugins. |
| 12 | Workspace search | HAS | `workspace.search`. |
| 13 | Write workspace text | HAS | Stronger than sites': author-stamped, engine-captured, door-attributed (`pluginSdkHost.ts:135-176`). |
| 14 | React to workspace changes | LACKS | `files.watch` and `workspace.events` are false everywhere (`siteSdkHost.ts:134-135`, `pluginSdkHost.ts:83`); SitesView leans on the shell's file list and a manual refresh button (`DesktopWorkspaceShell.tsx:2268-2273`). The subscription protocol already exists end to end (`sdk/src/index.ts:47-53`, `node.ts:404-467`); no host emits workspace events over it. |
| 15 | A user-visible setting for preview mode | HAS | Manifest settings render with real UI (`pluginManifestSchema.ts:175-235`) — better than the current setting, which nothing reads. |
| 16 | Read-only previews in shared views and share mounts | LACKS | Every plugin surface refuses a non-writable workspace (`main.ts:6880,6930`) and the plugin SDK context hardcodes `scopeRoot: null` (`pluginSdkHost.ts:112-117`). Sites serve shared-view and `shared-with-me` static previews today (`main.ts:6769-6785`). |
| 17 | Share a site over relay | LACKS | `prepareShare` hands a manifest to the shell's share dialog (`SitePreviewPage.tsx:313-358`, `DesktopWorkspaceShell.tsx:5589`) — main-process/renderer integration a guest cannot reach. |
| 18 | Host the dohc SDK for the previewed site | LACKS | The panel bridge carries the **plugin's** authority (`main.ts:7069-7077`). Forwarding it to an embedded site's code would hand sandboxed site code the plugin's writable, full-trust-adjacent surface — an authority escalation the site host's own `plugins/` write refusal exists to prevent. Primitive: scoped sub-grants. |
| 19 | dohc-native look | LACKS | SitesView renders with theme tokens (`SitesView.tsx:106-199`); a panel iframe gets raw HTML with no token bridge. |
| 20 | Lifecycle policy (stop on switch/quit, generation guards) | HAS | The pipeline/host teardown and panel authorities provide the plugin-shaped equivalents (`PluginHost.ts:442-459`, `pluginPanelSdkAuthority.ts`). |

### The primitives the LACKS suggest

Grouped so each is something any app-building agent would also need — none is
a sites-specific hook. Sizes are relative, justified from what exists; no
invented numbers.

| Primitive | Closes | Size | Why this size |
| --- | --- | --- | --- |
| **P1. SDK parity plumb-through** — route `databases.read/edit` and `ui.open` (plus open-external) through the plugin SDK host and panel bridge | #9, #10, #11 | **S** | The handlers exist in `siteSdkHost.ts`; the work is switch cases, the panel page's open-path callback (mirror `SitePreviewPage.tsx:240-267`), and authority thought about writes-while-read-only. |
| **P2. Workspace events** — `files.watch` / a workspace-changed subscription served per authority | #14 | **M** | Protocol and transports are done (`sdk/src/index.ts:47-53`); new work is wiring the existing watcher to per-grant subscriptions with the async-guard invariant. Sites itself would get push refresh out of it. |
| **P3. Command-capable child broker** — brokered spawn of a command line with the tree-kill teardown `siteRunner` already has | #5 | **M** | The broker's supervision, retention, and output plumbing exist (954 lines); `resolveSpawnCommand`/`killChildTreeWin32` exist (`siteRunner.ts:7`). New is the containment story for arbitrary executables. |
| **P4. Dynamic surfaces** — per-instance tabs whose content is a plugin-provided loopback origin (a dynamic generalization of `webApps`/panels) | #6, #7 | **M** | Guest hardening, origin allow-listing, and tab plumbing all exist; the new part is instance identity (id minted at runtime), restore semantics, and bounds on instance count. |
| **P5. Design-token bridge** — dohc's theme tokens served to panel origins | #19 | **S** | Panels are same-origin loopback pages; a token stylesheet or a postMessage token payload rides existing channels. |
| **P6. View contribution** — a plugin-declared activity-bar view backed by a panel | #8 | **M** | Manifest shape is trivial; making `VIEW_IDS` dynamic touches workbench state persistence and layout. |
| **P7. Read-only plugin authority** — plugins run with a read-only scope in shared views/mounts | #16 | **L** | Not plumbing: every plugin surface currently asserts writability, attribution assumes an owned workspace, and the approval model must decide what "approved" means for a workspace you do not own. |
| **P8. Scoped sub-grants** — a plugin asks the host to mint a *lesser* SDK grant for content it embeds | #18 | **L** | A new authority concept: grant derivation, revocation tied to two lifetimes, and an escalation-proof capability lattice. Nothing like it exists. |

Share-over-relay (#17) is deliberately not a primitive: sharing is
collaboration substrate (AGENTS.md), and the honest sketch below keeps it in
dohc.

## 4. Conversion sketch

What a `sites` plugin looks like on today's SDK **plus P1–P6**:

- **Manifest**: `name: "dohc-sites"`, a `sites` view (P6) backed by a panel
  listing detected sites, a `select` setting for the default preview mode —
  which, unlike today's `sites.defaultPreviewMode`, would actually render and
  actually be read (`pluginManifestSchema.ts:175-235`).
- **Host code** (`entry`): on activate, `files.list` + `files.read` feed a
  bundled copy of `discoverSites`; P2 events replace the refresh button.
  Static previews run on a host-owned `node:http` server reusing the
  containment rules; dev/build commands run through P3 with the loopback-bind
  refusal kept (`siteRunner.ts:389-400`). Preview-mode memory moves from
  renderer `localStorage` to the plugin's `stateRoot`.
- **Surfaces**: the list panel opens one P4 dynamic tab per site, whose
  content is the preview origin; logs render in the panel; P1's `ui.open`
  restores "open this file in dohc"; P5 makes the list look native.
- **Attribution and approval**: the plugin's writes are door-attributed
  (`pluginSdkHost.ts:158-163`); its own source is hash-approved like any
  plugin, and #818 keeps casual reading of it from tripping approval.

**What is lost or changed — honestly:**

- **Shared-view and shared-with-me previews are gone** until P7 exists.
  Plugins do not run in read-only workspaces (`main.ts:6880,6930`); Sites
  serves static previews there today. This is a user-visible regression, not
  a corner case.
- **The previewed site loses its own SDK** until P8 exists. A site inside a
  plugin-owned tab must get *no* bridge rather than the plugin's bridge —
  anything else escalates sandboxed site code toward full-trust authority.
  Sites written against `window.parent` postMessage would stop working.
- **Share-a-site stays in dohc.** The share-manifest computation
  (`sitePackage.ts:245-311`) could move into the plugin, but the relay dialog
  and grant flow are collaboration substrate; the plugin would at most invoke
  a host-owned share action that does not exist yet.
- **The optimistic instant list** (`SitesView.tsx:79-82`) becomes a
  `files.list` round trip; the plugins view already lives with the same shape.
- **Trust inversion, stated plainly**: today's Sites executes site code only
  in OS processes and sandboxed frames dohc supervises directly. Converted,
  that supervision is delegated to a full-trust plugin. Guards that are
  currently enforced (loopback binds, containment) become conventions the
  bundled plugin honors — enforceable again only if P3/P4 carry them in the
  primitive rather than in plugin code.

**The bundled-plugin approval question, crisply.** A converted Sites must be
present on first run without a prompt. Two honest options:

1. **Ship it inside the app image**, pre-approved per release (its hash is
   known at build; the pipeline's `resourcesBasePath`/snapshot machinery
   already reads app-owned paths). Invisible in `plugins/`, not forkable in
   place — it behaves like a feature that happens to use the SDK.
2. **Install it into `plugins/` on first run**, approved by that device.
   Fully visible and forkable — the philosophy's preferred answer — but then
   every dohc-shipped update to it is an out-of-band source change that holds
   it for approval (`PluginPipeline.ts:1300-1310`), and once workspace sync
   exists its source syncs to collaborators as executable content.

A hybrid (ship in the image, "eject to `plugins/`" as the fork gesture) keeps
both properties and matches design rule 4's fork-in-place intent. This is
Ice's call; nothing in the code forces either.

## 5. Verdict

The missing surface is **clean, not a swamp**: two S plumb-throughs that
correct an inversion (a sandboxed site can read databases and open tabs; a
full-trust plugin cannot), three or four M primitives that generalize
machinery that already exists once (events, command broker, dynamic surfaces,
tokens, views), and two L items that are not really "missing plugin API" at
all — they are dohc's authority model (read-only scopes, derived grants)
surfacing exactly where AGENTS.md says the substrate should be. Sites splits
on that line: discovery, servers, and list UI are app; sandboxed rendering,
origin allow-listing, share scoping, and authority stay engine/substrate.
Sequencing that falls out: land P1–P2 (small, immediately useful to every
plugin), then P3–P4 (motivated by Sites but general — any plugin wrapping a
tool that is not a JS module needs P3, and any plugin whose surfaces are
per-thing rather than per-manifest-id needs P4; t3 needs neither, which is
why the SDK ships without them), and only then convert — a conversion
attempted today would fork `discoverSites`, hand-roll supervision, and still
lose shared-view previews.

**Open decisions for Ice** (one line each, with the tradeoff):

1. Bundled approval: ship `sites` pre-approved in the app image (invisible,
   un-forkable) or install into `plugins/` (forkable, but every dohc update
   prompts) — or the eject hybrid?
2. Do P1's parity plumb-throughs (`databases.*`, `ui.open`) land now on their
   own merit, or wait for the conversion to force them?
3. Does the child broker learn arbitrary commands (P3, larger supervised
   surface) or stay JS-only, limiting a sites plugin to static/build previews?
4. Is losing shared-view/shared-with-me site previews acceptable for a
   first conversion, or is P7 (read-only plugin authority) a precondition?
5. Do plugin-embedded guests ever get scoped SDK sub-grants (P8), or do sites
   previewed by a plugin permanently lose the site SDK?
6. Is the activity bar a contribution point (P6), or do plugin views stay
   editor tabs?

## The substrate-vs-app line for the other candidates

The same test sorts the rest. **Search** is already substrate — it is an SDK
capability (`workspace.search`) before it is a view, and the view is a thin
app over it. **History** is the engine's memory itself — provenance, moments,
restore are exactly the "sturdy pieces" the letter names, so its surfaces can
become apps but its data never leaves the engine. **Chat** is collaboration
substrate: identity, shares, review gates, and relay live below any UI, and a
chat app on primitives only works if those stay first-class. **Graph** is the
purest app of the four — a view computed from links the engine already
indexes — and is the natural second conversion once P2 (events) and P1
(`ui.open`) exist, with fewer losses than Sites because it spawns nothing and
embeds nothing. The pattern the Sites spike proves: convert the surfaces,
keep the authority — and every primitive the conversion demands is one a
user's agent building its own apps was going to ask for anyway.
