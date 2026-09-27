import { DohcCliError } from "@dohc/cli/errors";
import {
  CLI_PROTOCOL_VERSION,
  type CliRequestWithoutToken,
  type CliResultByVerb,
  type CliVerb,
} from "@dohc/cli/protocol";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createRecord,
  DOHC_TRANSPORT_UNAVAILABLE_REASON,
  queryCollection,
  listAutomationRuns,
  readAutomationRun,
  readRecord,
  retryAutomationRun,
  setRecordFields,
  type ToolContext,
} from "./tools";

const record = {
  id: "rec_abcdefghijklmnopqrstuvwxyz",
  path: "tasks/write-brief.md",
  conflicted: false,
  values: [
    {
      field: "status",
      value: "open",
      validation: { status: "valid" as const },
      resolvedRelations: [],
    },
  ],
};

const collection = {
  path: "tasks",
  status: "valid" as const,
  reasons: [],
};

const results = {
  collectionQuery: {
    ok: true,
    collection,
    records: [record],
    groups: null,
    nextCursor: null,
  },
  collectionRecord: {
    ok: true,
    collection,
    record,
    history: [
      {
        historyId: 7,
        field: "status",
        previous: { present: false, value: null },
        next: { present: true, value: "open" },
        authorOriginId: "origin_agent",
        actorKind: "agent" as const,
        onBehalfOf: "local",
        depth: 0,
        recordedAtMs: 20,
      },
    ],
  },
  collectionSetFields: {
    ok: true,
    recordPath: record.path,
  },
  collectionCreateRecord: {
    ok: true,
    recordId: record.id,
    recordPath: record.path,
  },
} satisfies {
  [Verb in Extract<
    CliVerb,
    | "collectionQuery"
    | "collectionRecord"
    | "collectionSetFields"
    | "collectionCreateRecord"
  >]: CliResultByVerb[Verb];
};

async function withWorkspace<T>(fn: (ctx: ToolContext) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "dohc-mcp-collections-test-"));
  const root = join(base, "ws");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  try {
    return await fn({ root, home });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

describe("desktop CLI collection proxy", () => {
  it("preserves the update diagnostic for collection queries and record reads", async () => {
    await withWorkspace(async (base) => {
      await mkdir(join(base.root, "tasks"));
      const failure = { ok: false as const, reason: "tasks/collection.yaml uses a newer version. Update dohc to read this file." };
      const ctx: ToolContext = { ...base, request: vi.fn(async () => failure) };
      await expect(queryCollection(ctx, { collectionPath: "tasks" })).resolves.toEqual(failure);
      await expect(readRecord(ctx, { collectionPath: "tasks", recordId: record.id })).resolves.toEqual(failure);
    });
  });
  it("maps all four collection tools to their CLI verbs with the MCP workspace and agent actor", async () => {
    await withWorkspace(async (base) => {
      await mkdir(join(base.root, "tasks"), { recursive: true });
      const requests: CliRequestWithoutToken[] = [];
      const ctx: ToolContext = {
        ...base,
        request: vi.fn(async (request: CliRequestWithoutToken) => {
          requests.push(request);
          return results[request.verb as keyof typeof results];
        }),
      };

      await expect(
        queryCollection(ctx, {
          collectionPath: "tasks",
          filter: { field: "status", operator: "equals", value: "open" },
          sort: [{ field: "status", direction: "asc" }],
          limit: 10,
        }),
      ).resolves.toEqual(results.collectionQuery);
      await expect(
        readRecord(ctx, { collectionPath: "tasks", recordId: record.id }),
      ).resolves.toEqual(results.collectionRecord);
      await expect(
        setRecordFields(ctx, {
          recordPath: record.path,
          fields: { status: "done", notes: null },
        }),
      ).resolves.toEqual(results.collectionSetFields);
      await expect(
        createRecord(ctx, {
          collectionPath: "tasks",
          name: "write-brief",
          fields: { status: "open" },
        }),
      ).resolves.toEqual(results.collectionCreateRecord);

      expect(requests.map((request) => request.verb)).toEqual([
        "collectionQuery",
        "collectionRecord",
        "collectionSetFields",
        "collectionCreateRecord",
      ]);
      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            verb: "collectionQuery",
            args: {
              cwd: base.root,
              actor: "agent",
              collectionPath: "tasks",
              filter: { field: "status", operator: "equals", value: "open" },
              sort: [{ field: "status", direction: "asc" }],
              limit: 10,
            },
          }),
          expect.objectContaining({
            verb: "collectionRecord",
            args: {
              cwd: base.root,
              actor: "agent",
              collectionPath: "tasks",
              recordId: record.id,
              historyLimit: 50,
            },
          }),
          expect.objectContaining({
            verb: "collectionSetFields",
            args: {
              cwd: base.root,
              actor: "agent",
              recordPath: record.path,
              fields: { status: "done", notes: null },
            },
          }),
          expect.objectContaining({
            verb: "collectionCreateRecord",
            args: {
              cwd: base.root,
              actor: "agent",
              collectionPath: "tasks",
              name: "write-brief",
              fields: { status: "open" },
            },
          }),
        ]),
      );
      for (const request of requests) {
        expect(request.protocolVersion).toBe(CLI_PROTOCOL_VERSION);
        expect(request.args).toMatchObject({ cwd: base.root, actor: "agent" });
      }
    });
  });

  it("refuses a traversal path before any transport call", async () => {
    await withWorkspace(async (base) => {
      const request = vi.fn(async () => results.collectionQuery);
      const ctx: ToolContext = { ...base, request };

      for (const result of [
        await queryCollection(ctx, { collectionPath: "../outside" }),
        await readRecord(ctx, { collectionPath: "../outside", recordId: record.id }),
        await setRecordFields(ctx, {
          recordPath: "../outside/task.md",
          fields: { status: "done" },
        }),
        await createRecord(ctx, { collectionPath: "../outside", name: "task" }),
      ]) {
        expect(result).toMatchObject({
          ok: false,
          reason: expect.stringContaining("path rejected"),
        });
      }
      expect(request).not.toHaveBeenCalled();
    });
  });

  it("reads a mounted share but refuses to write into it", async () => {
    await withWorkspace(async (base) => {
      await mkdir(join(base.root, "shared-with-me", "trip"), { recursive: true });
      const request = vi.fn(async (incoming: CliRequestWithoutToken) =>
        results[incoming.verb as keyof typeof results],
      );
      const ctx: ToolContext = { ...base, request };

      await expect(
        queryCollection(ctx, { collectionPath: "shared-with-me/trip" }),
      ).resolves.toEqual(results.collectionQuery);
      await expect(
        setRecordFields(ctx, {
          recordPath: "shared-with-me/trip/task.md",
          fields: { status: "done" },
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining("path rejected"),
      });
      await expect(
        createRecord(ctx, { collectionPath: "shared-with-me/trip", name: "task" }),
      ).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining("path rejected"),
      });
      // Only the read reached the desktop.
      expect(request).toHaveBeenCalledOnce();
    });
  });

  it("refuses a malformed fields shape with a readable reason, before any transport call", async () => {
    await withWorkspace(async (base) => {
      await mkdir(join(base.root, "tasks"), { recursive: true });
      const request = vi.fn(async () => results.collectionSetFields);
      const ctx: ToolContext = { ...base, request };

      await expect(
        setRecordFields(ctx, { recordPath: "tasks/task.md", fields: {} }),
      ).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining("invalid fields"),
      });
      await expect(
        setRecordFields(ctx, {
          recordPath: "tasks/task.md",
          fields: [{ field: "status", value: "done" }],
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining("invalid fields"),
      });
      // The engine owns the "id" key.
      await expect(
        setRecordFields(ctx, {
          recordPath: "tasks/task.md",
          fields: { id: "rec_impostor" },
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining("invalid fields"),
      });
      expect(request).not.toHaveBeenCalled();
    });
  });

  it("preserves structured desktop failures instead of replacing them", async () => {
    await withWorkspace(async (base) => {
      await mkdir(join(base.root, "tasks"), { recursive: true });
      const ctx: ToolContext = {
        ...base,
        request: async () => ({
          ok: false,
          reason: "collection writes are not available in a read-only shared view",
        }),
      };

      await expect(
        setRecordFields(ctx, {
          recordPath: "tasks/task.md",
          fields: { status: "done" },
        }),
      ).resolves.toEqual({
        ok: false,
        reason: "collection writes are not available in a read-only shared view",
      });
    });
  });

  it("returns an honest failure with desktop down and never falls back to file writes", async () => {
    await withWorkspace(async (base) => {
      const ctx: ToolContext = {
        ...base,
        request: async () => {
          throw new DohcCliError("desktop app not running");
        },
      };
      await mkdir(join(base.root, "tasks"), { recursive: true });
      await writeFile(join(base.root, "tasks", "task.md"), "---\nstatus: open\n---\n");

      await expect(
        setRecordFields(ctx, {
          recordPath: "tasks/task.md",
          fields: { status: "done" },
        }),
      ).resolves.toEqual({ ok: false, reason: DOHC_TRANSPORT_UNAVAILABLE_REASON });
      await expect(
        createRecord(ctx, { collectionPath: "tasks", name: "new-task" }),
      ).resolves.toEqual({ ok: false, reason: DOHC_TRANSPORT_UNAVAILABLE_REASON });
      // The record folder holds exactly the file the test wrote: no fallback
      // file write happened.
      await expect(readdir(join(base.root, "tasks"))).resolves.toEqual(["task.md"]);
    });
  });
});

describe("desktop CLI automation proxy", () => {
  const run = {
    run: "atc_1", state: "failed" as const, error: "The record is open elsewhere.", createdAtMs: 1, updatedAtMs: 2,
    trigger: { kind: "changed" as const, recordId: "rec_1", by: "human" as const, depth: 0 },
    definitionChanged: true, chainStopped: false, undone: false,
  };
  const answers = {
    automationRuns: { ok: true, runs: [{ ...run, changes: 1 }] },
    automationRun: { ok: true, run: { ...run, steps: [{ step: 1, changes: [{ kind: "created", recordId: "rec_2", path: "tasks/two.md" }] }], failedStep: 2, startsOver: false } },
  } satisfies { [Verb in Extract<CliVerb, "automationRuns" | "automationRun">]: CliResultByVerb[Verb] };

  it("maps the automation tools to their CLI verbs, and passes on a refused retry of a changed automation", async () => {
    await withWorkspace(async (base) => {
      await mkdir(join(base.root, "tasks"), { recursive: true });
      const requests: CliRequestWithoutToken[] = [];
      const ctx: ToolContext = {
        ...base,
        request: vi.fn(async (request: CliRequestWithoutToken) => {
          requests.push(request);
          if (request.verb === "automationRetry") {
            return request.args.startOver
              ? { ok: true, status: "queued" }
              : { ok: false, status: "definition-changed", repeatsMessages: false, reason: "This automation changed since the run failed." };
          }
          return answers[request.verb as keyof typeof answers];
        }),
      };
      const automation = { collectionPath: "tasks", automation: "stamp" };

      await expect(listAutomationRuns(ctx, automation)).resolves.toEqual(answers.automationRuns);
      await expect(readAutomationRun(ctx, { ...automation, run: "atc_1" })).resolves.toEqual(answers.automationRun);
      await expect(retryAutomationRun(ctx, { ...automation, run: "atc_1" })).resolves.toEqual({
        ok: false, status: "definition-changed", repeatsMessages: false, reason: "This automation changed since the run failed.",
      });
      await expect(retryAutomationRun(ctx, { ...automation, run: "atc_1", startOver: true })).resolves.toEqual({ ok: true, status: "queued" });

      const common = { cwd: base.root, actor: "agent", collectionPath: "tasks", automation: "stamp" };
      expect(requests.map((request) => ({ verb: request.verb, args: request.args }))).toEqual([
        { verb: "automationRuns", args: common },
        { verb: "automationRun", args: { ...common, run: "atc_1" } },
        { verb: "automationRetry", args: { ...common, run: "atc_1", startOver: false } },
        { verb: "automationRetry", args: { ...common, run: "atc_1", startOver: true } },
      ]);
    });
  });

  it("passes on a refused retry from the wrong computer with the notice that names the right one", async () => {
    await withWorkspace(async (base) => {
      await mkdir(join(base.root, "tasks"), { recursive: true });
      const refused = {
        ok: false,
        reason: "Only the computer this run failed on can try it again. The notice names that computer.",
        notice: { title: 'Automation "Stamp" failed', body: "The record is open elsewhere. It ran on Laptop." },
      };
      const ctx: ToolContext = { ...base, request: vi.fn(async () => refused) };
      await expect(retryAutomationRun(ctx, { collectionPath: "tasks", automation: "stamp", run: "atc_1" })).resolves.toEqual(refused);
      await expect(listAutomationRuns(ctx, { collectionPath: "../outside", automation: "stamp" }))
        .resolves.toMatchObject({ ok: false, reason: expect.stringContaining("path rejected") });
      // Try again changes records, so a mounted share is refused as any write is.
      await mkdir(join(base.root, "shared-with-me", "trip"), { recursive: true });
      await expect(retryAutomationRun(ctx, { collectionPath: "shared-with-me/trip", automation: "stamp", run: "atc_1" }))
        .resolves.toMatchObject({ ok: false, reason: expect.stringContaining("path rejected") });
      expect(ctx.request).toHaveBeenCalledTimes(1);
    });
  });
});
