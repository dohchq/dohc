import { afterEach, describe, expect, it } from "vitest";
import { AUTOMATION_SERVER_MAX_WORKSPACES } from "@dohc/workspace-contracts/relay";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import type { AutomationReplica, startAutomationReplicas } from "./automationReplicas";
import { RelayError } from "./errors";
import { ACCOUNT_VISIT_WORKSPACES, ACCOUNT_VISITS_PER_CALLER, startServerCopies, type CopyAutomations, type CopyVisitor } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import { closeTestStorages, testStorage } from "./testing";

// The copies run over a fake replicas module: each pass joins every wanted
// workspace's row with its reasons and opens its copy at once, and closes
// the copies nothing wants.

afterEach(closeTestStorages);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

const OWNER = "ana";

async function relay(workspaceIds: readonly string[] = ["trip"]) {
  const storage = await testStorage();
  for (const workspaceId of workspaceIds) {
    storage.claimWorkspace({ workspaceId, ownerUserId: OWNER, createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId, replicationEpoch: "epoch", streamIdentity: "stream" });
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
        workspaceId, ownerUserId: row.ownerUserId, incarnation: row.incarnation, reasons: row.reasons, startedAtMs: 1, pulledHead: 0,
        root: "unused", metadataDir: "unused", client: {} as unknown as EngineClient, workspace: "handle", signal: new AbortController().signal,
        nextRequestId: () => 1, sync: async () => undefined, withRecordWork: (work) => work(),
      });
      hooks!.onChanged?.(workspaceId);
    }
    for (const workspaceId of [...open.keys()]) if (!wanted.has(workspaceId)) {
      open.delete(workspaceId);
      hooks!.onChanged?.(workspaceId);
    }
  };
  const started = await startServerCopies({
    storage, root: "unused", engineExecutable: "unused", relayOrigin: "https://relay.example.test", key: new Uint8Array(32), namespace: "test",
    ...(automations ? { automations } : {}),
    startReplicas: async (options) => {
      hooks = options;
      return { unavailable: false, replica: (id) => open.get(id), reconcile: () => queueMicrotask(pass), deleteWorkspaces: async () => undefined,
        failedSyncs: () => new Map(), settled: async () => undefined, close: async () => undefined };
    },
  });
  cleanup.push(() => started.close());
  return {
    copies: started, open,
    wanted: () => hooks!.wanted(),
    holdOpens: () => { opens = false; },
  };
}

const phone = (caller = "session-1", signal = new AbortController().signal): CopyVisitor => ({ reason: "account", caller, signal });

/** A visit that holds its copy until `release` is called. */
function holding(run: Awaited<ReturnType<typeof copies>>, workspaceId: string, visitor: CopyVisitor = phone()) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const visit = run.copies.withServerCopy(OWNER, workspaceId, visitor, async (replica) => { entered(); await held; return replica.workspaceId; });
  return { visit, inside, release };
}

async function refusal(promise: Promise<unknown>): Promise<RelayError> {
  const error: unknown = await promise.then(() => null, (reason: unknown) => reason);
  if (!(error instanceof RelayError)) throw new Error(`Expected a relay refusal, got ${String(error)}`);
  return error;
}

describe("an account's visits to the server's copies", () => {
  it("opens a copy for the account, keeps it for the account's reason, and lets it go when the visit ends", async () => {
    const storage = await relay();
    const run = await copies(storage);
    const visit = holding(run, "trip");
    await visit.inside;
    expect(run.wanted()).toEqual(new Map([["trip", ["account"]]]));
    expect(storage.listAutomationWorkspaces()).toMatchObject([{ workspaceId: "trip", reasons: ["account"] }]);
    visit.release();
    expect(await visit.visit).toBe("trip");
    expect(run.wanted()).toEqual(new Map());
  });

  it("refuses another owner's workspace, one without a sync identity, and one hidden from the phone, all alike", async () => {
    const storage = await relay(["trip", "notes", "budget"]);
    storage.claimWorkspace({ workspaceId: "theirs", ownerUserId: "ben", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: "theirs", replicationEpoch: "epoch", streamIdentity: "stream" });
    storage.claimWorkspace({ workspaceId: "unsynced", ownerUserId: OWNER, createdAtMs: 1 });
    storage.setShowOnPhone({ ownerUserId: OWNER, workspaceId: "budget", showOnPhone: false });
    const run = await copies(storage);
    for (const workspaceId of ["theirs", "unsynced", "budget", "missing"]) {
      const error = await refusal(run.copies.withServerCopy(OWNER, workspaceId, phone(), async () => undefined));
      expect([error.code, error.statusCode], workspaceId).toEqual(["not_found", 404]);
    }
    expect(run.wanted()).toEqual(new Map());
    expect(storage.listAutomationWorkspaces()).toEqual([]);
  });

  it("holds at most ACCOUNT_VISITS_PER_CALLER visits for one sign-in, and none of another's", async () => {
    const ids = Array.from({ length: ACCOUNT_VISITS_PER_CALLER + 1 }, (_, n) => `w-${n}`);
    const storage = await relay(ids);
    const run = await copies(storage);
    const held = ids.slice(0, ACCOUNT_VISITS_PER_CALLER).map((id) => holding(run, id));
    await Promise.all(held.map((visit) => visit.inside));
    const busy = await refusal(run.copies.withServerCopy(OWNER, ids.at(-1)!, phone(), async () => undefined));
    expect([busy.code, busy.statusCode]).toEqual(["server-busy", 503]);
    expect(await run.copies.withServerCopy(OWNER, ids.at(-1)!, phone("session-2"), async (replica) => replica.workspaceId)).toBe(ids.at(-1));
    held[0]!.release();
    await held[0]!.visit;
    expect(await run.copies.withServerCopy(OWNER, ids.at(-1)!, phone(), async (replica) => replica.workspaceId)).toBe(ids.at(-1));
    for (const visit of held.slice(1)) visit.release();
    await Promise.all(held.map((visit) => visit.visit));
  });

  it("lets account visits hold at most ACCOUNT_VISIT_WORKSPACES places, so the server's automations keep the rest", async () => {
    const accountIds = Array.from({ length: ACCOUNT_VISIT_WORKSPACES + 1 }, (_, n) => `a-${n}`);
    const runningIds = Array.from({ length: AUTOMATION_SERVER_MAX_WORKSPACES - ACCOUNT_VISIT_WORKSPACES }, (_, n) => `r-${n}`);
    const storage = await relay([...accountIds, ...runningIds]);
    const run = await copies(storage, { wanted: () => runningIds, running: () => runningIds, ready: () => true });
    const held = accountIds.slice(0, ACCOUNT_VISIT_WORKSPACES)
      .map((id, n) => holding(run, id, phone(`session-${Math.floor(n / ACCOUNT_VISITS_PER_CALLER)}`)));
    await Promise.all(held.map((visit) => visit.inside));
    const busy = await refusal(run.copies.withServerCopy(OWNER, accountIds.at(-1)!, phone("another-session"), async () => undefined));
    expect([busy.code, busy.statusCode]).toEqual(["server-busy", 503]);
    const wanted = run.wanted();
    expect(wanted.size).toBe(AUTOMATION_SERVER_MAX_WORKSPACES);
    for (const id of runningIds) expect(wanted.get(id), id).toEqual(["automation"]);
    // A workspace whose automations run here already has its place.
    expect(await run.copies.withServerCopy(OWNER, runningIds[0]!, phone("another-session"), async () => "read")).toBe("read");
    for (const visit of held) visit.release();
    await Promise.all(held.map((visit) => visit.visit));
  });

  it("ends the account's reason after its visits when Show on phone turned off while they ran", async () => {
    const storage = await relay();
    const run = await copies(storage);
    const visit = holding(run, "trip");
    await visit.inside;
    storage.setShowOnPhone({ ownerUserId: OWNER, workspaceId: "trip", showOnPhone: false });
    // A pass during the visit keeps the reason while the visit holds the copy.
    run.copies.reconcile();
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.listAutomationWorkspaces()).toMatchObject([{ reasons: ["account"] }]);
    visit.release();
    await visit.visit;
    expect(storage.listAutomationWorkspaces()).toMatchObject([{ workspaceId: "trip", reasons: [] }]);
  });

  it("stops waiting for a copy when the request goes, and frees the caller's visit", async () => {
    const storage = await relay();
    const run = await copies(storage);
    run.holdOpens();
    const request = new AbortController();
    const waiting = run.copies.withServerCopy(OWNER, "trip", phone("session-1", request.signal), async () => undefined);
    request.abort(new Error("The phone went away."));
    await expect(waiting).rejects.toThrow("The phone went away.");
    expect(run.wanted()).toEqual(new Map());
  });

  it("refuses a copy whose workspace changed owner while it opened", async () => {
    const storage = await relay();
    const run = await copies(storage);
    const visit = run.copies.withServerCopy(OWNER, "trip", phone(), async () => "read");
    // The copy opens in the next pass, after the owner changed.
    (storage as StorageContext).db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'ben' WHERE workspace_id = 'trip'").run();
    expect((await refusal(visit)).code).toBe("not_found");
  });
});

describe("an automation visit beside account visits", () => {
  it("keeps a copy for both reasons while both visit it, and puts back an automation copy's times only without an account visit", async () => {
    const storage = await relay();
    storage.joinAutomationWorkspace({ workspaceId: "trip", nowMs: 1, reasons: ["automation"] });
    storage.unwantAutomationWorkspace({ workspaceId: "trip", nowMs: 5 });
    const run = await copies(storage, { wanted: () => [], running: () => [], ready: () => true });
    const automation = holding(run, "trip", { reason: "automation" });
    await automation.inside;
    const account = holding(run, "trip");
    await account.inside;
    expect(run.wanted()).toEqual(new Map([["trip", ["automation", "account"]]]));
    automation.release();
    account.release();
    await Promise.all([automation.visit, account.visit]);
    expect(storage.listAutomationWorkspaces()).toMatchObject([{ reasons: ["account", "automation"], unwantedSinceMs: null }]);
  });
});
