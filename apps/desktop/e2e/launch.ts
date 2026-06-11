import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication } from "playwright";

// Single source for launching the built desktop app in E2E. Keeps the
// dist path, the WSL --no-sandbox flag, and the test env in one place.
export async function launchApp(
  env: Record<string, string> = {},
): Promise<ElectronApplication> {
  const args = ["apps/desktop/dist/main/main.js"];
  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") args.push("--no-sandbox");
  // EVERY launch gets a distinct userData dir: the single-instance lock keys
  // on it (so two clients can run CONCURRENTLY for live co-editing), and
  // renderer-origin state (localStorage, e.g. the stored theme) must never
  // leak between tests or runs. Test-only app state (registry, credentials,
  // window state) already lives under DOHC_TEST_HOME.
  const userData =
    env.DOHC_TEST_USER_DATA ?? (await mkdtemp(join(tmpdir(), "dohc-e2e-ud-")));
  args.push(`--user-data-dir=${userData}`);
  return electron.launch({
    args,
    cwd: process.cwd(),
    env: { ...process.env, DOHC_DESKTOP_TEST: "1", ...env },
  });
}
