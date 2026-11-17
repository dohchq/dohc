import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const smoke = fileURLToPath(new URL("./smoke-test.mjs", import.meta.url));
// Windows has no SIGTERM to catch, and the smoke runs on Linux and macOS packages only.
const skip = process.platform === "win32";

// Stands in for dohc. Until it has started it catches no signal, as a process still loading does.
const app = (startAfterMs) => `
setTimeout(() => {
  console.log("[desktop] launch marks (ms since process start): app-ready 1, first-window 2, daemon-ready 3, first-paint 4");
  process.on("SIGTERM", () => {
    console.log("[desktop] quit: shutdown finished in 1 ms");
    process.exit(0);
  });
}, ${String(startAfterMs)});
setInterval(() => {}, 1000);
`;

/** Runs the smoke on `source` in place of the built app, with Node in place of Electron. */
async function runSmoke(t, source) {
  const root = await mkdtemp(join(tmpdir(), "dohc-smoke-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "apps/desktop/dist/main"), { recursive: true });
  await writeFile(join(root, "apps/desktop/dist/main/main.js"), source);
  const { DOHC_SMOKE_USER_DATA_DIR: _profile, ...env } = process.env;
  const child = spawn(process.execPath, [smoke], {
    cwd: root,
    env: { ...env, DOHC_SMOKE_ELECTRON: process.execPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  const [code] = await new Promise((resolve) =>
    child.once("close", (...result) => resolve(result)),
  );
  return { code, output };
}

test(
  "an app that takes longer to start than the smoke keeps it up still passes",
  { skip, timeout: 60_000 },
  async (t) => {
    // The smoke keeps a started app up for 8 s. A signal after 8 s from launch would end this one unstarted.
    const { code, output } = await runSmoke(t, app(9_000));
    const startedMs = /Desktop smoke passed: dohc started in (\d+)ms/u.exec(output)?.[1];
    assert.ok(Number(startedMs) >= 9_000, output);
    assert.equal(code, 0);
  },
);

test("an app that ends before it has started fails, and the smoke says so", { skip }, async (t) => {
  const { code, output } = await runSmoke(t, "process.exit(3);");
  assert.match(output, /app exited before it started \(code=3, signal=null\)/u);
  assert.equal(code, 1);
});
