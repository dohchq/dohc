import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "../../../../scripts/verification/process.mjs";

const require = createRequire(import.meta.url);
const vitest = pathToFileURL(require.resolve("vitest/package.json"));
const directory = resolve(process.argv[2]);
const desktop = fileURLToPath(new URL("../../", import.meta.url));
const parent = join(directory, "dohc-test-scratch");
const events = join(directory, "events.jsonl");
const aged = join(parent, "fixture-123-0000000000000001");
// A recent run of a live process, and an empty one its dead process abandoned.
const recent = join(parent, `fixture-${process.pid}-0000000000000002`);
const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
const abandoned = join(parent, `fixture-${deadPid}-0000000000000003`);
mkdirSync(aged, { recursive: true });
mkdirSync(recent);
mkdirSync(abandoned);
const old = new Date(Date.now() - 49 * 60 * 60 * 1000);
utimesSync(aged, old, old);

// Instrument the real global setup and isolated workers inside an owned parent.
const preload = join(directory, "preload.mjs");
writeFileSync(preload, `
  import fsSync from 'node:fs';
  import fs from 'node:fs/promises';
  import { syncBuiltinESMExports } from 'node:module';
  const exists = fsSync.existsSync;
  fsSync.existsSync = path => path === '/tmp' ? false : exists(path);
  const readdir = fs.readdir;
  fs.readdir = async function(path, ...args) {
    if (String(path) === ${JSON.stringify(parent)}) {
      fsSync.appendFileSync(${JSON.stringify(events)}, JSON.stringify({scan: true}) + '\\n');
      if (process.env.DOHC_SCRATCH_FIXTURE_FAIL === '1') throw new Error('injected global scratch failure');
    }
    return readdir.call(this, path, ...args);
  };
  syncBuiltinESMExports();
`);

const files = [];
for (let index = 0; index < 3; index++) {
  const file = join(directory, `scratch-${index}.test.ts`);
  files.push(file);
  writeFileSync(file, `
    import { expect, it } from ${JSON.stringify(new URL("./dist/index.js", vitest).href)};
    import { appendFileSync, existsSync } from 'node:fs';
    import { createTestScratch, createTestScratchSync, createSuiteTestScratchSync, testScratchRunRoot } from ${JSON.stringify(new URL("./testTemp.ts", import.meta.url).href)};
    const suite = createSuiteTestScratchSync('suite-');
    let scratch;
    it('allocates independent scratch', async () => {
      scratch = [await createTestScratch('async-'), createTestScratchSync('sync-')];
      expect(scratch.every(existsSync)).toBe(true);
      appendFileSync(${JSON.stringify(events)}, JSON.stringify({file: ${index}, root: testScratchRunRoot(), suite, scratch}) + '\\n');
    });
    it('cleans per-test scratch while preserving suite scratch', () => {
      expect(scratch.every(path => !existsSync(path))).toBe(true);
      expect(existsSync(suite)).toBe(true);
    });
  `);
}
const config = join(directory, "vitest.config.mjs");
writeFileSync(config, `
  import base from ${JSON.stringify(new URL("../../vitest.config.ts", import.meta.url).href)};
  const desktopProject = base.test.projects.find(project => project.test.name === 'desktop');
  export default { ...desktopProject, root: ${JSON.stringify(desktop)}, test: { ...desktopProject.test,
    include: ${JSON.stringify(files.map(file => file.replaceAll("\\", "/")))}, maxWorkers: 1,
    execArgv: [...desktopProject.test.execArgv, '--import', ${JSON.stringify(pathToFileURL(preload).href)}],
  }};
`);
const log = join(directory, "vitest.log");
let status = 0;
try {
  await run(process.execPath, ["--import", pathToFileURL(preload).href, fileURLToPath(new URL("./vitest.mjs", vitest)), "run", "--config", config], {
    cwd: desktop, quietStdout: true, timeoutMs: 60_000, log,
    env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory, DOHC_TEST_SCRATCH_ROOT: "", DOHC_TEST_SCRATCH_RUN: "" },
  });
} catch { status = 1; }
const records = existsSync(events) ? readFileSync(events, "utf8").trim().split(/\r?\n/u).map(line => JSON.parse(line)) : [];
const allocations = records.filter(record => record.root);
console.log(JSON.stringify({
  status, scans: records.filter(record => record.scan).length,
  files: allocations.length, roots: new Set(allocations.map(record => record.root)).size,
  clean: allocations.every(record => [record.root, record.suite, ...record.scratch].every(path => !existsSync(path))),
  agedExists: existsSync(aged), recentExists: existsSync(recent), abandonedExists: existsSync(abandoned),
  ...(status ? { output: readFileSync(log, "utf8") } : {}),
}));
