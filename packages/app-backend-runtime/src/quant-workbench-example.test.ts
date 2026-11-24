import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
import { importObservations, parseObservations } from "../../../examples/quant-workbench/ingest.ts";

const read = (file: string) =>
  readFileSync(new URL(`../../../examples/quant-workbench/${file}`, import.meta.url), "utf8");
const datasetPath = "quant-workbench/data/dataset.json";
const definition = parseDatasetDefinition(JSON.parse(read("data/dataset.json")), {
  descriptorPath: datasetPath,
});
const schemaSql = read("data/schema.sql");
const operationSource = read("data/operations.js");
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
const operationId = (name: string) =>
  definition.operations.find((op) => op.name === name)!.operationId;
const encode = (text: string) => new TextEncoder().encode(text).buffer;

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
  const workers = privateFolder(join(directory, "workers"));
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
  const supervisor = await createDatasetSupervisor({ journal, directory: workers });
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

describe("quant-workbench example on the real dataset host", () => {
  it("imports CSV observations, runs rollups and correlation, and isolates published reports", async () => {
    const { call } = await fixture();
    const csv = [
      "series,observed_at,value,name,unit,domain,tags_json",
      'sleep-hours,2025-01-01,7.5,Sleep duration,h,Health,"{""device"":""watch""}"',
      "sleep-hours,2025-01-02,6.5,Sleep duration,h,Health,{}",
      "sleep-hours,2025-01-03,8.0,Sleep duration,h,Health,{}",
      "sleep-hours,2025-01-04,7.0,Sleep duration,h,Health,{}",
      "resting-hr,2025-01-01,58,Resting heart rate,bpm,Health,{}",
      "resting-hr,2025-01-02,62,Resting heart rate,bpm,Health,{}",
      "resting-hr,2025-01-03,56,Resting heart rate,bpm,Health,{}",
      "resting-hr,2025-01-04,60,Resting heart rate,bpm,Health,{}",
    ].join("\n");
    type Commit = { received: number; complete: boolean; inserted: number };
    const bytes = encode(csv);
    const imported = await importObservations("sample.csv", bytes, (chunk) =>
      call<Commit>("importChunk", chunk),
    );
    expect(imported).toMatchObject({ total: 8, received: 8, inserted: 8 });
    const duplicate = await importObservations("renamed.csv", bytes, (chunk) =>
      call<Commit>("importChunk", chunk),
    );
    expect(duplicate).toMatchObject({ commits: 1, inserted: 0, received: 8 });

    const overview = await call<{ observations: number; batches: number; series: unknown[] }>(
      "overview",
    );
    expect(overview).toMatchObject({ observations: 8, batches: 1 });
    expect(overview.series).toHaveLength(2);

    const view = {
      start: "2025-01-01",
      end: "2025-01-04",
      ids: ["sleep-hours", "resting-hr"],
      grain: "day",
    };
    const analyzed = await call<{
      rollups: { grain: string; series: Array<{ id: string; bars: unknown[] }> };
      comparison: { n: number; r: number } | null;
      outliers: unknown[];
    }>("analyze", { ...view, lag: 0 });
    expect(analyzed.rollups.grain).toBe("day");
    expect(analyzed.rollups.series.map((s) => s.id)).toEqual(view.ids);
    expect(analyzed.comparison?.n).toBe(4);
    expect(analyzed.comparison?.r).toBeLessThan(-0.9);

    const saved = await call<{ id: string }>("saveNote", {
      ...view,
      title: "Sleep vs pulse",
      body: "Inverse relationship.",
    });
    await call("setReportLink", { id: saved.id, grant: "report-grant" });
    const published = await call("publishedReport", {}, "report-grant");
    expect(published).toMatchObject({
      title: "Sleep vs pulse",
      body: "Inverse relationship.",
    });
    expect(JSON.stringify(published)).not.toMatch(/tags_json|import_batch_id|grant_id/);
    expect(await call("publishedReport", {}, "other-grant")).toBeNull();
    for (const op of definition.operations.filter((entry) => entry.access === "owner")) {
      await expect(call(op.name, {}, "report-grant")).rejects.toMatchObject({
        code: "not_authorized",
      });
    }
  });

  it("keeps interrupted multi-chunk imports hidden until resumed by checksum", async () => {
    const { call } = await fixture();
    type Commit = { received: number; complete: boolean; inserted: number };
    const csv = [
      "series,observed_at,value",
      "sleep,2025-01-01,3",
      "sleep,2025-01-08,6",
      "sleep,2025-01-09,8",
    ].join("\n");
    const bytes = encode(csv);
    const sha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
    const parsed = parseObservations(csv);

    const partial = await call<Commit>("importChunk", {
      sha256,
      filename: "sleep.csv",
      total: parsed.rows.length,
      offset: 0,
      rows: parsed.rows.slice(0, 2),
      metadata: [],
    });
    expect(partial).toMatchObject({ received: 2, complete: false, inserted: 2 });
    expect(await call("overview")).toMatchObject({ observations: 0, series: [] });

    const resumed = await importObservations("renamed.csv", bytes, (chunk) =>
      call<Commit>("importChunk", chunk),
    );
    expect(resumed).toMatchObject({ commits: 2, inserted: 1, received: 3 });
    const rollups = await call<{
      series: Array<{ bars: Array<{ ma7: number | null; ma30: number | null }> }>;
    }>("rollups", {
      start: "2025-01-08",
      end: "2025-01-09",
      ids: ["sleep"],
      grain: "day",
    });
    expect(rollups.series[0]!.bars.map(({ ma7, ma30 }) => [ma7, ma30])).toEqual([
      [6, 4.5],
      [7, 17 / 3],
    ]);
    expect(await call("seedDemo")).toEqual({ inserted: 0 });
  });
});
