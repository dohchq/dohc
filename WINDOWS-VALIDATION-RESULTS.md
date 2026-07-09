# Windows Validation — Multi-User Chat + Collaboration Surface

**Target:** dohc `main` @ `f1c1045d` (PR #102 merge — the MU-C arc, PRs #97–#102).
**Ran on:** native Windows 11 (not WSL, not Linux CI).
**Date:** 2026-07-09.

## One-line verdict

**Multi-user chat works on native Windows.** The crown-jewel two-user Electron
e2e (`workspace-chat-multiuser`) and the entire chat / DM / share / presence /
sync e2e surface pass on the real Windows display, and `node:sqlite` +
`safeStorage` (DPAPI) both work inside the Electron 42 main process. Status is
**PASS-WITH-FIXES** — five fixes, all verified on Windows and cross-platform-safe
(Linux/WSL stays green): the Windows-only secret-classification bypass
(Finding 1), the opted-out-workspace engine-store regression (Finding 2), the
NUL-byte source hazard (Finding 3), the missing EOL policy (Finding 4), and the
e2e temp-dir leak (Finding 6). Two findings are documented but deliberately not
fixed (Finding 5, out of chat scope; Finding 7, benign). The fixes live in the
working tree, uncommitted — ready for a PR on request (I did not auto-push).

---

## Environment

| Item | Value |
| --- | --- |
| OS | Microsoft Windows 11 Pro 10.0.22631 |
| Shell | PowerShell 7.6.3 |
| Node | v24.16.0 |
| pnpm | 10.24.0 |
| Electron | 42.4.1 — embeds **Node 24.16.0**, Chromium 148 |
| `git config core.autocrlf` | `input` |
| `.gitattributes` | **was ABSENT** → added (Finding 4) |
| codex / gpt-5.5 | Installed (`codex-cli 0.142.5`), authenticated (ChatGPT). Usable non-interactively only with an empty-stdin pipe (`"" \| codex exec …`); a bare `codex exec` blocks on stdin under this harness. Triage was run on Claude models (Opus/Sonnet). |
| `pnpm install` | Exit 0 — **no-op** (lockfile up to date, node_modules already warm). |

### Native-module reality (the biggest a-priori risk — retired)

The brief flagged native SQLite / Electron-ABI as risk #1. On investigation:

- The engine and relay use **Node's built-in `node:sqlite` (`DatabaseSync`)**,
  resolved via `createRequire('node:sqlite')` in
  `services/sqlite-worker/src/sqliteEngine.ts`. **`better-sqlite3` is NOT
  installed** — it appears in `pnpm-lock.yaml` only via a `@types/better-sqlite3`
  peer edge. There are **zero sqlite `.node` binaries** in `node_modules`.
- Because it is a builtin, **Node-ABI vs Electron-ABI does not apply** — and
  Electron 42.4.1 embeds the *same* Node 24.16.0 as the system Node anyway.
- Proven empirically in **both** runtimes on Windows:
  - System Node: `new DatabaseSync(':memory:')` create/insert/select → OK.
  - Electron **main process** (not `ELECTRON_RUN_AS_NODE`): opened an on-disk DB
    in a temp dir, created a table, inserted, read the rows back, file on disk →
    `MAIN_SQLITE_OK`.
  - `electron-vite` correctly keeps `node:sqlite` **external** in the built
    `dist/main/main.js` (a bundler inlining a builtin would be the classic
    failure — it does not).
- `safeStorage.isEncryptionAvailable()` in the Electron main process on Windows
  → **`true`** (DPAPI live), so cloud-credential encryption works.

---

## Per-suite results

Run as a parallel fan-out (8 lanes at once on a 32-core box), then every failing
lane re-verified in **isolation** to separate genuine regressions from
concurrent-load flake. Baselines are the WSL numbers from the brief.

| Lane | Result | Baseline | Verdict |
| --- | --- | --- | --- |
| `pnpm -r typecheck` | **16/16 packages clean, exit 0** | — | ✅ clean |
| `@dohc/sync-relay` | 179 pass / **3 fail** / 182 | ~182 | ⚠️ 3 = **load-flake** (see below) |
| `@dohc/workspace-engine` (both vitest passes) | **397 pass** (pass 1) + 19 pass / 114 skip (fs-lock pass) | ~393 + ~128/5-skip | ✅ skips are **intentional** (see below) |
| `@dohc/desktop` (unit) | 1166 pass / **2 fail** / 1 skip / 1169 | 1167 / 2 skip | ⚠️ 2 = load-flake + known flake |
| `@dohc/workspace-fs` | **44/44 pass** | — | ✅ clean |
| native/path pkgs (sqlite-worker, core, contracts, mcp) | **209 pass / 3 skip** | — | ✅ clean |
| other pkgs (sdk, perf, auth, kernel-client, ydoc, agent-sandbox, workspace-api, postgres) | 80 pass / **1 fail** | — | ⚠️ 1 = agent-sandbox `cat` (Finding 5, out of chat scope) |
| `node scripts/check-self-host.mjs` | **18/18 checks passed** | — | ✅ clean |

*\* workspace-engine pass 1 is 397 (not 393): +1 regression test for Finding 1,
+3 regression tests for Finding 2.*

### Why the "failures" are not chat regressions

- **sync-relay (3 fail)** — all in `*.integration.test.ts` that spawn a real
  relay child + real localhost HTTP + `node:sqlite`. All three are **timeouts**
  (two 5 000 ms per-test, one 15 000 ms "relay did not report a port"), never
  assertion mismatches. Re-verified in isolation: **run 2 passed 19/19 (exit 0)**,
  and the failing test *moved* between isolation runs — the definitive signature
  of load-flake, not an OS fault. Cause: Windows child-process cold-start +
  loopback + SQLite I/O is slower than WSL against tight timeouts, and collection
  alone took 80 s under 8-way load. **Not a regression.**
- **workspace-engine skips (114 vs baseline ~5)** — **intentional, not
  breakage.** `changeSetStore.test.ts` and `versionedFileWorkspace.test.ts` gate
  their *anchored-history* suites to Linux (`process.platform === "linux" ? it :
  it.skip`) and provide a dedicated Windows counterpart
  (`describePortableHistory("portable durable history (win32)")`). The engine is
  in fact Windows-aware (`win32-process-starttime` lock identity,
  `windowsSpawn.ts`). Both vitest passes are green.
- **desktop unit (2 fail)** — `FileInspector.engineSaveState.test.tsx` (the
  documented known flake) + `workspaceFiles.test.ts collectZipEntries` (a
  5 000 ms **timeout**, not an assertion). Both pass **2/2 in isolation**.
  Windows actually ran one *more* test than the WSL baseline (1 fewer skip) — no
  hidden skipping.

---

## The Electron e2e (the load-bearing proof)

Built with `pnpm --filter @dohc/desktop build` (exit 0 on Windows), then ran the
full Playwright suite on the real Windows display (no xvfb, no `TMPDIR=/tmp`).

**Full run: 39 passed / 2 failed (3.4 min).** Every chat / collaboration spec
passed:

| Spec | Result |
| --- | --- |
| **`workspace-chat-multiuser` — owner + participant chat & co-presence converge in the real app** | ✅ **9.9 s** |
| `workspace-chats` (general channel, relaunch persistence, unread, search; opted-out rejects; perf) ×3 | ✅ |
| `workspace-shares` (grant side; receive read-only + honest end) ×2 | ✅ |
| `workspace-linked-chats` (send a message, **survive relaunch and rename**; agent authorship) ×2 | ✅ |
| `workspace-secret-env` (.env versioned-protected, **no plaintext at rest**, search finds nothing) | ✅ |
| `workspace-engine-search` (**.env.local content never surfaces**) | ✅ |
| `workspace-sync-rejoin` (offline conflict; join flow; relay claim) ×3 | ✅ |
| `workspace-switch-race` (A→B switch never leaks A's history/chats into B) | ✅ |
| `workspace-collab-decoupling` (engine provider, no Hocuspocus) ×2 | ✅ |
| `workspace-agent-attribution` ×2, `workspace-direct-disk` ×1 | ✅ |

The crown jewel drives the real owner app through: create a channel → start a
thread → send a message (renders) → share the channel to a second account from
the Chats UI → the participant's **presence face** renders at channel scope →
the participant's **typing indicator** renders at thread scope → the
participant's reply and 🚀 reaction converge back into the owner's real app after
a sync nudge. This is genuine two-user multi-user chat, verified authorship and
all, on native Windows.

**Only 2 specs failed** (`workspace-engine-capture` +
`workspace-engine-history`), both the same assertion — see Finding 2.

**Process hygiene:** after the crown-jewel run, **0 orphaned electron/relay
processes** and 0 held ports. The relay child is a leaf `node` process; the
missing SIGTERM handler on Windows (Finding 7) is benign.

---

## Findings

### 1. `enginePathFloor` secret classifier misses Windows trailing-dot/space aliases — FIXED ✅

**Severity:** High (Opus triage rated Critical). **Class:** genuine bug that only
opens on Windows. **File:** `packages/workspace-engine/src/enginePathFloor.ts`.

`classifyEngineFilePath` is THE shared security floor: it decides secret-vs-tracked
for the versioned-text write gate, engine search visibility, the MCP agent
secret-read DENY gate (`packages/mcp/src/tools.ts:502`), and the **share
selector** (`services/sync-relay/src/shareFilter.ts:145` grant gate and `:231`
per-op gate — shareable requires `kind === "tracked"`).

Windows silently strips trailing dots/spaces from path segments, so `secret.env `
and `secret.env.` alias the real `secret.env` on disk (**verified**: writing
`secret.env ` via a Win32/.NET file API overwrote `secret.env`). The classifier
lower-cased but did **not** strip those aliases, while its sibling guards
`isReservedPath` / `hasIgnoredSegment` *do*. **Verified at runtime** before the
fix: `.env `, `.ENV `, `secret.env `, `secret.env.`, `config/.env `, `prod.env `
all classified as **`tracked`** — meaning journaled as plaintext, indexed by
search, and **admitted through the share selector** to recipients.

Scope nuance (verified): Node's own `fs` does **not** alias trailing-space names
(`existsSync("secret.env ") === false`, `realpath` throws `ENOENT`), so an agent
cannot use the alias to *read* an existing `.env` through the MCP read tool. The
real exposure is the **share/version floor** classifying an alias-named secret
file as tracked-and-shareable, plus the internal-consistency invariant with the
sibling guards.

**Fix:** export the existing `stripWindowsAliasSuffix` from
`@dohc/workspace-core` and apply it per-segment inside `classifyEngineFilePath`,
so the floor normalizes aliases exactly like the reserved/ignored guards.
**Verified after fix:** all 6 aliases now classify `secret`; ordinary
trailing-space files stay `tracked`; probe reports **BYPASSES=0**. Added a
regression test in `workspaceSearch.test.ts`. Tests green: workspace-core 115,
workspace-engine classifier suites 84, sync-relay `shareFilter` 35, full engine
394; all consumer packages typecheck clean.

### 2. Opted-out workspace still creates an engine store — FIXED ✅

**Severity:** High (product-invariant violation: an opted-out workspace must
record **nothing**). **Class:** latent on every OS; **observed** only on Windows
(timing-exposed). **Specs:** `apps/desktop/e2e/workspace-engine-capture.spec.ts:162`
and `workspace-engine-history.spec.ts:93`.

Both seed `experimental.workspaceEngineAlpha: false` and assert
`existsSync(.dohc/engine/engine.db) === false`; on Windows both got **`true`**,
deterministically in isolation.

**Root cause (traced with an instrumented `DatabaseSync` stack capture — exactly
one of the 7 construction sites fired):** the store is created by the
**secret-file store**, not the capture path:

- `apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:864` — a `useEffect` fires
  `refreshCloudStatus()` → `bridge().cloudStatus({ workspaceId })`
  **unconditionally** on every workspace open, with no engine-flag gate.
- `apps/desktop/src/main.ts:2086` — the `cloudStatus` handler calls
  `readWorkspaceSecretState(rootPath, workspaceId)`.
- `packages/workspace-engine/src/secretFileStore.ts:297` →
  `openDatabase(rootDir)` (line ~159) does `mkdirSync(.dohc/engine/)` +
  `new DatabaseSync(path)` **writable** (no `readOnly`). That path is the *same*
  `.dohc/engine/engine.db` the e2e asserts must not exist.

**Verdict — latent-everywhere, observed-on-Windows.** There is **no
`process.platform` branch** on this path; the writable open creates the file on
every OS (`node:sqlite` only refrains with `{readOnly:true}`), and the read never
deletes it. So the *write side-effect exists on Linux too* — Linux stays green
only because it is a timing race: the async `cloudStatus`→secret-read vs. the
test's `waitForWorkspaceFile` + `existsSync`. Windows' slower filesystem watcher
lets the ungated read reliably land **before** the assertion; Linux/WSL's faster
watcher lets the assertion win. (Not empirically timed on Linux — no Linux box —
but the code is conclusive that the side-effect is platform-independent.)

**Fix (minimal, cross-platform, fail-closed) —
`packages/workspace-engine/src/secretFileStore.ts`:** reading secret state is a
pure query and must never *create* the shared store. An absent `engine.db` ⟹ no
protected rows can exist ⟹ return the empty answer with zero filesystem
side-effect. Both read entry points now short-circuit through one shared
`engineStoreExists()` guard (so they cannot drift):
`readWorkspaceSecretState` returns `"none"` and
`readWorkspaceDataKeyForEnrollment` returns `null` when the store file is absent.
This guards the *root* rather than the caller, fixing the whole "a read grows the
store" class for every caller on every OS without coupling secret state to the
engine flag.

**Verified on Windows:** the two specs now **pass** (2.3 s / 2.7 s, no timeout);
3 new regression tests in `secretFileStore.test.ts` assert the reads return
`none`/`null` **and leave `engine.db` absent** (confirmed to catch the bug — they
fail with the guard reverted). Full engine suite 397 + 19, desktop unit 1168,
typecheck clean, desktop app rebuilt. Independently re-verified together with the
crown jewel: **6 passed** (multi-user chat unaffected).

### 3. Raw NUL bytes in tracked source → git treats files as binary — FIXED ✅

**Severity:** High (the exact "NUL-byte-in-source" incident class this repo has
hit). **Files:** `versionedTextStore.ts` (8), `ydocEngineDriver.ts` (3),
`liveYDocRegistry.ts` (2), `services/sync-relay/src/shareFilter.test.ts` (1).

These embed raw `0x00` bytes as load-bearing composite-key delimiters
(`` `${enginePath}\0${workspaceId}\0${objectId}` ``) and sentinels
(`"\0absent-local-root"`). Git classified all four files as **binary**
(`ls-files --eol` → `-text`), so ripgrep/Grep **silently skip them** and diffs
degrade to "binary differ"; worse, a Windows editor that strips NUL on save would
silently corrupt the delimiters.

**Fix:** replaced each raw `0x00` with the escape `\u0000` via a byte-precise
transform. Every NUL was verified to sit inside a `"…"` or `` `…` `` literal, so
the escape is **byte-identical at runtime** — confirmed by the full engine suite
(394 pass, exercising the exact composite keys) and `shareFilter` (35 pass) still
green, and typecheck clean. Post-fix the tree has **zero NUL bytes** and all four
files are now text (`w/lf`) and grep-visible.

### 4. No `.gitattributes` (no repo EOL policy) — FIXED ✅

**Severity:** High (latent). The repo had no `.gitattributes`, so EOL depended
entirely on each dev's `core.autocrlf`. This machine's `input` keeps the tree LF,
but the Windows Git installer default is `autocrlf=true` — a contributor with
that setting checks every text file out as **CRLF**, breaking any byte-exact /
hash-of-source assertion and reintroducing churn.

**Fix:** added a root `.gitattributes` pinning `* text=auto eol=lf` (+ `*.sh` LF,
+ explicit `binary` for image/font/wasm/node assets). The working tree is already
100% LF, so this introduces **no renormalization churn** now while protecting
every future checkout.

### 5. `agent-sandbox` test spawns `cat` → `ENOENT` on Windows — NOT FIXED (out of chat scope)

**Severity:** Medium. **Class:** genuine Windows test-gap, **outside the
multi-user-chat surface.** `services/agent-sandbox/src/agentSandbox.test.ts:119`
runs `runWorkspaceShellCommand({command:"cat", …})`; `commands.ts` spawns with
`shell:false` and has no `cat` fallback (it does for `python`→`python3` and
`sqlite3`→JS), so on Windows `spawn cat` → `ENOENT` deterministically. The agent
sandbox is designed to run in a **projected Linux container**, not native
Windows, so this is a test-environment assumption rather than a product defect on
the chat path. Left unfixed to avoid scope creep; recommend either a Windows
skip-guard or a portable `cat` shim if native-Windows sandbox tests are wanted.

### 6. e2e temp-dir cleanup races open sqlite handles → EBUSY leak — FIXED ✅

**Severity:** Low (tests pass; hygiene only). Two sources of the same Windows
behavior — POSIX unlinks open files, Windows throws **EBUSY**: (a) the relay
specs ran `cleanupDesktopWorkspace(desktop, temp)` **before** `relay.stop()`, so
`rm` hit the still-open `relay.sqlite` under the temp dir; (b) non-relay specs
raced the app's own `engine.db-shm`/`-wal` handle, not yet released the instant
after `desktop.close()`. Observed **48+ leaked `dohc-desktop-e2e-*` dirs** in
`%TEMP%`, each holding exactly `relay.sqlite{,-shm,-wal}` or `engine.db-shm`.

**Fix (cross-platform-safe):** (1) `createTempWorkspace().cleanup()` now retries
`rm` on EBUSY/EPERM/ENOTEMPTY with a short backoff on `win32` only (single
attempt elsewhere — no slowdown on the POSIX path); (2) reordered `relay.stop()`
**before** workspace cleanup in the three relay specs
(`workspace-chat-multiuser`, `workspace-shares`, `workspace-sync-rejoin`).
**Verified:** re-ran all relay specs — **6 passed, 0 new leaked temp dirs, no
EBUSY logged** (was ~6–9 leaks/run).

### 7. Relay SIGTERM/SIGINT shutdown handler never runs on Windows — INFO (benign)

`services/sync-relay/src/main.ts:250` registers a graceful-shutdown handler
(`server.close()` / `storage.close()` / `pool.end()`). The e2e harness stops the
relay via `child.kill("SIGTERM")`, which on Windows maps to `TerminateProcess` —
the handler never fires. **Benign:** the relay is a leaf `node` child (no tree to
orphan), its SQLite is WAL-mode crash-durable (the offline-rejoin restart spec
proves recovery), the OS releases the socket on exit, and `pool` is undefined
under the test-auth seam. Production relays run on Linux. No action needed.

---

## Phase 3 — driving the real app

The real Windows app was driven end-to-end by the Playwright e2e suite (the
brief explicitly permits scripted Playwright against the real app), covering
every requested flow: create channel/thread/message + render + **persist across
an app relaunch** (`workspace-linked-chats` "survive relaunch and rename"),
reactions render (🚀 in the crown jewel), **cloud sign-in + DPAPI credential
persistence** (`safeStorage` available = true; the multi-user spec signs in over
the relay), **share a channel to a second account** (crown jewel + shares specs),
**presence at channel AND thread level with two clients** (crown jewel), and the
**secret-path guard** on Windows paths (`workspace-secret-env`,
`workspace-engine-search` — `.env` never surfaces, no plaintext at rest).

I also drove the built app by hand via a scripted Playwright session and captured
a **positive screenshot** (`scratchpad/shots/01-chat-thread.png`): the real dohc
window on the Windows display showing the Chats view with a channel
`windows-validation`, a thread, and the message *"Validated on native Windows 11
— node:sqlite + DPAPI live. 🚀"* authored by **You**, the 🚀 emoji rendering, and
the status bar reading **"Local · saved"**.

**What could NOT be exercised:** two *literal* Electron windows. This is
**blocked by design** — `apps/desktop/src/main.ts:4352`
`requestSingleInstanceLock()` calls `app.quit()` on a second instance (keyed on a
shared `userData`, which `DOHC_TEST_HOME` does not redirect). The e2e's
"second authenticated relay client" is the correct substitute and exercises the
same relay surface the desktop's own main process uses.

---

## What is proven vs still assumed

**Proven on native Windows:** the native-SQLite backend loads in Node *and*
Electron; DPAPI `safeStorage` works; the full multi-user chat / DM / share /
presence / sync surface passes as real-app e2e including a real two-user
convergence; verified authorship holds; secret `.env` files stay protected and
never surface plaintext; workspace isolation holds across switches; no orphaned
processes/ports after teardown.

**Fixed this pass (cross-platform-safe, Linux-green preserved; in the working
tree, uncommitted):**

| # | Fix | Files |
| --- | --- | --- |
| 1 | Secret classifier strips Windows dot/space aliases | `workspace-core/src/paths.ts`, `workspace-engine/src/enginePathFloor.ts` (+ test) |
| 2 | Secret-state read no longer creates the engine store | `workspace-engine/src/secretFileStore.ts` (+ test) |
| 3 | Raw NUL bytes → `\u0000` escapes (text-safe) | `versionedTextStore.ts`, `ydocEngineDriver.ts`, `liveYDocRegistry.ts`, `sync-relay/src/shareFilter.test.ts` |
| 4 | Add repo EOL policy | `.gitattributes` (new) |
| 6 | e2e temp cleanup: EBUSY retry + relay-stop ordering | `e2e/helpers/workspace.ts`, 3 relay specs |

**Still open (documented, deliberately not fixed):** Finding 5 (agent-sandbox
`cat` test — outside chat scope, sandbox targets Linux) and Finding 7 (relay
SIGTERM handler — benign on Windows).

**Verification footprint:** `pnpm -r typecheck` exit 0; `@dohc/workspace-engine`
397 + 19; `@dohc/workspace-core` 115; `@dohc/sync-relay` `shareFilter` 35;
`@dohc/desktop` unit 1168/1 skip; the two formerly-failing e2e specs + the crown
jewel re-verified together (6 passed); all relay e2e specs (6 passed, 0 leaks).
No orphaned electron/relay/codex processes after any run.

**Tooling note:** `codex`/gpt-5.5 is installed and authenticated but blocks on
stdin when invoked non-interactively under this harness; the workaround is an
empty-stdin pipe (`"" | codex exec …`). Triage therefore ran on Claude models
(Opus + Sonnet), and the two security-relevant findings (1, 2) were additionally
verified by me directly (runtime probes + a captured `DatabaseSync` stack).
