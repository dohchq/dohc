// Usage: node run.mjs <test file>...
// Runs the files, in order, in one shared jsdom worker, and prints how each
// file ended and every uncaught error as one line of JSON.
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { startVitest } from "vitest/node";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const files = process.argv.slice(2);
process.env.DOHC_SHARED_WORKER_FILES = JSON.stringify(files);
// A full verification run sets this, and then the config has no shared project to run in.
delete process.env.DOHC_DESKTOP_TEST_ISOLATION;
const vitest = await startVitest("test", [], {
  config: fileURLToPath(new URL("./vitest.config.mjs", import.meta.url)),
  watch: false,
  reporters: [{}],
});
const tests = (task) => task.tasks?.flatMap(tests) ?? [task];
const summary = {
  files: vitest.state.getFiles().map((file) => ({
    file: relative(root, file.filepath).replaceAll("\\", "/"),
    state: file.result?.state,
    failedTests: tests(file).filter((test) => test.result?.state === "fail").map((test) => test.name),
    hookErrors: (file.result?.errors ?? []).map((error) => error.message),
  })),
  uncaught: vitest.state.getUnhandledErrors().map((error) => ({
    message: String(error?.message ?? error),
    file: error?.VITEST_TEST_PATH ? relative(root, error.VITEST_TEST_PATH).replaceAll("\\", "/") : undefined,
  })),
};
await vitest.close();
console.log(JSON.stringify(summary));
process.exitCode = 0;
