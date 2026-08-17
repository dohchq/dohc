# Spike: can Graph be rebuilt as a plugin?

Date: 2026-08-19. Read-only spike; no production code changed. Every citation
is against `feat/graph-plugin-spike` at `79454c1b`, which is main after the
sites plugin (#840) and the built-in sites deletion (#841). Companion to
[`2026-08-17-sites-plugin-spike.md`](2026-08-17-sites-plugin-spike.md) and
[`2026-08-13-plugin-system.md`](2026-08-13-plugin-system.md).

The sites spike named Graph the natural second conversion: "the purest app of
the four — a view computed from links the engine already indexes — ... with
fewer losses than Sites because it spawns nothing and embeds nothing"
(`2026-08-17-sites-plugin-spike.md:456-460`). This spike checked that sentence
against the code. **Two of its three claims are wrong, and the third is right
for the wrong reason.** The corrected picture still supports converting, but
not for free and not without a decision from Ice about what the graph is
allowed to show.

## Conclusion

**Convert the files half, after three small additions and one medium
primitive.** The rendering ports cleanly: hand-rolled SVG, no library, and
every theme token it draws with is already served to a panel. Both of graph's
surfaces exist as placements, but a plugin cannot hold both at once, so the
maximize gesture that promotes the rail view to a tab needs a small addition.

Three things block a straight port. First, **no engine indexes links** — the
desktop main process re-reads every markdown file on every graph call, so a
plugin either re-reads 32 MiB through a per-file postMessage bridge or gets the
derivation as a capability. Second, **half the graph is chat**: three node
kinds and five edge kinds, of which the chat ones need the engine capture,
the linked-chat store, and shared-channel sync — collaboration substrate a
plugin must not reach. Third, **graph has push refresh today and a panel
cannot keep it**, because `files.watch` is refused on the panel path.

The honest sizing: one **S** capability (`workspace.links`, serving the
derivation core already runs for backlinks), one **S** renderer push (the
active document, on the channel that already pushes the theme), one **S**
gesture (`ui.openPanel`, so the rail view can promote itself to a tab), and the
**M** panel-subscription primitive the sites build already argued for. The chat
overlay does not convert and should not; a plugin graph is a files-only graph,
and that is a real, user-visible subtraction.

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
(`ipc/bridgeContract.ts:628-666`):

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
is available (`GraphView.tsx:774-788`, `DesktopWorkspaceShell.tsx:5226`), and
routes a chat node to a chat tab through `onOpenChatThread`
(`GraphView.tsx:469-472`, shell `:5225`).

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

Both mounts pass `activePath={activeDocumentPath}` (`:5222`, `:5404`). The
active document is not decoration: it sorts first (`GraphView.tsx:96-102`),
starts at the centre (`:149-160`), gets a stronger centring force and pushes
every other node to a ring (`:230-250`), and is always labelled (`:566`).

## 2. What a graph panel can reach today

The plugin SDK host routes by request path (`plugins/pluginSdkHost.ts:185-320`).
For a panel:

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

Three details matter for graph specifically. `files.list` returns files only —
`listFiles` yields `{ files, folders }` but the SDK route uses `.files`
(`workspaceSdkHost.ts:137-150`) — which is exactly what the path index needs
(`workspaceGraph.ts:871-874`), so nothing is lost. Entries carry no size and no
mtime, so a panel cannot skip a file cheaply. And `files.read` returns a
`contentHash` — `null` on a truncated read (`workspaceAssets.ts:129-131`),
passed through at `workspaceSdkHost.ts:271-277`. The SDK's own type drops it,
but a raw `request("files.read", …)` sees it. It is the only change-detection a
panel has.
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
| 2 | Read every markdown body | AWKWARD | `files.read` is one call per file, capped at 2 MiB each (`workspaceAssets.ts:127`), above graph's own 512 KiB. A full graph is up to 2,000 round trips and 32 MiB across the panel bridge (`workspaceGraph.ts:65-69`), against one IPC call today. No batch read exists, and the panel's default request timeout is 10 s per call (`packages/sdk/src/index.ts:428`). **No round-trip cost has ever been measured** — no benchmark, no budget entry, no timing in `PluginPanelPage.tsx` or `pluginSdkHost.ts`. AGENTS.md says to measure before setting a limit that rejects healthy work; this fan-out is the same question in reverse and is unmeasured. |
| 3 | Link extraction and resolution | HAS | Pure TypeScript (`workspaceGraph.ts:350-492`); a plugin bundles it. Cost: the copy forks from the one backlinks still uses, so an edge and a backlink can drift apart — the exact property `:914-917` exists to hold. |
| 4 | Node titles | HAS | Needs each file's first H1 (`:120-127`), which comes with row 2's reads. |
| 5 | The secret floor | HAS | `files.list` and `files.read` enforce workspace policy; the plugin never opens files itself. |
| 6 | Rail view | HAS | P6 shipped with the sites conversion; the sites manifest declares `panels[].placement: "view"`, and the rail machinery is `PLUGIN_VIEW_ID_PREFIX`/`pluginViewId`/`parsePluginViewId` (`workbenchState.ts:26-49`). Cap is 4 view panels (`pluginManifestSchema.ts:151,419-429`). |
| 7 | Singleton tab | HAS | `placement: "editor"` gives `dohc://plugin-panel/<pluginId>/<panelId>` (`workbenchState.ts:78`), collapsed by `canonicalSingletonEditorTabPath` (`:183-191`) — one tab per panel, which is what graph wants. P4 (`webApps`) is not required and would be wrong: a web app is a `WebContentsView` guest with no SDK bridge (`pluginManifestSchema.ts:158-171`). |
| 7b | **Both surfaces at once** | LACKS | The placements are exclusive by design: `z.enum(["editor","view"])` (`pluginManifestSchema.ts:120`) with the reason at `:115-119` — "a running panel is keyed by (workspace, plugin, panel) and starting a second one stops the first". Opening a view panel as a tab is refused (`pluginPanelRegistration.ts:242-249`). A plugin can declare **two** panels sharing one entry file, but nothing lets one open the other: graph's maximize button (`DesktopWorkspaceShell.tsx:5195-5205`, testid `graph-open-tab`) has no SDK equivalent. `ui.open` takes a workspace path, `ui.openWebApp` takes a web app. |
| 8 | Open a file | HAS | `ui.open` is routed for panels (`pluginSdkHost.ts:230-239`) and returns `{ target }`, a workspace path (`workspaceSdkHost.ts:343-349`). |
| 8b | Open a file **at a heading** | LACKS | Graph opens with an anchor (`GraphView.tsx:474`, shell `openPathWithHeading`). The panel page reads only `target` and calls `onOpenPath(target)` with one argument (`PluginPanelPage.tsx:166-169`); the host's `position` passthrough (`workspaceSdkHost.ts:347`) is dropped. Moot if row 13 stays out, because heading nodes come from the same overlay. |
| 9 | dohc-native look | HAS | `ui.theme` plus the theme push (`PluginPanelPage.tsx:137-147,226-242`) — P5. The payload carries 14 color tokens and 2 font stacks (`renderer/tokens.ts:86-101,111-115`), including every one graph draws with: `--dohc-panel`, `--dohc-line`, `--dohc-ink`, `--dohc-muted`, `--dohc-match`. Both edge kinds keep their colors. |
| 10 | Rebuild when files change | LACKS | `files.watch` refused on the panel path (`pluginSdkHost.ts:213-219`); tracked as open issue #838, which records zero product consumers today. Partial mitigation: `files.read` returns a `contentHash` (`workspaceAssets.ts:129-131`, passed through at `workspaceSdkHost.ts:271-277`), so a panel can poll for change without re-parsing. It is still polling. Sites polls on `visibilitychange` (`plugins/sites/ui/index.js:230-232`). |
| 11 | Rebuild when an edit settles | LACKS | Today's key folds in `latestMomentOrder` (`DesktopWorkspaceShell.tsx:4799-4801`). No SDK surfaces moments. A file-level watch would not be equivalent: a settle rewrites the artifact, so it may arrive as a file event, but nothing in the SDK says so. |
| 12 | Know the active document | LACKS | Drives ordering, centring, and the ring layout (`GraphView.tsx:96-102,149-160,230-250`). No SDK member carries it. |
| 13 | Chat-thread nodes and chat edges | LACKS, and should stay LACKS | Needs engine capture, `syncWorkspaceSharedChannels`, and `linkedChatStoreFor` (`main.ts:4677-4700`). AGENTS.md puts identity, shares, and relay below any UI. |
| 14 | Open a chat thread | LACKS | `onOpenChatThread` reaches a chat tab (`GraphView.tsx:469-472`); `ui.open` takes a workspace path. Moot if 13 stays out. |

### The primitives the LACKS suggest

| Primitive | Closes | Size | Why this size |
| --- | --- | --- | --- |
| **G1. `workspace.links`** — an SDK capability returning the bounded link derivation core already runs | 2, 3 | **S** | `readWorkspaceGraph` is written and bounded (`workspaceGraph.ts:904-912`); the work is a switch case in `workspaceSdkHost.ts` beside `files.list`, plus deciding the result shape. It also keeps one link resolver instead of two, which row 3 otherwise forks. |
| **G2. Active-document push** — the renderer sends the active workspace path to a panel | 12 | **S** | Same channel and shape as the theme push (`PluginPanelPage.tsx:231-234`); the renderer already holds `activeDocumentPath`. Needs the workspace/generation guard the panel's SDK responses already carry. |
| **G3. Panel subscriptions** — a guarded relay from the workspace event feed to the panel that asked | 10, 11 | **M** | Named by the sites build as the next primitive (`2026-08-17-sites-plugin-spike.md:406-410`) and by issue #838. The feed exists (`plugins/pluginWorkspaceEvents.ts`, 16 subscriptions per spawn) and the push direction exists; new work is per-panel subscriptions under the same guards, and a decision on whether a settled moment is visible at all. |
| **G4. `ui.openPanel`** — a panel asks dohc to open another of its own panels as a tab | 7b | **S** | The same shape as `ui.openWebApp` (`pluginSdkHost.ts:246-280`): the plugin id comes from the grant, never the request, and the renderer performs the open. The tab path already exists (`workbenchState.ts:78`) and is already a singleton. Without it, graph loses its maximize button. |

G1 is the one worth arguing about, because it moves the derivation from app to
substrate. Two facts push that way: backlinks needs it in core regardless, and
every graph-shaped plugin a user's agent writes would otherwise re-read the
whole workspace. Two facts push back: it is a richer contract to keep stable,
and the sites rule was "convert the surfaces, keep the authority" — link
derivation is neither surface nor authority, so the rule does not decide it.

G1's payload fits. The 4 MiB, depth-32, 20,000-value bound
(`bridgeContract.ts:2524-2526`) applies to request **params**, enforced in the
preload; the response is `z.object({ result: z.unknown() })` (`:2695`) with no
declared cap. A 2,000-node, 10,000-edge result crosses in one message. If G1
lands, give the response a stated bound rather than inheriting none.

**The alternative to G1, measured.** A panel could skip full reads and use
`workspace.search` with a regex for `[[…]]` and `](…)`. It fails on three
counts. The cap is 2,000 matches (`workspaceSdkHost.ts:55`) against 10,000
edges and 20,000 link candidates today. Ripgrep cannot strip code, so a
`[[link]]` inside a fenced block becomes an edge, which today it never does
(`workspaceGraph.ts:190-192`). And titles need a second search budget for
`^# `. The result is a different, wronger graph.

## 4. What dies, what stays

If graph converts, with the chat overlay left in core:

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
either way. The force simulation and the SVG drawing port cleanly; the React
state plumbing around them does not.

**Deleted from core**

| Site | Lines |
| --- | --- |
| `main.ts:4672-4819` — the `readWorkspaceGraph` handler, of which `:4678-4818` is the chat branch | 148 |
| `main.ts` imports `:235-237,270,686-688,694` | 7 |
| `bridgeContract.ts:609-715` — node, edge, payload, result schemas | 107 |
| `bridgeContract.ts:4127-4129` — the bridge method | 3 |
| `channels.ts:649` + `preload.ts:134-135` | 3 |
| `workbenchState.ts:13,73,151-153,296` — `VIEW_IDS` entry, `GRAPH_TAB_PATH`, `isGraphTabPath`, and the `isVirtualTabPath` registration that keeps a persisted `dohc://graph` tab alive | ~7 |
| `ActivityBar.tsx:24,32` — rail icon and label, both entries in `Record<ViewId, …>` maps | 2 |
| `DesktopWorkspaceShell.tsx` — `graphChatOpenTarget` `:531-574`, lazy import `:679-681`, `graphRefreshKey` `:1811-1818`, `openGraphTab` `:3141-3143`, `openGraphChatThread` `:3298-3315`, `graphKey` `:4799-4801`, maximize button `:5195-5205`, two mounts `:5218-5229,5400-5411` | ~104 |
| `workspaces/chatMentionGraphOverlay.ts` + test | 322 + 288 |

About 2,200 lines are deleted or moved in total. Deleting the chat overlay is
the honest reading, because its only importer is the graph handler
(`main.ts:694,4759`). If Ice wants chat mentions kept, they cannot move to the
plugin and the built-in graph does not fully die.

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
(`DesktopWorkspaceShell.test.tsx:7479-7512`). But about fifteen tests that are
not about graph **drive themselves through the graph UI**. The DM-navigation
cancellation suite (`:4059-4970`) stubs `readWorkspaceGraph` and clicks
`activity-graph` → `graph-chat-mentions-toggle` → `graph-file-row` to exercise
`openGraphChatThread` and the canonical DM navigation. The shared-view gate
`:11371-11389` asserts that a shared view offers no chat mentions in the graph.

None of those tests can drive a plugin panel. They need a new driver, or the
coverage goes. Budget for that before the conversion, not during it. The e2e
suites touch graph as well (`e2e/renderer-stability.spec.ts:88`,
`e2e/ui-audit-screenshots.spec.ts:213-216`), and
`bridgeContract.test.ts:446-491` covers the wire contract that dies.

## 5. Conversion sketch, and what it loses

A `graph` plugin on today's SDK plus G1–G4:

- **Manifest**: `name: "dohc-graph"`, and **two** panels sharing one entry
  file — `graph` with `placement: "view"` for the rail, `graph-tab` with
  `placement: "editor"` for the full-page shape. Two ids are needed because the
  placements are exclusive (`pluginManifestSchema.ts:115-120`), and G4 is what
  lets the first open the second. Each is its own running panel with its own
  state, so the layout the user left behind in one does not carry to the other.
- **Panel code**: on open, `workspace.links` (G1) returns nodes and edges;
  the force simulation and SVG port unchanged. G2 supplies the active document
  for centring. G3 replaces the refresh key. `ui.open` handles node clicks.
  `ui.theme` plus the theme push keeps it native.
- **Without G1**: `files.list` then `files.read` per markdown file, with a
  bundled copy of the extractor and resolver, and the drift cost in row 3.

**What is lost or changed — honestly:**

- **Chat mentions are gone.** The toggle, chat-thread nodes, both chat edge
  kinds, `heading-in-file` edges, and opening a thread from a node all go. This
  is the largest subtraction and it is not recoverable by a primitive anyone
  should build: it would mean handing plugins the chat store.
- **Push refresh is gone until G3.** Graph rebuilds on every settled moment
  today (`DesktopWorkspaceShell.tsx:4799-4801`). A panel gets an open-time read
  and a refresh button. This is a user-visible regression on a view whose whole
  value is being current.
- **Even with G3, moment-level freshness is unproven.** `files.watch` reports
  file events. Whether every settled edit produces one, and how quickly, is not
  something the SDK states. Do not promise parity here without measuring.
- **The active document is a push, not a prop.** Today it is React state in the
  same tree; converted, it is a message that can arrive late. The centring
  animation will visibly lag a tab switch.
- **Link resolution forks without G1.** Two copies of a four-map path index and
  a code stripper, one serving backlinks and one serving graph, free to
  disagree — the property `workspaceGraph.ts:914-917` exists to prevent.
- **The tests are rewritten, not moved.** No bundler in a panel, and about
  fifteen chat-navigation tests lose the UI they drive through.
- **The marketing site loses its graph panel** or keeps a forked copy
  (`apps/site/src/DemoSidebar.tsx:9,223-228`).
- **Rail and tab stop sharing state.** Today one component serves both through
  a `variant` prop (`GraphView.tsx:61-90`), so the node layout the force
  simulation settled on is the same object. As two panels, they are two
  processes' worth of separate state: maximizing restarts the simulation.
- **No right-click menu worth having.** Graph does not use one today, so
  nothing is lost — but note a panel gets no native context menu, and a
  DOM one is clipped to the iframe rectangle, which in the rail is narrow.
- **Data cost without G1**: up to 2,000 round trips and 32 MiB across a
  postMessage bridge, per open and per refresh, against one IPC call today.
- **Shared views and share mounts.** Graph reads mounted shares today
  (`workspaceGraph.ts:869-871`). Plugin surfaces still refuse a non-writable
  workspace, so P7 remains the open item the sites spike recorded; graph
  inherits it unchanged.

## 6. Verdict

**Convert with four sized additions — G1 (S), G2 (S), G4 (S), G3 (M) — and
accept losing the chat overlay.** Ice's roadmap assumption survives, but two of
its premises do not, and both change the work:

1. **The engine does not index links.** Graph is not a thin view over indexed
   data; it is a 924-line derivation over a full workspace read, and that
   derivation has a second consumer. Any plan that assumed a plugin could just
   ask for the links must now choose: expose the derivation (G1), or let every
   graph plugin re-read the workspace and fork the resolver.
2. **Graph is not the purest app of the four.** Its contract is over half chat:
   two of three node kinds and three of five edge kinds come from the chat
   store through the engine capture. The files-only graph converts cleanly.
   The graph a user sees today does not convert at all.

The sites spike's third claim — fewer losses than sites — is right about the
mechanism and wrong about the total. Graph spawns nothing and embeds nothing,
so it needs no P3, no P4, and no P8, and that is why every addition here is S
except one. But sites lost shared-view previews and an embedded SDK; graph
loses chat mentions, push refresh, shared rail-and-tab state, and the maximize
gesture. The list is longer, not shorter. It is only cheaper to build.

Two costs sit outside the primitives and outside the plugin: `apps/site` breaks
until someone decides what the demo shows, and about fifteen chat-navigation
tests lose the UI they drive through. Neither is hard. Both are invisible until
you look, which is why they are decisions 6 and 7 below.

Sequencing: G1, G2, and G4 are each small and useful beyond graph — a links
capability serves any plugin that reasons about structure, an active-document
push serves any panel that follows the user, and `ui.openPanel` serves any
plugin whose rail view wants more room. G3 is already the sites build's named
next primitive and issue #838's subject; justify it on its own merit, not on
this conversion. Convert after all four. Converting before G1 forks the
resolver that backlinks depends on, and that fork is the one cost here that
gets worse the longer it exists.

**Open decisions for Ice** (one line each, with the tradeoff):

1. Is link derivation substrate? G1 makes it an SDK capability and keeps one
   resolver; refusing it keeps the SDK smaller and forks the resolver.
2. Do chat mentions stay in core as a separate feature, move nowhere and simply
   die with the built-in view, or block the conversion until they have a home?
3. Is losing push refresh acceptable for a first conversion, or is G3 a
   precondition — noting that graph, unlike sites, has push refresh today?
4. Does the converted graph ship in the app image or install into `plugins/`?
   The same unresolved question the sites spike left open
   (`2026-08-17-sites-plugin-spike.md:326-346`); graph does not add to it.
5. Should `workspace.links` return the whole graph, or the links for one file,
   so backlinks-shaped plugins are served by the same call?
6. Does the marketing site keep a graph panel? It imports the desktop component
   directly (`apps/site/src/DemoSidebar.tsx:9`), so the options are a forked
   copy, no graph in the demo, or a demo that runs real plugins.
7. Who re-homes the fifteen chat-navigation tests that drive through the graph
   UI (`DesktopWorkspaceShell.test.tsx:4059-4970`) before the view goes?
8. Two panels plus G4, or one rail-only panel and no full-page graph? The
   second is free and loses the tab.
9. Does anyone measure the panel bridge round trip before this is scheduled?
   Nothing in the repo measures it, and the choice between G1 and 2,000
   `files.read` calls turns on that number.
