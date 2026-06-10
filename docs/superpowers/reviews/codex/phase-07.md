# Codex + verifier review — phase7 (commit 0458779)

Two independent reviews of the phase7 commit (apps as local source folders):
Codex `exec review --commit 0458779` (gpt-5.5, xhigh) and an in-repo verifier
fan-out (security/trust, test-quality, claimed-vs-actual; adversarially
confirmed). Findings below are de-duplicated; all fixes landed in `phase7(fix)`.

## Confirmed + fixed

- **[P1 / verifier-MED] grantAppTrust bypassed the readiness gate at the IPC boundary**
  (`apps/desktop/src/workspaces/appPackage.ts`). `grantAppTrust` set `trusted:true`
  unconditionally; only the renderer hid the Trust button until `ready`. A
  scripted/forged IPC call could trust an untested/failed/nonexistent app.
  **Fix:** grantAppTrust now validates the package exists (`discoverApps`) and
  refuses unless backend readiness is `ready`; throws otherwise. Both Codex and
  the verifier flagged this as the phase's core security invariant.

- **[P1] Stale trust survived content changes** (`appPackage.ts`). State was keyed
  only by `pkg.root` with no content fingerprint, so editing `app.json` (e.g.
  widening `write` globs) or any source file after a pass inherited the old
  approval. **Fix:** added a SHA-256 fingerprint over manifest + all source
  files; `currentState` resets pass/trust to untested when the fingerprint
  changes and self-heals the persisted `.dohc/apps-state.json` so no reader sees
  stale trust. A failing re-test also revokes trust.

- **[verifier-LOW] appWriteAllowed did not exclude `.dohc` / refused no traversal**
  (`packages/workspace-core/src/apps.ts`). A trusted root-scope app with
  `write:["**"]` matched every path, including `.dohc/apps-state.json` (the trust
  store that governs the check). **Fix:** `appWriteAllowed` now refuses any path
  with a `..` segment and any `.dohc` control-dir path before any grant is
  considered. (No production caller wires writes yet — latent until Phase 7b —
  but the authorization primitive is now complete.)

- **[verifier-MED/LOW] tests didn't pin the trust→readiness gate or content invalidation.**
  **Fix:** added desktop unit tests (refuse-untested, refuse-failed,
  trust-after-pass, source-edit-resets, manifest-widen-resets) and E2E
  assertions (valid app shows `Trusted`; failed app has no trust button).

- **[verifier-LOW] app-tester had no direct static-mode tests.** **Fix:** new
  `services/app-tester/src/staticCheck.test.ts` pins `runStaticAppCheck`
  (clean pass, legacy-view reject, missing-sdk reject, compile-error) and the
  `runAppTest({mode:'static'})` compile-only contract.

- **[verifier-LOW] "passes a valid app" test over-claimed** what static mode
  verifies. **Fix:** test now asserts the result has exactly the `compile` check.

- **[P2] typescript was externalized but only a devDependency**
  (`apps/desktop/electron.vite.config.ts`). A packaged desktop omits devDeps, so
  AppTester would fail to resolve `typescript` at runtime. **Fix:** moved
  `typescript` to `apps/desktop` production `dependencies`.

- **[P2] over-claimed "broken builds".** `ts.transpileModule` is syntax-only (no
  module resolution / type-check). **Fix:** corrected the comments in
  `staticCheck.ts` / `appPackage.ts` — static mode catches legacy SDK imports +
  syntactically broken source; full build/module-resolution validation is the
  Phase 7b runtime's job. (A full TS program over arbitrary user `.apps` folders
  without installed node_modules is not viable, so this is a scoping correction,
  not a deferred code change.)

## Rejected (adversarially, real=false)

- **own-folder branch un-normalized targetPath traversal** — technically true but
  no production caller and `validateUserWritePath` already blocks `..` at the
  only live write path. Closed anyway by the `appWriteAllowed` traversal guard
  above (defense in depth).
- **legacy-@dohc/view rejection never exercises the compiler path** — false
  premise: the clean-pass test flows through `ts.transpileModule` end-to-end via
  the real `/static` dynamic import, so a typescript-load regression IS caught.
