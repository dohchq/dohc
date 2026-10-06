import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { checkRawBridge, rawBridgeReferences, isRendererTest, transportFiles } from "./check-raw-bridge.mjs";

const checker = resolve(import.meta.dirname, "check-renderer-async.mjs");
const fixtures = resolve(import.meta.dirname, "fixtures/renderer-async");
test("RA1–RA7 reject exactly the reviewed 40 findings in 37 files", () => {
  const run = spawnSync(process.execPath, [checker, join(fixtures, "reject"), "--strict"], { encoding: "utf8" });
  assert.equal(run.status, 1, run.stderr);
  const findings = run.stdout.split(/\r?\n/u).filter(line => /^RA[1-7] /u.test(line));
  const expected = readFileSync(join(fixtures, "expected-reject.txt"), "utf8").trim().split("\n").sort();
  assert.equal(findings.length, 40);
  assert.deepEqual(findings.map(line => line.match(/^RA[1-7] .+?:\d+/u)[0]).sort(), expected);
  assert.equal(new Set(findings.map(line => line.match(/^RA[1-7] (.+?):\d+/u)[1])).size, 37);
});
test("accepted caller and owner shapes have zero findings", () => {
  const output = execFileSync(process.execPath, [checker, join(fixtures, "accept"), "--strict"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(output.trim()), { files: 12, findings: 0 });
});
test("the raw-reference ratchet rejects an added call in a legacy file", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-u4-ratchet-"));
  try {
    writeFileSync(join(root, "Legacy.tsx"), 'import { bridge } from "./bridge";\nbridge().read();\n');
    const inventory = { counts: { "Legacy.tsx": 1 } };
    assert.deepEqual(checkRawBridge(root, inventory), []);
    writeFileSync(join(root, "Legacy.tsx"), 'import { bridge } from "./bridge";\nbridge().read(); bridge().read();\n');
    assert.deepEqual(checkRawBridge(root, inventory), ["RATCHET Legacy.tsx:2: raw bridge references exceed inventory count 1 -> 2. Use desktopAction or the operation's owner."]);
    assert.deepEqual(checkRawBridge(root, { counts: {} }), ["RATCHET Legacy.tsx:2: raw bridge references exceed inventory count 0 -> 2. Use desktopAction or the operation's owner."]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function probe(files) {
  const root = mkdtempSync(join(tmpdir(), "dohc-u4-checker-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), source);
    }
    return spawnSync(process.execPath, [checker, root, "--strict"], { encoding: "utf8" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const hooks = 'import { useDesktopEvent, useDesktopAction } from "./desktopAction";\n';
test("event names must be literal and respect the resource owner", () => {
  for (const [name, rule] of [['"onUpdateState"', "RA5"], ['props.event as never', "RA2"]]) {
    const result = probe({ "desktopActionOwners.json": '{"feed.ts":["onUpdateState"]}', "View.tsx": hooks + 'useDesktopEvent([], ' + name + ', () => {});' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, new RegExp(rule + " View"));
  }
});
test("dynamic imports cannot bypass transport or settlement boundaries", () => {
  for (const [source, rule] of [['"./bridge"', "RA1"], ['"./desktopActionTesting"', "RA6"], ['props.module', "RA7"]]) {
    const result = probe({ "View.tsx": 'export async function read() { await import(' + source + '); }' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, new RegExp(rule + " View"));
  }
});
test("data runtime re-exports obey the same dependency rule as imports", () => {
  for (const statement of ['export { read } from "../viewHelpers";', 'export * from "../viewHelpers";']) {
    const result = probe({ "data/read.ts": statement });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /RA4 data\/read.ts/);
  }
  const result = probe({ "data/read.ts": 'export type { Payload } from "../viewHelpers"; export type * from "../viewHelpers";' });
  assert.equal(result.status, 0, result.stdout);
});
test("deferred work is checked from calls rather than source spelling", () => {
  for (const call of ['later.then (paint)', 'later["then"](paint)', 'later ["catch"] (paint)', 'later.finally (paint)', 'window.setTimeout (() => paint(), 0)', 'globalThis["queueMicrotask"] (() => paint())', 'setInterval (() => paint(), 0)', 'window.requestAnimationFrame (paint)']) {
    const result = probe({ "View.tsx": hooks + 'useDesktopAction([], "read", { success: () => { ' + call + '; }, failure: () => {} });' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /RA3 View/);
  }
  const result = probe({ "View.tsx": hooks + 'useDesktopEvent([], "onWorkspaceActivity", () => { /* await later.then( */ const text = "setTimeout( await"; console.log(text); });' });
  assert.equal(result.status, 0, result.stdout);
});
test("a setter in another component cannot exempt an ambiguous handler", () => {
  const result = probe({ "View.tsx": hooks + 'function A() { const [, receive] = useState(0); } function B() { async function receive() { await Promise.resolve(); } useDesktopEvent([], "onWorkspaceActivity", receive); }' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /RA3 View/);
});
test("raw-reference counts include aliases, retained handles, and spacing", () => {
  for (const [source, expected] of [
    ['import { bridge as desktopBridge } from "./bridge"; desktopBridge().a(); desktopBridge ().b();', 2],
    ['import { bridge } from "./bridge"; const d = bridge(); d.a(); d.b();', 3],
    ['import { bridge } from "./bridge"; const d = useRef(bridge()).current; d.a(); d["b"]();', 3],
    ['import { bridge } from "./bridge"; const { a, b: read } = bridge(); a(); read();', 3],
    ['import { bridge } from "./bridge"; const read = flag ? bridge().a : bridge().b; read(); read();', 4],
    ['window.dohcDesktop.a(); window ["dohcDesktop"].b();', 2],
    ['const { bridge: desktopBridge } = await import("./bridge"); desktopBridge().a(); desktopBridge ().b();', 3],
    ['const module = await import("./bridge"); const d = module.bridge(); d.a(); d.b();', 4],
  ]) assert.equal(rawBridgeReferences(source), expected, source);
  assert.equal(rawBridgeReferences('const text = "bridge().read()"; // bridge().read()'), 0);
});
test("test and transport files share one skip rule", () => {
  for (const path of ['DesktopWorkspaceShell.testSupport.tsx', 'collab/engineDocLeaseTestHarness.ts', 'FileInspector.draft-fixture.ts', 'View.test-d.ts']) assert.equal(isRendererTest(path), true);
  for (const path of ['View.tsx', 'View.TestHarness.tsx', 'View.fixture.ts', 'View.testSupport.tsx', 'fixtures/Production.ts']) assert.equal(isRendererTest(path), false);
  assert.deepEqual(transportFiles, ['bridge.ts', 'desktopAction.ts', 'desktopActionTesting.ts', 'desktopOperations.ts']);
});
test("the operation map and resource-owner registry agree", () => {
  const { parseSync } = createRequire(import.meta.url)("oxc-parser");
  const renderer = resolve(import.meta.dirname, "../apps/desktop/src/renderer");
  const source = readFileSync(join(renderer, "desktopOperations.ts"), "utf8");
  const { program, errors } = parseSync("desktopOperations.ts", source);
  assert.deepEqual(errors, []);
  const declaration = program.body.find(node => node.type === "ExportNamedDeclaration" && node.declaration?.declarations?.[0]?.id.name === "desktopMembers");
  const object = declaration.declaration.declarations[0].init.expression.expression;
  const found = {};
  for (const member of object.properties) {
    const owner = member.value.properties.find(property => property.key.name === "owner");
    if (owner) (found[owner.value.value] ??= []).push(member.key.name);
  }
  const expected = JSON.parse(readFileSync(join(renderer, "desktopActionOwners.json"), "utf8"));
  const sorted = entries => Object.fromEntries(Object.entries(entries).map(([file, names]) => [file, names.sort()]));
  assert.deepEqual(sorted(found), sorted(expected));
});

test("bridge references cover escape forms and transitive copies", () => {
  for (const [body, expected] of [
    ["helper(bridge()); helper2(bridge());", 2],
    ["const deps = { api: bridge() }; deps.api.a();", 2],
    ["(bridge() as Api).a();", 1],
    ["bridge().a.call(null, 1); p.then(bridge().a);", 2],
    ["let d; d = bridge(); d.a(); d.b();", 4],
    ["function f(api = bridge()) { api.a(); }", 2],
    ["const b = bridge; const copy = b; copy().a(); copy().b();", 4],
    ["const read = bridge().a; const refresh = read; refresh(); refresh();", 4],
    ["const { a: read } = bridge(); const { b } = { b: read }; b();", 3],
  ]) assert.equal(rawBridgeReferences('import { bridge } from "./bridge"; ' + body), expected, body);
  assert.equal(rawBridgeReferences("const { dohcDesktop: api } = window; api.a(); api.b();"), 3);
  assert.equal(rawBridgeReferences("window.dohcDesktop!.a(); (window.dohcDesktop as Api).b(); dohcDesktop.c();"), 3);
});
test("bridge bindings respect lexical shadowing, keys, types, and hoisting", () => {
  const source = 'import { bridge } from "./bridge"; const d = bridge(); d.a();';
  for (const body of [
    "function update(d: { read(): void }) { d.read(); }",
    "{ const d = ordinary; d.read(); }",
    "try {} catch (d) { d.read(); }",
    "for (const d of items) { d.read(); }",
    "function update({ d }: { d: Api }) { d.read(); }",
    "function update() { d.read(); var d = ordinary; }",
    "const object = { d: 1 }; type T = typeof d;",
    "function update(bridge: Api) { bridge.read(); }",
  ]) assert.equal(rawBridgeReferences(source + body), 2, body);
  assert.equal(rawBridgeReferences(source + "{ const copy = d; copy.a(); }"), 4);
  assert.equal(rawBridgeReferences('import { bridge } from "./bridge"; const {read = fallback} = bridge(); read();'), 2);
  assert.equal(rawBridgeReferences('import { bridge } from "./bridge"; export { bridge };'), 1);
  assert.equal(rawBridgeReferences('import { bridge } from "./bridge"; const f = () => bridge(); f();'), 1);
  assert.equal(rawBridgeReferences('import type { bridge } from "./bridge"; type T = typeof bridge;'), 0);
});
test("transparent callees and constant-template promise members cannot defer delivery", () => {
  for (const call of ["(later.then)(paint)", "(later.then as Function)(paint)", "(later.then satisfies Function)(paint)", "later.then!(paint)", "later[`then`](paint)", "(window[`queueMicrotask`])(paint)", "(window as Window).setTimeout(paint, 0)"]) {
    const result = probe({ "View.tsx": hooks + 'useDesktopAction([], "read", { success: () => { ' + call + '; }, failure: () => {} });' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /RA3 View/);
  }
});
test("supported JavaScript specifiers retain every renderer boundary", () => {
  for (const [source, rule] of [
    ['import { bridge } from "./bridge.js"; bridge().read();', "RA1"],
    ['export { bridge } from "./bridge.js";', "RA7"],
    ['export { ReadName } from "./desktopOperations.js";', "RA7"],
    ['async function read() { await import("./desktopActionTesting.js"); }', "RA6"],
    ['import { useDesktopEvent as subscribe } from "./desktopAction.js"; subscribe([], "event", async () => {});', "RA7"],
  ]) {
    const result = probe({ "View.tsx": source });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, new RegExp(rule + " View"));
  }
  assert.equal(rawBridgeReferences('import { bridge as api } from "./bridge.js"; api().read(); api().read();'), 2);
  assert.equal(rawBridgeReferences('const { bridge: api } = await import("./bridge.js"); api().read();'), 2);
  for (const [specifier, file] of [["helpers.mjs", "helpers.mts"], ["helpers.jsx", "helpers.tsx"]]) {
    const result = probe({ "data/read.ts": 'export { read } from "../' + specifier + '";', [file]: 'export function read() {}' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /RA4 data/);
  }
});
test("production fixture and harness names do not bypass enforcement", () => {
  for (const name of ["View.fixture.ts", "ViewTestHarness.tsx", "View.testSupport.tsx"]) {
    const result = probe({ [name]: 'import { bridge } from "./bridge"; bridge().read();' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /RA1/);
  }
});

test("transparent calls retain same-file and void-call handler checks", () => {
  for (const body of ['async function defer() { await Promise.resolve(); }', 'function defer() { (props.report)(); }']) {
    const call = body.startsWith("async") ? "(defer)()" : "void ((props.report)())";
    const result = probe({ "View.tsx": hooks + body + 'useDesktopAction([], "read", { success: () => { ' + call + '; }, failure: () => {} });' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /RA3 View/);
  }
});
test("runtime TypeScript expressions remain references while type syntax does not", () => {
  const prefix = 'import { bridge } from "./bridge"; ';
  assert.equal(rawBridgeReferences(prefix + 'enum E { value = Number(Boolean(bridge())) }'), 1);
  assert.equal(rawBridgeReferences(prefix + 'enum E { bridge = 1, value = bridge }'), 0);
  assert.equal(rawBridgeReferences(prefix + 'namespace N { const b = bridge; b().a(); }'), 2);
  assert.equal(rawBridgeReferences(prefix + 'namespace N { var bridge = ordinary; bridge.read(); } bridge().read();'), 1);
  assert.equal(rawBridgeReferences(prefix + 'class C { constructor(private bridge: Api) { bridge.read(); } }'), 0);
  assert.equal(rawBridgeReferences(prefix + 'class C { static { const bridge = ordinary; bridge.read(); } }'), 0);
});

test("dynamic bridge imports count even when their promise uses then", () => {
  for (const specifier of ["./bridge", "./bridge.ts", "./bridge.js", "./bridge.mjs", "./bridge.jsx"]) {
    const source = 'void import("' + specifier + '").then(m => { m.bridge().a(); m.bridge().b(); });';
    assert.equal(rawBridgeReferences(source), 1, specifier);
  }
  assert.equal(rawBridgeReferences('void import("./ordinary").then(m => m.read());'), 0);
});
test("destructuring assignments retain bridge authority through existing bindings", () => {
  for (const assignment of ["({ api: d } = { api: bridge() })", "[d] = [bridge()]", "({ api: { nested: d } } = { api: { nested: bridge() } })"]) {
    const source = 'import { bridge } from "./bridge"; let d; ' + assignment + '; d.a(); d.b();';
    assert.equal(rawBridgeReferences(source), 4, assignment);
  }
  assert.equal(rawBridgeReferences('import { bridge } from "./bridge"; let d; { ({ api: d } = { api: bridge() }); } d.a();'), 3);
  assert.equal(rawBridgeReferences('import { bridge } from "./bridge"; const d = bridge(); { let d; ({ api: d } = ordinary); d.a(); } d.a();'), 2);
});
test("constant-template global destructuring assignments cannot bypass RA1", () => {
  for (const key of ["dohcDesktop", '"dohcDesktop"', '["dohcDesktop"]', '[`dohcDesktop`]']) {
    assert.equal(rawBridgeReferences('let d; ({ ' + key + ': d } = window); d!.a(); d!.b();'), 4, key);
  }
  const result = probe({ "View.tsx": 'let d; ({ [`dohcDesktop`]: d } = window); d!.a(); d!.b();' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /RA1 View.tsx:1:/);
});

test("the ratchet rejects growth through a destructuring-assigned handle", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-u4-assignment-"));
  try {
    const source = 'import { bridge } from "./bridge";\nlet d; ({ api: d } = { api: bridge() });\nd.read();\nd.read();\n';
    writeFileSync(join(root, "Legacy.tsx"), source);
    assert.deepEqual(checkRawBridge(root, { counts: { "Legacy.tsx": 1 } }), ["RATCHET Legacy.tsx:2,3,4: raw bridge references exceed inventory count 1 -> 4. Use desktopAction or the operation's owner."]);
    assert.deepEqual(checkRawBridge(root, { counts: { "Legacy.tsx": 4 } }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
