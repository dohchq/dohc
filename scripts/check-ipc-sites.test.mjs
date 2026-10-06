import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { checkIpcSites, extractIpcSites } from "./check-ipc-sites.mjs";

const preload = "apps/desktop/src/preload.ts";
const main = "apps/desktop/src/main.ts";
const registrar = "apps/desktop/src/ipc/exampleIpc.ts";
const root = resolve(import.meta.dirname, "..");
const oldSite = preload + " | preload | CHANNELS.old";

function fixture(t, sources = {}) {
  const artifacts = join(root, ".agent-artifacts");
  mkdirSync(artifacts, { recursive: true });
  const dir = mkdtempSync(join(artifacts, "u3a-ipc-sites-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (path, source) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), source);
  };
  write(preload, "ipcRenderer.invoke(CHANNELS.old);");
  write(main, "");
  for (const [path, source] of Object.entries(sources)) write(path, source);
  return { dir, write };
}

test("rejects a new hand invoke even when another legacy invoke is removed", t => {
  const { dir } = fixture(t, { [preload]: "ipcRenderer.invoke(CHANNELS.new);" });
  const { failures } = checkIpcSites(dir, { sites: [oldSite] });
  assert.equal(failures.length, 2);
  assert.match(failures[0], /CHANNELS.new.*new hand-written IPC site/u);
  assert.match(failures[0], /OperationTable in apps\/desktop\/src\/ipc\/bridgeContract\.ts/u);
  assert.match(failures[0], /operationBridge and registerOperations/u);
  assert.match(failures[1], /CHANNELS.old.*stale entry/u);
});

test("accepts an added table row and its derived bridge and registration", t => {
  const { dir } = fixture(t, {
    [preload]: 'function invoke(channel: string, payload: unknown) { return ipcRenderer.invoke(channel, payload); } const bridge = { old: () => ipcRenderer.invoke(CHANNELS.old), ...operationBridge(ops, invoke) };',
    [main]: "registerOperations(boundary, ops, handlers);",
    "apps/desktop/src/ipc/bridgeContract.ts": 'const ops = { new: { channel: "desktop:new", payload: Schema, guard: "trusted" } } satisfies OperationTable;',
  });
  const { failures, sites } = checkIpcSites(dir, { sites: [oldSite] });
  assert.deepEqual(failures, []);
  assert.deepEqual(sites.map(site => site.fingerprint), [oldSite]);
});

test("accepts removing a legacy site together with its inventory entry", t => {
  const { dir } = fixture(t, { [preload]: "" });
  assert.deepEqual(checkIpcSites(dir, { sites: [] }), { failures: [], sites: [] });
});

test("rejects a stale inventory entry", t => {
  const { dir } = fixture(t, { [preload]: "" });
  const { failures } = checkIpcSites(dir, { sites: [oldSite] });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /CHANNELS.old.*stale entry.*inventory only shrinks/u);
});

for (const [path, expression] of [
  [main, "handleIpc(CHANNELS.new, handler);"],
  [main, 'ipcMain.handle("desktop:new", handler);'],
  [registrar, "registerHandler(CHANNELS.new, handler);"],
  [registrar, "dependencies.registerHandler(CHANNELS.new, handler);"],
]) {
  test("rejects a main-side hand handler: " + expression, t => {
    const { dir } = fixture(t, { [path]: expression });
    const { failures } = checkIpcSites(dir, { sites: [oldSite] });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /main.*new hand-written IPC site/u);
  });
}

test("fingerprints survive unrelated line moves, formatting, and comments", () => {
  const source = 'ipcRenderer /* gap */ . invoke ( CHANNELS . old ); // ipcRenderer.invoke(CHANNELS.fake)';
  assert.deepEqual(extractIpcSites(preload, source).map(site => site.fingerprint), [oldSite]);
  assert.deepEqual(extractIpcSites(preload, "\n\n" + source), [{ fingerprint: oldSite, line: 3 }]);
  assert.deepEqual(extractIpcSites(preload, 'const text = "ipcRenderer.invoke(CHANNELS.fake)";'), []);
});

test("rejects an added invokeParsed helper call", t => {
  const helper = 'async function invokeParsed(channel: string, schema: Schema) { return schema.parse(await ipcRenderer.invoke(channel)); }';
  const { dir, write } = fixture(t, { [preload]: helper + ' invokeParsed(CHANNELS.old, Schema);' });
  const inventory = { sites: extractIpcSites(preload, helper + ' invokeParsed(CHANNELS.old, Schema);').map(site => site.fingerprint) };
  assert.deepEqual(inventory.sites, [preload + " | preload | ipcRenderer.invoke(channel)@invokeParsed", oldSite]);
  write(preload, helper + ' invokeParsed(CHANNELS.new, Schema);');
  const { failures } = checkIpcSites(dir, inventory);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /CHANNELS.new.*new hand-written IPC site/u);
});

test("rejects hand calls through the table's invoke helper", t => {
  const { dir } = fixture(t, { [preload]: 'function invoke(channel: string) { return ipcRenderer.invoke(channel); } operationBridge(ops, invoke); invoke(CHANNELS.new); ipcRenderer.invoke(CHANNELS.old);' });
  const { failures } = checkIpcSites(dir, { sites: [oldSite] });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /CHANNELS.new.*new hand-written IPC site/u);
});

test("rejects a direct hand invoke inside a table helper", t => {
  const { dir } = fixture(t, { [preload]: 'function invoke(channel: string) { ipcRenderer.invoke(CHANNELS.new); return ipcRenderer.invoke(channel); } operationBridge(ops, invoke); ipcRenderer.invoke(CHANNELS.old);' });
  const { failures } = checkIpcSites(dir, { sites: [oldSite] });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /CHANNELS.new.*new hand-written IPC site/u);
});

test("expands loop channels and rejects an added channel", t => {
  const loop = channels => 'for (const [channel, stop] of [' + channels + '] as const) { registerHandler(channel, handler); }';
  const before = loop('[CHANNELS.stop, true], [CHANNELS.resume, false]');
  const fingerprints = extractIpcSites(registrar, before).map(site => site.fingerprint);
  assert.deepEqual(fingerprints, [registrar + " | main | CHANNELS.stop", registrar + " | main | CHANNELS.resume"]);
  const { dir } = fixture(t, { [registrar]: loop('[CHANNELS.stop, true], [CHANNELS.new, false]') });
  const { failures } = checkIpcSites(dir, { sites: [oldSite, ...fingerprints] });
  assert.equal(failures.length, 2);
  assert.match(failures[0], /CHANNELS.new.*new hand-written IPC site/u);
});

test("rejects an additional call to an already inventoried channel", t => {
  const { dir } = fixture(t, { [preload]: 'ipcRenderer.invoke(CHANNELS.old); ipcRenderer.invoke(CHANNELS.old);' });
  const { failures } = checkIpcSites(dir, { sites: [oldSite] });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /CHANNELS.old #2.*new hand-written IPC site/u);
});

test("limits extraction to the declared production IPC files", () => {
  assert.deepEqual(extractIpcSites("apps/desktop/src/ipc/exampleIpc.test.ts", "registerHandler(CHANNELS.new, handler);"), []);
  assert.deepEqual(extractIpcSites("apps/desktop/src/ipc/operationTable.ts", "ipcMain.handle(channel, handler);"), []);
});

test("rejects malformed and duplicate inventories", t => {
  const { dir } = fixture(t);
  for (const inventory of [null, {}, { sites: [12] }, { sites: [oldSite, oldSite] }]) {
    assert.deepEqual(checkIpcSites(dir, inventory).failures, ["scripts/ipc-sites.json: expected unique site fingerprints."]);
  }
});

test("recognizes bracket access and explicit type arguments", () => {
  const source = 'function invokeParsed(channel: string) { return ipcRenderer["invoke"](channel); } invokeParsed<Schema>(CHANNELS.new);';
  assert.deepEqual(extractIpcSites(preload, source).map(site => site.fingerprint), [
    preload + " | preload | ipcRenderer.invoke(channel)@invokeParsed", preload + " | preload | CHANNELS.new",
  ]);
  assert.deepEqual(extractIpcSites(main, 'ipcMain["handle"](CHANNELS.new, handler);').map(site => site.fingerprint), [main + " | main | CHANNELS.new"]);
});

test("expands a direct channel array", () => {
  assert.deepEqual(extractIpcSites(registrar, 'for (const channel of [CHANNELS.a, CHANNELS.b]) registerHandler(channel, handler);').map(site => site.fingerprint), [
    registrar + " | main | CHANNELS.a", registrar + " | main | CHANNELS.b",
  ]);
});

test("CLI passes the inventory and exits nonzero for a new hand operation", t => {
  const { dir, write } = fixture(t);
  write("scripts/ipc-sites.json", JSON.stringify({ sites: [oldSite] }));
  const check = () => spawnSync(process.execPath, [join(root, "scripts/check-ipc-sites.mjs"), dir], { encoding: "utf8" });
  const passing = check();
  assert.equal(passing.status, 0, passing.stderr);
  assert.equal(passing.stdout.trim(), "IPC sites check passed (1 legacy sites).");
  write(main, "handleIpc(CHANNELS.new, handler);");
  const failing = check();
  assert.equal(failing.status, 1, failing.stderr);
  assert.match(failing.stderr, /CHANNELS.new.*new hand-written IPC site/u);
});

test("source and full repository verification include the check and fixtures", () => {
  const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(scripts["test:repo:source"].includes("node scripts/check-ipc-sites.mjs &&"));
  assert.ok(scripts["test:repo:source"].includes("scripts/check-ipc-sites.test.mjs"));
  assert.ok(scripts["test:repo"].startsWith("pnpm test:repo:source &&"));
});
