import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import {
  parseAppDatasetReference,
  parseDatasetDefinition,
  resolveAppDatasetReferenceBinding,
} from "@dohc/security-contract/dataset";
import type { AppBackendCaller, AppBackendJson } from "@dohc/security-contract/app-backend";
import { createDatasetJournal } from "./journal.ts";
import { createDatasetSupervisor } from "./supervisor.ts";
import { createDatasetHost } from "./dataset-host.ts";
import { privateFolder } from "./private-folder.test-helper";

type Person = "pm" | "eng-1" | "eng-2" | "exec" | "visitor";
type App = "roadmap-pm" | "eng-triage" | "exec-rollup";
type Json = Record<string, any>;

const APPS: App[] = ["roadmap-pm", "eng-triage", "exec-rollup"];
const ENGINEERS = ["eng-1", "eng-2"] as const;
const PEOPLE: Record<Person, AppBackendCaller> = {
  pm: { kind: "owner", userId: "pm" },
  "eng-1": { kind: "named", userId: "eng-1", grantId: "eng", access: "edit", helper: false },
  "eng-2": { kind: "named", userId: "eng-2", grantId: "eng", access: "edit", helper: false },
  exec: { kind: "named", userId: "exec", grantId: "leads", access: "view", helper: false },
  visitor: { kind: "link", principalId: "visitor", grantId: "rollup-link" },
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const read = (file: string) =>
  readFileSync(new URL(`../../../examples/team-roadmap/${file}`, import.meta.url), "utf8");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const definition = parseDatasetDefinition(JSON.parse(read("roadmap/dataset.json")), {
    descriptorPath: "team-roadmap/roadmap/dataset.json",
  });
  const schemaSql = read("roadmap/schema.sql");
  const operationSource = read("roadmap/operations.js");
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
  const directory = await mkdtemp(join(tmpdir(), "dohc-team-roadmap-"));
  const db = new DatabaseSync(join(directory, "host.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  function transaction<T>(run: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
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
  cleanups.push(async () => {
    await supervisor.close();
    db.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  });
  const host = createDatasetHost<Person>({
    db,
    transaction,
    journal,
    supervisor,
    resolveAuthority(person, request) {
      if (request.access.kind === "app" && !APPS.includes(request.access.appId as App))
        throw new Error("Unknown app");
      return {
        principalKey: person,
        ...(request.access.kind === "app" ? { appId: request.access.appId } : {}),
        caller: PEOPLE[person],
      };
    },
    compileOperations: async (source) =>
      (await transform(source, { loader: "js", target: "es2022" })).code,
    operationResources: () => ({ files: [], accountAndAttach: () => undefined }),
  });
  const scope = { workspaceId: "workspace", datasetId: definition.datasetId };
  await host.activate("pm", { workspaceId: "workspace", revision, schemaSql, operationSource });
  for (const app of APPS) {
    const reference = parseAppDatasetReference(JSON.parse(read(`${app}/app.publish.json`)).dataset);
    host.setBinding("pm", {
      ...scope,
      appId: app,
      binding: resolveAppDatasetReferenceBinding(reference, definition.datasetId, revision),
    });
  }
  const operationId = (name: string) =>
    definition.operations.find((entry) => entry.name === name)?.operationId ?? `unknown-${name}`;
  for (const engineer of ENGINEERS)
    host.setDataGrant("pm", {
      ...scope,
      principalKey: engineer,
      grant: {
        revision: 1,
        revisionSha256: revision.revisionSha256,
        operationIds: ["listItems", "triageItem", "updateStatus"].map(operationId),
        discover: true,
      },
    });
  let sequence = 0;
  async function call(person: Person, app: App | "data", name: string, input: AppBackendJson = {}) {
    const reply = await host.invoke(person, {
      ...scope,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationId: operationId(name),
      input,
      idempotencyKey: `call-${++sequence}`,
      ...(app === "data" ? {} : { access: { kind: "app", appId: app } as const }),
    });
    return reply.result as Json;
  }
  const events = () =>
    db
      .prepare(
        "SELECT operation, caller_key AS callerKey FROM dohc_dataset_events WHERE dataset_id=? ORDER BY revision",
      )
      .all(definition.datasetId) as { operation: string; callerKey: string }[];
  return { call, events };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seed(f: Fixture) {
  const { id: milestoneId } = await f.call("pm", "roadmap-pm", "createMilestone", {
    name: "Beta",
    dueOn: "2027-03-01",
  });
  const { id } = await f.call("pm", "roadmap-pm", "createItem", {
    title: "Offline edits sync on reconnect",
    area: "sync",
  });
  return { milestoneId, id };
}

async function item(f: Fixture, id: string) {
  const { items } = await f.call("pm", "roadmap-pm", "listItems", {});
  return items.find((entry: Json) => entry.id === id) as Json;
}

describe("team roadmap example", () => {
  it("keeps each app standalone and bound to the operations its manifest names", () => {
    for (const app of APPS) {
      const source = read(`${app}/index.tsx`);
      expect(source, app).not.toMatch(/from "\.\.\//);
      expect(JSON.parse(read(`${app}/app.publish.json`)).dataset.datasetPath).toBe(
        "team-roadmap/roadmap/dataset.json",
      );
    }
  });

  it("shows product and engineering changes in the exec rollup", async () => {
    const f = await fixture();
    const { milestoneId, id } = await seed(f);
    const rollup = () => f.call("exec", "exec-rollup", "rollup");
    expect(await rollup()).toMatchObject({ total: 1, open: 1, statuses: { new: 1 } });

    await expect(
      f.call("pm", "roadmap-pm", "planItem", { id, version: 1, priority: 0, milestoneId }),
    ).rejects.toMatchObject({ refusal: { code: "invalid_state" } });
    const triaged = await f.call("eng-1", "eng-triage", "triageItem", {
      id,
      version: 1,
      estimateDays: 5,
      note: "Needs a reconnect test rig.",
    });
    expect(triaged.item).toMatchObject({ status: "triaged", triagedBy: "eng-1", version: 2 });
    await expect(
      f.call("eng-2", "eng-triage", "triageItem", { id, version: 2, estimateDays: 3 }),
    ).rejects.toMatchObject({ refusal: { code: "invalid_state" } });
    await expect(
      f.call("eng-2", "eng-triage", "updateStatus", { id, version: 2, status: "in_progress" }),
    ).rejects.toMatchObject({ refusal: { code: "invalid_state" } });

    await f.call("pm", "roadmap-pm", "planItem", { id, version: 2, priority: 0, milestoneId });
    expect(await rollup()).toMatchObject({
      p0Open: 1,
      statuses: { planned: 1 },
      milestones: [{ name: "Beta", total: 1, done: 0, p0Open: 1, openDays: 5 }],
    });
    await expect(
      f.call("eng-2", "eng-triage", "updateStatus", { id, version: 2, status: "in_progress" }),
    ).rejects.toMatchObject({ refusal: { code: "conflict" } });
    await f.call("eng-2", "eng-triage", "updateStatus", { id, version: 3, status: "in_progress" });
    const done = await f.call("eng-2", "eng-triage", "updateStatus", {
      id,
      version: 4,
      status: "done",
    });
    expect(done.item).toMatchObject({ status: "done", triagedBy: "eng-1", updatedBy: "eng-2" });
    expect(await rollup()).toMatchObject({
      open: 0,
      p0Open: 0,
      statuses: { done: 1 },
      milestones: [{ total: 1, done: 1, openDays: 0 }],
      areas: [{ area: "sync", open: 0, done: 1 }],
    });

    const engView = await f.call("eng-1", "eng-triage", "listItems", { status: "done" });
    expect(engView.items).toEqual([await item(f, id)]);

    const archived = await f.call("pm", "roadmap-pm", "archiveItem", { id, version: 5 });
    expect(await rollup()).toMatchObject({ total: 0 });
    expect((await f.call("eng-1", "eng-triage", "listItems")).items).toEqual([]);
    await f.call("pm", "roadmap-pm", "restoreItem", archived.undo);
    expect(await rollup()).toMatchObject({ total: 1, statuses: { done: 1 } });
  });

  it("refuses every operation outside an app's binding or a person's grant", async () => {
    const f = await fixture();
    const { milestoneId, id } = await seed(f);
    const before = f.events().length;
    const ownerOnly: Array<[string, AppBackendJson]> = [
      ["createItem", { title: "Sneaky", area: "apps" }],
      ["importItems", { items: [{ title: "Sneaky", area: "apps" }] }],
      ["createMilestone", { name: "Sneaky", dueOn: "2027-01-01" }],
      ["planItem", { id, version: 1, priority: 0, milestoneId }],
      ["archiveItem", { id, version: 1 }],
      ["restoreItem", { id, version: 1 }],
    ];
    const triage: Array<[string, AppBackendJson]> = [
      ["listItems", {}],
      ["triageItem", { id, version: 1, estimateDays: 2 }],
      ["updateStatus", { id, version: 1, status: "done" }],
    ];
    const attempts: Array<readonly [Person, App | "data", string, AppBackendJson]> = [
      ...ownerOnly.flatMap(([name, input]) => [
        ["eng-1", "eng-triage", name, input] as const,
        ["eng-1", "roadmap-pm", name, input] as const,
        ["eng-1", "data", name, input] as const,
        ["exec", "exec-rollup", name, input] as const,
        ["exec", "roadmap-pm", name, input] as const,
        ["pm", "exec-rollup", name, input] as const,
        ["pm", "eng-triage", name, input] as const,
      ]),
      ...triage.flatMap(([name, input]) => [
        ["exec", "exec-rollup", name, input] as const,
        ["exec", "eng-triage", name, input] as const,
        ["exec", "data", name, input] as const,
        ["visitor", "eng-triage", name, input] as const,
        ["pm", "exec-rollup", name, input] as const,
      ]),
      ["eng-1", "eng-triage", "rollup", {}],
      ["eng-1", "data", "rollup", {}],
      ["visitor", "roadmap-pm", "listItems", {}],
      ["eng-1", "eng-triage", "dropItems", {}],
      ["pm", "roadmap-pm", "dropItems", {}],
    ];
    for (const [person, app, name, input] of attempts)
      await expect(
        f.call(person, app, name, input),
        `${person} ${app} ${name}`,
      ).rejects.toMatchObject({ code: "not_authorized" });
    expect(f.events()).toHaveLength(before);

    for (const person of ["exec", "visitor"] as const) {
      const rollup = await f.call(person, "exec-rollup", "rollup");
      expect(JSON.stringify(rollup)).not.toMatch(/Offline edits|eng-|"pm"/);
    }
    const viaData = await f.call("eng-1", "data", "triageItem", {
      id,
      version: 1,
      estimateDays: 2,
    });
    expect(viaData.item).toMatchObject({ status: "triaged", triagedBy: "eng-1" });
    expect(f.events()).toHaveLength(before + 1);
  });

  it("pages through every item, however long its text", async () => {
    const f = await fixture();
    const items = Array.from({ length: 51 }, (_, n) => ({
      title: `${n} ${"語".repeat(110)}`,
      detail: "語".repeat(2000),
      area: "apps",
    }));
    await f.call("pm", "roadmap-pm", "importItems", { items });
    const seen: string[] = [];
    let after: Json | null = null;
    do {
      const page = await f.call("eng-1", "eng-triage", "listItems", {
        status: "new",
        ...(after ? { after } : {}),
      });
      expect(page.total).toBe(51);
      expect(page.items[0].detail).toHaveLength(280);
      seen.push(...page.items.map((entry: Json) => entry.title.split(" ")[0]));
      after = page.next;
    } while (after);
    expect(new Set(seen).size).toBe(51);
  });

  it("records the person and app behind every change", async () => {
    const f = await fixture();
    const { milestoneId, id } = await seed(f);
    await f.call("eng-1", "eng-triage", "triageItem", { id, version: 1, estimateDays: 4 });
    await f.call("pm", "roadmap-pm", "planItem", { id, version: 2, priority: 1, milestoneId });
    await f.call("eng-2", "eng-triage", "updateStatus", { id, version: 3, status: "in_progress" });
    await f.call("eng-2", "data", "updateStatus", { id, version: 4, status: "done" });
    await f.call("exec", "exec-rollup", "rollup");
    const key = (person: Person, app: App | "data") =>
      sha256(
        JSON.stringify([person, app === "data" ? { kind: "data" } : { kind: "app", appId: app }]),
      );
    expect(f.events()).toEqual([
      { operation: "createMilestone", callerKey: key("pm", "roadmap-pm") },
      { operation: "createItem", callerKey: key("pm", "roadmap-pm") },
      { operation: "triageItem", callerKey: key("eng-1", "eng-triage") },
      { operation: "planItem", callerKey: key("pm", "roadmap-pm") },
      { operation: "updateStatus", callerKey: key("eng-2", "eng-triage") },
      { operation: "updateStatus", callerKey: key("eng-2", "data") },
    ]);
    expect(await item(f, id)).toMatchObject({
      requestedBy: "pm",
      triagedBy: "eng-1",
      updatedBy: "eng-2",
    });
  });
});
