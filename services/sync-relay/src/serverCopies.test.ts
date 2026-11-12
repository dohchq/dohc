import { afterEach, describe, expect, it } from "vitest";
import { AUTOMATION_SERVER_MAX_WORKSPACES } from "@dohc/workspace-contracts/relay";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import type { AutomationReplica, startAutomationReplicas } from "./automationReplicas";
import { RelayError } from "./errors";
import { ACCOUNT_VISIT_WORKSPACES, ACCOUNT_VISITS_PER_ACCOUNT, ACCOUNT_VISITS_PER_CALLER, startServerCopies, type CopyAutomations, type CopyVisitor } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";
import type { CopyReason } from "./storage/automationWorkspaces";
import type { StorageContext } from "./storage/context";
import { closeTestStorages, testStorage } from "./testing";

// The copies run over a fake replicas module: each pass joins every wanted
// workspace's row with its reasons and opens its copy at once, and closes
// the copies nothing wants.

afterEach(closeTestStorages);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

const OWNER = "ana";

async function relay(workspaceIds: readonly string[] = ["trip"], ownerOf: (workspaceId: string, n: number) => string = () => OWNER) {
  const storage = await testStorage();
  for (const [n, workspaceId] of workspaceIds.entries()) {
    storage.claimWorkspace({ workspaceId, ownerUserId: ownerOf(workspaceId, n), createdAtMs: 1 });
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
        nextRequestId: () => 1, sync: async () => undefined, step: async () => true, withRecordWork: (work) => work(),
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
    releaseOpens: () => { opens = true; pass(); },
    /** A copy the replicas module still has open, as one kept after the workspace left. */
    keepOpen(workspaceId: string) {
      const row = storage.listAutomationWorkspaces().find((kept) => kept.workspaceId === workspaceId)!;
      open.set(workspaceId, {
        workspaceId, ownerUserId: row.ownerUserId, incarnation: row.incarnation, reasons: row.reasons, startedAtMs: 1, pulledHead: 0,
        root: "unused", metadataDir: "unused", client: {} as unknown as EngineClient, workspace: "handle", signal: new AbortController().signal,
        nextRequestId: () => 1, sync: async () => undefined, step: async () => true, withRecordWork: (work) => work(),
      });
    },
  };
}

const phone = (caller = "session-1", signal = new AbortController().signal): CopyVisitor => ({ reason: "account", caller, signal, phone: true });
// An account visit "Show on phone" does not limit, as an agent's will be.
const agent = (caller = "agent:connection-1"): CopyVisitor => ({ reason: "account", caller, signal: new AbortController().signal, phone: false });

/** A visit that holds its copy until `release` is called. */
function holding(run: Awaited<ReturnType<typeof copies>>, workspaceId: string, visitor: CopyVisitor = phone(), owner = OWNER) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const visit = run.copies.withServerCopy(owner, workspaceId, visitor, async (replica) => { entered(); await held; return replica.workspaceId; });
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

  it("refuses another owner's workspace, one without a sync identity, and a missing one, all alike", async () => {
    const storage = await relay(["trip", "theirs"], (id) => id === "theirs" ? "ben" : OWNER);
    storage.claimWorkspace({ workspaceId: "unsynced", ownerUserId: OWNER, createdAtMs: 1 });
    const run = await copies(storage);
    for (const workspaceId of ["theirs", "unsynced", "missing"]) {
      const error = await refusal(run.copies.withServerCopy(OWNER, workspaceId, phone(), async () => undefined));
      expect([error.code, error.statusCode], workspaceId).toEqual(["not_found", 404]);
    }
    expect(run.wanted()).toEqual(new Map());
    expect(storage.listAutomationWorkspaces()).toEqual([]);
  });

  it("refuses a phone's visit to a workspace hidden from the phone, and admits an account visit the phone setting does not limit", async () => {
    const storage = await relay(["budget"]);
    storage.setShowOnPhone({ ownerUserId: OWNER, workspaceId: "budget", showOnPhone: false });
    const run = await copies(storage);
    const error = await refusal(run.copies.withServerCopy(OWNER, "budget", phone(), async () => undefined));
    expect([error.code, error.statusCode]).toEqual(["not_found", 404]);
    expect(await run.copies.withServerCopy(OWNER, "budget", agent(), async (replica) => replica.workspaceId)).toBe("budget");
    expect(storage.listAutomationWorkspaces(), "the phone setting ends only the phone's reason").toMatchObject([{ reasons: ["account"] }]);
  });

  it("holds at most ACCOUNT_VISITS_PER_CALLER visits for one sign-in", async () => {
    const ids = Array.from({ length: ACCOUNT_VISITS_PER_CALLER + 1 }, (_, n) => `w-${n}`);
    const storage = await relay([...ids, "theirs"], (id) => id === "theirs" ? "ben" : OWNER);
    const run = await copies(storage);
    const held = ids.slice(0, ACCOUNT_VISITS_PER_CALLER).map((id) => holding(run, id));
    await Promise.all(held.map((visit) => visit.inside));
    const busy = await refusal(run.copies.withServerCopy(OWNER, ids.at(-1)!, phone(), async () => undefined));
    expect([busy.code, busy.statusCode]).toEqual(["server_busy", 503]);
    expect(await run.copies.withServerCopy("ben", "theirs", phone("ben-session"), async (replica) => replica.workspaceId)).toBe("theirs");
    held[0]!.release();
    await held[0]!.visit;
    expect(await run.copies.withServerCopy(OWNER, ids.at(-1)!, phone(), async (replica) => replica.workspaceId)).toBe(ids.at(-1));
    for (const visit of held.slice(1)) visit.release();
    await Promise.all(held.map((visit) => visit.visit));
  });

  it("holds at most ACCOUNT_VISITS_PER_ACCOUNT visits for one account across its sign-ins, and leaves another account its place", async () => {
    const ids = Array.from({ length: ACCOUNT_VISITS_PER_ACCOUNT + 1 }, (_, n) => `w-${n}`);
    const storage = await relay([...ids, "theirs"], (id) => id === "theirs" ? "ben" : OWNER);
    const run = await copies(storage);
    const held = ids.slice(0, ACCOUNT_VISITS_PER_ACCOUNT).map((id, n) => holding(run, id, phone(n % 2 === 0 ? "phone" : "tablet")));
    await Promise.all(held.map((visit) => visit.inside));
    for (const session of ["phone", "tablet", "laptop"]) {
      const busy = await refusal(run.copies.withServerCopy(OWNER, ids.at(-1)!, phone(session), async () => undefined));
      expect([busy.code, busy.statusCode], session).toEqual(["server_busy", 503]);
    }
    expect(await run.copies.withServerCopy("ben", "theirs", phone("ben-session"), async (replica) => replica.workspaceId)).toBe("theirs");
    held[0]!.release();
    await held[0]!.visit;
    expect(await run.copies.withServerCopy(OWNER, ids.at(-1)!, phone("laptop"), async (replica) => replica.workspaceId)).toBe(ids.at(-1));
    for (const visit of held.slice(1)) visit.release();
    await Promise.all(held.map((visit) => visit.visit));
  });

  it("lets account visits hold at most ACCOUNT_VISIT_WORKSPACES places, so the server's automations keep the rest", async () => {
    const accountIds = Array.from({ length: ACCOUNT_VISIT_WORKSPACES + 1 }, (_, n) => `a-${n}`);
    const runningIds = Array.from({ length: AUTOMATION_SERVER_MAX_WORKSPACES - ACCOUNT_VISIT_WORKSPACES }, (_, n) => `r-${n}`);
    // Each account holds as many visits as it may.
    const ownerOf = (n: number) => `owner-${Math.floor(n / ACCOUNT_VISITS_PER_ACCOUNT)}`;
    const storage = await relay([...accountIds, ...runningIds], (_, n) => n < accountIds.length ? ownerOf(n) : OWNER);
    const run = await copies(storage, { wanted: () => runningIds, running: () => runningIds, ready: () => true });
    const held = accountIds.slice(0, ACCOUNT_VISIT_WORKSPACES).map((id, n) => holding(run, id, phone(`session-${n}`), ownerOf(n)));
    await Promise.all(held.map((visit) => visit.inside));
    const last = accountIds.length - 1;
    const busy = await refusal(run.copies.withServerCopy(ownerOf(last), accountIds[last]!, phone("another-session"), async () => undefined));
    expect([busy.code, busy.statusCode]).toEqual(["server_busy", 503]);
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

describe("the server's places", () => {
  const running = Array.from({ length: AUTOMATION_SERVER_MAX_WORKSPACES }, (_, n) => `r-${n}`);

  it("refuses a visit to a copy still open after its workspace left, when automations hold every place", async () => {
    const storage = await relay([...running, "kept"]);
    storage.joinAutomationWorkspace({ workspaceId: "kept", nowMs: 1, reasons: ["automation"] });
    const run = await copies(storage, { wanted: () => running, running: () => running, ready: () => true });
    run.keepOpen("kept");
    for (const visitor of [phone(), { reason: "automation" } as const]) {
      const busy = await refusal(run.copies.withServerCopy(OWNER, "kept", visitor, async () => undefined));
      expect(busy.statusCode, visitor.reason).toBe(503);
    }
    expect([...run.wanted().keys()]).toEqual(running);
  });

  it("admits a visit to a workspace that holds a place while its copy still opens", async () => {
    const storage = await relay(running);
    const others = running.slice(1);
    const run = await copies(storage, { wanted: () => others, running: () => others, ready: () => true });
    run.holdOpens();
    // The visit takes the last place, and its copy has not opened yet.
    const first = holding(run, running[0]!, phone("phone"));
    const second = holding(run, running[0]!, phone("tablet"));
    // A running workspace's copy that has not opened yet holds its place too.
    const third = holding(run, others[0]!, phone("laptop"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(run.wanted().size).toBe(AUTOMATION_SERVER_MAX_WORKSPACES);
    run.releaseOpens();
    await Promise.all([first.inside, second.inside, third.inside]);
    for (const visit of [first, second, third]) visit.release();
    expect(await Promise.all([first.visit, second.visit, third.visit])).toEqual([running[0], running[0], others[0]]);
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

describe("the copies the phone's unsent writes keep", () => {
  it("restores their reasons before the first pass, and gives them places within the account's limit", async () => {
    const ids = Array.from({ length: ACCOUNT_VISITS_PER_ACCOUNT + 1 }, (_, n) => `w-${n}`);
    const storage = await relay([...ids, "hidden"]);
    for (const [n, workspaceId] of [...ids, "hidden"].entries()) {
      // Each copy took a write during a visit that ended before the server restarted.
      storage.joinAutomationWorkspace({ workspaceId, nowMs: 1, reasons: ["account"] });
      storage.endCopyReason(workspaceId, "account");
      storage.recordAccountOperation({ accountId: OWNER, operationId: `write-${workspaceId}`, binding: { workspaceId, operation: "send", args: { n } },
        incarnation: 1, replicationEpoch: "epoch", streamIdentity: "stream", command: { stages: [] }, writesMessage: true, nowMs: n });
    }
    // A workspace hidden from the phone keeps no copy for its writes.
    storage.setShowOnPhone({ ownerUserId: OWNER, workspaceId: "hidden", showOnPhone: false });
    let atStart: Array<[string, readonly CopyReason[]]> = [];
    let wanted: ReadonlyMap<string, readonly CopyReason[]> = new Map();
    const started = await startServerCopies({
      storage, root: "unused", engineExecutable: "unused", relayOrigin: "https://relay.example.test", key: new Uint8Array(32), namespace: "test",
      startReplicas: async (options) => {
        atStart = storage.listAutomationWorkspaces().map((row): [string, readonly CopyReason[]] => [row.workspaceId, row.reasons]);
        wanted = options.wanted();
        return { unavailable: false, replica: () => undefined, reconcile: () => undefined, deleteWorkspaces: async () => undefined,
          failedSyncs: () => new Map(), settled: async () => undefined, close: async () => undefined };
      },
    });
    cleanup.push(() => started.close());
    expect(atStart).toEqual([["hidden", []], ...ids.map((id): [string, CopyReason[]] => [id, ["publication"]])]);
    // The oldest writes first, and no more than the account may hold.
    expect(wanted).toEqual(new Map(ids.slice(0, ACCOUNT_VISITS_PER_ACCOUNT).map((id): [string, CopyReason[]] => [id, ["publication"]])));
  });
});
