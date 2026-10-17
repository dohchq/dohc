import fsSync, { existsSync, mkdirSync, utimesSync } from "node:fs";
import fs from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mode = process.argv[2];
const parent = join(tmpdir(), "dohc-test-scratch");
const aged = join(parent, "fixture-123-0000000000000001");
mkdirSync(aged, { recursive: true });
const old = new Date(Date.now() - 49 * 60 * 60 * 1000);
utimesSync(aged, old, old);

let scans = 0;
let rootCreates = 0;
const failure = Object.assign(new Error("injected startup failure"), { code: "EACCES" });
// Keep the helper's Linux /tmp preference inside this child's owned TMPDIR.
const pathExists = fsSync.existsSync;
fsSync.existsSync = (path) => path === "/tmp" ? false : pathExists(path);
const readdir = fs.readdir;
fs.readdir = async function (path, ...args) {
  if (String(path) === parent) {
    scans++;
    if (mode === "scan-failure") throw failure;
  }
  return readdir.call(this, path, ...args);
};
const mkdir = fs.mkdir;
fs.mkdir = async function (path, ...args) {
  if (String(path).startsWith(join(parent, "process-"))) {
    rootCreates++;
    if (mode === "mkdir-failure") throw failure;
  }
  return mkdir.call(this, path, ...args);
};
syncBuiltinESMExports();

const setupUrl = new URL("../testSetup.ts", import.meta.url).href;
const helperUrl = new URL("./testTemp.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    // The next-file mode imports the setup again, as vitest runs it again for each file.
    if (context.parentURL?.split("?")[0] === setupUrl) {
      if (specifier === "vitest") {
        return { url: "data:text/javascript,export function afterEach(){};export function afterAll(){};export function inject(){}", shortCircuit: true };
      }
      if (specifier === "./workspaces/testTemp") return { url: helperUrl, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const helper = await import(helperUrl);
if (mode.endsWith("failure")) {
  const first = await helper.createTestScratch("first-").catch((error) => error);
  const second = await helper.createTestScratch("second-").catch((error) => error);
  console.log(JSON.stringify({ scans, rootCreates, sameFailure: first === failure && second === failure }));
} else if (mode === "next-file") {
  // A shared worker's next file allocates after the last file's suite cleanup removed the empty root.
  await import(setupUrl);
  await helper.createTestScratch("first-file-");
  await helper.cleanupTestScratch();
  await helper.cleanupSuiteTestScratch();
  const rootRemoved = !existsSync(helper.testScratchRunRoot());
  await import(`${setupUrl}?next-file`);
  const next = await helper.createTestScratch("next-file-");
  const nextExists = existsSync(next);
  await helper.cleanupTestScratch();
  await helper.cleanupSuiteTestScratch();
  console.log(JSON.stringify({ scans, rootCreates, rootRemoved, nextExists }));
} else {
  if (mode === "setup") {
    await import(setupUrl);
    helper.createTestScratchSync("sync-");
  }
  await Promise.all(Array.from({ length: 3 }, () => helper.createTestScratch("async-")));
  const agedExists = existsSync(aged);
  await helper.cleanupTestScratch();
  await helper.cleanupSuiteTestScratch();
  console.log(JSON.stringify({ scans, rootCreates, agedExists }));
}
