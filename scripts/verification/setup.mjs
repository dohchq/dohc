import { run, repoRoot } from "./process.mjs";

// The checkout cannot resolve its own pnpm package until installation completes. No terminal can confirm a
// modules purge, so a pnpm settings change reinstalls instead of aborting.
const installer = process.platform === "win32"
  ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; pnpm.cmd install --frozen-lockfile --config.confirm-modules-purge=false; exit $LASTEXITCODE"]]
  : ["pnpm", ["install", "--frozen-lockfile", "--config.confirm-modules-purge=false"]];
try {
  await run(...installer);
  await run(process.execPath, ["apps/desktop/scripts/ensure-electron-installed.mjs"], { cwd: repoRoot });
  await run(process.execPath, ["scripts/verification/doctor.mjs"]);
} catch (error) { console.error(error.message); process.exitCode = 1; }
