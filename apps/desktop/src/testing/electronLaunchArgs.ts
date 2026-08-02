/**
 * The command line the desktop E2E harness launches Electron with.
 *
 * The `--user-data-dir` switch is the load-bearing part. Electron's
 * single-instance lock is keyed on the user data directory, not on the app
 * name: `App::RequestSingleInstanceLock` reads `chrome::DIR_USER_DATA` and
 * hands that path to Chromium's `ProcessSingleton`
 * (electron/electron@76b7ac4e15c6492189a002215e3eeecf7157af48,
 * `shell/browser/api/electron_api_app.cc`). Without the switch every run on a
 * machine shared `AppData/Roaming/Electron`, so a second E2E run — or a
 * developer's own dev app — collided with the lock the first one held and one
 * of the two quit at launch (#530). A per-run directory also drops the profile
 * state (localStorage, cookies, caches) a previous run left behind.
 *
 * This module holds no Playwright or vitest import, so `src/**` tests and
 * `e2e/**` helpers can both use it (same reason as engineBinary.ts).
 */
export function electronLaunchArgs(input: {
  /** Absolute path of the built main entry (dist/main/main.js). */
  mainEntry: string;
  /** Per-run user data directory. Must be unique to the run. */
  userDataDir: string;
  platform?: NodeJS.Platform;
}): string[] {
  const platform = input.platform ?? process.platform;
  return [
    `--user-data-dir=${input.userDataDir}`,
    // Chromium's sandbox needs privileges the CI containers do not grant.
    ...(platform === "linux" ? ["--no-sandbox"] : []),
    // Electron takes the first non-switch argument as the app to run, so the
    // entry stays last.
    input.mainEntry,
  ];
}
