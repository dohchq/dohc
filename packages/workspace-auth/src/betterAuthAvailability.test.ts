import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const vitestCli = resolve(
  dirname(require.resolve("vitest/package.json")),
  "vitest.mjs",
);

describe("Better Auth database-suite availability gate", () => {
  it("skips the live-Postgres suite when Postgres is unreachable", () => {
    const result = spawnSync(
      process.execPath,
      [vitestCli, "run", "src/betterAuth.test.ts", "--reporter=json"],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: (() => {
          // This test verifies the SKIP path, which by definition is the
          // non-CI behaviour. CI sets DOHC_REQUIRE_POSTGRES=1 job-wide so an
          // unreachable database is a failure rather than a silent green --
          // inheriting it here would make the suite fail exactly as intended
          // and this test would report that as a bug.
          const { DOHC_REQUIRE_POSTGRES: _required, ...inherited } = process.env;
          return {
            ...inherited,
            POSTGRES_URL: "postgres://dohc:dohc@127.0.0.1:1/dohc",
          };
        })(),
      },
    );

    expect(
      result.status,
      `live-Postgres suite failed instead of skipping:\n${result.stdout}\n${result.stderr}`,
    ).toBe(0);

    const report = JSON.parse(result.stdout) as {
      numPendingTests: number;
      numTotalTests: number;
      testResults: Array<{ name: string }>;
    };
    expect(report.testResults).toHaveLength(1);
    expect(report.testResults[0]?.name).toContain("betterAuth.test.ts");
    expect(report.numPendingTests).toBe(report.numTotalTests);
    expect(report.numTotalTests).toBeGreaterThan(0);
  }, 15_000);
});
