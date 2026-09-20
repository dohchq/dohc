# dohc MVP launch security audit

Date: 2026-09-20. Auditor: opencode (z-ai/glm-5.3), at commit `7a2d7029`, working tree clean except audit artifacts.

Reader: Ice and any agent fixing findings before launch. Every finding names its file and line. Severity means "risk dohc is answerable for", not "bad style".

## Threat model

In scope, per Ice's direction: exploitable issues where dohc itself is to blame. Authentication bypasses, authorization breaks, injection, path traversal, sandbox escapes, command execution, backdoors, malicious code, secret leaks, and data egress dohc never disclosed.

Out of scope: what third-party app authors build. A malicious app that tricks a user is the author's responsibility. A broken sandbox that lets app content read more than its owner exposed is dohc's responsibility, and was audited.

## Verdict

The original static review reported no critical or high findings in the code it inspected. It did not establish that launch blockers are absent.

The original review reported no backdoor, malicious code, production secret leak, authentication bypass, SQL injection, path traversal, renderer XSS, sandbox escape, or undisclosed egress in its sampled code and history. These negative findings apply to the stated scope and method.

Follow-up by Codex, 2026-09-20: this is a scoped static review, not launch clearance. The original audit did not check current dependency advisories. A follow-up scan found 41 advisory records, including one critical dependency advisory. Patched JavaScript dependencies now return zero known advisories. Advisory counts do not establish exploitability in dohc.

The follow-up fixes signing-workflow access, preview Host validation, and production database configuration. Release testing and the external controls listed below still determine launch readiness. Original line references refer to commit `7a2d7029`.

## Findings

### 1. MEDIUM — Code-signing secrets reach pull-request build steps

Location: `.github/workflows/desktop-release.yml:4` (the `pull_request` trigger) and `:253-271` (the env blocks).

Evidence at the audited commit: matching pull requests received signing secrets in the signing-mode, package-smoke, and electron-builder steps. The earlier `pnpm build:desktop` step did not receive these env blocks directly.

Attack: a pull request from a same-repo branch, for example from a compromised maintainer account or a malicious collaborator, can change a build script to print `process.env` and exfiltrate the macOS and Windows signing keys. Pull-request builds run as `dry_run`, so these credentials are never needed on that event.

Follow-up: removed the PR trigger and restricted releases to main. Signing and publish jobs use the main-only `desktop-release` environment. Dry runs receive empty signing credentials. Environment restrictions must remain configured in GitHub; an editable workflow condition alone cannot protect repository secrets. See [release instructions](../how-to/desktop-release.md).

### 2. LOW — A user env var redirects the packaged update feed

Location: `apps/desktop/src/updates/electronUpdater.ts:67-75` and `:176-179`.

Evidence: `updateFeedOverride` returns `env.DOHC_UPDATE_URL` whenever it is set in a packaged build. `autoUpdater.autoDownload` and `autoInstallOnAppQuit` are enabled.

Attack: a process controlling the launch environment can redirect update metadata and downloads. Whether a hostile artifact installs depends on the platform and packaged signature configuration. The feed override alone does not prove native code execution.

Follow-up: documented the override in [release instructions](../how-to/desktop-release.md). On Windows, the locked electron-updater 6.8.9 verifier rejected unsigned, modified, and wrong-publisher fixtures and accepted a valid signed fixture. This does not prove a complete packaged dohc update or macOS/Linux behavior.

### 3. LOW — Default dev credentials in service entrypoints

Location: `services/sync-relay/src/main.ts:54` and `services/workspace-api/src/main.ts:12`.

Correction: sync-relay already refuses an unset `POSTGRES_URL` outside development/test at `services/sync-relay/src/main.ts:138`. Workspace-api had the production fallback.

Attack: none found. The self-host compose requires `POSTGRES_URL` with `:?` and the desktop app uses no Postgres. The fallback only applies to a bare local dev run against the dev compose, whose credentials are public in the repo anyway.

Follow-up: workspace-api now rejects missing, empty, and whitespace-only database configuration outside development/test. Child-process tests verify rejection before listening.

### 4. LOW — Committed localhost test TLS key

Location: `services/share-web/src/testing/device-control/localhost-key.pem`, added in commit `3f3ef44d`.

Evidence: a self-signed RSA key used only by integration tests. Not CA-trusted, not used by any production path.

Fix if desired: generate the pair inside the test run instead of committing it. Confidence: certain, no production impact.

### 5. LOW — Loopback preview servers accept any Host header

Location: `apps/desktop/src/security/staticDirectoryPreview.ts:123-251` (the request handler); the same pattern serves plugin panels and site previews.

Evidence: the server binds `127.0.0.1` on a random port, validates the path, realpath-contains the target, and sets `x-content-type-options`. It never reads the `Host` header.

Attack: a website that rebinds its DNS to `127.0.0.1` could, after discovering the random port, fetch workspace content through the preview origin without CORS stopping it. Random ports and browser protections can limit this attack but do not establish server-side access control. Exposure of the user's workspace content is the confidentiality risk. The CLI server authenticates requests with a timing-compared token.

Follow-up: the shared static server rejects Host values other than its bound `127.0.0.1:<port>` before reading files. Socket tests cover normal access, hostile authorities, and missing HTTP/1.1 Host headers. Owner file-source tests verify that rejected requests do not invoke the reader. This covers static site previews and plugin panels; independently authored dev servers retain their own Host policy.

## Open questions

1. Resolved in source: desktop releases no longer run on pull requests. The GitHub release workflow remains manually disabled.
2. `services/agent-sandbox` and `services/hocuspocus` have no tracked files. Local build leftovers do not establish missing product functionality. Check product claims against the current engine, relay, and guest implementations.
3. The renderer CSP allows `connect-src` to any `wss:` host, because relays are user-configured. That is an exfiltration channel only if an XSS exists first, and this audit found no XSS path. Keep or tighten, but no action is required.

## What was audited and found clean

### Electron main process

- Every window runs `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` (`apps/desktop/src/security/electronSecurity.ts:11-26`). Plugin guest views add `webviewTag: false` and no preload (`apps/desktop/src/plugins/pluginWebAppGuest.ts:66-84`). The PDF export window is preload-less (`apps/desktop/src/window/documentPdfExport.ts:43-50`).
- Navigation policy: exact-origin compare, never prefix; `file:` allowed only inside the packaged renderer bundle; unparseable URLs denied (`electronSecurity.ts:44-64`). `will-navigate`, `will-redirect`, and `will-frame-navigate` are all hooked (`createMainWindow.ts:312-322`). `window.open` is a pure deny (`createMainWindow.ts:308`).
- Every IPC handler the audit read validates the sender frame against the navigation policy (`assertTrustedSender`, `main.ts:3806-3811`) and parses its payload with zod. Workspace-scoped handlers additionally capture a workspace reference and re-assert it after every await, so a slow response for one workspace cannot act on another (`nativeMenusIpc.ts:147-166`, `workspaceFilesIpc.ts:642-667`).
- `shell.openExternal` has one entry point, and it admits only `http:`, `https:`, and `mailto:` (`windowIpc.ts:59-66`, `isSafeExternalUrl`). `shell.openPath` and `shell.showItemInFolder` only receive paths that passed lexical validation plus realpath containment inside the workspace root (`nativeMenusIpc.ts:152-163`, `workspaceFilesIpc.ts:650-663`).
- Path containment: the lexical validators reject traversal, absolute paths, NUL bytes, percent-encoded traversal decoded to a fixpoint, Windows trailing-dot aliases, reserved device names, ADS colons, and 8.3-shaped names (`packages/workspace-core/src/paths.ts:226-289`). `realRelativeInRoot` then realpaths the deepest existing ancestor and requires the result to sit under the canonical root, refusing dangling symlinks, unresolvable links, and unreadable paths (`packages/workspace-core/src/realPath.ts:62-132`). Delete and move operations resolve the parent chain and hold back the entry itself (`noFollow`).
- Process execution: agent prompts ride stdin, never argv (`chatRunnerProcess.ts:14-18`). ripgrep gets an argv array with `--` before the query and hardcoded exclusions last (`workspaceSearch.ts:114-140`). The Windows compiler supervisor builds its PowerShell command from absolute app paths through a strict single-quote escaper, carries no inherited credential env, and frames input on stdin (`compilerProcessSupervisor.ts:45-58`). Plugin child processes run as full-trust code by documented decision, but the broker refuses shells, contains every `modulePath` and `cwd` inside the plugin or workspace root via realpath, caps args, env, and env bytes, and owns the whole process tree for teardown (`pluginChildProcessBroker.ts:234-267, 1229-1272`).
- The CLI server: UDS or a random-named Windows pipe, a 32-byte token written `0600`, and a timing-safe token compare (`cliServer.ts:2528-311, 2676-2700`).
- The engine daemon: spawned as a child process and spoken to over stdio, with a fresh 32-byte handshake token per launch (`engineDaemonLifecycle.ts:303-309, 599-624`). No port, no pipe, no socket a website or another process can connect to.
- Deep links: the `dohc://` scheme accepts exactly one URL shape, a 43-character code and a canonically encoded relay URL, and nothing else reaches the app from argv (`shareHandoffIngress.ts:5-6, 58-86`).
- Fuses: runAsNode off, asar integrity on, only-load-app-from-asar on, inspect arguments off, with a smoke gate (`smoke:fuses`).
- Dev surfaces fail closed: `DOHC_DEV_TOOLS`, `DOHC_TEST_AUTH`, and `SYNC_RELAY_TEST_AUTH` are double-gated on unpackaged builds or dev/test `NODE_ENV`, and the impersonation seam crashes the server on a production `NODE_ENV` (`workspace-api/src/main.ts:19-36`, `sync-relay/src/main.ts:152-167`).

### Renderer

- The markdown pipeline is schema-gated end to end. Marked tokens pass into the ProseMirror schema; raw HTML in a document goes through `generateJSON` against the registered extensions, where script and iframe do not exist (`@tiptap/markdown` `parseHTMLToken`, `apps/desktop/src/renderer/editor/import-export.ts:161-165`). What renders is schema output, so no document text can become an event handler or a script node.
- Image sources are sanitized through one shared contract table, tested on both the editor and projection surfaces: every non-http(s) scheme, obfuscated schemes like `java\nscript:`, `data:`, `file:`, custom schemes, absolute paths, and protocol-relative URLs are dropped; `../` is preserved losslessly with containment enforced at the resolver and at export (`packages/ydoc-projection` `image-src`, `import-export.test.ts:336-428`).
- Every HTML sink the audit found is static or sanitized: callout and wikilink icons are fixed SVG strings; mermaid runs at `securityLevel: 'strict'` and only its sanitized SVG is inserted (`mermaidRender.ts:254-267, 353-371`); KaTeX runs with default trust settings and `throwOnError: false`; the export path strips image srcs that could leave the export directory (`documentExport.ts:220-247`). Chat messages render as escaped text nodes (`PostCard.tsx:229-232`).
- No `dangerouslySetInnerHTML` exists in production renderer code. The renderer stores UI layout state in `localStorage` only; no session token or secret is stored there.

### Plugin, app, and preview hosting

- Plugin guests are main-process-owned `WebContentsView`s, never webview tags or bare iframes, with a per-workspace per-plugin hashed storage partition, no preload, no node, sandbox on, navigation and redirect locked to the exact spawned loopback origin, downloads denied, and every permission request denied (`pluginWebAppGuest.ts` throughout).
- The credential that pairs a plugin web app rides a one-time URL fragment that is passed to `loadURL` and never to the registry, the renderer, or a log (`pluginWebAppGuest.ts:169-210`, `pluginWebAppGuest.test.ts:42-44`).
- The static preview server refuses escape: request paths are validated, realpath-contained against the containment root, opened with `O_NOFOLLOW` where the platform has it, and served with `nosniff` (`staticDirectoryPreview.ts:123-251`). Its own comment names the two residuals this audit confirms: Windows has no `O_NOFOLLOW`, and Node exposes no `openat`, so a path component swapped in a narrow window is followed. Those residuals are documented in the code and accepted.
- Site dev servers are spawned only when the command statically proves a loopback-only host binding; commands dohc cannot decompose, including wrapped `env` payloads, are refused (`siteRunner.ts:345-762`).

### Services

- Auth is Better Auth with a required 32-plus-character secret and no custom auth surface to get wrong (`workspace-api/src/main.ts:31-47`).
- SQL: every production query in the reviewed services and packages is parameterized through `prepare()` or the Postgres tagged helpers. The only string interpolation into SQL lives in test files building their own schemas. The sqlite worker and Postgres pool both sit behind bounded request readers.
- The sync relay resolves named-route actors from verified sessions, hashes link bearers with HMAC-SHA256 under a server-held link key, gates every live route behind configured admission limits, validates the request Host against an allowlist, and refuses to start when a security-relevant config value is missing (`sync-relay/src/main.ts`, `linkSecurity.ts:55-86`).
- share-web answers unknown Hosts with a refusal, sets `default-src 'none'` with `frame-ancestors 'none'` and `no-store`, rate-limits the exchange, and binds every session to a grant with an expiry (`share-web/src/server.ts:20-48, 1009-1015`). Link secrets are 32-byte base64url values matched against a fixed pattern (`packages/security-contract/src/wirePatterns.ts:4-5`). The relay URL it fetches is from configuration, so no client input becomes a fetch target: no SSRF from requests.
- The original review found no telemetry, crash-reporting, analytics, or hidden-beacon path in its sampled code. GitHub updates and npm plugin installation are not an exhaustive egress inventory: configured relays, auth services, agents, and author-controlled apps have their own network behavior.

### Rust engine

- The daemon has no inbound listener. `dohc-engine-sync-http` is an outbound client to the relay; the only `TcpListener` in the crate sits in tests.
- Zero `unsafe` blocks in any production engine crate. `dohc-engine-crypto` is `#![forbid(unsafe_code)]`.
- Crypto: AES-256-GCM with a fresh CSPRNG IV per seal, the deterministic-IV variant private and test-only, AAD binding workspace and path so ciphertext cannot be transplanted, plaintext carried only by a zeroize-on-drop type that has no `Display` or `Serialize` (`dohc-engine-crypto/src/lib.rs` header and exports).
- File materialization canonicalizes the root, walks components one at a time, refuses symlinks and reparse points in every existing below-root component, and rejects escape, absolute, and missing targets (`dohc-engine-files/src/materialize.rs:33-34, 258-283, 330-337, 1082+`).
- The `expect()` calls in engine sync code sit behind `#[cfg(test)]` (`dohc-engine-sync/src/enrolment.rs:383`). The protocol and storage crates show no unguarded unwrap on network-derived data in the code the audit sampled.

### Supply chain

- No install-time lifecycle scripts anywhere in 27 workspace packages; pnpm's build allowlist covers only electron, electron-winstaller, and esbuild. No lockfile deps from git or URLs.
- The three pnpm patches cover list rendering, file watching, and editor behavior. The vendored crates (`file-guard`, `yrs`) are verified by SHA-256 with documented upstream commits and change notes.
- No backdoor patterns: no remote-code eval, no `curl`-to-shell, no magic auth tokens, no time or date triggers, no origin-based bypasses.
- Workflows: action SHAs pinned, `persist-credentials: false`, no `pull_request_target`, PR checks dispatch-only on self-hosted runners.
- No secrets in the tree or in the scanned history beyond the test PEM in finding 4. `.gitignore` covers `.env*`; the example env file holds placeholders and honest disclosures.
- `deny.toml` restricts sources to crates.io and has an empty advisory ignore list. Separately, `.cargo/audit.toml` ignores `RUSTSEC-2026-0009` and documents the claimed unreachable dependency path.
- Electron fuses hardened with a smoke gate; no source maps ship in production; the mock update server is unreachable from app code.

## What this audit did not cover

Stated limits, so the verdict carries its own weight:

1. This was a static audit: reading code, targeted greps, and the repo's own tests as evidence. No runtime exploitation, no fuzzing, no penetration testing against a live deployment.
2. Lockfiles were checked for attribution and known-malicious names, not matched against a current CVE feed. The repo maintains cargo-deny and RUSTSEC tracking as a living control; that control, not this audit, is the advisory barrier.
3. sync-relay and share-web were reviewed at the architecture level with targeted reads of their auth, session, and route-gating code, not line by line. Their integration test suites exercise the security behaviors cited above.
4. Git history was swept for secret-shaped files and known token formats, not every historical blob.
5. Findings 1 and 5 describe mechanisms verified in code. Neither was demonstrated end to end at runtime.

## Hardening backlog

Items the audit noticed and chose to record rather than fix, each already a documented decision in the code or a small upgrade:

1. The shared static preview server now validates Host. Inventory independently spawned app dev servers separately; this change does not claim to secure arbitrary author code.
2. `staticDirectoryPreview`'s Windows `O_NOFOLLOW` gap and Node's missing `openat`: the code names both residuals. If Node ever exposes openat-style traversal, adopt it there.
3. The plugin broker's documented residual: a POSIX descendant forked after teardown capture, whose ancestors all exit, survives the kill round. Closing it needs a process group utilityProcess.fork cannot create.
4. The update feed env override (finding 2): consider requiring a config-file trust flag instead of a bare env var.
5. Keep the share-web test TLS pair as a fixture. No production use was found; generating it per run does not close a demonstrated exposure.

## Method

Recon of the monorepo, then six area audits: Electron main process, renderer sinks, plugin and app hosting, services, Rust engine, and supply chain including git history. Each area was verified by reading the actual implementation of the security primitive at that boundary, tracing attacker-controlled data from entry point to sink, and checking the repo's own tests where they encode a security contract. Findings were severity-rated by who can exploit them and what they get.

## Follow-up evidence and launch checks

The follow-up checks the fixes rather than repeating the original audit in full.

- GitHub reported the release workflow as `disabled_manually`. It remains disabled. Repository secrets contained no signing credentials. Organization-secret inventory returned HTTP 403, so historical exposure is unresolved. A past PR run completed packaging, but that does not prove credentials were present.
- Created the `desktop-release` environment with a single allowed branch, `main`, and no secrets. GitHub rejected required reviewers under the current billing plan. Preserve the branch restriction and add signing credentials only to this environment.
- JavaScript advisory evidence is local-only in `.agent-artifacts/security/pnpm-audit.json` and `pnpm-audit-after.json`. The scan changed from 41 advisory records to zero after compatible dependency updates. Regenerate the current scan with `pnpm audit --json`.
- Focused checks passed: 13 release tests, 11 static-preview tests, nine production-startup cases, 227 relay tests, and 75 share-web tests. The relay suites include workspace binding and grant revocation.
- The Windows signature proof used electron-updater 6.8.9 from the lockfile. Upstream source: [electron-builder](https://github.com/electron-userland/electron-builder/tree/bed3a9c421a8a05c49f36a2af5d7ae3598cb1b95/packages/electron-updater), commit `bed3a9c421a8a05c49f36a2af5d7ae3598cb1b95`. Windows verification reads `publisherName` from packaged configuration and skips that check when it is absent.

Before launch, verify signed packaged updates on Windows and macOS and establish the Linux feed trust model. Review organization-level signing-secret access with an account that can inspect it. A current empty repository-secret inventory cannot rule out past exposure.

GitHub also returned HTTP 403 for main branch protection because the current plan does not support it for this private repository. The environment restriction limits signing to main, but it does not enforce review before code reaches main. Resolve that release-control decision before enabling signing.
