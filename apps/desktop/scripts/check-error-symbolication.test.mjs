import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { LABEL, probeTargets, runProbes } from "./check-error-symbolication.mjs";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const MAIN_CHUNK = "0192f5b8-7c3a-5e1d-9a2b-3c4d5e6f7a8b";
const RENDERER_CHUNK = "1a2b3c4d-5e6f-5a7b-8c9d-0e1f2a3b4c5d";
const RELEASE = "0192f5b8-0000-7000-8000-000000000001";
const SECRET = "SecretPerson";
const PROJECT = { DOHC_POSTHOG_KEY: "phc_abcdefghij0123", DOHC_POSTHOG_HOST: "https://ph.example.test" };
const CODE = "export function boom() { throw new Error(); }";
// What `posthog-cli sourcemap inject` 0.18.10 writes: its snippet first, its trailer last.
const injected = (chunkId) => `!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{};e._posthogReleaseId=e._posthogReleaseId||"${RELEASE}";var n=(new e.Error).stack;n&&(e._posthogChunkIds=e._posthogChunkIds||{},e._posthogChunkIds[n]="${chunkId}")}catch(e){}}();\n${CODE}\n\n//# chunkId=${chunkId}\n`;
// Line 2, column 0 comes from a dependency; column 9 from line 3 of dohc's own source.
const sourceMap = (chunkId) => JSON.stringify({
  version: 3, chunk_id: chunkId, sources: ["../../node_modules/dep/index.js", "../../src/boom.ts"], names: [], mappings: ";AAAA,SCEA",
});

async function fixture(t, change = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dohc-symbolication-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, "build");
  const archive = join(dir, "Users", SECRET, "dohc", "resources", "app.asar");
  const write = (path, text) => {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    writeFileSync(join(app, path), text);
  };
  write("package.json", JSON.stringify({ name: "dohc", version: "1.2.3", main: "dist/main/main.js" }));
  write("dist/main/main.js", change.mainCode ?? injected(MAIN_CHUNK));
  write("dist/renderer/index.html", '<script type="module" crossorigin src="./assets/index-AbC9.js"></script>');
  write("dist/renderer/assets/index-AbC9.js", injected(RENDERER_CHUNK));
  mkdirSync(dirname(archive), { recursive: true });
  await asar.createPackage(app, archive);
  // The installer leaves source maps out; the build keeps them.
  if (change.mainMap !== null) write("dist/main/main.js.map", change.mainMap ?? sourceMap(MAIN_CHUNK));
  write("dist/renderer/assets/index-AbC9.js.map", sourceMap(RENDERER_CHUNK));
  return { dir, archive, dist: join(app, "dist"), write };
}

function recorder(status) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ status: "Ok" }), { status });
  };
  return { calls, fetch };
}

test("finds a position in dohc's own source in the main and window scripts", async (t) => {
  const { archive, dist } = await fixture(t);
  const targets = probeTargets(archive, dist);
  assert.deepEqual(targets.map(({ part, path, chunkId, releaseId, generated, original }) => ({ part, path, chunkId, releaseId, generated, original })), [
    {
      part: "main", path: "dist/main/main.js", chunkId: MAIN_CHUNK, releaseId: RELEASE,
      generated: { line: 2, column: 10 }, original: { source: "../../src/boom.ts", line: 3, column: 1 },
    },
    {
      part: "renderer", path: "dist/renderer/assets/index-AbC9.js", chunkId: RENDERER_CHUNK, releaseId: RELEASE,
      generated: { line: 2, column: 10 }, original: { source: "../../src/boom.ts", line: 3, column: 1 },
    },
  ]);
});

test("refuses a build whose files or source maps are not the package's", async (t) => {
  const changed = await fixture(t);
  changed.write("dist/main/main.js", injected(MAIN_CHUNK).replace("boom", "bang"));
  assert.throws(() => probeTargets(changed.archive, changed.dist), /dist\/main\/main\.js in app\.asar differs from/);

  const foreign = await fixture(t, { mainMap: sourceMap("ffffffff-7c3a-5e1d-9a2b-3c4d5e6f7a8b") });
  assert.throws(() => probeTargets(foreign.archive, foreign.dist), /belongs to chunk ffffffff-.*, not to 0192f5b8-/);

  const uninjected = await fixture(t, { mainCode: `${CODE}\n` });
  assert.throws(() => probeTargets(uninjected.archive, uninjected.dist), /carries no chunk ID/);

  const missing = await fixture(t, { mainMap: null });
  assert.throws(() => probeTargets(missing.archive, missing.dist), /Cannot read .*main\.js\.map/);

  const dependencyOnly = await fixture(t, { mainMap: sourceMap(MAIN_CHUNK).replace(",SCEA", "") });
  assert.throws(() => probeTargets(dependencyOnly.archive, dependencyOnly.dist), /ties no position/);
});

test("a dry run builds two short reports through dohc's report code and sends nothing", async (t) => {
  const { dir, archive, dist } = await fixture(t);
  const result = await runProbes({ archive, dist, env: {}, fetch: () => assert.fail("A dry run made a request.") });
  assert.equal(result.sent, false);
  assert.equal(result.passed, true);
  assert.deepEqual(result.events.map(({ part, file, generated, expected, problem }) => ({ part, file, generated, expected, problem })), [
    { part: "main", file: "app:///dist/main/main.js", generated: "2:10", expected: "../../src/boom.ts:3:1", problem: null },
    { part: "renderer", file: "app:///dist/renderer/assets/index-AbC9.js", generated: "2:10", expected: "../../src/boom.ts:3:1", problem: null },
  ]);
  for (const [index, { payload, releaseId, eventId }] of result.events.entries()) {
    const [exception] = payload.properties.$exception_list;
    assert.deepEqual(exception.stacktrace.frames, [{
      platform: "node:javascript", filename: `app:///${index === 0 ? "dist/main/main.js" : "dist/renderer/assets/index-AbC9.js"}`,
      function: "?", lineno: 2, colno: 10, in_app: true, chunk_id: index === 0 ? MAIN_CHUNK : RENDERER_CHUNK,
    }]);
    assert.equal(exception.value, "<message withheld>");
    assert.equal(exception.mechanism.handled, false);
    assert.equal(releaseId, RELEASE);
    assert.match(eventId, /^[0-9a-f-]{36}$/);
    assert.equal(payload.properties.channel, LABEL);
    assert.equal(payload.properties.dist, LABEL);
    assert.equal(payload.properties.process, index === 0 ? "main" : "renderer");
    const text = JSON.stringify(payload);
    for (const leaked of [SECRET, dir, JSON.stringify(dir).slice(1, -1), "boom", "src/"]) assert.ok(!text.includes(leaked), leaked);
  }
});

test("passes only when the project accepted both reports", async (t) => {
  const { archive, dist } = await fixture(t);
  const accepted = recorder(200);
  const result = await runProbes({ archive, dist, send: true, env: PROJECT, fetch: accepted.fetch });
  assert.equal(result.passed, true);
  assert.equal(accepted.calls.length, 2);
  for (const call of accepted.calls) assert.ok(call.url.startsWith(`${PROJECT.DOHC_POSTHOG_HOST}/`), call.url);
  assert.deepEqual(result.events.map((event) => [event.status, event.eventId]), accepted.calls.map((call) => [200, call.body.batch[0].uuid]));

  const refused = recorder(500);
  const failed = await runProbes({ archive, dist, send: true, env: PROJECT, fetch: refused.fetch });
  assert.equal(refused.calls.length, 2);
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.events.map((event) => [event.status, event.problem]), [
    [500, "PostHog did not accept the report."],
    [500, "PostHog did not accept the report."],
  ]);
});

test("sends nothing without a project, or when the environment turns reports off", async (t) => {
  const { archive, dist } = await fixture(t);
  const fetch = () => assert.fail("The check made a request.");
  await assert.rejects(runProbes({ archive, dist, send: true, env: {}, fetch }), /Set DOHC_POSTHOG_KEY/);
  await assert.rejects(runProbes({ archive, dist, send: true, env: { ...PROJECT, DO_NOT_TRACK: "1" }, fetch }), /Set DOHC_POSTHOG_KEY/);
  await assert.rejects(runProbes({ archive, dist, env: { DOHC_TELEMETRY: "off" }, fetch }), /turns reports off/);
});
