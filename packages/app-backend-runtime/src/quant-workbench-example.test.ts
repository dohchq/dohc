import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import {
  parseAppDatasetReference,
  parseDatasetDefinition,
  resolveAppDatasetReferenceBinding,
} from "@dohc/security-contract/dataset";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { createDatasetHost } from "./dataset-host.ts";
import { createDatasetJournal } from "./journal.ts";
import { createDatasetSupervisor } from "./supervisor.ts";
import { privateFolder } from "./private-folder.test-helper";
import {
  BULK_CHUNK_BYTES,
  CsvError,
  importObservations,
  parseObservations,
} from "../../../examples/quant-workbench/ingest.ts";
import { peakLag, strength } from "../../../examples/quant-workbench/stats.ts";
import {
  DAY,
  interval,
  type Bar,
  type LagPoint,
  type Snapshot,
} from "../../../examples/quant-workbench/report/model.ts";
import {
  axisFormat,
  formatDelta,
  formatR,
  formatValue,
  niceDomain,
  timeTicks,
} from "../../../examples/quant-workbench/report/format.ts";
import type { Pair } from "../../../examples/quant-workbench/types.ts";

const read = (file: string) =>
  readFileSync(new URL(`../../../examples/quant-workbench/${file}`, import.meta.url), "utf8");
const datasetPath = "quant-workbench/data/dataset.json";
const definition = parseDatasetDefinition(JSON.parse(read("data/dataset.json")), {
  descriptorPath: datasetPath,
});
const schemaSql = read("data/schema.sql");
const operationSource = read("data/operations.js");
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });

const encode = (text: string) => new TextEncoder().encode(text).buffer;
const operationId = (name: string) =>
  definition.operations.find((op) => op.name === name)!.operationId;
const shift = (date: string, days: number) =>
  new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const ids = ["sleep-hours", "resting-hr"];
const view = { start: "2025-01-01", end: "2025-12-31", ids, grain: "day" };
type Commit = { received: number; complete: boolean; inserted: number };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dohc-quant-example-"));
  cleanups.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }),
  );
  const db = new DatabaseSync(join(directory, "host.sqlite"));
  cleanups.push(async () => {
    db.close();
  });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  function transaction<T>(execute: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = execute();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const journal = createDatasetJournal({ db, transaction });
  const supervisor = await createDatasetSupervisor({
    journal,
    directory: privateFolder(join(directory, "workers")),
  });
  cleanups.push(() => supervisor.close());
  const host = createDatasetHost<string | null>({
    db,
    transaction,
    journal,
    supervisor,
    resolveAuthority(grant, request) {
      if (request.workspaceId !== "signalbook") throw new Error("Wrong workspace");
      if (grant && (request.access.kind !== "app" || request.access.appId !== "report"))
        throw new Error("Wrong report binding");
      return grant
        ? {
            principalKey: grant,
            appId: "report",
            caller: { kind: "link", grantId: grant, principalId: grant },
          }
        : { principalKey: "owner", caller: { kind: "owner", userId: "owner" } };
    },
    compileOperations: async (source) => source,
  });
  const scope = { workspaceId: "signalbook", datasetId: definition.datasetId };
  await host.activate(null, {
    workspaceId: scope.workspaceId,
    revision,
    schemaSql,
    operationSource,
  });
  for (const [path, appId] of [
    ["app.publish.json", "owner"],
    ["report/app.publish.json", "report"],
  ]) {
    const manifest = JSON.parse(read(path));
    const reference = parseAppDatasetReference(manifest.dataset);
    expect(reference.datasetPath).toBe(datasetPath);
    const binding = resolveAppDatasetReferenceBinding(reference, definition.datasetId, revision);
    expect(binding.operationIds).toEqual(
      definition.operations
        .filter((op) => op.access === (appId === "owner" ? "owner" : "link"))
        .map((op) => op.operationId),
    );
    host.setBinding(null, { ...scope, appId, binding });
  }
  let sequence = 0;
  async function call<T>(operation: string, input: AppBackendJson = {}, grant?: string) {
    const reply = await host.invoke(grant ?? null, {
      ...scope,
      revision: revision.revision,
      revisionSha256: revision.revisionSha256,
      operationId: operationId(operation),
      input,
      idempotencyKey: `quant-${++sequence}`,
      ...(grant ? { access: { kind: "app", appId: "report" } as const } : {}),
    });
    return reply.result as T;
  }
  return { call };
}

function regression(pairs: Pair[]) {
  const xMean = average(pairs.map((pair) => pair.x));
  const yMean = average(pairs.map((pair) => pair.y));
  const xy = average(pairs.map((pair) => (pair.x - xMean) * (pair.y - yMean)));
  const xx = average(pairs.map((pair) => (pair.x - xMean) ** 2));
  return { slope: xy / xx, intercept: yMean - (xy / xx) * xMean };
}

function pearson(pairs: Pair[]) {
  const x = pairs.map((pair) => pair.x);
  const y = pairs.map((pair) => pair.y);
  const xMean = average(x);
  const yMean = average(y);
  const dx = x.map((value) => value - xMean);
  const dy = y.map((value) => value - yMean);
  return (
    average(dx.map((value, index) => value * dy[index])) /
    Math.sqrt(average(dx.map((value) => value ** 2)) * average(dy.map((value) => value ** 2)))
  );
}

it("imports 23,360 observations and checks rollups, lagged correlation, outliers, and report access through the Collection host", async () => {
  const { call } = await fixture();
  const csv = benchmarkCsv();
  const bytes = encode(csv);
  const { rows } = parseObservations(csv);
  type Inventory = { observations: number; batches: number };
  const imported = await importObservations(
    "sample.csv",
    bytes,
    (chunk) => call<Commit>("importChunk", chunk),
    undefined,
    BULK_CHUNK_BYTES,
  );
  expect(imported).toMatchObject({ total: 23_360, received: 23_360, inserted: 23_360 });
  const duplicate = await importObservations("renamed.csv", bytes, (chunk) =>
    call<Commit>("importChunk", chunk),
  );
  expect(duplicate).toMatchObject({ commits: 1, inserted: 0, received: 23_360 });
  expect(await call<Inventory>("overview")).toMatchObject({
    observations: rows.length,
    batches: 1,
  });

  const daily = new Map<string, Map<string, number[]>>();
  for (const [slug, timestamp, value] of rows) {
    const date = timestamp.slice(0, 10);
    const days = daily.get(slug) ?? new Map<string, number[]>();
    const values = days.get(date) ?? [];
    values.push(value);
    days.set(date, values);
    daily.set(slug, days);
  }

  function checkBar(bar: Bar, values: number[], days: Map<string, number[]>, end: string) {
    expect(bar).toMatchObject({
      count: values.length,
      open: values[0],
      close: values.at(-1),
      low: Math.min(...values),
      high: Math.max(...values),
    });
    expect(bar.mean).toBeCloseTo(average(values), 10);
    expect(bar.total).toBeCloseTo(
      values.reduce((total, value) => total + value, 0),
      8,
    );
    for (const [period, key] of [
      [7, "ma7"],
      [30, "ma30"],
    ] as const) {
      const means = Array.from({ length: period }, (_, i) => days.get(shift(end, -i)))
        .filter((sample) => sample !== undefined)
        .map(average);
      expect(bar[key]).toBeCloseTo(average(means), 10);
    }
  }

  for (const grain of ["day", "week", "month"]) {
    const result = await call<Snapshot>("rollups", { ...view, start: "2025-02-03", grain });
    expect(result.grain).toBe(grain);
    for (const series of result.series) {
      const days = daily.get(series.id)!;
      const bar = series.bars[1];
      const end =
        grain === "day"
          ? bar.bucket
          : grain === "week"
            ? shift(bar.bucket, 6)
            : shift(bar.bucket.slice(0, 7) + "-01", 30);
      const values = [...days]
        .filter(([date]) => date >= bar.bucket && date <= end)
        .flatMap(([, values]) => values);
      checkBar(bar, values, days, end);
    }
  }
  const x = daily.get(ids[0])!;
  const y = daily.get(ids[1])!;
  const independent = (pairs: Pair[]) => {
    const xMean = average(pairs.map((pair) => pair.x));
    const yMean = average(pairs.map((pair) => pair.y));
    const byDay = new Map(pairs.map((pair) => [pair.day, pair]));
    let xx = 0;
    let yy = 0;
    let xa = 0;
    let ya = 0;
    for (const pair of pairs) {
      xx += (pair.x - xMean) ** 2;
      yy += (pair.y - yMean) ** 2;
      const next = byDay.get(shift(pair.day, 1));
      if (next === undefined) continue;
      xa += (pair.x - xMean) * (next.x - xMean);
      ya += (pair.y - yMean) * (next.y - yMean);
    }
    const carried = Math.max(0, Math.min(0.99, (xa / xx) * (ya / yy)));
    expect(carried).toBeGreaterThan(0.1);
    return Math.round(((pairs.length * (1 - carried)) / (1 + carried)) * 10) / 10;
  };
  const profiled = await call<{ profile: LagPoint[] }>("analyze", view);
  expect(profiled.profile.map((point) => point.lag)).toEqual(
    Array.from({ length: 61 }, (_, index) => index - 30),
  );
  for (const lag of [-2, 0, 2]) {
    const expected = [...x].flatMap(([day, values]) => {
      const yDay = shift(day, lag);
      const yValues = y.get(yDay);
      return yValues ? [{ day, y_day: yDay, x: average(values), y: average(yValues) }] : [];
    });
    const score = await call<{
      n: number;
      effective: number;
      r: number;
      line: [[number, number], [number, number]];
      points: Pair[];
    }>("compare", { ...view, lag });
    expect(score.n).toBe(expected.length);
    expect(score.effective).toBeCloseTo(independent(expected), 6);
    expect(score.effective).toBeLessThan(score.n);
    expect(score.r).toBeCloseTo(pearson(expected), 12);
    const line = regression(expected);
    expect(score.points).toHaveLength(Math.min(360, expected.length));
    expect(new Set(score.points.map((point) => point.day)).size).toBe(score.points.length);
    const xs = expected.map((pair) => pair.x);
    const [[xLow, yLow], [xHigh, yHigh]] = score.line;
    expect(xLow).toBeCloseTo(Math.min(...xs), 10);
    expect(xHigh).toBeCloseTo(Math.max(...xs), 10);
    expect(yLow).toBeCloseTo(line.intercept + line.slope * xLow, 8);
    expect(yHigh).toBeCloseTo(line.intercept + line.slope * xHigh, 8);
    const point = profiled.profile.find((entry) => entry.lag === lag)!;
    expect(point.n).toBe(expected.length);
    expect(point.effective).toBeCloseTo(independent(expected), 6);
    expect(point.r).toBeCloseTo(pearson(expected), 10);
    for (const point of score.points) {
      expect(point.y_day).toBe(shift(point.day, lag));
      expect(point.y).toBeCloseTo(average(y.get(point.y_day)!), 10);
    }
  }
  const baselines = ids.map((id) => {
    const means = new Map([...daily.get(id)!].map(([day, values]) => [day, average(values)]));
    const base = new Map<string, number>();
    for (const day of means.keys()) {
      const prior = Array.from({ length: 30 }, (_, back) =>
        means.get(shift(day, -back - 1)),
      ).filter((mean): mean is number => mean !== undefined);
      if (prior.length >= 7) base.set(day, average(prior));
    }
    const residuals = rows.flatMap(([series, at, value]) =>
      series === id && base.has(at.slice(0, 10)) ? [value - base.get(at.slice(0, 10))!] : [],
    );
    const bias = average(residuals);
    return {
      base,
      bias,
      sd: Math.sqrt(average(residuals.map((residual) => (residual - bias) ** 2))),
    };
  });
  const expectedOutliers = rows
    .flatMap(([id, observed_at, value]) => {
      const stats = baselines[ids.indexOf(id)];
      const mean = stats?.base.get(observed_at.slice(0, 10));
      if (!stats || mean === undefined) return [];
      const z = (value - mean - stats.bias) / stats.sd;
      return Math.abs(z) > 2
        ? [{ series_id: id, observed_at, value, z, mean: mean + stats.bias }]
        : [];
    })
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z) || a.observed_at.localeCompare(b.observed_at))
    .slice(0, 31);
  expect(expectedOutliers.length).toBeGreaterThan(0);
  const outliers = await call<typeof expectedOutliers>("outliers", view);
  expect(outliers).toHaveLength(expectedOutliers.length);
  for (const [i, expected] of expectedOutliers.entries()) {
    expect(outliers[i]).toMatchObject({
      series_id: expected.series_id,
      value: expected.value,
      observed_at: expected.observed_at,
    });
    expect(outliers[i].z).toBeCloseTo(expected.z, 10);
    expect(outliers[i].mean).toBeCloseTo(expected.mean, 8);
    expect(Math.sign(outliers[i].value - outliers[i].mean)).toBe(Math.sign(outliers[i].z));
  }

  const analyzed = await call<{
    rollups: Snapshot;
    profile: LagPoint[] | null;
    outliers: typeof expectedOutliers;
  }>("analyze", view);
  expect(analyzed.rollups.grain).toBe("day");
  expect(analyzed.rollups.series.map((series) => series.id)).toEqual(ids);
  expect(analyzed.profile?.find((point) => point.lag === 2)?.n).toBe(363);
  expect(analyzed.outliers).toEqual(outliers);
  const single = await call<typeof analyzed>("analyze", { ...view, ids: [ids[0]] });
  expect(single.profile).toBeNull();
  expect(single.rollups.series.map((series) => series.id)).toEqual([ids[0]]);

  const saved = await call<{ id: string }>("saveNote", {
    ...view,
    lag: 2,
    title: "Sleep and pulse",
    body: "Lagged trend.",
  });
  const privateNote = await call<{ id: string }>("saveNote", {
    ...view,
    title: "Private",
    body: "Never shared",
  });
  await call("setReportLink", { id: saved.id, grant: "report-grant", version: 0 });
  const published = await call(
    "publishedReport",
    { id: privateNote.id, grant: "another-grant", ids: ["close"] },
    "report-grant",
  );
  expect(published).toMatchObject({
    title: "Sleep and pulse",
    body: "Lagged trend.",
    snapshot: {
      grain: "day",
      series: [{ id: ids[0] }, { id: ids[1] }],
      comparison: { lag: 2, n: 363, r: analyzed.profile?.find((point) => point.lag === 2)?.r },
    },
  });
  const { snapshot } = published as { snapshot: { series: Array<{ bars: unknown[] }> } };
  expect(snapshot.series.map((series) => series.bars.length)).toEqual([365, 365]);
  expect(JSON.stringify(snapshot).length).toBeGreaterThan(64 * 1024);
  expect(JSON.stringify(published)).not.toMatch(
    /tags_json|observed_at|import_batch_id|Never shared|grant_id/,
  );
  expect(
    await call("publishedReport", { id: saved.id, grant: "report-grant" }, "another-grant"),
  ).toBeNull();
  for (const operation of definition.operations.filter((entry) => entry.access === "owner")) {
    await expect(call(operation.name, {}, "report-grant")).rejects.toMatchObject({
      code: "not_authorized",
    });
  }
  await call("setReportLink", { id: saved.id, grant: null, version: 1 });
  expect(await call("publishedReport", {}, "report-grant")).toBeNull();
}, 240_000);

it("keeps partial imports hidden, resumes them by checksum, and applies rolling means across missing days", async () => {
  const { call } = await fixture();
  const rows = [
    "series,observed_at,value",
    "sleep,2025-01-01,3",
    ...Array.from({ length: 2047 }, () => "sleep,2025-01-08,6"),
    "sleep,2025-01-09,8",
  ];
  const bytes = encode(rows.join("\n"));
  let committed = 0;
  await expect(
    importObservations("sleep.csv", bytes, async (chunk) => {
      if (committed) throw new Error("Interrupted after commit");
      const result = await call<Commit>("importChunk", chunk);
      committed = result.received;
      expect(result.complete).toBe(false);
      expect(await call("overview")).toMatchObject({ observations: 0, series: [] });
      return result;
    }),
  ).rejects.toThrow("Interrupted after commit");
  expect(await call("seedDemo")).toEqual({ inserted: 365 * 15 });
  expect(await call("overview")).toMatchObject({ observations: 365 * 15, total: 8 });
  const resumed = await importObservations("renamed.csv", bytes, (chunk) =>
    call<Commit>("importChunk", chunk),
  );
  expect(resumed).toMatchObject({ inserted: 2049 - committed, received: 2049 });
  expect(resumed.commits).toBeGreaterThan(1);
  const snapshot = await call<Snapshot>("rollups", {
    ...view,
    start: "2025-01-08",
    end: "2025-01-09",
    ids: ["sleep"],
  });
  expect(snapshot.series[0].bars.map(({ ma7, ma30 }) => [ma7, ma30])).toEqual([
    [6, 4.5],
    [7, 17 / 3],
  ]);
  expect(await call("seedDemo")).toEqual({ inserted: 0 });
  await expect(call("importChunk", { message: "x".repeat(1024 * 1024) })).rejects.toThrow(
    /exceeded its limit of 1048576 bytes/,
  );
}, 30_000);

it("validates a whole CSV before committing and normalizes quoted and offset values", async () => {
  const input =
    'series,observed_at,value,tags_json\r\nresting-hr,2025-02-01T01:02:03+02:00,11,"{""note"":""a,b""}"';
  expect(parseObservations(input).rows).toEqual([
    ["resting-hr", "2025-01-31T23:02:03.000Z", 11, '{"note":"a,b"}'],
  ]);
  let calls = 0;
  await expect(
    importObservations("bad.csv", encode(input + "\r\nresting-hr,2025-02-29,11,{}"), async () => {
      calls++;
      throw new Error("Unexpected commit");
    }),
  ).rejects.toThrow("record 3 has an invalid timestamp");
  expect(calls).toBe(0);
  expect(() => parseObservations(input.replace("resting-hr", "sample-resting-hr"))).toThrow(
    "reserved for sample data",
  );
  expect(() => parseObservations('series,observed_at,value\n"open,2025-01-01,1')).toThrow(CsvError);
  await expect(
    importObservations("latin1.csv", new Uint8Array([0xff, 0xfe, 0x41]).buffer, async () => {
      calls++;
      throw new Error("Unexpected commit");
    }),
  ).rejects.toThrow(CsvError);
  expect(calls).toBe(0);
});

it("refuses a snapshot that a report read could not return", async () => {
  const { call } = await fixture();
  const csv = ["series,observed_at,value"];
  for (let day = 0; day < 400; day++) {
    const date = new Date(Date.UTC(2024, 0, 1 + day)).toISOString().slice(0, 10);
    for (let slot = 0; slot < 4; slot++)
      csv.push(
        `wide-${slot < 2 ? "a" : "b"},${date}T0${slot}:00:00Z,${-(1 + Math.sin(day * 4 + slot) / 3) * 1e99}`,
      );
  }
  await importObservations("wide.csv", encode(csv.join(String.fromCharCode(10))), (chunk) =>
    call<Commit>("importChunk", chunk),
  );
  const note = {
    ids: ["wide-a", "wide-b"],
    grain: "day",
    start: "2024-01-01",
    end: "2025-02-03",
    lag: 0,
    title: "Wide",
  };
  const saved = await call<{ id: string }>("saveNote", { ...note, body: "€".repeat(6000) });
  const read = await call<{ snapshot: { series: Array<{ bars: unknown[] }> } }>("readNote", {
    id: saved.id,
  });
  expect(read.snapshot.series.map((series) => series.bars.length)).toEqual([400, 400]);
  expect(JSON.stringify(read).length).toBeGreaterThan(200 * 1024);
  const escaped = String.fromCharCode(1).repeat(6000);
  await expect(call("saveNote", { ...note, body: escaped })).rejects.toMatchObject({
    refusal: { code: "snapshot_too_large", message: expect.stringMatching(/over the 248 KiB/) },
  });
}, 30_000);

it("keeps older linked notes accessible and reserves the synthetic series at the Collection boundary", async () => {
  const { call } = await fixture();
  type Note = { id: string; grant_id: string | null };
  await expect(
    call("importChunk", {
      sha256: "a".repeat(64),
      filename: "sample.csv",
      total: 1,
      offset: 0,
      metadata: [],
      rows: [["sample-sleep-hours", "2025-01-01T00:00:00.000Z", 7, "{}"]],
    }),
  ).rejects.toMatchObject({ refusal: { code: "sample_series" } });
  expect(await call("seedDemo")).toEqual({ inserted: 5_475 });
  const seeded = await call<{
    series: Array<{ id: string; name: string; unit: string; spark: Array<[number, number]> }>;
    shortcuts: boolean;
  }>("overview");
  expect(seeded.series).toContainEqual(
    expect.objectContaining({ id: "sample-steps", name: "Step count", unit: "steps" }),
  );
  const steps = seeded.series.find((entry) => entry.id === "sample-steps");
  expect(steps?.spark.map(([ago]) => ago)).toEqual(
    Array.from({ length: 30 }, (_, index) => 29 - index),
  );
  expect(seeded.shortcuts).toBe(true);
  await expect(call("setShortcuts", { enabled: "off" })).rejects.toMatchObject({
    refusal: { code: "invalid_setting" },
  });
  await call("setShortcuts", { enabled: false });
  expect(await call("overview")).toMatchObject({ shortcuts: false });
  const bytes = encode("series,observed_at,value\nsleep-hours,2025-01-01,5");
  await importObservations("sleep.csv", bytes, (chunk) => call<Commit>("importChunk", chunk));
  const note = {
    ...view,
    ids: ["sleep-hours"],
    end: view.start,
    title: "Report",
    body: "An observation.",
  };
  const first = await call<Note>("saveNote", note);
  await call("setReportLink", { id: first.id, grant: "older-link", version: 0 });
  for (let index = 0; index < 51; index++) await call("saveNote", note);
  const latest = await call<Note[]>("listNotes", { offset: 0 });
  expect(latest.slice(0, 50).some((item) => item.id === first.id)).toBe(false);
  expect(await call("listNotes", { offset: 50 })).toEqual([
    expect.objectContaining({ grant_id: null }),
    expect.objectContaining({ id: first.id, grant_id: "older-link" }),
  ]);
  expect(await call("readNote", { id: first.id })).toMatchObject({
    grant: "older-link",
    version: 1,
  });
  const withdraw = { id: first.id, grant: null, version: 1 };
  expect(await call("setReportLink", withdraw)).toMatchObject({
    previous: "older-link",
    version: 2,
  });
  expect(await call("readNote", { id: first.id })).toMatchObject({ grant: null, version: 2 });
  const undo = { id: first.id, grant: "older-link", version: 2 };
  await call("setReportLink", { id: first.id, grant: "newer-link", version: 2 });
  await call("setReportLink", { id: first.id, grant: null, version: 3 });
  for (const stale of [undo, { ...withdraw, grant: "older-link" }])
    await expect(call("setReportLink", stale)).rejects.toMatchObject({
      refusal: { code: "link_changed" },
    });
  await expect(call("setReportLink", { id: first.id, grant: null })).rejects.toMatchObject({
    refusal: { code: "invalid_report" },
  });
  const relink = { id: first.id, grant: "newer-link", version: 4 };
  expect(await call("setReportLink", relink)).toMatchObject({ previous: null, version: 5 });
  expect(await call("setReportLink", relink)).toMatchObject({
    previous: "newer-link",
    version: 5,
  });
  expect(await call("publishedReport", {}, "newer-link")).toMatchObject({ title: "Report" });
  expect(await call("publishedReport", {}, "older-link")).toBeNull();
}, 30_000);
it("pages a large catalog under the result budget, searches it, and keeps plotted series in the page", async () => {
  const { call } = await fixture();
  type Catalog = {
    series: Array<{ id: string; name: string; latest: number; spark: Array<[number, number]> }>;
    total: number;
    matches: number;
  };
  const records = ["series,observed_at,value,name,unit,domain"];
  for (let index = 0; index < 130; index++) {
    const slug = `metric-${String(index).padStart(3, "0")}`;
    const name = "測".repeat(76) + String(index).padStart(4, "0");
    for (let day = 0; day < 30; day++) {
      const date = new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10);
      records.push(
        `${slug},${date},${(123_456.789_012 + index + day / 7).toFixed(6)},${name},unit,${"領".repeat(32)}`,
      );
    }
  }
  await importObservations("wide.csv", encode(records.join("\n")), (chunk) =>
    call<Commit>("importChunk", chunk),
  );
  const page = await call<Catalog>("overview", { query: "", include: [] });
  expect(page).toMatchObject({ total: 130, matches: 130, shown: 100 });
  const pinned = await call<Catalog>("overview", {
    query: "metric-1",
    include: ["metric-000", "metric-001"],
  });
  expect(pinned).toMatchObject({ matches: 30, shown: 30 });
  expect(pinned.series).toHaveLength(32);
  expect(page.series).toHaveLength(100);
  expect(page.series.every((entry) => entry.spark.length === 30)).toBe(true);
  const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
  expect(bytes).toBeGreaterThan(64 * 1024);
  expect(bytes).toBeLessThan(128 * 1024);
  const found = await call<Catalog>("overview", { query: "METRIC-12", include: ["metric-001"] });
  expect(found).toMatchObject({ total: 130, matches: 10, shown: 10 });
  expect(found.series.map((entry) => entry.id)).toEqual([
    "metric-001",
    ...Array.from({ length: 10 }, (_, index) => `metric-${120 + index}`),
  ]);
  const kept = await call<Catalog>("overview", {
    query: "",
    include: ["metric-129", "metric-128"],
  });
  expect(kept.series.map((entry) => entry.id)).toContain("metric-129");
  expect(kept.series).toHaveLength(100);
  expect(kept.series.find((entry) => entry.id === "metric-129")?.latest).toBeCloseTo(
    123_456.789_012 + 129 + 29 / 7,
    5,
  );
  await expect(call("overview", { query: "", include: ["a", "b", "c"] })).rejects.toMatchObject({
    refusal: { code: "invalid_filter" },
  });
}, 60_000);

it("flags a reversal in a steady trend as a large negative z instead of the trend's own ends", async () => {
  const { call } = await fixture();
  const records = ["series,observed_at,value"];
  for (let day = 0; day < 90; day++) {
    const date = new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10);
    records.push(`trend,${date}T08:00:00Z,${day === 89 ? 2 * day - 40 : 2 * day}`);
  }
  await importObservations("trend.csv", encode(records.join("\n")), (chunk) =>
    call<Commit>("importChunk", chunk),
  );
  const flagged = await call<Array<{ observed_at: string; z: number }>>("outliers", {
    start: "2025-02-01",
    end: "2025-03-31",
    ids: ["trend"],
  });
  expect(flagged).toHaveLength(1);
  expect(flagged[0].observed_at).toBe("2025-03-31T08:00:00.000Z");
  expect(flagged[0].z).toBeLessThan(-7);
  const opening = await call<Array<{ observed_at: string }>>("outliers", {
    start: "2025-01-01",
    end: "2025-03-31",
    ids: ["trend"],
  });
  expect(opening.map((row) => row.observed_at).sort()[0]).toBe("2025-01-08T08:00:00.000Z");
}, 30_000);

it("withholds the persistence-adjusted interval when the paired days are rarely consecutive", async () => {
  const { call } = await fixture();
  const records = ["series,observed_at,value"];
  for (let week = 0; week < 60; week++) {
    const date = new Date(Date.UTC(2024, 0, 1 + week * 7)).toISOString().slice(0, 10);
    records.push(`weight,${date},${70 + Math.sin(week) * 2}`, `waist,${date},${80 + week / 10}`);
  }
  await importObservations("weekly.csv", encode(records.join("\n")), (chunk) =>
    call<Commit>("importChunk", chunk),
  );
  const input = {
    start: "2024-01-01",
    end: "2025-03-31",
    ids: ["weight", "waist"],
    grain: "week",
  };
  const score = await call<{ n: number; effective: number | null; r: number | null }>("compare", {
    ...input,
    lag: 0,
  });
  expect(score.n).toBe(60);
  expect(score.r).not.toBeNull();
  expect(score.effective).toBeNull();
  expect(strength(score.r, score.n, score.effective).label).toBe("Too few consecutive days");
  const { profile } = await call<{ profile: LagPoint[] }>("analyze", { ...input, lag: 0 });
  expect(profile.find((point) => point.lag === 7)).toMatchObject({ n: 59, effective: null });
  const staggered = ["series,observed_at,value"];
  for (let k = 1; k <= 40; k++) {
    const day = (offset: number) =>
      new Date(Date.UTC(2023, 0, 1 + 3 * k + offset)).toISOString().slice(0, 10);
    staggered.push(`mood,${day(0)},${k % 7}`, `mood,${day(1)},${k % 5}`);
    staggered.push(`focus,${day(-1)},${k % 3}`, `focus,${day(0)},${k % 4}`);
  }
  await importObservations("staggered.csv", encode(staggered.join("\n")), (chunk) =>
    call<Commit>("importChunk", chunk),
  );
  const sparse = await call<{ n: number; effective: number | null }>("compare", {
    start: "2023-01-01",
    end: "2023-12-31",
    ids: ["mood", "focus"],
    grain: "day",
    lag: 0,
  });
  expect(sparse).toMatchObject({ n: 40, effective: null });
  const unpaired = ["series,observed_at,value"];
  for (let day = 0; day < 220; day++) {
    const date = new Date(Date.UTC(2022, 0, 1 + day)).toISOString().slice(0, 10);
    if (day < 40) unpaired.push(`drift,${date},${day + Math.sin(day)}`, `load,${date},${day / 2}`);
    else unpaired.push(`drift,${date},${day % 2 ? 90 : -90}`);
  }
  await importObservations("unpaired.csv", encode(unpaired.join("\n")), (chunk) =>
    call<Commit>("importChunk", chunk),
  );
  const paired = { ids: ["drift", "load"], grain: "day", lag: 0, start: "2022-01-01" };
  const trimmed = await call<{ n: number; effective: number | null }>("compare", {
    ...paired,
    end: "2022-02-09",
  });
  const padded = await call<{ n: number; effective: number | null }>("compare", {
    ...paired,
    end: "2022-08-08",
  });
  expect(trimmed.n).toBe(40);
  expect(trimmed.effective).not.toBeNull();
  expect(trimmed.effective).toBeLessThan(10);
  expect(padded).toMatchObject(trimmed);
  const { profile: padding } = await call<{ profile: LagPoint[] }>("analyze", {
    ...paired,
    end: "2022-08-08",
  });
  expect(padding.find((point) => point.lag === 0)?.effective).toBe(trimmed.effective);
  const few = { ...paired, end: "2022-01-09" };
  expect(await call<{ n: number; r: number | null; line: null }>("compare", few)).toMatchObject({
    n: 9,
    r: null,
    line: null,
  });
  const { profile: thin } = await call<{ profile: LagPoint[] }>("analyze", few);
  expect(thin.find((point) => point.lag === 0)).toMatchObject({ n: 9, r: null });
  const flat = ["series,observed_at,value", "lonely,2021-01-07T12:00:00Z,5"];
  for (let day = 0; day < 120; day++) {
    const date = new Date(Date.UTC(2021, 0, 1 + day)).toISOString().slice(0, 10);
    flat.push(`wave,${date}T12:00:00Z,${Math.sin(day)}`);
    if (day < 14) flat.push(`balance,${date}T12:00:00Z,${day < 7 ? "1000000.01" : "1000000.04"}`);
    flat.push(`large,${date}T12:00:00Z,${day === 119 ? 1e12 + 100 : 1e12}`);
    flat.push(`drop,${date}T12:00:00Z,${day === 10 ? 300 : 0}`);
    if (day < 31)
      flat.push(
        `jump,${date}T12:00:00Z,${day === 30 ? 30 : 1}`,
        `tiny-jump,${date}T12:00:00Z,${(day === 30 ? 30 : 1) * 1e-170}`,
        `offset-x,${date}T12:00:00Z,${1e12 + (day % 5) / 8}`,
        `offset-y,${date}T12:00:00Z,${day % 5}`,
        `rise-a,${date}T12:00:00Z,${day + 3 * Math.sin(day)}`,
        `rise-b,${date}T12:00:00Z,${2 * day + 5 * Math.cos(day * 3)}`,
        `steep-a,${date}T12:00:00Z,${100 * day + (day % 2 ? -1 : 1)}`,
        `steep-b,${date}T12:00:00Z,${200 * day - (day % 2 ? -1 : 1)}`,
      );
    if (day < 20)
      flat.push(
        `tiny-a,${date}T12:00:00Z,${((day % 7) + 1) * 1e-170}`,
        `tiny-b,${date}T12:00:00Z,${((day % 7) + 1) * 2e-170}`,
        `huge,${date}T12:00:00Z,${-((day % 7) + 1) * 1e99}`,
        `micro,${date}T12:00:00Z,${((day % 7) + 1) * 1e-221}`,
        `macro,${date}T12:00:00Z,${((day % 7) + 1) * 1e98}`,
      );
    if (day < 12 && day !== 7)
      flat.push(
        `line-a,${date}T12:00:00Z,${1e14 + 10 * day}`,
        `line-b,${date}T12:00:00Z,${2 * (1e14 + 10 * day)}`,
      );
    for (let slot = 0; slot <= day % 3; slot++)
      flat.push(`flat-a,${date}T0${slot}:00:00Z,0.1`, `flat-b,${date}T0${slot}:00:00Z,0.2`);
  }
  await importObservations("flat.csv", encode(flat.join(String.fromCharCode(10))), (chunk) =>
    call<Commit>("importChunk", chunk),
  );
  const level = {
    ids: ["flat-a", "flat-b"],
    grain: "day",
    start: "2021-01-01",
    end: "2021-04-30",
  };
  expect(await call("compare", { ...level, lag: 0 })).toMatchObject({ r: null, line: null });
  for (const ids of [
    ["wave", "flat-b"],
    ["flat-a", "wave"],
  ])
    expect(await call("compare", { ...level, ids, lag: 0 })).toMatchObject({
      n: 120,
      r: null,
      line: null,
    });
  expect(await call("outliers", { ...level, ids: ["flat-a"] })).toEqual([]);
  const [plain] = await call<Array<{ z: number }>>("outliers", { ...level, ids: ["jump"] });
  const [scaledJump] = await call<Array<{ z: number }>>("outliers", {
    ...level,
    ids: ["tiny-jump"],
  });
  expect(plain.z).toBeGreaterThan(4);
  expect(scaledJump.z).toBeCloseTo(plain.z, 9);
  expect(
    await call("outliers", { ...level, ids: ["drop"], start: "2021-02-10", end: "2021-03-02" }),
  ).toEqual([
    expect.objectContaining({ observed_at: "2021-02-10T12:00:00.000Z", z: expect.any(Number) }),
  ]);
  type Detrended = { n: number; r: number; detrended: number | null };
  const offset = await call<Detrended>("compare", {
    ...level,
    ids: ["offset-x", "offset-y"],
    lag: 0,
  });
  expect(offset).toMatchObject({ detrended: null });
  expect(offset.r).toBeCloseTo(1, 6);
  const days = Array.from({ length: 31 }, (_, day) => day);
  const residual = (values: number[]) => {
    const line = regression(days.map((day) => ({ day: "", y_day: "", x: day, y: values[day] })));
    return values.map((value, day) => value - line.intercept - line.slope * day);
  };
  const riseA = residual(days.map((day) => day + 3 * Math.sin(day)));
  const riseB = residual(days.map((day) => 2 * day + 5 * Math.cos(day * 3)));
  const rise = await call<Detrended>("compare", { ...level, ids: ["rise-a", "rise-b"], lag: 0 });
  expect(rise.n).toBe(31);
  expect(rise.r).toBeGreaterThan(0.9);
  expect(rise.detrended).toBeCloseTo(
    pearson(days.map((day) => ({ day: "", y_day: "", x: riseA[day], y: riseB[day] }))),
    9,
  );
  expect(Math.abs(rise.detrended!)).toBeLessThan(0.5);
  const steep = await call<Detrended>("compare", { ...level, ids: ["steep-a", "steep-b"], lag: 0 });
  expect(steep.r).toBeGreaterThan(0.999);
  expect(steep.detrended).toBeCloseTo(-1, 6);
  const straight = await call<Detrended>("compare", {
    ...level,
    ids: ["line-a", "line-b"],
    lag: 0,
  });
  expect(straight).toMatchObject({ n: 11, detrended: null });
  expect(straight.r).toBeCloseTo(1, 9);
  expect(await call("compare", { ...level, ids: ["rise-a", "offset-y"], lag: 0 })).toMatchObject({
    n: 31,
    detrended: null,
  });
  for (const [ids, r, low, high] of [
    [["tiny-a", "tiny-b"], 1, 2e-170, 14e-170],
    [["tiny-a", "huge"], -1, -1e99, -7e99],
    [["micro", "macro"], 1, 1e98, 7e98],
  ] as const) {
    const scaled = await call<{
      n: number;
      r: number;
      line: [[number, number], [number, number]];
    }>("compare", { ...level, ids: [...ids], lag: 0 });
    expect(scaled.n).toBe(20);
    expect(scaled.r).toBeCloseTo(r, 9);
    expect(scaled.line[0][1] / low).toBeCloseTo(1, 9);
    expect(scaled.line[1][1] / high).toBeCloseTo(1, 9);
    const { profile: scaledProfile } = await call<{ profile: LagPoint[] }>("analyze", {
      ...level,
      ids: [...ids],
      lag: 0,
    });
    expect(scaledProfile.find((point) => point.lag === 0)?.r).toBeCloseTo(r, 9);
  }
  const { series: listed } = await call<{
    series: Array<{ id: string; spark: Array<[number, number]> }>;
  }>("overview");
  const balance = listed.find((entry) => entry.id === "balance")!.spark;
  expect(balance.at(-1)![1] - balance[0][1]).toBeCloseTo(0.03, 6);
  const [jump, ...rest] = await call<Array<{ observed_at: string; z: number }>>("outliers", {
    ...level,
    ids: ["large"],
    start: "2021-04-01",
  });
  expect(rest).toEqual([]);
  expect(jump.observed_at).toBe("2021-04-30T12:00:00.000Z");
  expect(jump.z).toBeCloseTo(Math.sqrt(29), 6);
  const { profile: levels } = await call<{ profile: LagPoint[] }>("analyze", {
    ...level,
    lag: 0,
  });
  expect(levels.every((point) => point.r === null)).toBe(true);
  const oneDay = await call<{ id: string }>("saveNote", {
    ids: ["drift"],
    grain: "day",
    lag: 0,
    start: "2022-01-20",
    end: "2022-01-20",
    title: "One day",
    body: "Only this day.",
  });
  const kept = await call<{ snapshot: Saved }>("readNote", { id: oneDay.id });
  const [bar] = kept.snapshot.series[0].bars;
  expect(bar).toMatchObject({ ma7: null, ma30: null });
  expect(kept.snapshot.changes).toEqual([null]);
  const single = await call<{ id: string }>("saveNote", {
    ids: ["lonely"],
    grain: "day",
    lag: 0,
    start: "2021-01-01",
    end: "2021-01-20",
    title: "One reading",
    body: "One reading in twenty days.",
  });
  const lone = await call<{ snapshot: Saved }>("readNote", { id: single.id });
  expect(lone.snapshot.changes).toEqual([null]);
  const month = await call<{ id: string }>("saveNote", {
    ids: ["drift"],
    grain: "day",
    lag: 0,
    start: "2022-01-01",
    end: "2022-02-09",
    title: "Forty days",
    body: "Only these days.",
  });
  const { snapshot: forty } = await call<{ snapshot: Saved }>("readNote", { id: month.id });
  const bars = forty.series[0].bars;
  expect(bars.findIndex((entry) => entry.ma7 !== null)).toBe(6);
  expect(bars.findIndex((entry) => entry.ma30 !== null)).toBe(29);
  expect(bars[6].ma7).toBeCloseTo(average(bars.slice(0, 7).map((entry) => entry.mean)), 10);
  expect(bars.at(-1)?.bucket).toBe("2022-02-09");
  const daily = { first: bars[6].ma7, last: bars.at(-1)?.ma7 };
  expect(forty.changes[0]?.first).toBeCloseTo(daily.first!, 10);
  expect(forty.changes[0]?.last).toBeCloseTo(daily.last!, 10);
  const monthly = await call<{ id: string }>("saveNote", {
    ids: ["drift"],
    grain: "month",
    lag: 0,
    start: "2022-01-01",
    end: "2022-02-09",
    title: "Forty days by month",
    body: "Same days, monthly buckets.",
  });
  const { snapshot: buckets } = await call<{ snapshot: Saved }>("readNote", { id: monthly.id });
  expect(buckets.grain).toBe("month");
  expect(buckets.changes).toEqual(forty.changes);
}, 30_000);

type Saved = {
  grain: string;
  series: Array<{ bars: Bar[] }>;
  changes: Array<{ first: number; last: number } | null>;
};

function benchmarkCsv() {
  const catalog = [
    ["sleep-hours", "Sleep duration", "h", "Sample health"],
    ["resting-hr", "Resting heart rate", "bpm", "Sample health"],
    ["steps", "Step count", "steps", "Sample health"],
    ["hrv", "Heart rate variability", "ms", "Sample health"],
    ["training-load", "Training load", "AU", "Sample health"],
    ["close", "Portfolio value", "USD", "Sample portfolio"],
    ["volume", "Trading volume", "shares", "Sample portfolio"],
    ["daily-return", "Daily return", "%", "Sample portfolio"],
  ];
  const records = ["series,observed_at,value,name,unit,domain,tags_json"];
  const sleep = (day: number) => 7.2 + 0.58 * Math.sin(day / 11) + 0.42 * Math.sin(day * 1.3);
  for (let day = 0; day < 365; day++) {
    const date = new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10);
    for (let slot = 0; slot < 8; slot++) {
      const stamp = date + "T" + String(slot * 3).padStart(2, "0") + ":00:00Z";
      const noise = Math.sin(day * 74.97 + slot * 6.6);
      const pulse = day % 89 === 0 && slot === 6 ? 1 : 0;
      const values = [
        sleep(day) + 0.14 * noise - pulse * 2,
        62 - 4 * (sleep(day - 2) - 7.2) + 1.9 * Math.cos(day / 6) + 0.6 * noise + pulse * 12,
        7800 + 1700 * Math.sin(day / 8) + 1800 * noise + pulse * 9000,
        54 + 7 * (sleep(day) - 7.2) + 6 * Math.sin(day / 21) + 3 * noise,
        58 + 26 * Math.sin(day / 6) + 15 * noise + pulse * 65,
        24_000 + 18 * day + 870 * Math.sin(day / 14) + 180 * noise,
        340 + 110 * Math.sin(day / 13) + 75 * noise + pulse * 500,
        0.12 + 0.9 * Math.sin(day / 14 + 1.57) + 0.25 * noise,
      ];
      for (const [index, [slug, name, unit, domain]] of catalog.entries()) {
        records.push(
          `${slug},${stamp},${values[index].toFixed(4)},${name},${unit},${domain},"{""source"":""demo""}"`,
        );
      }
    }
  }
  return records.join("\n");
}

it("picks the lag peak only from lags with enough paired days", () => {
  const profile: LagPoint[] = [
    { lag: -25, n: 2, r: 1 },
    { lag: -3, n: 9, r: -0.95 },
    { lag: 0, n: 27, r: 0.41 },
    { lag: 2, n: 25, r: -0.59 },
    { lag: 12, n: 15, r: -0.62 },
    { lag: 14, n: 13, r: 0.9 },
  ].map((point) => ({ ...point, effective: point.n }));
  expect(peakLag(profile)).toMatchObject({ lag: 2, n: 25, r: -0.59 });
  expect(peakLag(profile.filter((point) => point.n < 20))).toMatchObject({
    lag: 14,
    n: 13,
    r: 0.9,
  });
  expect(peakLag(profile.map((point) => ({ ...point, n: Math.min(point.n, 9) })))).toBeNull();
});

it("labels a correlation by size only when its 95% interval excludes zero", () => {
  const [low, high] = interval(-0.7, 90)!;
  expect(low).toBeCloseTo(-0.792, 3);
  expect(high).toBeCloseTo(-0.576, 3);
  expect(interval(0.5, 3)).toBeNull();
  expect(strength(-0.7, 90, 90).label).toBe("Strong negative");
  expect(strength(0.85, 40, 40).label).toBe("Strong positive");
  expect(strength(0.95, 200, 200).label).toBe("Very strong positive");
  expect(strength(0.5, 40, 40).label).toBe("Weak positive");
  expect(strength(0.3, 20, 20).label).toBe("No clear correlation");
  expect(strength(0.25, 120, 120).label).toBe("Weak positive");
  expect(strength(0.25, 120, 20).label).toBe("No clear correlation");
  expect(strength(0.05, 4000, 4000).label).toBe("Little linear correlation");
  expect(strength(0.05, 400, 400).label).toBe("No clear correlation");
  expect(strength(0.9, 9, 9).label).toBe("Too few pairs");
  expect(strength(null, 40, 40).label).toBe("One series is constant");
  expect(strength(1, 30, 3.1).label).toBe("Too few independent days");
  const edge = Math.tanh(1.96 / Math.sqrt(97));
  expect(interval(edge, 100)![0]).toBeCloseTo(0, 12);
  expect(strength(edge, 100, 100).label).toBe("No clear correlation");
});

it("gives narrow charts three or four date ticks across short and long ranges", () => {
  const at = (date: string) => Date.parse(date + "T00:00:00Z");
  for (const [start, end] of [
    ["2025-10-27", "2025-11-28"],
    ["2025-07-01", "2025-12-31"],
    ["2025-01-01", "2025-12-31"],
    ["2025-10-02", "2025-12-31"],
    ["2024-01-01", "2025-12-31"],
  ]) {
    const { ticks } = timeTicks(at(start), at(end), 3);
    expect(ticks.length, `${start} to ${end}`).toBeGreaterThanOrEqual(3);
    expect(ticks.length, `${start} to ${end}`).toBeLessThanOrEqual(5);
  }
  expect(timeTicks(at("1990-01-01"), at("2025-12-31"), 3).ticks.length).toBeLessThanOrEqual(4);
  expect(timeTicks(at("1990-01-01"), at("2025-12-31"), 3).ticks.length).toBeGreaterThanOrEqual(3);
  expect(timeTicks(at("2025-01-01"), at("2025-12-31"), 11)).toMatchObject({ months: true });
  expect(timeTicks(at("2025-01-01"), at("2025-12-31"), 11).ticks).toHaveLength(12);
  expect(niceDomain([57, 74], 7).ticks).toEqual([57.5, 60, 62.5, 65, 67.5, 70, 72.5, 75]);
  expect(niceDomain([1000, 1000.0000000000001]).ticks.length).toBeGreaterThan(1);
  const returns = [0.0011, 0.0018, 0.0024, 0.003];
  expect(returns.map((value) => formatValue(value))).toEqual([
    "0.0011",
    "0.0018",
    "0.0024",
    "0.0030",
  ]);
  const returnAxis = niceDomain(returns);
  const axis = returnAxis.ticks.map(axisFormat(returnAxis).tick);
  expect(new Set(axis).size).toBe(axis.length);
  for (const [values, unit] of [
    [[1_000_000.01, 1_000_000.04], "USD"],
    [[62.0501, 62.054], "bpm"],
    [[29_012.5, 31_315.55], "USD"],
    [[1e12, 1e12 + 10], ""],
    [[1e-8, 2e-8], ""],
    [[1e-22, 2e-22], ""],
    [[1e15, 1e15 + 1e5], ""],
    [[1e15, 1e15 + 1100], ""],
    [[1, 1 + 1e-10], ""],
  ] as const) {
    const scale = niceDomain([...values]);
    const format = axisFormat(scale, unit);
    expect(new Set(scale.ticks).size).toBe(scale.ticks.length);
    expect(new Set(scale.ticks.map(format.tick)).size).toBe(scale.ticks.length);
    expect(new Set(values.map(format.tag)).size).toBe(values.length);
  }
  const tiny = niceDomain([1e-8, 2e-8]);
  expect(tiny.ticks.map(axisFormat(tiny).tick)).toContain("1.50e−8");
  expect([1e-9, 1.5e-9, -2e-9].map((value) => formatValue(value))).toEqual([
    "1.00e−9",
    "1.50e−9",
    "−2.00e−9",
  ]);
  expect(formatValue(0.0000001)).toBe("0.00000010");
  expect(formatValue(1e-9, "", 0.5)).toBe("1.00e−9");
  expect(formatValue(7e-15, "", 59)).toBe("0.00");
  expect(formatValue(1e-9, "", 0)).toBe("1.00e−9");
  expect(formatValue(0.0005, "", 0)).toBe("0.00050");
  const large = niceDomain([1e12, 1e12 + 10]);
  expect(large.ticks.map(axisFormat(large).tick)).toContain("1,000,000,000,005.0");
  const balance = niceDomain([1_000_000.01, 1_000_000.04]);
  expect(axisFormat(balance, "USD").tag(1_000_000.04)).toBe("$1,000,000.04");
  const portfolio = niceDomain([29_012.5, 31_315.55]);
  expect(portfolio.ticks.map(axisFormat(portfolio, "USD").tick)).toContain("$30.0k");
  expect(axisFormat(portfolio, "USD").tag(31_315.55)).toBe("$31.32k");
  expect(formatR(0.003)).toBe("0.00");
  expect(formatR(-0.001)).toBe("0.00");
  expect(formatValue(7.25)).toBe("7.25");
  const macro = niceDomain([1e98, 7e98]);
  const macroTicks = macro.ticks.map(axisFormat(macro).tick);
  expect(new Set(macroTicks).size).toBe(macro.ticks.length);
  expect(Math.max(...macroTicks.map((tick) => tick.length))).toBeLessThan(10);
  expect(formatValue(7e98)).toBe("7.00e+98");
  expect(formatDelta(7e98, "", 100)).toBe("+7.00e+98");
  expect(formatValue(-2e15, "USD")).toBe("−$2.00e+15");
});

it("formats dollar values beyond whole-cent precision instead of throwing", () => {
  expect(formatValue(31_315.55, "USD")).toBe("$31,315.55");
  expect(formatValue(1e14, "USD")).toBe("$100T");
  expect(formatValue(-1e14, "USD")).toBe("−$100T");
});
