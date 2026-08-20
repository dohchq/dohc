# Spike: can Graph be rebuilt as a plugin?

Date: 2026-08-19. Read-only spike; no production code changed. Base citations
are against `feat/graph-plugin-spike` at `79454c1b`, which is main after the
sites plugin (#840) and the built-in sites deletion (#841). Later corrections
name the follow-up PR or commit they use. Companion to
[`2026-08-17-sites-plugin-spike.md`](2026-08-17-sites-plugin-spike.md) and
[`2026-08-13-plugin-system.md`](2026-08-13-plugin-system.md).

The sites spike named Graph the natural second conversion: "the purest app of
the four — a view computed from links the engine already indexes — and is the
natural second conversion once P2 (events) and P1 (`ui.open`) exist, with fewer
losses than Sites because it spawns nothing and embeds nothing"
(`2026-08-17-sites-plugin-spike.md:456-460`). This spike checked that sentence
against the code. **All three supporting claims are wrong.** The corrected
picture still supports converting, but not for free: the recommended plugin is
a files-only graph.

## Conclusion

**Convert the files half after three S additions, one M primitive, and one L
port: rewrite the 886-line `GraphView` and its 333 lines of tests for an
unbundled panel, then re-home about fifteen shell tests.** The force simulation
needs no library, and every color token it draws with is already served to a
panel. The L port must include a panel stylesheet for Graph's interaction,
entrance, and reduced-motion rules. Both of graph's surfaces exist as
placements, but a plugin cannot hold both at once, so the maximize gesture that
promotes the rail view to a tab needs a small addition. The two panels also
need separate entry wrappers. If they share one entry file, an optional S host
addition must give the panel its id and placement. The editor placement adds a
40 px host title band; exact height parity costs one more S panel-layout change.

Three things block a straight port. First, **no engine indexes links** — the
desktop main process re-reads every markdown file on every graph call. A
faithful panel fallback can move about 130 MiB through per-file postMessage
calls before it crosses the graph's own 32 MiB accounting. The plugin should
get the derivation as a capability. Second, **half the graph contract is
chat**: three
node kinds and five edge kinds, of which the chat ones need the engine capture,
the linked-chat store, and shared-channel sync — collaboration substrate a
plugin must not reach. That mode is off by default, per mount, and unpersisted
(`GraphView.tsx:658`), so the files-only graph is what a user opens and it does
convert. Third, **graph has push refresh today and a panel cannot keep it**,
because `files.watch` is refused on the panel path.

The honest sizing: one **S** capability (`workspace.links`, serving the
derivation core already runs for backlinks), one **S** renderer push (the
rail's active document, on the channel that already pushes the theme), one **S**
gesture (`ui.openPanel`, so the rail view can promote itself to a tab), and the
**M** panel-subscription primitive the sites build already argued for. Exact
editor layout adds an optional **S** host change for a chrome-free editor panel;
without it, the plugin keeps the extra title band. The chat mentions mode does
not convert and should not; a plugin graph is a files-only graph. Removing the
off-by-default toggle is still a user-visible subtraction. Graph also
disappears from every non-writable shared view until the plugin platform admits
those workspaces.

## 1. Graph, end to end

### The data source — the load-bearing finding

Graph asks main for a whole graph in one call:
`bridge().readWorkspaceGraph({ workspaceId, includeChatMentions })`
(`GraphView.tsx:686-690`). Main handles it at `main.ts:4672-4819`.

The derivation is `readWorkspaceGraph` in
`apps/desktop/src/workspaces/workspaceGraph.ts:904-912`. It calls
`loadGraphDocuments` (`:853-902`), which does a `listFiles` of the workspace
and then **opens and reads every markdown file with `node:fs`** (`:827-847`).
Its bounds are stated in one place (`:65-69`):

| Bound | Value |
| --- | --- |
| `MAX_GRAPH_FILES` | 2,000 |
| `MAX_GRAPH_EDGES` | 10,000 |
| `MAX_GRAPH_LINK_CANDIDATES` | 20,000 |
| `MAX_GRAPH_FILE_TEXT_BYTES` | 512 KiB per file |
| `MAX_GRAPH_TOTAL_TEXT_BYTES` | 32 MiB total |

Link extraction strips fenced, indented, and inline code before it scans
(`:190-192,350-374`), then resolves each raw target against a four-map path
index — exact, case-folded, stem, and extension-stripped
(`:381-405,443-492`). Node titles come from each document's first H1, falling
back to the basename (`:120-127`). The loader applies the engine secret floor
so a `.env`-family file is never scanned, indexed, or surfaced (`:865-873`).

**Nothing indexes links.** The Rust engine mentions wikilinks in exactly one
place, and it is projection, not indexing: `render_wikilink` writes `[[…]]`
back out of a Y.Doc mark (`crates/dohc-engine-collab/src/ydoc.rs:2267,2597`).
A repo-wide search of `crates/` for wikilink, backlink, or link-index terms
returns five hits, all in that one function's neighbourhood. The graph is
recomputed from disk on every call.

### The second consumer

`workspaceGraph.ts` serves two IPC channels, not one. Main imports both
`readWorkspaceGraph` and `readWorkspaceBacklinks` (`main.ts:685-688`), and
`getBacklinks` (`main.ts:4821`, `channels.ts:650`) backs the "Linked mentions"
UI in `renderer/BacklinksPanel.tsx` (234 lines), mounted from
`FileInspector.tsx`. `computeBacklinks` inverts the same extraction and
resolution so a backlink and a graph edge can never disagree
(`workspaceGraph.ts:914-924`).

This is the sites lesson repeating: enumerate consumers before calling a module
graph-only. `workspaceGraph.ts` is not graph-only, and it does not move. Only
`buildMarkdownGraph` (`:494-577`) and `readWorkspaceGraph` (`:904-917`), about
98 lines, serve the graph view alone. `buildMarkdownGraph`,
`computeBacklinks`, and `extractMarkdownGraphLinks` have no production caller
outside the module; they are exported for its tests.

### The consumer outside the desktop app

`apps/site` — the marketing site — imports the desktop component directly:

```
import { GraphView } from "../../desktop/src/renderer/workbench/GraphView";
```

(`apps/site/src/DemoSidebar.tsx:9`, rendered at `:223-228`.) Worse, the demo's
panel union is derived from the desktop's view ids:
`export type DemoPanelId = ViewId | "chats"` (`:19`). Removing `"graph"` from
`VIEW_IDS` breaks the site's typecheck. The demo also carries a fake bridge
implementing `readWorkspaceGraph` (`apps/site/src/demoDesktopBridge.ts:242,441-455`).

A plugin panel cannot be imported by the site, so the demo either keeps a
forked copy, drops its graph panel, or the conversion stops. This is a product
decision, not a mechanical one, and no earlier spike surfaced it.

### Graph is not only files

The contract carries three node kinds and five edge kinds
(`ipc/bridgeContract.ts:615-666`):

- nodes: `file`, `heading` (with `filePath` + `headingAnchor`), `chat-thread`
  (with `threadId`, `channelId`, `channelWireId`, `channelName`, `channelSlug`,
  `channelKind` of `channel`/`dm`/`agent`);
- edges: `wikilink`, `markdown`, `chat-mentions-file`,
  `chat-mentions-heading`, `heading-in-file`.

Only `wikilink` and `markdown` come from `workspaceGraph.ts`. The rest are
added by `chatMentionGraphOverlay.ts` (322 lines, test 288) when the caller
passes `includeChatMentions`. That branch requires an engine capture, runs
`syncWorkspaceSharedChannels`, and reads threads and channels from
`linkedChatStoreFor` (`main.ts:4677-4700`). The result even carries a
partial-freshness marker, `sharedChannelRowsUncovered`
(`bridgeContract.ts:675-676`).

The renderer exposes this as a "Chat mentions" toggle, shown only when capture
is available (`GraphView.tsx:774-788`, `DesktopWorkspaceShell.tsx:5226`). Its
`useState(false)` belongs to each `GraphView` mount, so files-only is the
initial, unpersisted mode (`GraphView.tsx:658`). A chat node routes to a chat tab
through `onOpenChatThread` (`GraphView.tsx:469-472`, shell `:5225`).

### Live updates

Graph refreshes without being asked. The shell derives `graphRefreshKey` from
the file list (`DesktopWorkspaceShell.tsx:1811-1818`) and then folds in the
engine's moment counter (`:4799-4801`):

```
const graphKey = engineEnabled
  ? `${graphRefreshKey}\0${engineHistory?.latestMomentOrder ?? -1}`
  : graphRefreshKey;
```

The key is a prop, and a change re-runs the load effect
(`GraphView.tsx:719`). So the graph rebuilds when the file set changes **and**
when any edit settles into a moment. There is also a manual refresh button
(`:792-800`). Sites had only the button; graph has both.

### Rendering

No library. `useForceGraph` is a hand-written force simulation over
`requestAnimationFrame` — centring, ring placement, edge springs, a bounded
pairwise charge, velocity damping, and an alpha that decays to rest
(`GraphView.tsx:199-425`). It draws plain SVG `<line>` and `<g><circle><text>`
(`:518-643`), styled with dohc theme tokens (`fill-panel`, `stroke-line`,
`var(--dohc-panel)`). Dragging uses pointer capture on the SVG, and a pointer
release that did not move opens the node (`:490-516`).

Two layout variants are table-driven, `panel` and `page`
(`GraphView.tsx:61-90`): the rail packs a 260×420 map above a file list, the
tab gets 1200×760 and no list.

### Surfaces

Graph is a rail view and a singleton tab.

- Rail: `VIEW_IDS` includes `"graph"` (`workbenchState.ts:13`); the shell
  mounts `LazyGraphView` with `variant="panel"`
  (`DesktopWorkspaceShell.tsx:5218-5229`), lazily imported at `:679-681`.
- Tab: `GRAPH_TAB_PATH = "dohc://graph"` (`workbenchState.ts:73`) with
  `isGraphTabPath` (`:151-153`), opened by `openGraphTab`
  (`DesktopWorkspaceShell.tsx:3141-3143`) and rendered with `variant="page"`
  (`:5400-5411`).

One component serves both, chosen by the `variant` prop, and a maximize button
in the rail promotes one to the other (`DesktopWorkspaceShell.tsx:5195-5205`,
testid `graph-open-tab`). Section 3 shows why that pairing is the part the
plugin system does not offer.

The rail passes `activePath={activeDocumentPath}` (`:5222`). The tab passes
`activePath={groupDocumentPath}` (`:5404`), but `groupDocumentPath` is `null`
for every virtual tab (`:5342`), including Graph
(`workbenchState.ts:294-300`). The full-page graph therefore always receives
`null`; [issue #842](https://github.com/dohc-ai/dohc/issues/842) tracked the bug,
and PR #844 fixed it after this spike was written: both mounts now pass
`activeDocumentPath`. On the rail,
the active document is not decoration: it sorts first
(`GraphView.tsx:96-102`), starts at the centre (`:149-160`), gets a stronger
centring force and pushes every other node to a ring (`:230-250`), and is always
labelled (`:566`). The tab never had those active-document behaviours.

## 2. What a graph panel can reach today

The plugin SDK host routes by SDK method, then uses `requestPath` as a secondary
gate for methods that need a renderer or process event channel
(`plugins/pluginSdkHost.ts:185-320`). For a panel:

| Capability | Panel | Evidence |
| --- | --- | --- |
| `files.read` | yes | `pluginSdkHost.ts:196-201` → `workspaceSdkHost.ts` |
| `files.list` | yes, 10,000 entries | `workspaceSdkHost.ts:54,149` |
| `workspace.search` | yes, 2,000 matches | `workspaceSdkHost.ts:55,176-177` |
| `databases.read` | yes | `pluginSdkHost.ts:196-201` |
| `files.write` | yes, author-stamped | `pluginSdkHost.ts:281-320` |
| `ui.open` | panel only | `pluginSdkHost.ts:230-243` |
| `ui.openWebApp` | panel only | `pluginSdkHost.ts:246-266` |
| `ui.theme` | answered in the renderer | `PluginPanelPage.tsx:137-147` |
| `files.watch` | **refused** | `pluginSdkHost.ts:213-219` |
| chat / threads / channels | absent | SDK groups are `files`, `workspace`, `databases`, `ui` (`packages/sdk/src/index.ts:966,1047,1067,1107`) |
| active document | absent | same |

Three details matter for graph specifically. `files.list` returns files only:
`listFiles` yields `{ files, folders }`, and the SDK route uses `.files`
(`workspaceSdkHost.ts:133-151`). But this is not the graph loader's visible
set. `listFiles` skips symlinks and the `.dohc`, `node_modules`, and `.git`
directories (`workspaceFiles.ts:183-218`). `listVisibleFiles` then applies only
the requested root, recursion mode, and 10,000-entry cap. It never calls
`classifyEngineFilePathForRead`. A markdown-named secret such as
`.env.local.md` therefore appears in `files.list`.

`files.read` does not close that gap. Its `sdkWorkspacePath` call uses
`validateUserReadPath`, which rejects traversal, reserved metadata, ignored
segments, and unsafe read paths (`workspaceSdkHost.ts:71-79`,
`packages/workspace-core/src/paths.ts:192-212`). `readWorkspaceText` repeats that path
safety and real-path containment (`workspaceAssets.ts:60-95`), but neither
layer classifies `.env`-family secrets. The same `.env.local.md` is readable
through the SDK. The graph loader separately calls
`classifyEngineFilePathForRead` before it indexes or reads a path
(`workspaceGraph.ts:859-875`). Entries also carry no size and no mtime, so a
panel cannot skip a file cheaply. `files.read` returns a `contentHash`, or
`null` on a truncated read (`workspaceAssets.ts:129-131`), passed through at
`workspaceSdkHost.ts:271-277`. The SDK's own type drops it, but a raw
`request("files.read", …)` sees it. It is the only change-detection a panel
has.
`collections.*` and `provenance.record` read false for a panel
(`pluginSdkHost.ts:162-163`); graph needs neither.

The `files.watch` refusal states its own reason: "A subscription needs a
channel to push events on, and only a plugin's own process has one."
(`pluginSdkHost.ts:216`). The plugin's process does get `files.watch`, but the
process cannot render, and dohc routes exactly one message between a plugin's
process and its panel — the web-app instance key
(`2026-08-17-sites-plugin-spike.md:390-397`).

The panel iframe is not the constraint. It runs
`sandbox="allow-forms allow-same-origin allow-scripts"`
(`PluginPanelPage.tsx:283`) and its own document carries no CSP —
`staticDirectoryPreview.ts:193-197` sets only `cache-control`, `content-type`,
and `nosniff`. Scripts, ES modules, SVG, canvas, WebGL, WASM,
`ResizeObserver`, pointer capture, and drag inside the frame all work, and a
bundled layout library beside `index.html` is served (`.js`, `.mjs`, `.wasm`
are in the MIME table, `:20-39`). Graph needs none of it; its simulation is
about 225 lines of arithmetic (`GraphView.tsx:199-425`).

What the sandbox denies, graph does not use: popups, downloads, top-level
navigation, modals, and drag across the frame boundary. The renderer pushes the
theme into the frame on change (`PluginPanelPage.tsx:226-242`) — the one
host-to-panel push that exists.

## 3. Gap analysis

HAS names the route; LACKS names the missing primitive; AWKWARD is possible but
wrong-shaped.

| # | Graph capability | Status | Detail |
| --- | --- | --- | --- |
| 1 | Enumerate workspace files | HAS | `files.list`, 10,000-entry cap (`workspaceSdkHost.ts:54`), well above `MAX_GRAPH_FILES` of 2,000. |
| 2 | Read every markdown body | AWKWARD | `files.read` is one call per file. The route uses only `path`, so a raw request cannot ask for the graph's 512 KiB prefix (`workspaceSdkHost.ts:271-276`). `readWorkspaceText` returns up to 2 MiB (`workspaceTextLimits.ts:1`, `workspaceAssets.ts:416-435`). With files at least that large, a faithful sequential port transfers 65 × 2 MiB, about 130 MiB, before the 65th 512 KiB graph slice crosses the graph's 32 MiB total (`workspaceGraph.ts:65-69`). That makes G1 more valuable, not less. A full graph is still up to 2,000 round trips. No batch read exists, and the panel's default request timeout is 10 s per call (`packages/sdk/src/index.ts:428`). **No round-trip cost has ever been measured** — no benchmark, no budget entry, no timing in `PluginPanelPage.tsx` or `pluginSdkHost.ts`. AGENTS.md says to measure before setting a limit that rejects healthy work; this fan-out is the same question in reverse and is unmeasured. |
| 3 | Link extraction and resolution | AWKWARD | The logic is TypeScript, but `workspaceGraph.ts` imports `posix` from `node:path` and calls `extname`, `basename`, `normalize`, `join`, and `dirname` (`workspaceGraph.ts:1,111-125,377-482`). An unbundled browser panel cannot copy it unchanged. The fallback needs a browser-path port or a build step. Either choice still forks the resolver backlinks uses, so an edge and a backlink can drift apart — the exact property `:914-917` exists to hold. |
| 4 | Node titles | HAS | Needs each file's first H1 (`:120-127`), which comes with row 2's reads. |
| 5 | The secret floor | AWKWARD | `files.list` does not call `classifyEngineFilePathForRead`, and `files.read` enforces path safety rather than the `.env`-family secret floor (`workspaceSdkHost.ts:133-151,271-279`; `packages/workspace-core/src/paths.ts:192-212`). A no-G1 fallback must reproduce the loader's filter before it reads or indexes any path. If it does not, `.env.local.md` is readable and becomes graph input even though the core loader excludes it (`workspaceGraph.ts:859-875`). G1 is safer because it runs that loader. |
| 6 | Rail view | HAS | P6 shipped with the sites conversion; the sites manifest declares `panels[].placement: "view"`, and the rail machinery is `PLUGIN_VIEW_ID_PREFIX`/`pluginViewId`/`parsePluginViewId` (`workbenchState.ts:26-49`). Cap is 4 view panels (`pluginManifestSchema.ts:151,419-429`). |
| 7 | Singleton tab | HAS | `placement: "editor"` gives `dohc://plugin-panel/<pluginId>/<panelId>` (`workbenchState.ts:78,113-115`), collapsed by `canonicalSingletonEditorTabPath` (`:183-191`) — one tab per panel, which is what graph wants. P4 (`webApps`) is not required and would be wrong: a web app is a `WebContentsView` guest (`pluginManifestSchema.ts:158-171`) with no preload, Node, IPC, or workspace authority (`pluginWebAppGuest.ts:1-6`). |
| 7b | **Both surfaces at once** | LACKS | The placements are exclusive by design: `z.enum(["editor","view"])` (`pluginManifestSchema.ts:120`) with the reason at `:115-119` — "a running panel is keyed by (workspace, plugin, panel) and starting a second one stops the first". Opening a view panel as a tab is refused (`pluginPanelRegistration.ts:242-249`). A plugin can declare **two** panels sharing one entry file, but nothing lets one open the other: graph's maximize button (`DesktopWorkspaceShell.tsx:5195-5205`, testid `graph-open-tab`) has no SDK equivalent. `ui.open` takes a workspace path, `ui.openWebApp` takes a web app. |
| 7c | Editor panel chrome | AWKWARD | Every `placement: "editor"` panel gets a host header with the panel title and plugin id before the iframe (`PluginPanelPage.tsx:249-260`). Graph already draws its own 40 px count-and-refresh header (`GraphView.tsx:754-801`), so the converted tab gains a second title band and loses 40 px of map height. Exact parity needs an **S** panel-layout change, such as an explicit chrome-free editor-panel mode; otherwise this visible change is part of the conversion. The remedy is S: one explicit layout choice, its registration plumbing, a conditional header, and host tests. |
| 7d | Know which panel placement is running | LACKS | Two panels may point at one entry file, but that file cannot tell whether it is the rail or editor panel. `StartPluginPanelResult` returns only `url` and `title` after `status` (`bridgeContract.ts:2160-2168`), and `frameUrlWithHostOrigin` adds only `dohcHostOrigin` (`sdkFrame.ts:54-63`). Viewport-size inference is not a contract: users can resize the rail, and an editor group can be as narrow as the rail. The conversion must use separate entry wrappers or add G5 so the panel receives its id and placement. |
| 8 | Open a file | HAS | `ui.open` is routed for panels (`pluginSdkHost.ts:230-239`) and returns `{ target }`, a workspace path (`workspaceSdkHost.ts:343-349`). |
| 8b | Open a file **at a heading** | LACKS | Graph opens with an anchor (`GraphView.tsx:474`, shell `openPathWithHeading`). The panel page reads only `target` and calls `onOpenPath(target)` with one argument (`PluginPanelPage.tsx:166-169`); the host's `position` passthrough (`workspaceSdkHost.ts:347`) is dropped. Moot if row 13 stays out, because heading nodes come from the same overlay. |
| 9 | dohc-native look and interaction | AWKWARD | `ui.theme` plus the theme push (`PluginPanelPage.tsx:137-147,226-242`) carries all 14 color tokens Graph draws with. Base paint can use inline styles, but inline styles cannot express the `:active`, `:hover`, or `:focus-visible` descendant selectors or either `@keyframes` rule (`styles.css:816-900`). Graph nodes also suppress the normal outline (`GraphView.tsx:573-578`), so dropping those rules removes keyboard-focus visibility, hover feedback, and node and edge entrance animations. dohc's global `[data-reduce-motion='true']` reset suppresses those animations for the built-in Graph (`styles.css:121-130`). The theme application sets that attribute inside the panel (`packages/sdk/src/index.ts:244-256`), but the iframe does not receive the global stylesheet (`pluginPanelTheme.ts:1-3`). The L port must ship a panel stylesheet with the interaction and animation rules and copy the attribute-based reset. If it does not, the conversion ignores the accessibility setting. The theme carries two font-family stacks but not the font files, so a panel origin falls through to system families (`renderer/tokens.ts:103-115`). Typography and SVG label metrics will still differ. |
| 9b | Native editor context menu | LACKS | The built-in page graph sits under the editor wrapper. Its right-clicks bubble to `onContextMenu`, which calls `showWorkbenchMenu("editor", ...)` (`DesktopWorkspaceShell.tsx:5384-5390`). A right-click inside `PluginPanelPage`'s iframe stays in the frame document, and the panel page has no route that forwards it (`PluginPanelPage.tsx:277-285`). The converted tab loses the native editor menu. |
| 10 | Rebuild when files change | LACKS | `files.watch` refused on the panel path (`pluginSdkHost.ts:213-219`); tracked as open issue #838, which records zero product consumers today. Partial mitigation: `files.read` returns a `contentHash` (`workspaceAssets.ts:129-131`, passed through at `workspaceSdkHost.ts:271-277`), so a panel can poll for change without re-parsing. It is still polling. Sites polls on `visibilitychange` (`plugins/sites/ui/index.js:230-232`). |
| 11 | Rebuild when an edit settles | LACKS | Today's key folds in `latestMomentOrder` (`DesktopWorkspaceShell.tsx:4799-4801`). No SDK surfaces moments. A file-level watch would not be equivalent: a settle rewrites the artifact, so it may arrive as a file event, but nothing in the SDK says so. |
| 12 | Know the active document | LACKS | This is rail behavior: `activeDocumentPath` drives ordering, centring, and the ring layout there (`DesktopWorkspaceShell.tsx:5222`; `GraphView.tsx:96-102,149-160,230-250`). The tab received `null` until [#842](https://github.com/dohc-ai/dohc/issues/842) was fixed (PR #844); both mounts now pass `activeDocumentPath`. No SDK member carries the rail's active path. |
| 13 | Chat-thread nodes and chat edges | LACKS, and should stay LACKS | Needs engine capture, `syncWorkspaceSharedChannels`, and `linkedChatStoreFor` (`main.ts:4677-4700`). AGENTS.md puts identity, shares, and relay below any UI. |
| 14 | Open a chat thread | LACKS | `onOpenChatThread` reaches a chat tab (`GraphView.tsx:469-472`); `ui.open` takes a workspace path. Moot if 13 stays out. |

### The primitives the LACKS suggest

| Primitive | Closes | Size | Why this size |
| --- | --- | --- | --- |
| **G1. `workspace.links`** — an SDK capability returning the full bounded files-only `WorkspaceGraph`: `nodes`, `edges`, `unresolvedLinks`, `scannedFileCount`, `omittedFileCount`, and `truncatedFileCount` (`workspaceGraph.ts:28-35`; `bridgeContract.ts:674-684`) | 2, 3, 5 | **S** | `readWorkspaceGraph` is written and bounded (`workspaceGraph.ts:904-912`). The plumbing spans a `workspaceSdkHost.ts` case, an explicit `pluginSdkHost.ts` forwarding case because its default rejects unknown methods (`pluginSdkHost.ts:184-203,323-344`), capability and SDK exposure, and host/SDK tests. It stays S by the sites spike's P1 SDK-parity precedent, which routed `databases.*` and `ui.open` through the same layers (`2026-08-17-sites-plugin-spike.md:254-256`). G1 saves the per-file bridge calls, keeps one link resolver, and applies the core loader's secret floor. The panel must receive `unresolvedLinks`, `omittedFileCount`, and `truncatedFileCount` unchanged so it can keep the built-in incompleteness notices (`GraphView.tsx:427-438`). G1 must also revise the request deadline for `workspace.links`. The panel transport defaults to 10 seconds and accepts a per-call `timeoutMs` override (`packages/sdk/src/index.ts:69-72,428,499`), while the current graph IPC call has no deadline (`preload.ts:134-135`). One call can read up to 2,000 files sequentially (`workspaceGraph.ts:65-69,853-912`), so the default can reject a healthy workspace on slow storage. Measure the whole derivation on representative workspaces before setting either an evidence-based transport deadline or a per-call override. |
| **G2. Active-document push** — the renderer sends the active workspace path to every mounted graph panel | 12 | **S** | Same channel and shape as the theme push (`PluginPanelPage.tsx:231-234`); the renderer already passes `activeDocumentPath` to the rail (`DesktopWorkspaceShell.tsx:5222`). Since the [#842](https://github.com/dohc-ai/dohc/issues/842) fix (PR #844), both built-in mounts receive `activeDocumentPath`, so G2 pushes to every mounted graph panel the plugin keeps — a rail-only push would reintroduce #842 in the editor panel. Needs the workspace/generation guard the panel's SDK responses already carry. |
| **G3. Panel subscriptions** — a guarded relay from the workspace event feed to the panel that asked | 10, 11 | **M** | Named by the sites build as the next primitive (`2026-08-17-sites-plugin-spike.md:406-410`) and by issue #838. The feed exists and caps each plugin spawn at 16 open subscriptions (`plugins/pluginWorkspaceEvents.ts:5-14,88-95`), and the push direction exists; new work is per-panel subscriptions under the same guards, and a decision on whether a settled moment is visible at all. One settled batch emits one subscription event per changed path (`pluginWorkspaceEvents.ts:150-170`). A checkout can therefore deliver hundreds of callbacks, and each immediate `workspace.links` refresh can reread up to 2,000 files (`workspaceGraph.ts:65-69,853-912`). Before G3 can count as preserved push refresh, the graph panel must debounce the event burst into one scan or keep one scan in flight and set a dirty flag for one follow-up scan. The Sites panel is the precedent: issue #838's implementation clears and rearms a 300 ms timer before `load()` (`apps/desktop/plugins/sites/ui/index.js`, panel-watch commit `5aa04300`). |
| **G4. `ui.openPanel`** — a panel asks dohc to open another of its own panels as a tab | 7b | **S** | The same shape as `ui.openWebApp` (`pluginSdkHost.ts:246-280`): the plugin id comes from the grant, never the request, and the renderer performs the open. The tab path already exists (`workbenchState.ts:78`) and is already a singleton. Without it, graph loses its maximize button. |
| **G5. Panel identity context** — give a panel `{ panelId, placement }` in its host-provided context | 7d | **S**, optional | The renderer already knows both values and passes `placement` to the start request (`PluginPanelPage.tsx:29-45,67-72`). The host must expose them to the iframe, then cover the context shape and stale-panel guard in host and SDK tests. This is informational context, not authority. G5 is unnecessary if the two manifest entries use separate rail and editor entry wrappers. |

G1 is the one worth arguing about, because it moves the derivation from app to
substrate. Two facts push that way: backlinks needs it in core regardless, and
every graph-shaped plugin a user's agent writes would otherwise re-read the
whole workspace. Two facts push back: it is a richer contract to keep stable,
and the sites rule was "convert the surfaces, keep the authority" — link
derivation is neither surface nor authority, so the rule does not decide it.

G1 does not expand the panel's raw-file read authority. It is safer than the
no-G1 fallback. The panel can already list and read `.env.local.md`, because
the SDK routes apply path safety but not `classifyEngineFilePathForRead`
(`workspaceSdkHost.ts:133-151,271-279`). `workspace.links` would run the core
loader and exclude that path before reading or indexing it
(`workspaceGraph.ts:859-875`). A no-G1 fallback must reproduce that filter
exactly. If it reads every markdown path returned by `files.list`, it leaks
content that the graph and backlinks deliberately exclude. G1 also replaces
up to 2,000 per-file bridge calls with one bounded derivation call.

G1's payload fits. The 4 MiB, depth-32, 20,000-value bound
(`bridgeContract.ts:2524-2526`) applies to request **params**, enforced in the
preload; the response is `z.object({ result: z.unknown() })` (`:2695`) with no
declared cap. A 2,000-node, 10,000-edge result crosses in one message. If G1
lands, give the response a stated bound rather than inheriting none.

**The alternative to G1, bounded by the code's own caps.** A panel could skip
full reads and use `workspace.search` with a regex for `[[…]]` and `](…)`. It fails on three
counts. The cap is 2,000 matches (`workspaceSdkHost.ts:55`) against 10,000
edges and 20,000 link candidates today. Ripgrep cannot strip code, so a
`[[link]]` inside a fenced block becomes an edge, which today it never does
(`workspaceGraph.ts:190-192`). And titles need a second search budget for
`^# `. The result is a different, wronger graph.

## 4. What dies, what stays

If graph converts, the chat overlay is deleted with its only production
consumer:

**Moves to the plugin**

| File | Lines |
| --- | --- |
| `renderer/workbench/GraphView.tsx` | 886 |
| `renderer/workbench/GraphView.test.tsx` | 333 |

Neither moves unchanged. `GraphView.tsx` is 886 lines of React and TSX; the
sites plugin's panel is vanilla JavaScript and HTML under `ui/`
(`apps/desktop/plugins/sites/`), because a panel is static files with no
bundler (`2026-08-17-sites-plugin-spike.md:392-395`). A converted graph either
adds a build step or is rewritten without React, and its tests are rewritten
either way. Only the force-simulation arithmetic ports unchanged. The SVG uses
Tailwind utilities such as `fill-panel`, `stroke-line`, `text-ink`, and
`stroke-match/70`, plus four bespoke classes: `dohc-graph-edge`,
`dohc-graph-node`, `dohc-graph-node-halo`, and `dohc-graph-node-dot`
(`GraphView.tsx:518-643`, `styles.css:816-900`). None reaches a panel iframe.
The 14-color theme payload covers the palette (`renderer/tokens.ts:86-101`),
and base SVG declarations can become inline styles and CSS-variable references.
The `:hover` and `:focus-visible` descendant selectors and the node and edge
`@keyframes` cannot. Since each node also has `outline-none`
(`GraphView.tsx:573-578`), the L port must include a panel stylesheet for those
rules. Omitting it removes keyboard-focus visibility, hover feedback, and both
entrance animations. The two font tokens name stacks, not loadable assets. On
a panel origin they fall through to system families
(`renderer/tokens.ts:103-115`).

**Deleted from core**

| Site | Lines |
| --- | --- |
| `main.ts:4672-4819` — the `readWorkspaceGraph` handler, of which `:4678-4818` is the chat branch | 148 |
| `main.ts` imports `:235,270,686,694` | 4 |
| `bridgeContract.ts:609-684` — node, edge, payload, result schemas | 76 |
| `bridgeContract.ts:4127-4129` — the bridge method | 3 |
| `channels.ts:649` + `preload.ts:134-135` | 3 |
| `workbenchState.ts:13,73,151-153,296` — `VIEW_IDS` entry, `GRAPH_TAB_PATH`, `isGraphTabPath`, and the `isVirtualTabPath` registration that keeps a persisted `dohc://graph` tab alive | ~7 |
| `ActivityBar.tsx:24,32` — rail icon and label, both entries in `Record<ViewId, …>` maps | 2 |
| `DesktopWorkspaceShell.tsx` — `graphChatOpenTarget` `:531-574`, lazy import `:679-681`, `graphRefreshKey` `:1811-1818`, `openGraphTab` `:3141-3143`, `openGraphChatThread` `:3298-3316`, `graphKey` `:4799-4801`, maximize button `:5195-5205`, two mounts `:5218-5229,5400-5411` | ~115 |
| `workspaces/chatMentionGraphOverlay.ts` + test | 322 + 288 |

About 2,180 lines are deleted or moved in total. The chat overlay goes with the
graph handler, its only production importer (`main.ts:694,4759`), and its test
goes with it. This records the chat-mentions mode as the conversion's
user-visible subtraction; the overlay does not remain in core without a
consumer.

`workbenchState.ts:296` deserves its own line. It registers `dohc://graph` as
a live virtual tab so `isRemovedVirtualTabPath` does not drop it from persisted
state. The sites removal already documented this exact case at `:280-284`, and
`workbenchState.test.ts:1011` asserts the current answer — that assertion
inverts on removal.

**Stays core**

- `workspaces/workspaceGraph.ts` (924) and its test (529) — backlinks needs
  the extraction and resolution helpers `:110-493` plus `computeBacklinks`
  (`main.ts:685-688`, `:4821-4828`).
- `renderer/BacklinksPanel.tsx` (234) and its test (172), mounted from
  `FileInspector.tsx:63,3160-3169` on every markdown open.
- `getBacklinks`, `listWorkspaceHeadings`, `listChatFileMentions` channels.

Sites deleted a subsystem; graph deletes a view and leaves the derivation.

### The test cost is larger than the graph's own tests

`describe("graph view")` in the shell suite is one test, 34 lines
(`DesktopWorkspaceShell.test.tsx:7479-7512`). But fifteen tests that are not
about graph **drive themselves through the graph UI**. One parameterized
duplicate-file test uses Graph's maximize button (`:2602-2605`). Fourteen
DM-navigation tests stub `readWorkspaceGraph` and click `activity-graph` →
`graph-chat-mentions-toggle` → `graph-file-row` to exercise
`openGraphChatThread` and canonical DM navigation (`:4059-4966`). The
shared-view gate `:11371-11389` asserts that a shared view offers no chat
mentions in the graph.

None of those tests can drive a plugin panel. They need a new driver, or the
coverage goes. Budget for that before the conversion, not during it. The e2e
suites touch graph as well (`e2e/renderer-stability.spec.ts:88`,
`e2e/ui-audit-screenshots.spec.ts:213-216`), and
`bridgeContract.test.ts:446-491` covers the wire contract that dies.

One source-contract test also breaks when the handler dies:

| Test | Conversion action |
| --- | --- |
| `main.sharedChannelSyncBound.test.ts:174-189` | Its aggregate-read loop includes `WorkspaceGraphResult`, then uses `sourceBetween` to find `return WorkspaceGraphResult.parse({` and assert the shared-channel partiality field (`:177-187`). Deleting the chat branch removes that response. Remove the graph case with the overlay, or replace it with coverage for any new host route that still exposes graph shared-channel partiality. |

## 5. Conversion sketch, and what it loses

A `graph` plugin on today's SDK plus G1–G4:

- **Manifest**: `name: "dohc-graph"`, and **two** panels with separate entry
  wrappers — `graph` with `placement: "view"` for the rail, `graph-tab` with
  `placement: "editor"` for the full-page shape. Two ids are needed because the
  placements are exclusive (`pluginManifestSchema.ts:115-120`), and G4 is what
  lets the first open the second. Each wrapper selects its layout explicitly,
  then imports the shared graph code. A shared entry file is valid only if G5
  gives it `{ panelId, placement }`; viewport size cannot distinguish a resized
  rail from a narrow editor group (`bridgeContract.ts:2160-2168`;
  `sdkFrame.ts:54-63`). Each is its own running panel. That does not introduce a
  simulation-state split: today's rail and editor are separate
  `GraphView` mounts (`DesktopWorkspaceShell.tsx:5218-5229,5400-5411`), and
  each mount's `GraphMap` owns its own `useForceGraph` state
  (`GraphView.tsx:199-218,441-460`). The editor panel also receives the host's
  title-and-plugin-id header before its iframe (`PluginPanelPage.tsx:249-260`),
  above Graph's own count-and-refresh header (`GraphView.tsx:754-801`).
- **Panel code**: on open, `workspace.links` (G1) returns the full bounded
  `WorkspaceGraph`. The panel keeps the unresolved, omitted, and truncated
  notices. The force-simulation arithmetic ports. Base SVG paint becomes inline
  styles and theme-variable references, while a panel stylesheet preserves the
  hover, focus-visible, and entrance-animation rules. That stylesheet must also
  copy the global `[data-reduce-motion='true']` reset (`styles.css:121-130`).
  The theme push sets the attribute, but the iframe does not receive the global
  stylesheet (`packages/sdk/src/index.ts:244-256`; `pluginPanelTheme.ts:1-3`).
  If the panel omits the reset, the conversion ignores the accessibility
  setting. G2 supplies the rail's active document for centring. G3 replaces the
  refresh key only after the panel debounces each event burst or serializes G1
  scans with an in-flight flag and one dirty follow-up. `ui.open` handles node
  clicks. `ui.theme` plus the theme push supplies the palette.
- **Without G1**: `files.list` then `files.read` per markdown file. Before any
  read or path indexing, the panel must reproduce
  `classifyEngineFilePathForRead` or it leaks markdown-named secrets. The
  extractor and resolver also import `node:path`; an unbundled panel needs a
  browser-path port or a build step. Both copies carry the drift cost in rows 3
  and 5.

**What the recommended G1-G4 design still loses or changes:**

- **Chat mentions are gone.** The toggle, chat-thread nodes, both chat edge
  kinds, `heading-in-file` edges, and opening a thread from a node all go. This
  is the largest subtraction and it is not recoverable by a primitive anyone
  should build: it would mean handing plugins the chat store.
- **G3 preserves push refresh only after the panel coalesces events.** One
  settled batch emits one event per changed path
  (`pluginWorkspaceEvents.ts:150-170`). Calling `workspace.links` from every
  callback can start hundreds of concurrent scans after a checkout, and each
  scan can reread 2,000 files. The panel must debounce the burst or allow one
  scan in flight with a dirty flag for one follow-up. The Sites panel uses a
  300 ms debounce for the same feed (`apps/desktop/plugins/sites/ui/index.js`,
  panel-watch commit `5aa04300`). Moment-level parity still needs measurement.
  Graph rebuilds on every settled moment today
  (`DesktopWorkspaceShell.tsx:4799-4801`). G3 relays workspace file events to
  the panel. Measure whether every settled edit produces the expected event,
  and how quickly, before promising identical freshness.
- **The rail's active document is a push, not a prop.** Today it is React state
  in the same tree; converted, it is a message that can arrive late. The rail's
  centring animation will visibly lag a tab switch. The full-page graph received
  `null` until the [#842](https://github.com/dohc-ai/dohc/issues/842) fix
  (PR #844); both mounts now carry the active document.
- **The tests are rewritten, not moved.** No bundler in a panel, and about
  fifteen shell tests lose the Graph UI they drive through. The aggregate-read
  loop in `main.sharedChannelSyncBound.test.ts:177-187` also loses its
  `WorkspaceGraphResult.parse` source target and needs the remove-or-replace
  action in section 4.
- **The marketing site loses its graph panel** or keeps a forked copy
  (`apps/site/src/DemoSidebar.tsx:9,223-228`).
- **Typography is approximate.** The theme payload carries dohc's font stacks,
  but a panel origin cannot load the bundled families and falls back to system
  fonts (`renderer/tokens.ts:103-115`). SVG node-label glyph widths and
  baselines change, so label fit and alignment can differ from the built-in
  graph.
- **The editor tab gains a second title band.** Every editor panel gets the
  host's panel-title and plugin-id header (`PluginPanelPage.tsx:249-260`) above
  Graph's own count-and-refresh header. The map loses 40 px of height. Removing
  the band needs the S panel-layout change in row 7c; G1-G4 do not cover it.
- **The native editor context menu is gone.** Right-clicks on the built-in page
  graph bubble to the editor wrapper and call `showWorkbenchMenu("editor", ...)`
  (`DesktopWorkspaceShell.tsx:5384-5390`). Events inside the panel iframe do not
  reach that wrapper, and no panel host route replaces them. The converted tab
  loses the native edit-role menu.
- **Graph disappears from every non-writable shared view.** The built-in Graph
  works there in files-only mode
  (`DesktopWorkspaceShell.test.tsx:11365-11389`), and its loader includes
  readable share mounts (`workspaceGraph.ts:868-873`). Starting a plugin panel
  takes the blanket writable-workspace gate (`main.ts:817-824,6590-6608`). P7
  remains the open item the sites spike recorded. Until it lands, this is a
  conversion loss, not an inherited implementation detail.

**What today's SDK baseline loses or changes without G1-G4:**

- **Link resolution forks.** Two copies of a four-map path index and a code
  stripper, one serving backlinks and one serving graph, can disagree. The
  property at `workspaceGraph.ts:914-917` exists to prevent this.
- **Data cost rises to 2,000 round trips.** Each SDK read can return 2 MiB while
  Graph counts only a 512 KiB prefix. A faithful sequential port can transfer
  about 130 MiB before crossing Graph's 32 MiB accounting
  (`workspaceSdkHost.ts:271-276`, `workspaceAssets.ts:416-435`,
  `workspaceGraph.ts:65-69`).
- **Push refresh is gone.** Without G3, a panel gets an open-time read and a
  refresh button, but no event that asks it to rebuild.
- **The maximize gesture is gone.** Without G4, the rail panel cannot open the
  editor panel. G4 keeps the built-in gesture that opens Graph in a tab
  (`DesktopWorkspaceShell.tsx:5195-5205`).

## 6. Verdict

**Convert with four sized additions — G1 (S), G2 (S), G4 (S), G3 (M) — plus an
L port: rewrite the 886-line `GraphView` and its 333 lines of tests for an
unbundled panel, then re-home about fifteen shell tests and remove or replace
one aggregate-read source assertion. Accept losing the chat mentions mode and
native editor context menu. Accept that Graph disappears from every
non-writable shared view until P7 lands. Accept the extra editor title band or
add an S host layout change. Use separate entry wrappers, or add the optional
G5 (S) panel identity context.** Ice's roadmap assumption survives, but its
three supporting claims do not:

1. **The engine does not index links.** Graph is not a thin view over indexed
   data; it is a 924-line derivation over a full workspace read, and that
   derivation has a second consumer. Any plan that assumed a plugin could just
   ask for the links must now choose: expose the derivation (G1), or let every
   graph plugin re-read the workspace and fork the resolver.
2. **Graph is not the purest app of the four.** Its contract is over half chat:
   two of three node kinds and three of five edge kinds come from the chat
   store through the engine capture. The files-only graph converts cleanly.
   That is the graph a user sees on open. What does not convert is the chat
   mentions mode behind an off-by-default, per-mount toggle
   (`GraphView.tsx:658`).

The sites spike's third claim — fewer losses than Sites — is wrong about the
total, though it names the mechanism correctly. Graph spawns nothing and embeds
nothing, so it needs no P3, no P4, and no P8, and that is why every addition
here is S except one.

- **Recommended G1-G4 design:** Graph loses the chat-mentions mode, exact
  typography, the native editor context menu, and availability in every
  non-writable shared view. The editor tab gains a 40 px host title band unless
  an S panel-layout change removes it. The L port's panel stylesheet preserves
  keyboard-focus visibility, hover feedback, and entrance animations, and
  copies the attribute-based reduced-motion reset. Moment-level refresh parity
  still needs measurement. G3 keeps push refresh only after the panel
  coalesces its per-path events. G4 keeps the maximize gesture. Separate entry
  wrappers distinguish the two layouts; sharing one entry instead adds G5 (S).
- **Today's SDK baseline:** Graph loses those features or changes plus push
  refresh and the maximize gesture because panels lack subscriptions and a way
  to open another panel.

Sites lost shared-view previews and an embedded SDK. Graph also disappears from
every non-writable shared view, so shared-view availability is a common plugin
platform loss, not a Sites-only loss. The recommended Graph list is not
shorter. It is only cheaper to build.

Two costs sit outside the primitives and outside the plugin: `apps/site` breaks
until someone decides what the demo shows, and the test suite loses about
fifteen shell drivers plus one aggregate-read source target. Neither is hard.
Both are invisible until you look, which is why they are decisions 3 and 4
below.

Sequencing: G1, G2, and G4 are each small and useful beyond graph — a links
capability serves any plugin that reasons about structure, an active-document
push serves any panel that follows the user, and `ui.openPanel` serves any
plugin whose rail view wants more room. G3 is already the sites build's named
next primitive and issue #838's subject; justify it on its own merit, not on
this conversion. Convert after all four, and coalesce G3 events before each G1
scan. Use separate entry wrappers unless G5 lands. Converting before G1 forks
the resolver that backlinks depends on, and that fork is the one cost here
that gets worse the longer it exists.

**Open decisions for Ice** (one line each, with the tradeoff):

1. Is link derivation substrate? G1 makes it an SDK capability and keeps one
   resolver; refusing it keeps the SDK smaller and forks the resolver.
2. Does the converted graph ship in the app image or install into `plugins/`?
   The same unresolved question the sites spike left open
   (`2026-08-17-sites-plugin-spike.md:326-346`); graph does not add to it.
3. Does the marketing site keep a graph panel? It imports the desktop component
   directly (`apps/site/src/DemoSidebar.tsx:9`), so the options are a forked
   copy, no graph in the demo, or a demo that runs real plugins.
4. Who re-homes the fifteen shell tests that drive through the Graph UI
   (`DesktopWorkspaceShell.test.tsx:2602-2605,4059-4966`) and removes or
   replaces the `WorkspaceGraphResult` aggregate-read assertion before the view
   goes?
5. Two panels plus G4, or one rail-only panel and no full-page graph? The
   second is free and loses the tab. If both ship, use separate entry wrappers
   or budget G5 (S) to expose `{ panelId, placement }`; viewport size is not a
   placement contract.
6. Does anyone measure the panel bridge round trip before this is scheduled?
   Nothing in the repo measures it, and the choice between G1 and 2,000
   `files.read` calls turns on that number.
7. Does the editor panel keep its extra 40 px host title band? Accept the lost
   map height, or budget the S panel-layout change in row 7c.
8. Does the conversion accept removing Graph from every non-writable shared
   view? The built-in works there today; keeping that availability means P7
   must land before conversion.
