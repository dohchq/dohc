import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { type ReachRoster } from "@dohc/automation-executor/automation-reach";
import {
  createAutomationRunStore,
  type StoredRun,
} from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder } from "../testing/preparedLocalState";
import { definitionHash } from "@dohc/automation-executor/automation-plan";
import { datasetAutomationFixture } from "./collectionAutomationDatasetTestSupport";

const {
  id,
  BUDGET,
  AUTOMATION,
  PAID,
  STATUS,
  NOTES,
  LIST,
  CREATE,
  EDIT,
  REMOVE,
  closePaid,
  world,
  engineClaim,
} = datasetAutomationFixture();

describe("undoing the records a dataset automation added", () => {
  const addLog = closePaid(`      - add-record:
          Notes: Log
        operation: invoices.create
`);
  const ana = {
    grantId: "g-ana",
    recipientUserId: "u-ana",
    recipientEmail: "ana@dohc.test",
    files: { paths: ["Budget"], versionId: null, access: "edit" as const },
    channel: null,
  };
  const withAna: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [ana] };
  const trash = async () => {
    throw new Error("A dataset keeps no trash.");
  };
  const counts = {
    reverted: 0,
    removed: 0,
    deleted: 0,
    kept: 0,
    keptChanged: 0,
    gone: 0,
    changedSince: 0,
    missing: 0,
    irreversible: 0,
    actions: 0,
    actionsReversed: 0,
  };
  const logs = async (f: Awaited<ReturnType<typeof world>>) =>
    (await f.records()).filter((row) => row.values[NOTES] === "Log");
  // What the person sees when they click Undo, then the Undo they confirm from it.
  const ask = (f: Awaited<ReturnType<typeof world>>, claimId: string) =>
    f.executor.undo({ automationId: AUTOMATION, claimId, deletes: null }, trash);
  const confirmed = async (f: Awaited<ReturnType<typeof world>>, claimId: string) => {
    const asked = await ask(f, claimId);
    return asked.status === "confirm"
      ? await f.executor.undo(
          {
            automationId: AUTOMATION,
            claimId,
            deletes: { token: asked.preview.token, chosen: [] },
          },
          trash,
        )
      : asked;
  };
  const shown = {
    deletes: 0,
    unchecked: 0,
    kept: 0,
    keptChanged: 0,
    gone: 0,
    reverts: 0,
    irreversible: 0,
    reverses: 0,
    actions: 0,
    choices: [],
    token: expect.any(String),
  };

  async function ranOnce(f: Awaited<ReturnType<typeof world>>) {
    await f.writeAutomations(addLog);
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    return f.claims()[0]!.claimId;
  }

  it("keeps a record it added when an editor lost the delete before Undo, and refuses while it cannot check who can edit", async () => {
    const f = await world({ roster: withAna });
    f.grant("g-ana", "u-ana", [LIST, CREATE, EDIT, REMOVE]);
    const claimId = await ranOnce(f);
    expect((await f.executor.runs(AUTOMATION)).runs[0]!.writes).toEqual([
      expect.objectContaining({ kind: "dataset-created", deletes: [REMOVE] }),
    ]);
    f.setRoster({
      kind: "unknown",
      problem: { kind: "unchecked", next: "dohc checks again when the server answers." },
    });
    expect(await ask(f, claimId)).toEqual({
      status: "refused",
      reason:
        "dohc could not check who can edit Budget. dohc checks again when the server answers.",
    });
    f.setRoster(withAna);
    f.grant("g-ana", "u-ana", [LIST, CREATE, EDIT]);
    expect(await confirmed(f, claimId)).toEqual({ status: "undone", ...counts, kept: 1 });
    expect(await logs(f)).toHaveLength(1);
    await f.executor.dispose();
  });

  it("sends the saved delete again after dohc stops once it committed, and counts one already gone apart", async () => {
    const f = await world();
    const claimId = await ranOnce(f);
    const asked = await ask(f, claimId);
    if (asked.status !== "confirm") throw new Error("Undo should ask first.");
    f.crashAfterOwnerInvoke(REMOVE);
    await expect(
      f.executor.undo(
        { automationId: AUTOMATION, claimId, deletes: { token: asked.preview.token, chosen: [] } },
        trash,
      ),
    ).rejects.toThrow("dohc stopped.");
    expect(await logs(f)).toEqual([]);
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    const [saved] = (await store.runsOf(AUTOMATION, claimId)).runs;
    expect(saved).toMatchObject({
      undo: "started",
      undoCalls: [
        expect.objectContaining({ kind: "delete", operationId: REMOVE, expectedVersion: 1 }),
      ],
    });
    // The retry chooses nothing again: it sends the saved request, whose receipt replays.
    expect(
      await f.executor.undo({ automationId: AUTOMATION, claimId, deletes: null }, trash),
    ).toEqual({ status: "undone", ...counts, deleted: 1 });
    await f.executor.dispose();

    const g = await world();
    const other = await ranOnce(g);
    const [log] = await logs(g);
    await g.host.action({
      ...g.rules,
      operationId: REMOVE,
      input: { id: log!.id, expectedVersion: 1 },
      idempotencyKey: "owner-delete",
    });
    expect(await ask(g, other)).toEqual({ status: "confirm", preview: { ...shown, gone: 1 } });
    expect(await confirmed(g, other)).toEqual({ status: "undone", ...counts, gone: 1 });
    await g.executor.dispose();
  });
});

describe("dataset automation claims in both ledgers", () => {
  it("pages the runs of both ledgers together, newest first, and reads and undoes a run on any page", async () => {
    const f = await world();
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const ledgerClaim = f.claims()[0]!;
    // The automation then ran 21 times on a schedule, after its record change.
    for (let index = 0; index < 21; index += 1)
      f.engineClaims.push(
        engineClaim(`atc_later_${index}`, "done", ledgerClaim.createdAtMs + 1 + index),
      );
    const first = await f.executor.runs(AUTOMATION);
    expect(first.runs).toHaveLength(20);
    const listed = [...first.runs];
    for (let before = first.next; before !== null;) {
      const page = await f.executor.runs(AUTOMATION, before);
      listed.push(...page.runs);
      before = page.next;
    }
    expect(listed.map((run) => run.claimId)).toEqual([
      ...Array.from({ length: 21 }, (_, index) => `atc_later_${20 - index}`),
      ledgerClaim.claimId,
    ]);
    expect(await f.executor.listedRun(AUTOMATION, ledgerClaim.claimId)).toMatchObject({
      claimId: ledgerClaim.claimId,
      state: "done",
    });
    expect(await f.executor.run(AUTOMATION, ledgerClaim.claimId)).toMatchObject({
      claimId: ledgerClaim.claimId,
      state: "done",
    });
    const summary = await f.executor.automationsIn("Budget");
    if (summary.status !== "read" || !summary.automations[0]?.valid)
      throw new Error("The automation should read.");
    const trash = async () => {
      throw new Error("A dataset's added records stay.");
    };
    await expect(
      f.executor.undoRunsOf(
        [
          {
            collectionPath: "Budget",
            id: "close-paid",
            definitionHash: definitionHash(summary.automations[0].automation),
          },
        ],
        trash,
      ),
    ).resolves.toEqual({
      undone: 1,
      left: 0,
      reverted: 1,
      missing: 0,
      keptFields: [],
      otherKept: 0,
      errorMessage: null,
    });
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    await f.executor.dispose();
  });

  it("expires saved runs 30 days after they ended, and keeps a failure a ledger may still try again or cannot answer for", async () => {
    // The dataset host stays closed: another process holds its store.
    const f = await world({ hostOpen: false, storeFails: true });
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const saved = (
      claimId: string,
      outcome: StoredRun["outcome"],
      rest: Partial<StoredRun> = {},
    ): StoredRun => ({
      durableEffects: 0,
      version: 13,
      claimId,
      automationId: AUTOMATION,
      definitionHash: "h",
      keySeed: "h-1",
      startedAtMs: old,
      finishedAtMs: old,
      steps: [],
      applied: [],
      created: [],
      replans: [],
      undoRequests: [],
      undoCalls: [],
      undoCovers: [],
      readableFields: null,
      collections: [],
      rules: null,
      superseded: false,
      undo: null,
      undoKept: [],
      settled: outcome?.state === "done",
      outcome,
      ...rest,
    });
    const failed = { state: "failed" as const, error: "Not yet.", run: 1, step: 0 };
    await store.save(saved("atc_done", { state: "done" }));
    // Undone since, which does not keep it longer.
    await store.save(saved("atc_undone", { state: "done" }, { undo: "done" }));
    await store.save(saved("atc_recent", { state: "done" }, { finishedAtMs: Date.now() }));
    // The engine still offers its Try again.
    await store.save(saved("atc_offered", failed));
    f.engineClaims.push(engineClaim("atc_offered", "failed", old));
    // No ledger holds it any more.
    await store.save(saved("atc_gone", failed));
    // Its dataset's ledger may hold it, and cannot say while its host is closed.
    await store.save(
      saved("atc_dataset", failed, {
        rules: { datasetId: "budget", revision: 1, revisionSha256: "r" },
      }),
    );
    await f.executor.open();
    await f.until(() => f.expiries() > 0);
    const left: string[] = [];
    for (const claimId of [
      "atc_done",
      "atc_undone",
      "atc_recent",
      "atc_offered",
      "atc_gone",
      "atc_dataset",
    ]) {
      if ((await store.runsOf(AUTOMATION, claimId)).runs.length > 0) left.push(claimId);
    }
    expect(left).toEqual(["atc_recent", "atc_offered", "atc_dataset"]);
    await f.executor.dispose();
  });
});

describe("schedules on a dataset Collection", () => {
  const SWEEP = `collection:${BUDGET}#sweep`;
  const sweep = (steps: string) => `  - id: sweep
    name: Sweep paid invoices
    when: {schedule: day, timezone: UTC}
    do:
${steps}`;
  const closeFound = `      - find: record.Paid == true && record.Status == "Open"
        as: paid
        operation: invoices.list
      - set:
          Status: Closed
        records: paid
        operation: invoices.status
`;
  const due = Date.UTC(2026, 8, 27, 0, 0);
  it("runs a waiting due time once its folder's descriptor is fixed, and settles one whose dataset this store does not hold", async () => {
    const f = await world();
    await f.writeAutomations(sweep(closeFound));
    const descriptor = join(f.root, "Budget", "dataset.json");
    const fixed = await readFile(descriptor, "utf8");
    await writeFile(descriptor, JSON.stringify({ ...JSON.parse(fixed), datasetId: id(98) }));
    await f.executor.open();
    const { id: paid } = await f.create({ [PAID]: true });
    // A due time of a dataset the store never approved names no Collection
    // here, so it settles; the approved one waits for its descriptor.
    f.engineClaims.push(
      engineClaim("atc_budget", "pending", due, SWEEP),
      engineClaim("atc_elsewhere", "pending", due + 1, `collection:${id(97)}#sweep`),
    );
    f.executor.notifyClaimed();
    await f.until(
      () =>
        f.engineClaims[0]!.state === "pending" &&
        f.engineClaims[0]!.attempts === 0 &&
        f.engineClaims[1]!.state === "done",
    );
    await f.executor.idle();
    await writeFile(descriptor, fixed);
    f.executor.handleWatcherEvents([{ operation: "update", path: "Budget/dataset.json" }]);
    await f.until(() => f.engineClaims.every((claim) => claim.state === "done"));
    expect((await f.record(paid))?.values[STATUS]).toBe("Closed");
    await f.executor.dispose();
  });
});
