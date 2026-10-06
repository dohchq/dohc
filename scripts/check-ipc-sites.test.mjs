import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { checkIpcSites, extractIpcSites } from "./check-ipc-sites.mjs";

const preload = "apps/desktop/src/preload.ts";
const main = "apps/desktop/src/main.ts";
const registrar = "apps/desktop/src/ipc/exampleIpc.ts";
const root = resolve(import.meta.dirname, "..");
const oldSite = preload + " | CHANNELS.old";

function fixture(t, sources = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dohc-ipc-sites-"));
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
  assert.doesNotMatch(failures[0], /[Ii]f this change only moves/u);
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
    assert.match(failures[0], /new hand-written IPC site/u);
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
  assert.deepEqual(inventory.sites, [preload + " | invokeParsed forwards channel to ipcRenderer.invoke", oldSite]);
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
  assert.deepEqual(fingerprints, [registrar + " | CHANNELS.stop", registrar + " | CHANNELS.resume"]);
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
  assert.deepEqual(extractIpcSites("apps/desktop/src/renderer/bridge.ts", "ipcRenderer.invoke(CHANNELS.new);"), []);
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
    preload + " | invokeParsed forwards channel to ipcRenderer.invoke", preload + " | CHANNELS.new",
  ]);
  assert.deepEqual(extractIpcSites(main, 'ipcMain["handle"](CHANNELS.new, handler);').map(site => site.fingerprint), [main + " | CHANNELS.new"]);
});

test("expands a direct channel array", () => {
  assert.deepEqual(extractIpcSites(registrar, 'for (const channel of [CHANNELS.a, CHANNELS.b]) registerHandler(channel, handler);').map(site => site.fingerprint), [
    registrar + " | CHANNELS.a", registrar + " | CHANNELS.b",
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

test("tuple wrappers, constants, and spreads retain sites", () => {
  const rows = [
    '[CHANNELS.new, true] as const',
    '[CHANNELS.new, true] satisfies Row',
    '([CHANNELS.new, true])',
    'row',
    '[...channelTuple]',
    '...rows',
  ];
  const results = rows.map(row => extractIpcSites(registrar,
    'const channelTuple = [CHANNELS.new, true] as const; const row = channelTuple; const rows = [row]; for (const [channel, stop] of ['
    + row + '] as const) registerHandler(channel, handler);').map(site => site.fingerprint.split(' | ').at(-1)));
  assert.deepEqual(results, rows.map(() => ['CHANNELS.new']));
  assert.deepEqual(extractIpcSites(registrar, 'const rows = [[CHANNELS.new, true]] as const; for (const [channel, stop] of (rows satisfies Rows)) registerHandler(channel, handler);').map(site => site.fingerprint), [registrar + ' | CHANNELS.new']);
});

test("unresolved rows retain their collection text", () => {
  const spread = extractIpcSites(registrar, 'for (const [channel] of [...unknownRows]) registerHandler(channel, handler);');
  assert.equal(spread.length, 1);
  assert.match(spread[0].fingerprint, /collection/u);
  const unknown = value => extractIpcSites(registrar,
    'const rows = makeRows(' + value + '); for (const [channel, stop] of rows) registerHandler(channel, handler);');
  assert.equal(unknown('CHANNELS.a').length, 1);
  assert.notDeepEqual(unknown('CHANNELS.a'), unknown('CHANNELS.b'));
  const mixed = value => extractIpcSites(registrar,
    'for (const [channel, stop] of [[CHANNELS.old, true], makeRow(' + value + ')]) registerHandler(channel, handler);');
  assert.equal(mixed('CHANNELS.a').length, 2);
  assert.notDeepEqual(mixed('CHANNELS.a'), mixed('CHANNELS.b'));
  const tupleSpread = value => extractIpcSites(registrar,
    'for (const [channel, stop] of [[...makeTuple(' + value + ')]]) registerHandler(channel, handler);');
  assert.equal(tupleSpread('CHANNELS.a').length, 1);
  assert.notDeepEqual(tupleSpread('CHANNELS.a'), tupleSpread('CHANNELS.b'));
  const indirect = value => extractIpcSites(registrar,
    'const inputs = [' + value + ']; const rows = inputs.map(makeRow); for (const [channel] of rows) registerHandler(channel, handler);');
  assert.equal(indirect('CHANNELS.a').length, 1);
  assert.notDeepEqual(indirect('CHANNELS.a'), indirect('CHANNELS.b'));
});

test("boundary and one-shot registrations are hand sites", () => {
  const results = ['operationBoundary.handle', 'ipcMain.handleOnce'].map(callee =>
    extractIpcSites(main, 'const operationBoundary = { handle: handleIpc }; ' + callee + '(CHANNELS.new, handler);').map(site => site.fingerprint.split(' | ').at(-1)));
  assert.deepEqual(results, [['CHANNELS.new'], ['CHANNELS.new']]);
});

test("invoke normalization follows transparent expressions and local aliases", () => {
  const sources = [
    '(ipcRenderer.invoke)(CHANNELS.new);',
    '(ipcRenderer).invoke(CHANNELS.new);',
    'ipcRenderer?.invoke(CHANNELS.new);',
    '(ipcRenderer as X).invoke(CHANNELS.new);',
    '(<X>ipcRenderer).invoke(CHANNELS.new);',
    'ipcRenderer!.invoke?.(CHANNELS.new);',
    'const renderer = ipcRenderer; const r = renderer; r["invoke"](CHANNELS.new);',
    'const r = ipcRenderer; r.invoke(CHANNELS.new);',
    'const { invoke } = ipcRenderer; invoke(CHANNELS.new);',
    'const { invoke: request } = ipcRenderer; request(CHANNELS.new);',
    'const request = ipcRenderer.invoke.bind(ipcRenderer); request(CHANNELS.new);',
    '(ipcRenderer.invoke.bind(ipcRenderer))(CHANNELS.new);',
  ];
  assert.deepEqual(sources.map(source => extractIpcSites(preload, source)
    .map(site => site.fingerprint.split(' | ').at(-1))), sources.map(source => source.includes('.bind')
    ? ['CHANNELS.new', 'invoke transport reference: ipcRenderer.invoke'] : ['CHANNELS.new']));
});

test("inline and constant table transports are exempt only when forwarding", () => {
  for (const transport of [
    '(channel, payload) => ipcRenderer.invoke(channel, payload)',
    'function(channel, payload) { return ipcRenderer.invoke(channel, payload); }',
  ]) {
    assert.deepEqual(extractIpcSites(preload, 'operationBridge(ops, ' + transport + ');'), []);
    assert.deepEqual(extractIpcSites(preload, 'const transport = ' + transport + '; operationBridge(ops, transport);'), []);
    assert.deepEqual(extractIpcSites(preload, 'operationBridge(ops, '
      + transport.replace('invoke(channel', 'invoke(CHANNELS.new') + ');').map(site => site.fingerprint), [preload + ' | CHANNELS.new']);
    assert.equal(extractIpcSites(preload, 'const transport = ' + transport
      + '; operationBridge(ops, transport); transport(CHANNELS.new);').length, 1);
  }
});

test("moved preload and registrar modules remain in the scanned set", t => {
  const paths = ['apps/desktop/src/bridge/transport.ts', 'apps/desktop/src/ipc/settings/handlers.ts'];
  const { dir } = fixture(t, {
    [paths[0]]: 'ipcRenderer.invoke(CHANNELS.new);',
    [paths[1]]: 'registerHandler(CHANNELS.new, handler);',
  });
  const inventory = { sites: extractIpcSites(preload, 'ipcRenderer.invoke(CHANNELS.old);').map(site => site.fingerprint) };
  const { failures, sites } = checkIpcSites(dir, inventory);
  assert.equal(failures.length, 2);
  assert.equal(sites.length, 3);
  for (const path of paths) assert.ok(failures.some(failure => failure.startsWith(path)));
});

test("cross-file moves explain fingerprint replacement", t => {
  const moved = "apps/desktop/src/bridge/transport.ts";
  const { dir } = fixture(t, { [preload]: "", [moved]: "ipcRenderer.invoke(CHANNELS.old);" });
  const stale = extractIpcSites(preload, 'ipcRenderer.invoke(CHANNELS.old);')[0].fingerprint;
  const { failures } = checkIpcSites(dir, { sites: [stale] });
  assert.match(failures.join('\n'), /If this change only moves existing hand sites, replace the stale fingerprints with these/u);
  assert.match(failures.join('\n'), /CHANNELS.old/u);
  assert.match(failures.join('\n'), /bridge\/transport.ts/u);
  const duplicate = fixture(t, { [moved]: 'ipcRenderer.invoke(CHANNELS.old);' });
  const duplicateMove = checkIpcSites(duplicate.dir, { sites: [oldSite, oldSite + ' #2'] });
  assert.match(duplicateMove.failures.join('\n'), /If this change only moves/u);
});

test("local aliases respect function and block bindings", () => {
  const source = 'const r = ipcRenderer; function unrelated(r: Other) { r.invoke(CHANNELS.fake); } '
    + '{ const r = other; r.invoke(CHANNELS.fake); } r.invoke(CHANNELS.new);';
  assert.deepEqual(extractIpcSites(preload, source).map(site => site.fingerprint), [preload + ' | CHANNELS.new']);
});

test("forwarding fingerprints name the registrar and channel parameter", () => {
  assert.deepEqual(extractIpcSites(main,
    'registerExampleIpc({ registerHandler: (channel, handler) => ipcMain.handle(channel, handler) });')
    .map(site => site.fingerprint), [main + ' | registerExampleIpc.registerHandler forwards channel to ipcMain.handle']);
});

test("entry-name bindings remain hand calls after alias resolution", () => {
  for (const [path, source] of [
    [preload, 'const { ipcRenderer } = require("electron"); ipcRenderer.invoke(CHANNELS.new);'],
    [preload, 'const ipcRenderer = electron.ipcRenderer; ipcRenderer.invoke(CHANNELS.new);'],
    [main, 'const handleIpc = createHandleIpc(ipcMain); handleIpc(CHANNELS.new, handler);'],
    [registrar, 'const registerHandler = guarded(deps.registerHandler); registerHandler(CHANNELS.new, handler);'],
    [registrar, 'const registerHandler = deps.handle; registerHandler(CHANNELS.new, handler);'],
  ]) assert.deepEqual(extractIpcSites(path, source).map(site => site.fingerprint), [path + ' | CHANNELS.new']);
});

test("named row collections referenced outside their loop are sites", () => {
  const rows = 'const rows = [[CHANNELS.old, true], [CHANNELS.resume, false]]; ';
  const loop = 'for (const [channel, stop] of rows) registerHandler(channel, handler);';
  assert.deepEqual(extractIpcSites(registrar, rows + loop).map(site => site.fingerprint), [
    registrar + ' | CHANNELS.old', registrar + ' | CHANNELS.resume',
  ]);
  for (const use of ['rows.push([CHANNELS.new, true]);', 'mutate(rows);', 'mutate({ rows });', 'const other = rows;', 'rows[0] = [CHANNELS.new, true];']) {
    assert.deepEqual(extractIpcSites(registrar, rows + use + loop).map(site => site.fingerprint), [
      registrar + ' | collection(rows) referenced outside its loop',
    ]);
  }
  assert.deepEqual(extractIpcSites(registrar, rows + '{ const rows = other; mutate(rows); }' + loop)
    .map(site => site.fingerprint), [registrar + ' | CHANNELS.old', registrar + ' | CHANNELS.resume']);
});

test("table forwarding distinguishes a shadowed channel binding", () => {
  for (const named of [false, true]) {
    const transport = '(channel, payload) => { { const channel = "desktop:new"; ipcRenderer.invoke(channel); } return ipcRenderer.invoke(channel, payload); }';
    const source = named ? 'const transport = ' + transport + '; operationBridge(ops, transport);' : 'operationBridge(ops, ' + transport + ');';
    assert.deepEqual(extractIpcSites(preload, source).map(site => site.fingerprint), [preload + ' | "desktop:new"']);
  }
});

test("Electron imports and let aliases identify hand calls", t => {
  const sources = [
    'import { ipcRenderer as ipc } from "electron"; ipc.invoke(CHANNELS.new);',
    'import * as electron from "electron"; electron.ipcRenderer.invoke(CHANNELS.new);',
    'import { ipcMain as mainIpc } from "electron"; mainIpc.handle(CHANNELS.new, handler);',
    'import * as electron from "electron"; electron.ipcMain.handle(CHANNELS.new, handler);',
    'let r = ipcRenderer; r.invoke(CHANNELS.new);',
  ];
  for (const source of sources) {
    const { dir } = fixture(t, { [preload]: source });
    const { sites, failures } = checkIpcSites(dir, { sites: [] });
    assert.deepEqual(sites.map(site => site.fingerprint), [preload + ' | CHANNELS.new']);
    assert.equal(failures.length, 1);
  }
  assert.deepEqual(extractIpcSites(preload, 'import { ipcRenderer as ipc } from "other"; ipc.invoke(CHANNELS.fake);'), []);
});

test("uncalled invoke transports and helper references are sites", t => {
  const helper = 'function invoke(channel, payload) { return ipcRenderer.invoke(channel, payload); } operationBridge(ops, invoke); ';
  for (const expression of [
    'export const request = ipcRenderer.invoke.bind(ipcRenderer);',
    'const transport = { request: ipcRenderer.invoke.bind(ipcRenderer) };',
    'const request = invoke.bind(null); request(CHANNELS.new);',
    'ipcRenderer.invoke.call(ipcRenderer, CHANNELS.new);',
    'ipcRenderer.invoke.apply(ipcRenderer, [CHANNELS.new]);',
    'Reflect.apply(ipcRenderer.invoke, ipcRenderer, [CHANNELS.new]);',
    'const transport = { invoke };',
    'invoke.call(null, CHANNELS.new);',
    'invoke.apply(null, [CHANNELS.new]);',
    'Reflect.apply(invoke, null, [CHANNELS.new]);',
  ]) {
    const reference = expression.includes('ipcRenderer.invoke') ? 'ipcRenderer.invoke' : 'invoke';
    assert.deepEqual(extractIpcSites(preload, helper + expression).map(site => site.fingerprint), [
      preload + ' | invoke transport reference: ' + reference,
    ], expression);
  }
  const provider = 'apps/desktop/src/bridge/auditTransport.ts';
  const { dir } = fixture(t, {
    [preload]: '',
    [provider]: 'import { ipcRenderer } from "electron"; export const invoke = ipcRenderer.invoke.bind(ipcRenderer);',
    'apps/desktop/src/bridge/auditIndex.ts': 'export { invoke as requestFromMain } from "./auditTransport";',
    'apps/desktop/src/bridge/auditMethods.ts': 'import { requestFromMain } from "./auditIndex"; export const getStatus = () => requestFromMain(CHANNELS.new);',
  });
  const { sites, failures } = checkIpcSites(dir, { sites: [] });
  assert.deepEqual(sites.map(site => site.fingerprint), [provider + ' | invoke transport reference: ipcRenderer.invoke']);
  assert.equal(failures.length, 1);
  assert.deepEqual(extractIpcSites(preload, 'operationBridge(ops, (ipcRenderer.invoke as Transport));'), []);
});

test("table forwarding accepts transparent channel wrappers and local aliases", () => {
  for (const expression of ['(channel)', 'channel as string', 'channel!', 'key']) {
    const transport = '(channel, payload) => { const key = channel; return ipcRenderer.invoke(' + expression + ', payload); }';
    assert.deepEqual(extractIpcSites(preload, 'operationBridge(ops, ' + transport + ');'), [], expression);
    assert.deepEqual(extractIpcSites(preload, 'const transport = ' + transport + '; operationBridge(ops, transport);'), [], expression);
  }
});

test("same-file site swaps keep the plain OperationTable diagnostic", t => {
  const { dir } = fixture(t, { [preload]: 'ipcRenderer.invoke(CHANNELS.new);' });
  const { failures } = checkIpcSites(dir, { sites: [oldSite] });
  assert.equal(failures.length, 2);
  assert.match(failures[0], /Declare a row in an OperationTable/u);
  assert.doesNotMatch(failures.join('\n'), /[Ii]f this change only moves/u);
});

test("mutable channel aliases never inherit their initializer or table exemption", () => {
  assert.deepEqual(extractIpcSites(preload,
    'const bridge = { pickWorkspaceRoot: () => { let channel = CHANNELS.pickWorkspaceRoot; channel = CHANNELS.brandNew; return ipcRenderer.invoke(channel); } };')
    .map(site => site.fingerprint), [preload + ' | pickWorkspaceRoot forwards channel to ipcRenderer.invoke']);
  assert.deepEqual(extractIpcSites(preload,
    'operationBridge(ops, (channel, payload) => { let c = channel; c = "desktop:x"; return ipcRenderer.invoke(c, payload); });')
    .map(site => site.fingerprint), [preload + ' | <inline>/<inline> forwards c to ipcRenderer.invoke']);
  assert.deepEqual(extractIpcSites(preload, 'let r = ipcRenderer; r.invoke(CHANNELS.new);').map(site => site.fingerprint), [preload + ' | CHANNELS.new']);
});

test("loop and catch shadows have their own binding identities", () => {
  for (const body of [
    'for (const channel of ["desktop:sol-audit-new"]) void ipcRenderer.invoke(channel); return ipcRenderer.invoke(channel, payload);',
    'for (const channel of [CHANNELS.x]) void ipcRenderer.invoke(channel); return ipcRenderer.invoke(channel, payload);',
    'for (const channel in channels) void ipcRenderer.invoke(channel); return ipcRenderer.invoke(channel, payload);',
    'for (let channel = 0; channel < 1; channel++) void ipcRenderer.invoke(channel); return ipcRenderer.invoke(channel, payload);',
    'try { throw "desktop:sol-audit-new"; } catch (channel) { void ipcRenderer.invoke(channel as string); } return ipcRenderer.invoke(channel, payload);',
    'try { return ipcRenderer.invoke(channel, payload); } catch (channel) { return ipcRenderer.invoke(channel); }',
  ]) {
    const result = extractIpcSites(preload, 'operationBridge(scheduleHostOperations, (channel, payload) => { ' + body + ' });').map(site => site.fingerprint);
    assert.deepEqual(result, [preload + ' | ' + (body.includes('of ["') ? '"desktop:sol-audit-new"'
      : body.includes('of [CHANNELS') ? 'CHANNELS.x' : '<inline>/<inline> forwards channel to ipcRenderer.invoke')], body);
  }
  assert.deepEqual(extractIpcSites(preload, 'import { ipcRenderer as ipc } from "electron"; for (const { ipc: plugin } of plugins) ipc.invoke("desktop:new");')
    .map(site => site.fingerprint), [preload + ' | "desktop:new"']);
  for (const body of [
    'const plugins = [{ invoke: (_channel: string) => undefined }]; for (const ipc of plugins) ipc.invoke("desktop:sol-audit-new");',
    'for (const ipc in plugins) ipc.invoke("desktop:sol-audit-new");',
    'try {} catch (ipc) { ipc.invoke("desktop:sol-audit-new"); }',
  ]) assert.deepEqual(extractIpcSites(preload, 'import { ipcRenderer as ipc } from "electron"; ' + body), [], body);
});

test("collection mutations in another declarator count as outside uses", t => {
  const source = 'const rows: Array<readonly [string, boolean]> = [[CHANNELS.stopOwnerLiveDocument, true], [CHANNELS.resumeOwnerLiveDocument, false]], appended = rows.push(["desktop:sol-audit-new", true]); for (const [channel, stop] of rows) registerHandler(channel, handler);';
  assert.deepEqual(extractIpcSites(registrar, source).map(site => site.fingerprint), [registrar + ' | collection(rows) referenced outside its loop']);
  const { dir } = fixture(t, { [registrar]: source });
  const { failures } = checkIpcSites(dir, { sites: [oldSite] });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Keep the row list in the loop, or declare the operation in an OperationTable/u);
});

test("entry identities survive alias chains and Electron namespace forms", () => {
  for (const source of [
    'const { ipcRenderer } = require("electron"); const renderer = ipcRenderer; renderer.invoke("desktop:sol-audit-new");',
    'import * as electron from "electron"; const { ipcRenderer: renderer } = electron; renderer.invoke("desktop:sol-audit-new");',
    'import electron from "electron"; electron.ipcRenderer.invoke("desktop:sol-audit-new");',
    'require("electron").ipcRenderer.invoke("desktop:sol-audit-new");',
    'const electronModule = require("electron"); electronModule.ipcRenderer.invoke("desktop:sol-audit-new");',
    'const electronModule = require("electron"); const { ipcRenderer: r } = electronModule; r.invoke("desktop:sol-audit-new");',
  ]) assert.deepEqual(extractIpcSites(preload, source).map(site => site.fingerprint), [preload + ' | "desktop:sol-audit-new"'], source);
  assert.deepEqual(extractIpcSites(main, 'const handleIpc = createHandleIpc(ipcMain); const register = handleIpc; register(CHANNELS.new, h);')
    .map(site => site.fingerprint), [main + ' | CHANNELS.new']);
});

test("exported table helper declarations are transport escapes", t => {
  for (const source of [
    'import { ipcRenderer } from "electron"; export function invoke(channel: string, payload: unknown) { return ipcRenderer.invoke(channel, payload); } operationBridge(ops, invoke);',
    'export const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload); operationBridge(ops, invoke);',
    'export const { invoke: request } = ipcRenderer;',
    'export const { invoke } = ipcRenderer;',
    'export const invoke = ((channel, payload) => ipcRenderer.invoke(channel, payload)); operationBridge(ops, invoke);',
  ]) {
    const provider = 'apps/desktop/src/bridge/auditTransport.ts';
    const reference = source.includes('const {') ? 'ipcRenderer.invoke' : 'invoke';
    const { dir } = fixture(t, { [preload]: '', [provider]: source,
      'apps/desktop/src/bridge/auditMethods.ts': 'import { invoke } from "./auditTransport"; export const getAuditStatus = () => invoke("desktop:sol-audit-new", undefined);',
    });
    const { failures, sites } = checkIpcSites(dir, { sites: [] });
    assert.deepEqual(sites.map(site => site.fingerprint), [provider + ' | invoke transport reference: ' + reference], source);
    assert.equal(failures.length, 1);
  }
});

test("move hints list only matched cross-file pairs", t => {
  const moved = 'apps/desktop/src/bridge/transport.ts';
  const { dir } = fixture(t, {
    [preload]: 'ipcRenderer.invoke(CHANNELS.swapNew);',
    [moved]: 'ipcRenderer.invoke(CHANNELS.moved); ipcRenderer.invoke(CHANNELS.brandNew);',
  });
  const { failures } = checkIpcSites(dir, { sites: [preload + ' | CHANNELS.moved', preload + ' | CHANNELS.swapOld'] });
  assert.equal(failures.length, 5);
  const hint = failures.find(failure => failure.includes('\nIf this change only moves')).split('\nIf')[1];
  assert.equal(hint, ' this change only moves existing hand sites, replace the stale fingerprints with these.\nStale fingerprints:\n'
    + preload + ' | CHANNELS.moved\nReplacement fingerprints:\n' + moved + ' | CHANNELS.moved');
});

test("type positions do not create uncalled transport references", () => {
  const helper = 'function invoke(channel: string) { return ipcRenderer.invoke(channel); } operationBridge(ops, invoke); ';
  for (const source of [
    'type Transport = typeof invoke;',
    'operationBridge(ops, invoke as typeof invoke);',
    'type RawTransport = typeof ipcRenderer.invoke;',
    'const typed: typeof invoke = invoke; operationBridge(ops, typed);',
  ]) {
    // A value reference assigned to typed still escapes; its annotation does not add a second site.
    const expected = source.startsWith('const typed') ? [preload + ' | invoke transport reference: invoke'] : [];
    assert.deepEqual(extractIpcSites(preload, helper + source).map(site => site.fingerprint), expected, source);
  }
  assert.deepEqual(extractIpcSites(preload, helper + 'ipcRenderer.invoke(CHANNELS.new); type T = typeof invoke;')
    .map(site => site.fingerprint), [preload + ' | CHANNELS.new']);
});
