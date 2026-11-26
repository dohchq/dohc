import { AUTOMATION_SERVER_MAX_WORKSPACES } from "@dohc/workspace-contracts/relay";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import type { AutomationReplica, startAutomationReplicas } from "./automationReplicas";
import { RelayError } from "./errors";
import {
  ACCOUNT_VISITS_PER_ACCOUNT,
  READ_HOLD_MS,
  startServerCopies,
  type CopyAutomations,
  type CopyVisitor,
} from "./serverCopies";
import type { SyncRelayStorage } from "./storage";
import type { CopyReason } from "./storage/automationWorkspaces";
import type { StorageContext } from "./storage/context";
import { closeTestStorages, testStorage } from "./testing";

afterEach(closeTestStorages);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

const OWNER = "ana";
type Run = Awaited<ReturnType<typeof copies>>;

async function relay(
  workspaceIds: readonly string[] = ["trip"],
  ownerOf: (workspaceId: string, n: number) => string = () => OWNER,
) {
  const storage = await testStorage();
  for (const [n, workspaceId] of workspaceIds.entries()) {
    storage.claimWorkspace({ workspaceId, ownerUserId: ownerOf(workspaceId, n), createdAtMs: 1 });
    storage.claimWorkspaceIdentity({
      workspaceId,
      replicationEpoch: "epoch",
      streamIdentity: "stream",
    });
  }
  return storage;
}

async function copies(storage: SyncRelayStorage, automations?: CopyAutomations) {
  const open = new Map<string, AutomationReplica>();
  let hooks: Parameters<typeof startAutomationReplicas>[0] | undefined;
  let opens = true;
  const pass = () => {
    const wanted = hooks!.wanted();
    for (const [workspaceId, reasons] of wanted) {
      const row = storage.joinAutomationWorkspace({ workspaceId, nowMs: 1, reasons });
      if (!row || open.has(workspaceId) || !opens) continue;
      open.set(workspaceId, {
        workspaceId,
        ownerUserId: row.ownerUserId,
        incarnation: row.incarnation,
        reasons: row.reasons,
        startedAtMs: 1,
        pulledHead: 0,
        root: "unused",
        metadataDir: "unused",
        client: {} as unknown as EngineClient,
        workspace: "handle",
        signal: new AbortController().signal,
        nextRequestId: () => 1,
        sync: async () => undefined,
        step: async () => true,
        withRecordWork: (work) => work(),
        busy: () => false,
      });
      hooks!.onChanged?.(workspaceId);
    }
    for (const workspaceId of [...open.keys()])
      if (!wanted.has(workspaceId)) {
        open.delete(workspaceId);
        hooks!.onChanged?.(workspaceId);
      }
  };
  const started = await startServerCopies({
    storage,
    root: "unused",
    engineExecutable: "unused",
    relayOrigin: "https://relay.example.test",
    key: new Uint8Array(32),
    namespace: "test",
    ...(automations ? { automations } : {}),
    startReplicas: async (options) => {
      hooks = options;
      return {
        unavailable: false,
        replica: (id) => open.get(id),
        reconcile: () => queueMicrotask(pass),
        deleteWorkspaces: async () => undefined,
        failedSyncs: () => new Map(),
        settled: async () => undefined,
        close: async () => undefined,
      };
    },
  });
  cleanup.push(() => started.close());
  return {
    copies: started,
    wanted: () => hooks!.wanted(),
    holdOnly: (workspaceId: string) => hooks!.holdOnly?.(workspaceId),
    lose: (workspaceId: string) => {
      open.delete(workspaceId);
    },
    holdOpens: () => {
      opens = false;
    },
  };
}

const phone = (caller = "session-1", signal = new AbortController().signal): CopyVisitor => ({
  reason: "account",
  userId: OWNER,
  caller,
  signal,
  phone: true,
});
// An account visit "Show on phone" does not limit, as an agent's will be.
const agent = (caller = "agent:connection-1"): CopyVisitor => ({
  reason: "account",
  userId: OWNER,
  caller,
  signal: new AbortController().signal,
  phone: false,
});

async function refusal(promise: Promise<unknown>): Promise<RelayError> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof RelayError))
    throw new Error(`Expected a relay refusal, got ${String(error)}`);
  return error;
}

describe("an account's visits to the server's copies", () => {
  it("refuses another owner's workspace, one without a sync identity, and a missing one, all alike", async () => {
    const storage = await relay(["trip", "theirs"], (id) => (id === "theirs" ? "ben" : OWNER));
    storage.claimWorkspace({ workspaceId: "unsynced", ownerUserId: OWNER, createdAtMs: 1 });
    const run = await copies(storage);
    for (const workspaceId of ["theirs", "unsynced", "missing"]) {
      const error = await refusal(
        run.copies.withServerCopy(OWNER, workspaceId, phone(), async () => undefined),
      );
      expect([error.code, error.statusCode], workspaceId).toEqual(["not_found", 404]);
    }
    expect(run.wanted()).toEqual(new Map());
    expect(storage.listAutomationWorkspaces()).toEqual([]);
  });

  it("refuses a phone's visit to a workspace hidden from the phone, and admits an account visit the phone setting does not limit", async () => {
    const storage = await relay(["budget"]);
    storage.setShowOnPhone({ userId: OWNER, workspaceId: "budget", showOnPhone: false });
    const run = await copies(storage);
    const error = await refusal(
      run.copies.withServerCopy(OWNER, "budget", phone(), async () => undefined),
    );
    expect([error.code, error.statusCode]).toEqual(["not_found", 404]);
    expect(
      await run.copies.withServerCopy(
        OWNER,
        "budget",
        agent(),
        async (replica) => replica.workspaceId,
      ),
    ).toBe("budget");
    expect(
      storage.listAutomationWorkspaces(),
      "the phone setting ends only the phone's reason",
    ).toMatchObject([{ reasons: ["account"] }]);
  });

  it("stops waiting for a copy when the request goes, and frees the caller's visit", async () => {
    const storage = await relay();
    const run = await copies(storage);
    run.holdOpens();
    const request = new AbortController();
    const waiting = run.copies.withServerCopy(
      OWNER,
      "trip",
      phone("session-1", request.signal),
      async () => undefined,
    );
    request.abort(new Error("The phone went away."));
    await expect(waiting).rejects.toThrow("The phone went away.");
    expect(run.wanted()).toEqual(new Map());
  });

  it("refuses a copy whose workspace changed owner while it opened", async () => {
    const storage = await relay();
    const run = await copies(storage);
    const visit = run.copies.withServerCopy(OWNER, "trip", phone(), async () => "read");
    (storage as StorageContext).db
      .prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'ben' WHERE workspace_id = 'trip'")
      .run();
    expect((await refusal(visit)).code).toBe("not_found");
  });
});

describe("a Member's visits to the owner's copies", () => {
  const ben = (caller: string, signal = new AbortController().signal): CopyVisitor => ({
    reason: "account",
    userId: "ben",
    caller,
    signal,
    phone: true,
  });

  it("count toward the Member's own limit and never the owner's, and outlast the owner hiding it", async () => {
    const ids = Array.from({ length: ACCOUNT_VISITS_PER_ACCOUNT }, (_, n) => `w-${n}`);
    const storage = await relay(ids);
    storage.setShowOnPhone({ userId: OWNER, workspaceId: "w-0", showOnPhone: false });
    const run = await copies(storage);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const visits = Array.from({ length: ACCOUNT_VISITS_PER_ACCOUNT }, (_, n) =>
      run.copies.withServerCopy(OWNER, "w-0", ben(`ben-${n}`), () => held),
    );
    await vi.waitFor(() => expect(run.copies.replica("w-0")).toBeDefined());
    const refused = await refusal(
      run.copies.withServerCopy(OWNER, "w-1", ben("ben-more"), async () => undefined),
    );
    expect(refused.message).toContain("Your account is already reading");
    for (const workspaceId of ids.slice(1))
      expect(
        await run.copies.withServerCopy(
          OWNER,
          workspaceId,
          phone(),
          async (copy) => copy.workspaceId,
        ),
      ).toBe(workspaceId);
    release();
    await Promise.all(visits);
  });
});

describe("the hold a read keeps on its copy", () => {
  const read = (run: Run, workspaceId: string) =>
    run.copies.withServerCopy(OWNER, workspaceId, phone(), async () => {
      run.copies.hold(OWNER, workspaceId);
      return workspaceId;
    });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the copy open for READ_HOLD_MS after the read, and only after a read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const storage = await relay(["trip", "notes"]);
    const run = await copies(storage);
    await read(run, "trip");
    await run.copies.withServerCopy(OWNER, "notes", phone(), async () => undefined);
    await vi.waitFor(() => expect(run.copies.replica("notes")).toBeUndefined());
    expect(run.wanted()).toEqual(new Map([["trip", ["account"]]]));
    expect(run.copies.replica("trip")).toBeDefined();
    await vi.advanceTimersByTimeAsync(READ_HOLD_MS);
    await vi.waitFor(() => expect(run.copies.replica("trip")).toBeUndefined());
    expect(run.wanted()).toEqual(new Map());
  });

  it("counts toward no visit limit, and keeps an account's newest holds within its visit limit", async () => {
    const ids = Array.from({ length: ACCOUNT_VISITS_PER_ACCOUNT + 1 }, (_, n) => `w-${n}`);
    const storage = await relay(ids);
    const run = await copies(storage);
    for (const workspaceId of ids.slice(0, ACCOUNT_VISITS_PER_ACCOUNT))
      await read(run, workspaceId);
    const last = ids.at(-1)!;
    expect(await read(run, last)).toBe(last);
    expect([...run.wanted().keys()].sort()).toEqual(ids.slice(1));
  });

  it("gives way at once to automations and a visit that need its place, and does not come back", async () => {
    const automated = Array.from(
      { length: AUTOMATION_SERVER_MAX_WORKSPACES - 1 },
      (_, n) => `automated-${n}`,
    );
    const storage = await relay(["held", "next", ...automated]);
    let running: string[] = [];
    const run = await copies(storage, {
      wanted: () => running,
      running: () => running,
      ready: () => true,
    });
    await read(run, "held");
    running = automated;
    run.copies.reconcile();
    await vi.waitFor(() => expect(run.copies.replica(automated.at(-1)!)).toBeDefined());
    expect(run.wanted().has("held"), "the last place is free").toBe(true);
    await run.copies.withServerCopy(OWNER, "next", phone(), async () => {
      expect(run.wanted().has("held")).toBe(false);
    });
    expect(run.copies.replica("held")).toBeUndefined();
    expect(run.wanted().has("held")).toBe(false);
  });

  it("ends when the workspace stops showing on the phone", async () => {
    const storage = await relay();
    const run = await copies(storage);
    await read(run, "trip");
    storage.setShowOnPhone({ userId: OWNER, workspaceId: "trip", showOnPhone: false });
    run.copies.endHold("trip", OWNER);
    storage.setShowOnPhone({ userId: OWNER, workspaceId: "trip", showOnPhone: true });
    await vi.waitFor(() => expect(run.copies.replica("trip")).toBeUndefined());
    expect(run.wanted()).toEqual(new Map());
  });

  it("keeps only a copy that is open and current, and never reopens one", async () => {
    const storage = await relay(["trip", "notes"]);
    const run = await copies(storage);
    await read(run, "trip");
    await read(run, "notes");
    run.lose("trip");
    (storage as StorageContext).db
      .prepare(
        "UPDATE sync_relay_automation_workspaces SET left_at_ms = 1 WHERE workspace_id = 'notes'",
      )
      .run();
    run.copies.reconcile();
    await vi.waitFor(() => expect(run.copies.replica("notes")).toBeUndefined());
    expect(run.copies.replica("trip")).toBeUndefined();
    expect(run.wanted()).toEqual(new Map());
  });

  it("tells the replicas which copies only a hold keeps, so no pass pulls them", async () => {
    const storage = await relay();
    const run = await copies(storage);
    let during: boolean | undefined;
    await run.copies.withServerCopy(OWNER, "trip", phone(), async () => {
      run.copies.hold(OWNER, "trip");
      run.wanted();
      during = run.holdOnly("trip");
    });
    expect(during, "a visit's copy").toBe(false);
    expect(run.holdOnly("trip"), "once the visit ends, before the next pass").toBe(true);
  });
});

describe("the copies the phone's unsent writes keep", () => {
  it("restores their reasons before the first pass, and gives them places within the account's limit", async () => {
    const ids = Array.from({ length: ACCOUNT_VISITS_PER_ACCOUNT + 1 }, (_, n) => `w-${n}`);
    const storage = await relay([...ids, "hidden"]);
    for (const [n, workspaceId] of [...ids, "hidden"].entries()) {
      storage.joinAutomationWorkspace({ workspaceId, nowMs: 1, reasons: ["account"] });
      storage.endCopyReason(workspaceId, "account");
      storage.recordAccountOperation({
        accountId: OWNER,
        operationId: `write-${workspaceId}`,
        binding: { workspaceId, operation: "send", args: { n } },
        incarnation: 1,
        replicationEpoch: "epoch",
        streamIdentity: "stream",
        command: { stages: [] },
        writesMessage: true,
        nowMs: n,
      });
    }
    storage.setShowOnPhone({ userId: OWNER, workspaceId: "hidden", showOnPhone: false });
    let atStart: Array<[string, readonly CopyReason[]]> = [];
    let wanted: ReadonlyMap<string, readonly CopyReason[]> = new Map();
    const started = await startServerCopies({
      storage,
      root: "unused",
      engineExecutable: "unused",
      relayOrigin: "https://relay.example.test",
      key: new Uint8Array(32),
      namespace: "test",
      startReplicas: async (options) => {
        atStart = storage
          .listAutomationWorkspaces()
          .map((row): [string, readonly CopyReason[]] => [row.workspaceId, row.reasons]);
        wanted = options.wanted();
        return {
          unavailable: false,
          replica: () => undefined,
          reconcile: () => undefined,
          deleteWorkspaces: async () => undefined,
          failedSyncs: () => new Map(),
          settled: async () => undefined,
          close: async () => undefined,
        };
      },
    });
    cleanup.push(() => started.close());
    expect(atStart).toEqual([
      ["hidden", []],
      ...ids.map((id): [string, CopyReason[]] => [id, ["publication"]]),
    ]);
    expect(wanted).toEqual(
      new Map(
        ids
          .slice(0, ACCOUNT_VISITS_PER_ACCOUNT)
          .map((id): [string, CopyReason[]] => [id, ["publication"]]),
      ),
    );
  });
});
