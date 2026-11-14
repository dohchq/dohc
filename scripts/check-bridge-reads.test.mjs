import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkBridgeReads, extractBridgeReads } from "./check-bridge-reads.mjs";

const panel = "apps/desktop/src/renderer/Panel.tsx";
const hook = "apps/desktop/src/renderer/useThing.ts";
const imports = 'import { bridge } from "../bridge"; ';
const query = 'import { useWorkspaceQuery } from "./workspace/useWorkspaceQuery"; ';
const reads = (path, source) => extractBridgeReads(path, source).map((site) => site.fingerprint);

function fixture(t, sources) {
  const dir = mkdtempSync(join(tmpdir(), "dohc-bridge-reads-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(sources)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), source);
  }
  return dir;
}

test("rejects a new raw read and points at useWorkspaceQuery", (t) => {
  const dir = fixture(t, {
    [panel]: imports + "export function Panel() { void bridge().getStatus(); return <div />; }",
  });
  const { failures } = checkBridgeReads(dir, { sites: [] });
  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /^apps\/desktop\/src\/renderer\/Panel\.tsx \| getStatus \(line 1\): new raw desktop-bridge read/u,
  );
  assert.match(
    failures[0],
    /useWorkspaceQuery.*apps\/desktop\/src\/renderer\/workspace\/useWorkspaceQuery\.ts/u,
  );
  assert.match(failures[0], /scripts\/bridge-reads\.json is not a fix/u);
});

test("accepts a listed read and rejects a stale entry", (t) => {
  const dir = fixture(t, {
    [panel]: imports + "export function Panel() { void bridge().getStatus(); return <div />; }",
  });
  assert.deepEqual(checkBridgeReads(dir, { sites: [panel + " | getStatus"] }).failures, []);
  const { failures } = checkBridgeReads(dir, {
    sites: [panel + " | getStatus", panel + " | getStatus #2"],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /getStatus #2: stale entry.*inventory only shrinks/u);
});

test("a read in a query's load is owned, even inside a nested function", () => {
  const source =
    imports +
    query +
    `export function useThing(id: string) {
    const query = useWorkspaceQuery(session, {
      key: id,
      load: async () => Promise.all([1, 2].map(page => bridge().listPages({ id, page }))),
    });
    return { query, other: () => bridge().readOther() };
  }`;
  assert.deepEqual(reads(hook, source), [hook + " | readOther"]);
  assert.deepEqual(reads(hook, source.replace("useWorkspaceQuery(", "useOtherQuery(")), [
    hook + " | listPages",
    hook + " | readOther",
  ]);
  assert.deepEqual(
    reads(
      hook,
      imports +
        query +
        "export function useThing() { return useWorkspaceQuery(session, { key: 'k', async load() { return bridge().getThing(); } }); }",
    ),
    [],
  );
});

test("only the imported useWorkspaceQuery owns a read", () => {
  const load = "(session, { key: 'k', load: () => bridge().getThing() }); }";
  assert.deepEqual(
    reads(
      hook,
      imports +
        "function useWorkspaceQuery(s, o) {} export function useThing() { return useWorkspaceQuery" +
        load,
    ),
    [hook + " | getThing"],
  );
  assert.deepEqual(
    reads(
      hook,
      imports +
        'import { useWorkspaceQuery as useQuery } from "./workspace/useWorkspaceQuery"; export function useThing() { return useQuery' +
        load,
    ),
    [],
  );
  assert.deepEqual(
    reads(
      hook,
      imports +
        'import * as queries from "./workspace/useWorkspaceQuery"; export function useThing() { return queries.useWorkspaceQuery' +
        load,
    ),
    [],
  );
  const sibling = "apps/desktop/src/renderer/workspace/useThing.ts";
  assert.deepEqual(
    reads(
      sibling,
      'import { bridge } from "../bridge"; import { useWorkspaceQuery } from "./useWorkspaceQuery"; export function useThing() { return useWorkspaceQuery' +
        load,
    ),
    [],
  );
  assert.deepEqual(
    reads(
      hook,
      imports +
        'import { useWorkspaceQuery } from "./other/useWorkspaceQuery"; export function useThing() { return useWorkspaceQuery' +
        load,
    ),
    [hook + " | getThing"],
  );
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
    const { bridge: make } = desktop;
    make().readE();
  }`;
  assert.deepEqual(
    reads(hook, source),
    ["readA", "readB", "readC", "readD", "readE"].map((name) => hook + " | " + name),
  );
});

test("finds the bridge through a local helper that returns it", () => {
  const source =
    imports +
    `const api = () => bridge();
  function desktop() { return api(); }
  export function useThing() {
    api().readA();
    desktop().readB();
  }`;
  assert.deepEqual(reads(hook, source), [hook + " | readA", hook + " | readB"]);
});

test("a parameter named like the bridge does not count", () => {
  assert.deepEqual(
    reads(hook, imports + "export function useThing(bridge: Fake) { bridge().readA(); }"),
    [],
  );
});

test("counts reads by name and action, and repeats by number", () => {
  const source =
    imports +
    `export function useThing() {
    bridge().dataset({ action: "list" });
    bridge().dataset({ action: "write" });
    bridge().ownerRestore({ action: "status" });
    bridge().saveThing();
    bridge().searchWorkspace();
    bridge().chatLinks();
    bridge().chatLinks();
  }`;
  assert.deepEqual(reads(hook, source), [
    hook + " | dataset:list",
    hook + " | ownerRestore:status",
    hook + " | chatLinks",
    hook + " | chatLinks #2",
  ]);
});

test("counts an action it cannot read as a literal, and reads both branches of a choice", () => {
  const source =
    imports +
    `export function useThing(write: boolean, action: string) {
    const payload = { action: "list" };
    bridge().dataset(payload);
    bridge().dataset({ action });
    bridge().dataset(write ? { action: "setGrant" } : { action: "removeGrant" });
    bridge().dataset(write ? { action: "setGrant" } : { action: "status" });
  }`;
  assert.deepEqual(reads(hook, source), [
    hook + " | dataset:?",
    hook + " | dataset:? #2",
    hook + " | dataset:status",
  ]);
});

test("fails when the inventory grows above its ceiling or shrinks below it", (t) => {
  const dir = fixture(t, {
    [panel]:
      imports +
      "export function Panel() { void bridge().getStatus(); void bridge().getOther(); return <div />; }",
  });
  const sites = [panel + " | getStatus", panel + " | getOther"];
  assert.deepEqual(checkBridgeReads(dir, { sites }, 2).failures, []);
  assert.match(
    checkBridgeReads(dir, { sites }, 1).failures.join(),
    /lists 2 reads, above the ceiling of 1\. Read it in the load of useWorkspaceQuery/u,
  );
  assert.match(
    checkBridgeReads(dir, { sites }, 3).failures.join(),
    /Lower the ceiling in scripts\/check-bridge-reads\.mjs from 3 to 2/u,
  );
});

test("skips files that are not components or hooks, and tests", () => {
  const plain = imports + "export async function loadThing() { return bridge().getThing(); }";
  assert.deepEqual(reads("apps/desktop/src/renderer/thing.ts", plain), []);
  assert.deepEqual(
    reads(
      "apps/desktop/src/renderer/Panel.test.tsx",
      imports + "function Panel() { bridge().getThing(); return <div />; }",
    ),
    [],
  );
  assert.deepEqual(
    reads(
      "apps/desktop/src/main/useThing.ts",
      imports + "export function useThing() { bridge().getThing(); }",
    ),
    [],
  );
});
