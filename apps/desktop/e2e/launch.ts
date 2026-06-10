import { _electron as electron, type ElectronApplication } from "playwright";

// Single source for launching the built desktop app in E2E. Keeps the
// dist path, the WSL --no-sandbox flag, and the test env in one place.
export async function launchApp(
  env: Record<string, string> = {},
): Promise<ElectronApplication> {
  const args = ["apps/desktop/dist/main/main.js"];
  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") args.push("--no-sandbox");
  return electron.launch({
    args,
    cwd: process.cwd(),
    env: { ...process.env, DOHC_DESKTOP_TEST: "1", ...env },
  });
}
