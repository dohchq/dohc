import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// macOS $TMPDIR is a link into /private. Tests that make folders under
// os.tmpdir() must hold the path that code resolving links sees.
if (process.platform === "darwin") process.env.TMPDIR = privateShortTmpdir();
else if (process.platform !== "win32") process.env.TMPDIR = realpathSync(tmpdir());

// macOS $TMPDIR is a long /var/folders path, and a replica's relay.sock must fit
// in the 104-byte sun_path. Use this user's own folder in the shared /tmp instead.
function privateShortTmpdir(): string {
  const uid = process.getuid!();
  const dir = join(realpathSync("/tmp"), `dohc-${uid}`);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stats = lstatSync(dir);
  if (!stats.isDirectory() || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
    throw new Error(`${dir} must be a directory that only user ${uid} can enter. Remove it as its owner, then run the tests again.`);
  }
  return dir;
}

// 30s is the floor for the 8 test files here that do not spawn a relay child.
//
// The 3 that do — main/dm/presence.integration — raise their own budgets per file,
// because their spawn helper now allows 45s for the port line: it launches
// `node --import tsx/esm src/main.ts`, which compiles on startup and measured 12-15s
// under load. That startup deadline, not any assertion, is what failed these tests
// in #372. Keeping the package floor tight means a hang in the other 8 files still
// surfaces in 30s rather than 90.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    // expect.poll's own default is 1 s; a loaded host needs the same 10 s as desktop.
    expect: { poll: { timeout: 10_000 } },
  },
});
