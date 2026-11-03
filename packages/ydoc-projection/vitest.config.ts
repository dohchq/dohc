import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// macOS $TMPDIR is a link into /private. Tests that make folders under
// os.tmpdir() must hold the path that code resolving links sees.
if (process.platform === "darwin") process.env.TMPDIR = privateShortTmpdir();
else if (process.platform !== "win32") process.env.TMPDIR = realpathSync(tmpdir());

// macOS $TMPDIR is a long /var/folders path, and a replica's relay.sock must fit
// in the 104-byte sun_path. Use this user's own folder in the shared /tmp instead,
// as sync-relay's tests do.
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

export default defineConfig({
  test: {
    // Bound concurrent durable SQLite fixtures on shared development machines.
    maxWorkers: 4,
    // The gate runs these durable SQLite suites beside every other package. On a
    // loaded host four storage tests exceeded vitest's 5 s default in one run,
    // while the package took 18 minutes. 30 s matches sync-relay.
    testTimeout: 30_000,
    // expect.poll's own default is 1 s; a loaded host needs the same 10 s as desktop.
    expect: { poll: { timeout: 10_000 } },
  },
});
