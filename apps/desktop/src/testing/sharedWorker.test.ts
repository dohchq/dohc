import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Runs real files, in order, in one worker of the desktop-shared-dom project.
function runInOneWorker(...files: string[]) {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./sharedWorker/run.mjs", import.meta.url)), ...files], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8", timeout: 110_000, stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output.trim().split(/\r?\n/u).at(-1)!) as {
    files: { file: string; state: string; failedTests: string[]; hookErrors: string[] }[];
    uncaught: { message: string; file?: string }[];
  };
}

describe("a shared jsdom worker", () => {
  it("gives the next file its baseline when a file's afterAll throws", () => {
    expect(runInOneWorker(
      "src/testing/sharedWorker/leavesState.fixture-test.ts",
      "src/testing/sharedWorker/checksBaseline.fixture-test.ts",
    )).toEqual({
      files: [
        { file: "src/testing/sharedWorker/leavesState.fixture-test.ts", state: "fail", failedTests: [], hookErrors: ["leaves the worker dirty"] },
        { file: "src/testing/sharedWorker/checksBaseline.fixture-test.ts", state: "pass", failedTests: [], hookErrors: [] },
      ],
      uncaught: [],
    });
  }, 120_000);

  it("still reports an error thrown from a click handler after ErrorBoundary.test.tsx", () => {
    const result = runInOneWorker("src/renderer/ErrorBoundary.test.tsx", "src/testing/sharedWorker/throwsFromClick.fixture-test.tsx");
    expect(result.files.map(({ file, state }) => [file, state])).toEqual([
      ["src/renderer/ErrorBoundary.test.tsx", "pass"],
      ["src/testing/sharedWorker/throwsFromClick.fixture-test.tsx", "pass"],
    ]);
    expect(result.uncaught).toEqual([
      { message: "thrown from a click handler", file: "src/testing/sharedWorker/throwsFromClick.fixture-test.tsx" },
    ]);
  }, 120_000);
});
