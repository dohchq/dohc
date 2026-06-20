# dohc Sites: normal websites as first-class workspace artifacts

## Product decision

dohc will scrap the `.apps` model and replace it with **Sites**.

A Site is a normal browser-viewable website that lives in the user's local dohc
filesystem. Agents should be able to build ordinary websites with ordinary web
tooling, with or without dohc-specific knowledge, and dohc should detect, run,
preview, build, test, sync, and share them.

The core promise:

> Agents build normal websites. dohc makes them local-first, inspectable,
> shareable, and optionally dohc-aware.

This is a hard cut. There is no compatibility requirement for `.apps`,
`app.json`, or `@dohc/app`.

## Non-negotiables

- No new product surface may teach `.apps`.
- No new generated output may use `.apps`.
- No new SDK import may use `@dohc/app`.
- Plain websites must work without importing any dohc package.
- dohc-specific powers must come from `@dohc/sdk`.
- Sites can live anywhere in the local dohc filesystem, including accepted
  `shared-with-me` projections.
- Static preview, dev-server preview, and built preview are all required.
- Every phase that changes behavior must include unit tests and Electron
  Playwright E2E tests.
- An agent without the dohc MCP must still succeed by writing a normal website
  into the workspace.
- Local-first means local power. Cloud/share/publish boundaries require review.

## Concepts to delete

Delete as active product concepts:

- `.apps/<name>/`
- `app.json`
- `@dohc/app`
- `AppPackage`
- `app-source`
- `AppsView`
- MCP `dohc_create_app`
- MCP `dohc_test_app`
- the custom tiny React-ish app runtime as the main website path

The valuable concepts to keep and reshape:

- workspace watcher and change history
- local MCP integration
- agent-run attribution
- source visibility
- process/test gating
- local preview server
- capability bridge idea, renamed to `@dohc/sdk`
- publish/share review gates

## New concepts

### Site

A Site is any folder that dohc can identify as a browser-viewable website.

Examples:

```text
client-dashboard/
  package.json
  index.html
  src/App.tsx

report/
  index.html
  styles.css
  script.js

shared-with-me/alex/pricing-portal/
  package.json
  src/main.tsx

research/site/
  dohc.json
  package.json
```

### `dohc.json`

`dohc.json` is optional. It is not required for plain websites.

It clarifies title, commands, build output, publish settings, and later SDK
capabilities.

```json
{
  "type": "site",
  "title": "Client Dashboard",
  "preview": {
    "mode": "dev",
    "command": "pnpm dev"
  },
  "build": {
    "command": "pnpm build",
    "output": "dist"
  }
}
```

Invalid `dohc.json` must produce repairable diagnostics. It must not hide the
site forever or render a blank pane.

### `@dohc/sdk`

`@dohc/sdk` replaces `@dohc/app`.

Plain sites do not need the SDK. A site imports `@dohc/sdk` only when it wants
to interact with dohc local services, workspace data, cloud sync, provenance,
sharing, or agents.

No alias is required. No backwards compatibility package is required.

## Local file model

dohc is local-file-first. The user's local dohc filesystem is the practical
working boundary for local agents, local dev servers, and local websites.

Local websites can use data in local files when the website or its dev/build
tooling can access those files. In browser-only contexts, direct arbitrary file
reads still require a local server route, build-time ingestion, or
`@dohc/sdk`.

The product rule:

> If the data is in the user's local dohc filesystem, local user-owned sites and
> agents should be able to use it.

The review boundary starts when data crosses out of the local system:

- publishing a site
- creating a share link
- exposing `shared-with-me` data
- syncing edits back to a source owned by someone else
- sending data to external APIs
- giving collaborators or public viewers access to private/local data

## Shared With Me local sync

Accepted shares should materialize locally under a dohc-managed
`shared-with-me` folder.

Suggested layout:

```text
~/dohc/
  personal/
  work/
  shared-with-me/
    alex/
      pricing-notes.md
      pricing-portal/
    acme/
      research-pack/
```

Rules:

- Unaccepted shares remain cloud references.
- Accepted shares sync locally into `shared-with-me`.
- Sites inside `shared-with-me` are detected and previewable.
- Local agents and local sites can use accepted shared files because they are
  now present locally.
- Publishing a site that includes or references `shared-with-me` data must show
  an explicit review step.
- Revocation can remove the managed projection, but dohc must not pretend it can
  erase arbitrary copies that local tools already made.

## Site detection

Create a detector in the workspace-core layer. It should scan visible workspace
folders and identify likely websites.

Detection signals:

- `index.html`
- `package.json`
- `dohc.json`
- `vite.config.*`
- `next.config.*`
- `astro.config.*`
- `svelte.config.*`
- TanStack config
- known build outputs such as `dist`, `build`, or `out`
- package dependencies or scripts for common web frameworks

Ignored paths:

- `.dohc/`
- `node_modules/`
- `.git/`
- package-manager caches
- build cache internals

The detector should produce a normalized `WorkspaceSite` descriptor:

```ts
type WorkspaceSite = {
  root: string
  title: string
  kind: "static" | "package" | "configured"
  confidence: "high" | "medium" | "low"
  entry?: string
  packageManager?: "pnpm" | "npm" | "yarn" | "bun"
  scripts: {
    dev?: string
    start?: string
    build?: string
    preview?: string
  }
  buildOutputs: string[]
  configPath?: string
  diagnostics: SiteDiagnostic[]
}
```

Site detection must prefer explicit `dohc.json` but must not require it.

## Run modes

Build all three modes from the start.

### Static preview

For folders with `index.html`.

Requirements:

- Serve the folder from a local loopback origin.
- Render in a desktop preview iframe/webview.
- Load relative CSS, JS, images, fonts, and assets.
- Show errors for missing entry files.
- Provide reload.
- Stop serving when the site preview is closed or workspace closes.

### Dev-server preview

For package-based projects.

Requirements:

- Detect package manager from lockfiles and package metadata.
- Prefer configured command from `dohc.json`.
- Infer `dev` or `start` scripts when no config exists.
- Run scripts in a controlled child process with cwd set to the site root.
- Capture stdout/stderr logs.
- Detect local URL and port.
- Handle port conflicts with retry or clear diagnostics.
- Embed the detected local URL.
- Provide stop, restart, and open-in-browser actions.
- Kill the process on preview close, workspace close, and app quit.

### Built preview

For build artifacts.

Requirements:

- Prefer configured build command and output from `dohc.json`.
- Infer build script from `package.json`.
- Run build in a controlled child process.
- Capture logs and exit status.
- Detect output folders: `dist`, `build`, `out`, or configured output.
- Serve the built output from a loopback static server.
- Preview build artifact.
- Surface build failures without hiding logs.

## Sites UI

Replace Apps product UI with Sites.

Required surfaces:

- Sites activity/sidebar entry.
- Site list with detection status.
- Site inspector with root, kind, scripts, config, diagnostics, and actions.
- Preview surface.
- Logs panel.
- Build result panel.
- Process status: stopped, starting, running, failed, building, built.
- Open in browser.
- File/source links back into the workspace explorer.

Required actions:

- Preview static
- Run dev
- Stop
- Restart
- Build
- Preview build
- Reload preview
- Open in browser
- Publish/share, once the publish flow exists

## `@dohc/sdk`

Create or rename the browser/client SDK to `@dohc/sdk`.

Principles:

- SDK is optional.
- SDK does not define the web framework.
- SDK exposes dohc capabilities to websites.
- SDK calls flow through a local/cloud dohc service that enforces the relevant
  workspace and share policy.
- Plain websites are valid without SDK imports.

First useful SDK shape:

```ts
import { dohc } from "@dohc/sdk"

const text = await dohc.files.read("notes/today.md")
const rows = await dohc.collections.get("transactions").list()
await dohc.provenance.record("Updated dashboard")
```

Rename all generated guidance and tests away from `@dohc/app`.

## MCP changes

Replace app tools with site tools.

Required tools:

- `dohc_detect_sites`
- `dohc_create_site`
- `dohc_test_site`
- `dohc_preview_site`
- `dohc_build_site`
- `dohc_publish_site`
- `dohc_add_sdk`

Rules:

- `dohc_create_site` creates a normal website folder, not `.apps`.
- MCP tools are convenience. They are not required for success.
- A non-MCP agent writing normal website files directly to disk must still get a
  working dohc Site.
- MCP writes must continue to record change history and agent provenance.

## Publish/share review

Publishing or sharing a Site is a cloud boundary. It requires review.

The review must show:

- site root
- preview mode being published: static build, static folder, or live site
- files included in the publish artifact
- whether `shared-with-me` data is included or referenced
- whether the site uses `@dohc/sdk`
- whether the site calls external network endpoints
- who can view it
- whether viewers need workspace/share permissions

Do not treat local preview approval as publish approval.

## Subagent execution model

Use subagents deliberately. The implementing agent should not serially hold the
whole migration in one head.

Recommended lanes:

1. **Detector worker**
   - Owns workspace-core site detection, `dohc.json` parsing, and unit tests.
   - Write scope: `packages/workspace-core/src/sites*`, path classification.

2. **Runner worker**
   - Owns static server, dev-server process manager, build runner, cleanup.
   - Write scope: `apps/desktop/src/workspaces/site*`.

3. **UI worker**
   - Owns Sites panel, inspector, preview frame, logs, actions.
   - Write scope: desktop renderer Sites components.

4. **MCP worker**
   - Owns site MCP tools and tests.
   - Write scope: `packages/mcp/src/*`.

5. **SDK worker**
   - Owns `@dohc/sdk` package shape and local bridge.
   - Write scope: SDK package and desktop/local service bridge.

6. **Shared sync worker**
   - Owns `shared-with-me` local materialization and sync semantics.
   - Write scope: workspace sync/cloud data fragment code.

7. **E2E worker**
   - Owns Playwright Electron harness and cross-feature E2E coverage.
   - Write scope: `apps/desktop/e2e/*`, Playwright config, test scripts.

8. **Critic/review worker**
   - Reads diffs after each phase.
   - Looks for old `.apps` leakage, process leaks, path escapes, missing E2E,
     publish-boundary holes, and user-flow rough edges.

Coordination rules:

- Assign disjoint write scopes before spawning workers.
- Tell workers they are not alone in the codebase and must not revert unrelated
  edits.
- Run integration after each phase, not only at the end.
- If two workers need the same file, one owns it and the other reports required
  changes instead of editing.
- Use a critic loop after each major merge.

## Workflows and loops

Every phase should follow this loop:

1. **RED**
   - Add unit tests and E2E tests that describe the intended behavior.
   - E2E must simulate direct disk writes by an outside/local agent whenever the
     feature relates to detection or sync.

2. **GREEN**
   - Implement the smallest coherent slice.
   - Keep product behavior complete for that slice.

3. **INTEGRATE**
   - Run targeted unit tests.
   - Run targeted desktop E2E.
   - Run typecheck for touched packages.

4. **CRITIC**
   - Spawn or reuse a reviewer subagent to inspect the slice.
   - Check for old `.apps` leakage and test holes.

5. **HARDEN**
   - Fix reviewer findings.
   - Add regression tests for every bug found.

6. **PROMOTE**
   - Only mark the phase complete after tests pass and the user journey is
     boringly seamless.

## E2E harness requirements

The current desktop E2E surface must be upgraded before Sites can be considered
done.

Required harness capabilities:

- Launch built or dev Electron app with Playwright.
- Create temp local dohc workspaces.
- Open a workspace in the desktop shell.
- Write files directly to disk while the app is running.
- Wait for the workspace watcher to refresh the UI.
- Interact with Sites panel and preview frames.
- Inspect iframe/webview content.
- Capture screenshots and verify nonblank rendered pixels.
- Assert child processes are cleaned up after stop, tab close, workspace close,
  and app quit.
- Collect runner logs for test assertions.
- Run under CI/headless Linux with `xvfb` support where needed.

Add or update scripts:

```text
pnpm test:desktop:e2e
pnpm test:sites:e2e
```

The root Playwright config should support desktop E2E instead of only the legacy
web app test directory.

## Required E2E matrix

### Static site

Test file suggestion:

```text
apps/desktop/e2e/sites-static.spec.ts
```

Flow:

1. Create temp workspace.
2. Open workspace in desktop.
3. Simulate local agent writing:

   ```text
   report/index.html
   report/styles.css
   report/script.js
   ```

4. Wait for watcher refresh.
5. Confirm Sites panel detects `report`.
6. Open Preview.
7. Assert HTML content renders.
8. Assert CSS asset loads.
9. Assert JS interaction works.
10. Edit `index.html` on disk.
11. Reload preview and confirm change.

### Dev-server site

Test file suggestion:

```text
apps/desktop/e2e/sites-dev-server.spec.ts
```

Flow:

1. Simulate local agent writing a Vite React site.
2. Confirm dohc detects package manager and scripts.
3. Click Run Dev.
4. Confirm logs stream.
5. Confirm local URL/port detection.
6. Confirm preview renders the dev server.
7. Stop and assert process exits.
8. Restart and confirm preview works again.
9. Close site/workspace and assert process cleanup.

### Built preview

Test file suggestion:

```text
apps/desktop/e2e/sites-build.spec.ts
```

Flow:

1. Create package site with build script.
2. Click Build.
3. Confirm build logs.
4. Detect `dist`, `build`, or `out`.
5. Preview build artifact.
6. Break the build script.
7. Confirm useful failure diagnostics and no stale success state.

### `dohc.json`

Test file suggestion:

```text
apps/desktop/e2e/sites-config.spec.ts
```

Flow:

1. Create a site with `dohc.json`.
2. Confirm configured title appears.
3. Confirm configured commands override inference.
4. Confirm configured build output is used.
5. Corrupt `dohc.json`.
6. Confirm diagnostic appears and source remains openable.

### Agent without MCP

Test file suggestion:

```text
apps/desktop/e2e/sites-agent-files.spec.ts
```

Flow:

1. Start desktop workspace.
2. Write normal website files directly to disk.
3. Do not call any MCP tool.
4. Confirm dohc detects, previews, and builds the site.

This is the core product test.

### MCP site tools

Test file suggestion:

```text
apps/desktop/e2e/sites-mcp.spec.ts
```

Flow:

1. Enable/localize MCP config.
2. Call `dohc_create_site`.
3. Confirm normal website files are created.
4. Confirm watcher records agent-authored change set.
5. Call `dohc_detect_sites`.
6. Call `dohc_test_site`.
7. Open the generated site in desktop.

### SDK site

Test file suggestion:

```text
apps/desktop/e2e/sites-sdk.spec.ts
```

Flow:

1. Create local source file, collection, or database.
2. Create site importing `@dohc/sdk`.
3. Run preview.
4. Confirm site reads data through dohc local service.
5. Confirm plain site without SDK still previews.
6. Confirm no `@dohc/app` import is required or accepted in generated docs.

### Shared With Me

Test file suggestion:

```text
apps/desktop/e2e/sites-shared-with-me.spec.ts
```

Flow:

1. Create or simulate accepted share.
2. Materialize it under `shared-with-me/<owner>/<share>`.
3. Include a website in the accepted share.
4. Confirm Sites panel detects it.
5. Preview it locally.
6. Attempt publish and confirm shared-data review appears.

### Publish review

Test file suggestion:

```text
apps/desktop/e2e/sites-publish-review.spec.ts
```

Flow:

1. Create site that references local workspace files.
2. Create site that references `shared-with-me`.
3. Start publish/share flow.
4. Confirm included files and boundary warnings.
5. Confirm user must explicitly approve cloud/share boundary.

### Robustness

Test file suggestion:

```text
apps/desktop/e2e/sites-robustness.spec.ts
```

Cases:

- Port conflict fallback.
- Missing `index.html`.
- Broken `package.json`.
- Missing package manager.
- Dev server exits early.
- Build command hangs and times out.
- Huge folder does not freeze UI.
- `node_modules`, `.git`, and `.dohc` are ignored.
- Multiple sites run independently.
- Process cleanup on app quit.

## Unit test requirements

Add focused unit tests for:

- site detection
- path classification with no `app-source`
- `dohc.json` parser
- package-manager detection
- script inference
- build output detection
- static server path containment
- process manager lifecycle
- log buffering/truncation
- MCP site tool path containment
- shared-with-me path rules
- publish review file graph

## Implementation phases

### Phase 0: inventory and deletion map

Goal: make the hard-cut blast radius explicit.

Tasks:

- List every active `.apps`, `app.json`, `@dohc/app`, `AppPackage`,
  `app-source`, and Apps UI reference.
- Decide which files are deleted versus renamed.
- Identify old docs that should be rewritten versus archived.
- Add a no-old-app-model guard test for active source and docs.

Expected touched areas:

- `packages/workspace-core/src/apps.ts`
- `packages/workspace-core/src/paths.ts`
- `apps/desktop/src/workspaces/appPackage.ts`
- `apps/desktop/src/workspaces/appRuntime.ts`
- `apps/desktop/src/renderer/workbench/AppsView.tsx`
- `apps/desktop/src/renderer/AppPackageView.tsx`
- `packages/mcp/src/tools.ts`
- `packages/mcp/src/server.ts`
- `services/app-tester`
- docs under `docs/product`, `docs/security`, `docs/qa`, and old plans

E2E gate:

- None yet, but add the legacy guard before proceeding.

### Phase 1: desktop E2E harness

Goal: make future behavior provable.

Tasks:

- Add Playwright Electron desktop harness.
- Add temp workspace helpers.
- Add direct-disk-write helpers.
- Add watcher wait helpers.
- Add preview-frame assertions.
- Add process cleanup assertions.
- Add `pnpm test:desktop:e2e` and `pnpm test:sites:e2e`.

E2E gate:

- A simple desktop launch/open-workspace test passes in CI/headless local.

### Phase 2: site detection

Goal: normal website folders appear as Sites.

Tasks:

- Add workspace-core site detector.
- Add `dohc.json` parser.
- Remove `app-source` classification.
- Add site descriptors to desktop IPC.
- Replace Apps sidebar with Sites sidebar.

E2E gate:

- Direct disk write of `report/index.html` appears in Sites panel without MCP.

### Phase 3: static preview

Goal: plain HTML/CSS/JS sites run.

Tasks:

- Add loopback static file server.
- Serve site roots with path containment.
- Add preview frame.
- Add reload.
- Add diagnostics for missing entries.

E2E gate:

- Static site with CSS and JS renders and updates after disk edit.

### Phase 4: dev-server runner

Goal: package websites run with their own toolchain.

Tasks:

- Detect package manager.
- Infer dev/start command.
- Add process manager.
- Capture logs.
- Detect URL/port.
- Add stop/restart.
- Add cleanup on close and quit.

E2E gate:

- Vite React site runs, logs, previews, stops, restarts, and cleans up.

### Phase 5: build runner and built preview

Goal: build artifacts are first-class.

Tasks:

- Infer build command.
- Run build.
- Detect output folder.
- Serve output folder.
- Show build logs and failures.

E2E gate:

- Build succeeds and previews artifact.
- Broken build shows diagnostics.

### Phase 6: `@dohc/sdk`

Goal: normal websites can opt into dohc powers.

Tasks:

- Create/rename SDK package to `@dohc/sdk`.
- Remove `@dohc/app`.
- Add local dohc service bridge for site previews.
- Add minimal file/collection read.
- Add SDK docs and examples.

E2E gate:

- SDK site reads local dohc data.
- Plain site still works without SDK.
- Guard test fails on `@dohc/app` in active generated guidance.

### Phase 7: MCP site tools

Goal: agent tools create and test normal websites.

Tasks:

- Replace `dohc_create_app` with `dohc_create_site`.
- Replace `dohc_test_app` with `dohc_test_site`.
- Add detect, preview, build, publish, add-sdk tools.
- Preserve path containment and change history.

E2E gate:

- MCP-created normal site appears in Sites and previews.
- Non-MCP direct file site still works.

### Phase 8: shared-with-me local sync

Goal: accepted shares become local files.

Tasks:

- Add accepted-share projection root.
- Materialize accepted shares under `shared-with-me`.
- Sync changes according to share permission.
- Detect sites inside `shared-with-me`.
- Track provenance for publish review.

E2E gate:

- Accepted shared site materializes and previews locally.

### Phase 9: publish/share review

Goal: cloud/share boundaries are explicit.

Tasks:

- Build publish file graph.
- Detect shared-with-me inclusion.
- Detect SDK use.
- Detect static versus live publish mode.
- Add review UI.
- Add approval step.

E2E gate:

- Publish flow warns for shared/local private data and requires approval.

### Phase 10: hardening and removal

Goal: no active old model remains.

Tasks:

- Delete old app runtime files.
- Delete old app tests or replace with site tests.
- Update docs.
- Update security doc from Apps to Sites.
- Update QA checklist.
- Run repo-wide guard against `.apps`, `app.json`, `@dohc/app`,
  `AppPackage`, and `app-source` in active source.

Allowed exceptions:

- Historical plans and execution logs may mention old terms as history.
- No active product docs, source, tests, prompts, or MCP descriptions may teach
  old terms.

E2E gate:

- Full Sites E2E matrix passes.

## Final verification command set

The implementing agent should keep this command set current as package names
change:

```bash
pnpm typecheck
pnpm --filter @dohc/desktop test
pnpm --filter @dohc/mcp test
pnpm test:desktop:e2e
pnpm test:sites:e2e
pnpm build:desktop
pnpm smoke:desktop
pnpm smoke:package:desktop
```

## Definition of done

The migration is done only when this user story passes:

1. A local agent with no dohc MCP writes a normal website into the workspace.
2. dohc detects it automatically.
3. The user opens Sites and sees it.
4. Static preview works if it is plain HTML.
5. Dev-server preview works if it is a package site.
6. Build preview works if it has a build script.
7. Logs are visible and useful.
8. Broken sites fail with repairable diagnostics.
9. Processes clean up reliably.
10. A site can optionally use `@dohc/sdk`.
11. Accepted shared sites under `shared-with-me` work locally.
12. Publish/share review catches local/private/shared data boundaries.
13. No active source or generated guidance teaches `.apps` or `@dohc/app`.

The target feeling is boringly seamless. An agent builds a normal website, and
dohc simply knows what to do with it.
