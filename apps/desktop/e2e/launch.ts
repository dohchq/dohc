import { _electron as electron, type ElectronApplication } from "playwright";

// Single source for launching the built desktop app in E2E. Keeps the
// dist path, the WSL --no-sandbox flag, and the test env in one place.
export async function launchApp(
  env: Record<string, string> = {},
): Promise<ElectronApplication> {
  const args = ["apps/desktop/dist/main/main.js"];
  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") args.push("--no-sandbox");
  // A distinct userData dir per launch lets two clients run CONCURRENTLY
  // (live co-editing): the single-instance lock keys on userData, so without
  // this the second instance would quit on launch. Test-only state
  // (registry, credentials) already lives under DOHC_TEST_HOME.
  if (env.DOHC_TEST_USER_DATA) args.push(`--user-data-dir=${env.DOHC_TEST_USER_DATA}`);
  return electron.launch({
    args,
    cwd: process.cwd(),
    env: { ...process.env, DOHC_DESKTOP_TEST: "1", ...env },
  });
}
