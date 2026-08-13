# Spike: can dohc embed t3 code as a plugin?
> Editorial note (2026-08-13, post-review): the spawn contract below was proven in DEV, where `ELECTRON_RUN_AS_NODE=1` works. Packaged dohc builds fuse `runAsNode` off, so PR3 must launch the t3 server through the plugin host's brokered `utilityProcess` spawn instead of `process.execPath`-as-Node. The readiness, shutdown, redaction, and state contracts apply unchanged. Distribution lockfile is `pnpm-lock.yaml` (via `pnpm import`), not npm's.

Date: 2026-08-13 (Asia/Manila)

Scope and safety: the reference checkout at `C:\Users\ice\dev\dohc\.agent-sources\pingdotgg\t3code` is read-only for this spike. All generated files, installed packages, logs, and probes live under `scratchpad\spike-t3`.

Reference source commit verified: `6bc6cb6be4ebecd5bd7a3b7b88f07cb61815ded5`.

## Conclusion

**Yes, with constraints: GO for an experimental pinned plugin, but it is not a drop-in iframe.** `t3@0.0.33` is a self-contained CLI/server bundle that can be launched once per workspace, serves its complete UI at a loopback origin, and completed a real Codex turn. PR3 needs a supervised, unpacked child process; authenticated guest-WebContents embedding; a unique base directory and port per canonical workspace; strict readiness/version checks; and Windows process-tree/stale-state handling.

## Progress

- [x] Isolated workspace created.
- [x] Published package and CLI mapped.
- [x] Runtime HTTP/WebSocket proof captured.
- [x] Session round-trip attempted and completed.
- [x] Embedding, state, lifecycle, and pinning analyzed.
- [x] Bridge contract finalized.

## Command evidence

This report records commands and concise output excerpts as evidence. Full generated logs and probe files are retained in `spike-t3\` where useful.

The reference checkout was verified without modifying it:

```text
> git rev-parse HEAD
6bc6cb6be4ebecd5bd7a3b7b88f07cb61815ded5
> git status --short
(no output)
```

## 1. PACKAGE SHAPE

**Finding: the correct public package is unscoped `t3`; the tested and source-matched version is exactly `t3@0.0.33`.** `@pingdotgg/t3`, `@t3tools/contracts`, and `@t3tools/client-runtime` all returned npm `E404`. The registry's `latest` tag was `0.0.33` during the spike; `nightly` was `0.0.34-nightly.20260813.1082`.

Registry evidence:

```text
> npm view t3 name version dist-tags bin engines repository --json
"name": "t3"
"version": "0.0.33"
"latest": "0.0.33"
"bin": { "t3": "./dist/bin.mjs" }
"engines": { "node": "^22.16 || ^23.11 || >=24.10" }
"repository.directory": "apps/server"
```

The source package declares the same name/version/bin, publishes only `dist`, and builds the server and service launcher as bundles (`apps/server/package.json:1-20`). There is no `main` or `exports` in either registry metadata or the installed manifest. Therefore this is **not a supported programmatic server library**: importing the bin would execute CLI bootstrap. The supported integration is a child process running the executable bundle.

Install evidence (Node satisfies the package engine):

```text
> node --version && npm --version && codex --version
v24.16.0
11.16.0
codex-cli 0.146.0
> npm install --save-exact
added 198 packages ... found 0 vulnerabilities
> npm ls t3 --depth=0
`-- t3@0.0.33
```

`package.json` and `package-lock.json` now pin `t3` to `0.0.33`. The tarball reported 796 entries, 17,497,877 packed bytes and 78,902,842 unpacked bytes. The installed package contains a 4.47 MB `dist/bin.mjs` with `#!/usr/bin/env node`, a prebuilt `dist/client/` SPA, `service-launcher.mjs`, Node/Bun PTY and SQLite adapter chunks, and resource-monitor executables for macOS ARM/x64, Linux x64, and Windows x64. It does not vendor a conventional source tree.

**Start contract and configuration.** Installed `t3 --help` and `t3 serve --help` expose:

```text
USAGE t3 serve [flags] [<cwd>]
--mode <web|desktop>
--port <integer>
--host <string>
--base-dir <string>
--no-browser
--bootstrap-fd <integer>
--auto-bootstrap-project-from-cwd
--log-websocket-events / --log-ws-events
```

The positional `cwd` is explicitly the provider-session working directory. Source confirms the flags (`apps/server/src/cli/config.ts:20-64,173-191`) and their environment equivalents: `T3CODE_MODE`, `T3CODE_PORT`, `T3CODE_HOST`, `T3CODE_HOME`, `T3CODE_NO_BROWSER`, `T3CODE_BOOTSTRAP_FD`, `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD`, and `T3CODE_LOG_WS_EVENTS` (`apps/server/src/cli/config.ts:78-142`). CLI values take precedence over environment/bootstrap; default mode is `web`; `--base-dir`/`T3CODE_HOME` and positional CWD are resolved independently (`apps/server/src/cli/config.ts:244-288`). `serve` is the headless form: it forces no browser and disables automatic project bootstrap (`apps/server/src/cli/server.ts:20-32`; `apps/server/src/cli/config.ts:294-316`).

Auth control-plane subcommands are present:

```text
t3 auth pairing create --base-dir ... [--ttl ...] [--label ...] [--base-url ...] [--json]
t3 auth session issue --base-dir ... [--ttl ...] [--label ...] [--subject ...] [--token-only|--json]
```

For the plugin, `serve` in `web` mode is preferable to pretending to be the upstream desktop shell: source says `web`+loopback uses `loopback-browser` and one-time-token bootstrap, while `desktop`+loopback advertises `desktop-managed-local` and expects a `desktop-bootstrap` secret (`apps/server/src/auth/EnvironmentAuthPolicy.ts:16-46`).

## 2. RUNTIME PROOF

**Finding: the pinned npm package served its web app and accepted an authenticated WebSocket RPC connection.** The reproducible probe is `spike-t3/runtime-probe.mjs`; structured results are in `spike-t3/runtime-result.json`, with child stdout/stderr in adjacent log files.

Spawn used:

```text
command: C:\Program Files\nodejs\node.exe
args: <spike>\node_modules\t3\dist\bin.mjs serve
      --mode web --host 127.0.0.1 --port 47653
      --base-dir <spike>\state-a <spike>\workspace-a
env additions: T3CODE_NO_BROWSER=1, NO_COLOR=1
cwd: <spike>\workspace-a
```

The first clean run created/migrated its database, logged `Listening on http://127.0.0.1:47653`, then printed:

```text
T3 Code server is ready.
Connection string: http://127.0.0.1:47653
Token: [REDACTED]
Pairing URL: http://127.0.0.1:47653/pair#token=[REDACTED]
```

Readiness and HTTP evidence from the final run:

```text
GET /.well-known/t3/environment -> 200 application/json at 3,019 ms
body.serverVersion -> "0.0.33"
GET / -> 200 text/html, decoded body 17,352 bytes
GET /assets/index-DiDfaONg.js -> 200 text/javascript, decoded body 5,221,782 bytes
```

Startup varied from 4.46 s to 7.37 s across warm runs; the first observed run was 5.12 s. The readiness endpoint path is also what upstream desktop uses (`apps/desktop/src/backend/DesktopBackendManager.ts:63-68,368-388`).

WebSocket proof used t3's required auth flow, not an unauthenticated bypass:

```text
POST /oauth/token (headless one-time token) -> 200 Bearer
scope -> orchestration:read orchestration:operate terminal:operate review:write
         relay:read access:read access:write relay:write
POST /api/auth/websocket-ticket (Bearer) -> 200
OPEN ws://127.0.0.1:47653/ws?wsTicket=[REDACTED] -> success
SEND {"_tag":"Request","id":1,"tag":"server.probe","payload":{},"headers":[]}
RECV {"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":{}}}
CLOSE code=1000 reason="probe complete" wasClean=true
```

This matches the contract's empty-payload `server.probe` RPC (`packages/contracts/src/rpc.ts:193-253,326-330`). A connection without cookie/ticket was rejected during upgrade (observed Node WebSocket `1006`/error), so auth is a real embedding requirement. Source defines the token-exchange endpoint and authenticated ticket endpoint at `packages/contracts/src/environmentHttp.ts:410-439`; a WebSocket ticket is appended as `wsTicket` (`packages/client-runtime/src/authorization/remote.ts:171-190`).

**Shutdown evidence and Windows caveat.** After a clean WebSocket close, the probe called `child.kill("SIGTERM")`. On Windows/Node this terminated the server in 231 ms with `signal=SIGTERM`, but `state-a/userdata/server-runtime.json` remained with the dead PID. Source intends graceful scope finalizers to close WebSockets and clears the runtime-state file on release (`apps/server/src/server.ts:120-124,490-520`). The observed leftover proves that Node's Windows signal emulation did not run those finalizers. This is process cleanup in the OS sense, but not application-graceful shutdown; it must be treated as a bridge risk and covered by stale-state recovery/Job Object ownership. No documented per-process shutdown CLI or HTTP endpoint was found.

## 3. EMBEDDING CONSTRAINTS

### Origin and WebSocket construction

There is no implementation symbol/file named `wsTransport` at this commit; the only `wsTransport` text is a stale lint-rule exemption for a former test. The current path is `apps/web/src/environments/primary/target.ts` plus `packages/client-runtime/src/connection/resolver.ts`.

**The published UI is same-origin by default, but it is not tied to a fixed hostname or port.** With no compile-time `VITE_HTTP_URL`/`VITE_WS_URL`, it uses `window.location.origin` for HTTP, swaps `http`/`https` to `ws`/`wss`, and appends `/ws` when the WebSocket base path is `/` (`apps/web/src/environments/primary/target.ts:184-235`; `packages/client-runtime/src/connection/resolver.ts:49-54`). This is compatible with `http://127.0.0.1:<per-workspace-port>` in an embedded browsing context. The runtime proof used a nonstandard port successfully.

Authenticated remote connections first obtain a short-lived ticket and add it as `?wsTicket=...` (`packages/client-runtime/src/authorization/remote.ts:171-190`). The UI must therefore load from the same t3 server origin and complete browser bootstrap; pointing a generic unauthenticated socket at `/ws` is insufficient.

### Frame policy and auth

**t3 itself does not currently block framing.** On both `/` and the fetched JS asset, the live response had no `Content-Security-Policy`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`, or `Cross-Origin-Resource-Policy`. Source applies a sandbox CSP only to `.svg` asset responses (`apps/server/src/http.ts:43-55`) and the SPA catch-all serves `index.html` without a frame policy (`apps/server/src/http.ts:229-315`). Searches found no `frame-ancestors`, frame-busting `window.top`/`window.parent`, or equivalent logic in the web/server source.

**Auth is the material embedding constraint.** The headless Pairing URL carries the one-time credential in the URL fragment. The web app reads and immediately strips that credential (`apps/web/src/environments/primary/auth.ts:151-176`), exchanges it at the browser-session endpoint (`apps/web/src/environments/primary/auth.ts:231-253`), and the server sets an `HttpOnly`, `Path=/`, `SameSite=Lax` session cookie (`apps/server/src/auth/http.ts:221-245`). Same-origin browser mode always uses `credentials: "include"`; the bearer path is reserved for a non-browser/desktop bridge target (`apps/web/src/environments/primary/httpLayer.ts:9-52`).

This makes a plain cross-origin `<iframe>` fragile: from dohc's top-level origin, the t3 cookie is a third-party/SameSite context and can be withheld by Chromium policy. There is no runtime switch telling the published UI to use bearer auth instead. A guest WebContents (`<webview>` for PR3, or preferably a main-process `WebContentsView` in a hardened production design) gives t3 its own top-level storage context and a dedicated session partition. Navigate that guest directly to the redacted `Pairing URL`, never proxy the credential through page fetches.

Security settings for the guest must remain `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true`, no preload supplied by the plugin, no popups, downloads denied unless explicitly brokered, and navigation restricted to the exact spawned origin. Use a unique partition per dohc workspace. This is a deliberate new Electron surface: dohc currently does not enable `webviewTag` in its main-window preferences (`apps/desktop/src/security/electronSecurity.ts:3-21` in dohc) and its current subframe navigation allowlist would also reject an unregistered t3 iframe (`apps/desktop/src/window/createMainWindow.ts:219-235` in dohc).

### Path prefix and cross-origin limitations

The package should be exposed at an origin root, not under `/plugins/t3/...`:

- Installed `dist/client/index.html` uses root-absolute assets such as `/assets/index-DiDfaONg.js` and `/favicon.ico`.
- Routes are root-based (`createFileRoute("/pair")` at `apps/web/src/routes/pair.tsx:9`; another pairing link constructs `new URL("/pair", window.location.href)` at `apps/web/src/components/settings/ConnectionsSettings.tsx:488`).
- The server's static catch-all is also rooted at `/` (`apps/server/src/http.ts:229-315`).

The `VITE_*` target overrides are compile-time inputs, not query parameters or a runtime plugin API. Production CORS is not a substitute for same-origin serving: the special credentialed origins are only the upstream `t3code://app` schemes in development configuration (`apps/server/src/http.ts:43-83`). Conclusion: one loopback origin per instance works; a reverse-proxy path prefix or a dohc-origin copy of the SPA is unsupported without rebuilding/patching t3.

## 4. SESSION ROUND-TRIP

**Finding: a real session through t3's own authenticated protocol and the machine's logged-in Codex CLI succeeded.** Before the run:

```text
> codex login status
Logged in using ChatGPT
```

The separately published contract packages do not exist on npm, so `session-probe.mjs` implements only the small, source-read Effect RPC envelope needed for the test. It did not import or vendor t3 source. The wire contract is: dispatch a `ClientOrchestrationCommand` through `orchestration.dispatchCommand` and subscribe to `orchestration.subscribeThread` (`packages/contracts/src/rpc.ts:859-866,914-921`). Source defines the exact project/thread commands at `packages/contracts/src/orchestration.ts:622-667`, the nested user-message turn command at `packages/contracts/src/orchestration.ts:832-849`, and provider-instance model routing at `packages/contracts/src/orchestration.ts:51-116`.

Final reproducible run evidence:

```text
server version: 0.0.33
ready after spawn: 2,780 ms
server.probe: success
server.getConfig Codex instance: instanceId=codex, driver=codex,
  status=warning, default model=gpt-5.6-sol
project.create receipt: {"sequence":16}
thread.create receipt:  {"sequence":17}
thread.turn.start receipt: {"sequence":19}
thread stream: {"kind":"synchronized"}
thread stream: role=user, streaming=false,
  text="Reply with exactly T3-SPIKE-OK and do not use tools."
thread stream: role=assistant, streaming=true, text="T3-SPIKE-OK"
assistant response observed: 14,303 ms after spawn
```

The structured evidence is `spike-t3/session-result.json`; redacted process logs are `session-stdout.log` and `session-stderr.log`. `status=warning` did not prevent operation; the source deliberately separates provider state from auth status (`packages/contracts/src/server.ts:46-74,161-198`). The subscribed stream's `synchronized`/`snapshot`/`event` union is source-defined (`packages/contracts/src/orchestration.ts:1478-1491`), and assistant deltas become `thread.message-sent` events with `streaming: true` (`apps/server/src/orchestration/decider.ts:1216-1267`).

The final run closed the client WebSocket with code 1000, then sent `SIGTERM`; the child exited in 19 ms. As with the runtime-only proof, that is fast Windows process termination, not proof that Effect finalizers ran.

## 5. MULTI-INSTANCE + STATE

**Finding: one t3 process per dohc workspace is viable when both `--port` and `--base-dir` are unique.** The explicit base directory maps to `<base-dir>\userdata\state.sqlite`; keybindings, settings, attachments, logs, environment ID, runtime-state JSON, and secrets are derived beside it, while caches and worktrees sit under the base directory (`apps/server/src/config.ts:25-46,99-132`). Server startup creates those directories (`apps/server/src/config.ts:135-154`).

Sessions are event-sourced into SQLite: `orchestration_events` is created by `apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts:1-44`, and provider session runtime rows by `apps/server/src/persistence/Migrations/004_ProviderSessionRuntime.ts:1-29`. The earlier failed/retried session probe confirmed durability in practice: attempting a second `project.create` for the same persisted workspace was rejected because the prior active project survived server restart.

Checkpoints are the exception to base-dir isolation. Source says the checkpoint store uses the active VCS and writes hidden refs (`apps/server/src/checkpointing/CheckpointStore.ts:1-14,49-63`); the prefix is `refs/t3/checkpoints` (`apps/server/src/checkpointing/Utils.ts:1-8`). Therefore two base dirs pointed at the *same Git workspace* still share/mutate that repository's t3 checkpoint refs. PR3 should enforce one process per canonical workspace root, or serialize access if duplicate views are ever allowed.

`multi-instance-probe.mjs` started both processes concurrently:

```text
instance A: port=47655, ready=200 in 2,992 ms,
  environmentId=19db7eed-e14a-49c9-a9cc-25f2b26dc6f9,
  database=<spike>\state-multi-a\userdata\state.sqlite (exists)
instance B: port=47656, ready=200 in 2,979 ms,
  environmentId=8db80cba-9ec2-4794-9486-dd8b35c1e9e1,
  database=<spike>\state-multi-b\userdata\state.sqlite (exists)
distinct environment IDs: true
distinct database paths: true
```

Structured evidence is `spike-t3/multi-instance-result.json`. Both exited after `SIGTERM` (33 ms / 29 ms), and both again left their runtime-state JSON files. Sharing a base directory must be treated as invalid: it would combine SQLite, credentials, environment identity, caches, logs, and the last-writer runtime-state file.

## 6. LIFECYCLE + VERSION PINNING

### Readiness

The source no longer has a `ServerReadiness` symbol; the current mechanism is `ServerRuntimeStartup`. It exposes an HTTP-listening latch and command-ready gate and describes pre-gate failure explicitly (`apps/server/src/serverRuntimeStartup.ts:46-75`). All routes are wrapped in middleware that awaits command readiness (`apps/server/src/server.ts:427-465`). Upstream desktop polls `/.well-known/t3/environment` every 100 ms with a 1 s request timeout and 1 minute overall timeout (`apps/desktop/src/backend/DesktopBackendManager.ts:63-68,368-388`).

Use that endpoint, not stdout, as the authoritative readiness signal. `T3 Code server is ready.` is useful for obtaining the Pairing URL, but source prints the headless access block from a forked task before the startup fiber waits for the HTTP listener and signals command readiness (`apps/server/src/serverRuntimeStartup.ts:400-460`; formatter at `apps/server/src/startupAccess.ts:122-145`). The plugin should:

1. Start buffering stdout/stderr with secret redaction and fail immediately on child exit.
2. Extract the `Pairing URL`/token block without persisting the raw fragment.
3. Poll `GET /.well-known/t3/environment` at 100 ms, 1 s per request, 60 s overall.
4. Require HTTP 200 JSON and `serverVersion === "0.0.33"`; then navigate the guest to the Pairing URL. An optional authenticated `server.probe` is a second end-to-end check.

Observed readiness ranged from 2.78 s to 7.37 s across probes. The two simultaneous instances were ready at about 3.0 s. Running the same entry with dohc's Electron executable plus `ELECTRON_RUN_AS_NODE=1` was also proven: Electron 43.3.0 embeds Node 24.18.1 (satisfies t3's engine), and t3 returned readiness 200 in 3,863 ms. Evidence is `spike-t3/electron-node-result.json`.

### Pinning and updates

Pin the dependency and the launched descriptor, not merely the install command:

```text
package.json: "t3": "0.0.33"
package-lock.json: exact t3@0.0.33 resolution/integrity
startup check: environment.serverVersion must equal 0.0.33
launch: direct unpacked dist/bin.mjs path; never npx, npm exec, @latest, or PATH t3
```

Foreground `serve --mode web` is not launcher-managed, so it advertises no `serverSelfUpdate` capability (confirmed in every readiness JSON). Source only exposes self-update for desktop-managed or boot-service-managed runtimes (`apps/server/src/cloud/selfUpdate.ts:30-35,57-75`; descriptor construction at `apps/server/src/environment/ServerEnvironment.ts:126-155`). The explicit `t3 service update` command installs the CLI version used to invoke it and recommends `npx t3@latest` only when the operator requests latest (`apps/server/src/cli/service.ts:95-113`). Therefore PR3 must never install the t3 background service and must not invoke the `server.updateServer*` RPCs; no automatic server-package mutation was observed in foreground mode.

t3 does perform registry checks for provider CLI advisories during startup (the trace showed GETs to npm for `@openai/codex/latest` and `@anthropic-ai/claude-code/latest`). That is separate from updating the pinned t3 package. Provider-update RPCs can mutate globally installed provider CLIs if the user invokes the UI action, so PR3 should decide explicitly whether to hide/deny that capability rather than treating it as part of plugin version management.

Anonymous PostHog telemetry is enabled by default and was observed as a startup POST in the trace. Source provides `T3CODE_TELEMETRY_ENABLED` with a default of `true` (`apps/server/src/telemetry/AnalyticsService.ts:31-44`). The plugin spawn contract below sets it to `false`; enabling it should require an explicit dohc product/privacy decision.

## BRIDGE REQUIREMENTS FOR PR3

### Exact spawn contract

Dependency/package contract:

- Plugin manifest/package: exact `"t3": "0.0.33"`; commit the lockfile and integrity.
- Package t3 and its production dependencies as physical, unpacked files outside `app.asar`. The probe did not validate ASAR execution, and t3 includes native modules/helpers and platform executables.
- Resolve the entry from that dependency's installed `package.json`, then join `dist/bin.mjs`; never use a PATH-resolved `t3` or `npx`.
- One manager record per canonical dohc workspace root: `{ workspaceId, workspaceRoot, baseDir, port, child, guestPartition, expectedVersion }`.

Spawn from the Electron **main process**, not the renderer:

```text
command = process.execPath                # dohc's Electron executable
args = [
  <unpacked-plugin-node_modules>\t3\dist\bin.mjs,
  "serve",
  "--mode", "web",
  "--host", "127.0.0.1",
  "--port", String(<manager-allocated-unique-port>),
  "--base-dir", <dohc-userData>\plugins\t3\<workspace-id>,
  <canonical-workspace-root>
]
options = {
  cwd: <canonical-workspace-root>,
  shell: false,
  detached: false,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...sanitizedHostEnv,                 # retain PATH and Codex auth-related HOME/USERPROFILE
    ELECTRON_RUN_AS_NODE: "1",
    T3CODE_NO_BROWSER: "1",
    T3CODE_TELEMETRY_ENABLED: "false",
    NO_COLOR: "1"
  }
}
```

The exact Electron-as-Node form above was runtime-proven with Electron 43.3.0/Node 24.18.1. Standalone `node.exe dist/bin.mjs ...` was also proven. Allocate ports centrally and serialize concurrent launches; if bind fails, choose a new port and respawn. Never bind `0.0.0.0` or expose the origin beyond loopback. Keep `baseDir` outside the workspace so plugin state is not committed, and never reuse one base dir across workspaces.

### Readiness contract

1. Register exit/error and stdout/stderr handlers before spawn. Maintain a bounded redacting buffer; raw `Token:` and `#token=` values must never reach logs or telemetry.
2. Parse and hold the `Pairing URL` from the headless access block in memory. The stdout sentence `T3 Code server is ready.` is informational only.
3. Poll `http://127.0.0.1:<port>/.well-known/t3/environment` every 100 ms, with a 1 s request timeout and 60 s overall deadline. Abort immediately if the child exits.
4. Ready means HTTP 200, a decodable environment descriptor, and exact `serverVersion === "0.0.33"`. On mismatch, destroy the process and report a plugin/package integrity error.
5. Create/navigate the guest only after readiness. Navigate to the held Pairing URL for first/bootstrap authentication. For deeper health checks, exchange the bootstrap credential, obtain a WebSocket ticket, and require `server.probe` success as demonstrated by the probe.

### Shutdown contract

1. Stop accepting renderer/plugin commands. Destroy or navigate away the guest so its HTTP/WebSocket activity ends; wait briefly for the code-1000 socket close when observable.
2. Send `SIGTERM` to the owned t3 child. Treat `code=null, signal=SIGTERM` as expected and allow 2 seconds (matching upstream desktop's grace setting).
3. The Windows child must be placed in an owned Job Object with kill-on-close semantics, or an equivalent verified process-tree supervisor. At the deadline, terminate the entire owned tree; never target a PID until its executable/command line and ownership record match.
4. Drain redacted stdout/stderr for up to 5 seconds. Close the Job Object and guest partition handles.
5. Expect `<baseDir>\userdata\server-runtime.json` to be stale after Windows termination. On next start, verify its PID is dead or belongs to a different command before removing/ignoring this plugin-owned file. Do not interpret it as proof that a server is live; HTTP readiness is authoritative.

There is no supported HTTP/CLI shutdown command in `t3@0.0.33`, and the observed Windows `SIGTERM` did not run the runtime-state cleanup finalizer. PR3 should not claim graceful application shutdown until upstream exposes one or a Windows control-event path is proven.

### Embedding method

Use a **sandboxed `<webview>` guest for PR3, not an iframe**, because t3's browser UI authenticates through a `SameSite=Lax` cookie and a cross-origin iframe is a fragile third-party-cookie context. Give each workspace a dedicated `persist:dohc-t3-<workspace-id>` partition (or an in-memory partition if re-pairing on every app start is intentional), load the exact `http://127.0.0.1:<port>/pair#token=...` URL, and do not reverse-proxy under a path prefix.

Enabling `webviewTag` must be paired with a main-process `will-attach-webview` gate that rejects every source/partition except the manager-issued exact origin and partition, removes any preload, forces `nodeIntegration=false`, `contextIsolation=true`, and `sandbox=true`, and denies popups, external navigation, unbrokered downloads, permissions, and guest-to-host IPC not explicitly specified. A production follow-up should prefer a main-process `WebContentsView`, which avoids exposing general webview creation to the renderer while preserving the required independent storage context.

### Top 3 risks

1. **Guest-content/auth security.** The pairing fragment is an orchestration credential, webview enablement expands Electron attack surface, and an origin-validation mistake exposes workspace-capable UI. Mitigate with main-process ownership, exact-origin/partition gates, no preload/Node, secret redaction, and loopback-only binding.
2. **Lifecycle correctness on Windows.** `SIGTERM` killed the process but left `server-runtime.json`; there is no graceful shutdown API. Without Job Object ownership, crashes or provider subprocesses could outlive dohc. Mitigate with process-tree supervision, PID/command verification, timeouts, and stale-state recovery.
3. **Unsupported integration/packaging surface.** `t3` publishes a CLI and opaque SPA, not a library or separately versioned contracts; the unpacked footprint is about 79 MB and includes native/platform assets. Root-path, auth, headers, wire details, install scripts, and provider-update behavior can change between versions. Mitigate by exact pinning, unpacked packaging tests (including terminal/native features), version-gated readiness, no self-update/service commands, and a compatibility re-spike for every upgrade.

SPIKE-COMPLETE
