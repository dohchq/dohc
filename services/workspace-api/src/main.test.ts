import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

for (const nodeEnv of [undefined, "production", "staging"]) {
  for (const postgresUrl of [undefined, "", "   "]) {
    test(`refuses missing database configuration in ${nodeEnv ?? "unset NODE_ENV"}: ${JSON.stringify(postgresUrl)}`, () => {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: {
          ...process.env,
          NODE_ENV: nodeEnv,
          POSTGRES_URL: postgresUrl,
          BETTER_AUTH_SECRET: "test-secret-with-at-least-32-characters",
          DOHC_TEST_AUTH: undefined,
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /POSTGRES_URL must be set outside development\/test/);
      assert.doesNotMatch(result.stdout, /listening/);
    });
  }
}
