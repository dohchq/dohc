import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { describeDatasetRevision } from "../../packages/security-contract/src/datasetArtifacts.ts";
import {
  parseAppDatasetReference,
  parseDatasetDefinition,
  resolveAppDatasetReferenceBinding,
} from "../../packages/security-contract/src/dataset.ts";
import type { AppBackendJson } from "../../packages/security-contract/src/appBackend.ts";
import { createDatasetHost } from "../../packages/app-backend-runtime/src/dataset-host.ts";
import { createDatasetJournal } from "../../packages/app-backend-runtime/src/journal.ts";
import { createDatasetSupervisor } from "../../packages/app-backend-runtime/src/supervisor.ts";
import type { Bar, Pair, Snapshot } from "./charts";
import { importObservations, parseObservations } from "./ingest.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const schemaSql = read("./data/schema.sql");
const operationSource = read("./data/operations.js");
const datasetPath = "quant-workbench/data/dataset.json";
const definition = parseDatasetDefinition(JSON.parse(read("./data/dataset.json")), {
  descriptorPath: datasetPath,
});
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
const encode = (text: string) => new TextEncoder().encode(text).buffer;
const operationId = (name: string) =>
  definition.operations.find((op) => op.name === name)!.operationId;
const DAY = 86_400_000;
const shift = (date: string, days: number) =>
  new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const ids = ["sleep-hours", "resting-hr"];
const view = { start: "2025-01-01", end: "2025-12-31", ids, grain: "day" };
type Commit = { received: number; complete: boolean; inserted: number };

async function withHost(
  run: (fixture: {
    call: <T>(operation: string, input?: AppBackendJson, grant?: string) => Promise<T>;
    size: () => Promise<number>;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "signalbook-test-"));
  const workers = join(directory, "workers");
  await mkdir(workers);
  const db = new DatabaseSync(join(directory, "journal.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
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
  const supervisor = await createDatasetSupervisor({ journal, directory: async () => workers });
  try {
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
      const manifest = JSON.parse(read("./" + path));
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
      const result = await host.invoke(grant ?? null, {
        ...scope,
        revision: revision.revision,
        revisionSha256: revision.revisionSha256,
        operationId: operationId(operation),
        input,
        idempotencyKey: `operation-${++sequence}`,
        ...(grant ? { access: { kind: "app", appId: "report" } as const } : {}),
      });
      return result.result as T;
    }
    await run({
      call,
      async size() {
        const paths = (await readdir(workers, { recursive: true })).filter((file) =>
          /(?:^|[\\/])app\.sqlite$/.test(file),
        );
        expect(paths).toHaveLength(1);
        return (await stat(join(workers, paths[0]))).size;
      },
    });
  } finally {
    await supervisor.close();
    db.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
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
  await withHost(async ({ call, size }) => {
    const csv = benchmarkCsv();
    const bytes = encode(csv);
    const { rows } = parseObservations(csv);
    type Inventory = { observations: number; batches: number };
    const imported = await importObservations("sample.csv", bytes, (chunk) =>
      call<Commit>("importChunk", chunk),
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
    const sqliteBytes = await size();

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
    for (const lag of [-2, 0, 2]) {
      const expected = [...x].flatMap(([day, values]) => {
        const yDay = shift(day, lag);
        const yValues = y.get(yDay);
        return yValues ? [{ day, y_day: yDay, x: average(values), y: average(yValues) }] : [];
      });
      const score = await call<{ n: number; r: number; rSquared: number; points: Pair[] }>(
        "compare",
        { ...view, lag },
      );
      expect(score.n).toBe(expected.length);
      expect(score.r).toBeCloseTo(pearson(expected), 12);
      expect(score.rSquared).toBeCloseTo(pearson(expected) ** 2, 12);
      for (const point of score.points) {
        expect(point.y_day).toBe(shift(point.day, lag));
        expect(point.y).toBeCloseTo(average(y.get(point.y_day)!), 10);
      }
    }
    const deviations = ids.map((id) => {
      const values = [...daily.get(id)!.values()].flat();
      const mean = average(values);
      return { mean, sd: Math.sqrt(average(values.map((value) => (value - mean) ** 2))) };
    });
    const expectedOutliers = rows
      .flatMap(([id, observed_at, value]) => {
        const stats = deviations[ids.indexOf(id)];
        if (!stats) return [];
        const z = (value - stats.mean) / stats.sd;
        return Math.abs(z) > 2 ? [{ series_id: id, observed_at, value, z }] : [];
      })
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z) || a.observed_at.localeCompare(b.observed_at))
      .slice(0, 30);
    const outliers = await call<typeof expectedOutliers>("outliers", view);
    expect(outliers).toHaveLength(expectedOutliers.length);
    for (const [i, expected] of expectedOutliers.entries()) {
      expect(outliers[i]).toMatchObject({
        series_id: expected.series_id,
        value: expected.value,
        observed_at: expected.observed_at,
      });
      expect(outliers[i].z).toBeCloseTo(expected.z, 12);
    }

    const analyzed = await call<{
      rollups: Snapshot;
      comparison: { n: number; r: number; rSquared: number; points: Pair[] } | null;
      outliers: typeof expectedOutliers;
    }>("analyze", { ...view, lag: 2 });
    expect(analyzed.rollups.grain).toBe("day");
    expect(analyzed.rollups.series.map((series) => series.id)).toEqual(ids);
    expect(analyzed.comparison?.n).toBe(363);
    expect(analyzed.outliers).toEqual(outliers);
    const single = await call<typeof analyzed>("analyze", { ...view, ids: [ids[0]], lag: 2 });
    expect(single.comparison).toBeNull();
    expect(single.rollups.series.map((series) => series.id)).toEqual([ids[0]]);

    const saved = await call<{ id: string }>("saveNote", {
      ...view,
      title: "Sleep and pulse",
      body: "Lagged trend.",
    });
    const privateNote = await call<{ id: string }>("saveNote", {
      ...view,
      title: "Private",
      body: "Never shared",
    });
    await call("setReportLink", { id: saved.id, grant: "report-grant" });
    const published = await call(
      "publishedReport",
      { id: privateNote.id, grant: "another-grant", ids: ["close"] },
      "report-grant",
    );
    expect(published).toMatchObject({
      title: "Sleep and pulse",
      body: "Lagged trend.",
      snapshot: { series: [{ id: ids[0] }, { id: ids[1] }] },
    });
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
    await call("setReportLink", { id: saved.id, grant: null });
    expect(await call("publishedReport", {}, "report-grant")).toBeNull();

    const queryMs: Record<string, { p50: number; p95: number; resultBytes: number }> = {};
    for (const operation of ["rollups", "compare", "outliers", "analyze"]) {
      const samples: number[] = [];
      let result: unknown;
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        result = await call(operation, view);
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      queryMs[operation] = {
        p50: samples[9],
        p95: samples[18],
        resultBytes: Buffer.byteLength(JSON.stringify(result)),
      };
    }
    console.log(
      JSON.stringify({
        csvBytes: bytes.byteLength,
        sqliteBytes,
        imported,
        rowsPerSecond: (imported.inserted * 1000) / imported.elapsedMs,
        duplicate,
        queryMs,
      }),
    );
  });
}, 120_000);

it("keeps partial imports hidden, resumes them by checksum, and applies rolling means across missing days", async () => {
  await withHost(async ({ call }) => {
    const rows = [
      "series,observed_at,value",
      "sleep,2025-01-01,3",
      ...Array.from({ length: 511 }, () => "sleep,2025-01-08,6"),
      "sleep,2025-01-09,8",
    ];
    const bytes = encode(rows.join("\n"));
    let partial = false;
    await expect(
      importObservations("sleep.csv", bytes, async (chunk) => {
        if (partial) throw new Error("Interrupted after commit");
        const result = await call<Commit>("importChunk", chunk);
        partial = true;
        expect(result).toMatchObject({ received: 512, complete: false });
        expect(await call("overview")).toMatchObject({ observations: 0, series: [] });
        return result;
      }),
    ).rejects.toThrow("Interrupted after commit");
    const resumed = await importObservations("renamed.csv", bytes, (chunk) =>
      call<Commit>("importChunk", chunk),
    );
    expect(resumed).toMatchObject({ commits: 2, inserted: 1, received: 513 });
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
    await expect(call("importChunk", { message: "x".repeat(64 * 1024) })).rejects.toThrow(
      /byte bound/,
    );
  });
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
});

it("keeps older linked notes accessible and reserves the synthetic series at the Collection boundary", async () => {
  await withHost(async ({ call }) => {
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
    expect(await call("seedDemo")).toEqual({ inserted: 23_360 });
    const seeded = await call<{ series: Array<{ id: string; name: string; unit: string }> }>(
      "overview",
    );
    expect(seeded.series).toContainEqual(
      expect.objectContaining({ id: "sample-steps", name: "Step count", unit: "steps" }),
    );
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
    await call("setReportLink", { id: first.id, grant: "older-link" });
    for (let index = 0; index < 51; index++) await call("saveNote", note);
    const latest = await call<Note[]>("listNotes", { offset: 0 });
    expect(latest.slice(0, 50).some((item) => item.id === first.id)).toBe(false);
    expect(await call("listNotes", { offset: 50 })).toEqual([
      expect.objectContaining({ grant_id: null }),
      expect.objectContaining({ id: first.id, grant_id: "older-link" }),
    ]);
    expect(await call("readNote", { id: first.id })).toMatchObject({ linked: true });
    await call("setReportLink", { id: first.id, grant: null });
    expect(await call("readNote", { id: first.id })).toMatchObject({ linked: false });
  });
}, 30_000);
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
