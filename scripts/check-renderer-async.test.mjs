import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { checkRawBridge, rawBridgeCalls, isRendererTest, transportFiles } from "./check-raw-bridge.mjs";

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
test("the raw-call ratchet rejects an added call in a legacy file", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-u4-ratchet-"));
  try {
    writeFileSync(join(root, "Legacy.tsx"), 'import { bridge } from "./bridge";\nbridge().read();\n');
    const inventory = { counts: { "Legacy.tsx": 1 } };
    assert.deepEqual(checkRawBridge(root, inventory), []);
    writeFileSync(join(root, "Legacy.tsx"), 'import { bridge } from "./bridge";\nbridge().read(); bridge().read();\n');
    assert.deepEqual(checkRawBridge(root, inventory), ["RATCHET Legacy.tsx: raw bridge calls 1 -> 2. Use desktopAction or the operation's owner."]);
    assert.deepEqual(checkRawBridge(root, { counts: {} }), ["RATCHET Legacy.tsx: raw bridge calls 0 -> 2. Use desktopAction or the operation's owner."]);
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
test("raw-call counts include aliases, retained handles, and spacing", () => {
  for (const source of [
    'import { bridge as desktopBridge } from "./bridge"; desktopBridge().a(); desktopBridge ().b();',
    'import { bridge } from "./bridge"; const d = bridge(); d.a(); d.b();',
    'import { bridge } from "./bridge"; const d = useRef(bridge()).current; d.a(); d["b"]();',
    'import { bridge } from "./bridge"; const { a, b: read } = bridge(); a(); read();',
    'import { bridge } from "./bridge"; const read = flag ? bridge().a : bridge().b; read(); read();',
    'window.dohcDesktop.a(); window ["dohcDesktop"].b();',
    'const { bridge: desktopBridge } = await import("./bridge"); desktopBridge().a(); desktopBridge ().b();',
    'const module = await import("./bridge"); const d = module.bridge(); d.a(); d.b();',
  ]) assert.equal(rawBridgeCalls(source), 2, source);
  assert.equal(rawBridgeCalls('const text = "bridge().read()"; // bridge().read()'), 0);
});
test("test and transport files share one skip rule", () => {
  for (const path of ['View.testSupport.tsx', 'View.TestHarness.tsx', 'View.fixture.ts', 'View.test-d.ts']) assert.equal(isRendererTest(path), true);
  assert.equal(isRendererTest('View.tsx'), false);
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
