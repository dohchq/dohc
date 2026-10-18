import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

// macOS $TMPDIR is a link into /private. Tests that make folders under
// os.tmpdir() must hold the path that code resolving links sees.
if (process.platform !== "win32") process.env.TMPDIR = realpathSync(tmpdir());

export default defineConfig({
  test: {
    // Tool tests import and query real SQLite files; two take close to 1 s on a
    // quiet host. 30 s matches sync-relay.
    testTimeout: 30_000,
  },
});
