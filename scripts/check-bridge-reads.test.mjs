import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkBridgeReads, extractBridgeReads } from "./check-bridge-reads.mjs";

const panel = "apps/desktop/src/renderer/Panel.tsx";
const hook = "apps/desktop/src/renderer/useThing.ts";
const imports = 'import { bridge } from "../bridge"; ';
const reads = (path, source) => extractBridgeReads(path, source).map(site => site.fingerprint);

function fixture(t, sources) {
  const dir = mkdtempSync(join(tmpdir(), "dohc-bridge-reads-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(sources)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), source);
  }
  return dir;
}

test("rejects a new raw read and points at useWorkspaceQuery", t => {
  const dir = fixture(t, { [panel]: imports + "export function Panel() { void bridge().getStatus(); return <div />; }" });
  const { failures } = checkBridgeReads(dir, { sites: [] });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^apps\/desktop\/src\/renderer\/Panel\.tsx \| getStatus \(line 1\): new raw desktop-bridge read/u);
  assert.match(failures[0], /useWorkspaceQuery.*apps\/desktop\/src\/renderer\/workspace\/useWorkspaceQuery\.ts/u);
  assert.match(failures[0], /scripts\/bridge-reads\.json is not a fix/u);
});

test("accepts a listed read and rejects a stale entry", t => {
  const dir = fixture(t, { [panel]: imports + "export function Panel() { void bridge().getStatus(); return <div />; }" });
  assert.deepEqual(checkBridgeReads(dir, { sites: [panel + " | getStatus"] }).failures, []);
  const { failures } = checkBridgeReads(dir, { sites: [panel + " | getStatus", panel + " | getStatus #2"] });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /getStatus #2: stale entry.*inventory only shrinks/u);
});

test("a read in a query's load is owned, even inside a nested function", () => {
  const source = imports + `export function useThing(id: string) {
    const query = useWorkspaceQuery(session, {
      key: id,
      load: async () => Promise.all([1, 2].map(page => bridge().listPages({ id, page }))),
    });
    return { query, other: () => bridge().readOther() };
  }`;
  assert.deepEqual(reads(hook, source), [hook + " | readOther"]);
  assert.deepEqual(reads(hook, source.replace("useWorkspaceQuery(", "useOtherQuery(")), [hook + " | listPages", hook + " | readOther"]);
  assert.deepEqual(reads(hook, imports + "export function useThing() { return useWorkspaceQuery(session, { key: 'k', async load() { return bridge().getThing(); } }); }"), []);
});

test("finds the bridge through aliases, destructuring, namespaces, and the global", () => {
  const source = `import * as desktop from "../bridge"; import { bridge as b } from "./bridge";
  export function useThing() {
    const api = b();
    const { readA } = api;
    readA();
    desktop.bridge().readB();
    window.dohcDesktop.readC();
    globalThis["dohcDesktop"].readD();
  }`;
  assert.deepEqual(reads(hook, source), ["readA", "readB", "readC", "readD"].map(name => hook + " | " + name));
});

test("a parameter named like the bridge does not count", () => {
  assert.deepEqual(reads(hook, imports + "export function useThing(bridge: Fake) { bridge().readA(); }"), []);
});

test("counts reads by name and action, and repeats by number", () => {
  const source = imports + `export function useThing() {
    bridge().dataset({ action: "list" });
    bridge().dataset({ action: "write" });
    bridge().ownerRestore({ action: "status" });
    bridge().saveThing();
    bridge().searchWorkspace();
    bridge().chatLinks();
    bridge().chatLinks();
  }`;
  assert.deepEqual(reads(hook, source), [hook + " | dataset:list", hook + " | ownerRestore:status", hook + " | chatLinks", hook + " | chatLinks #2"]);
});

test("skips files that are not components or hooks, and tests", () => {
  const plain = imports + "export async function loadThing() { return bridge().getThing(); }";
  assert.deepEqual(reads("apps/desktop/src/renderer/thing.ts", plain), []);
  assert.deepEqual(reads("apps/desktop/src/renderer/Panel.test.tsx", imports + "function Panel() { bridge().getThing(); return <div />; }"), []);
  assert.deepEqual(reads("apps/desktop/src/main/useThing.ts", imports + "export function useThing() { bridge().getThing(); }"), []);
});
