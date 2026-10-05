import { describe, expect, it, vi } from "vitest";
import { createServerRuns } from "../automations/serverRuns";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { writeAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import { collectionAutomationId, definitionHash } from "@dohc/automation-executor/automation-plan";
import type { CollectionAutomations, KeptAutomationField } from "@dohc/automation-executor/collection-automations";
import { CHANNELS } from "./channels";
import { registerStopAndRestoreIpc } from "./stopAndRestoreIpc";
import { KeptAutomationFieldShape } from "./bridgeContract";
import {
  LiveDocumentMutationError,
  RestoreHeadChangedError,
  type WorkspaceEngineMomentDetail,
} from "../workspaces/workspaceEngineCapture";
import type { LocalPersonAuthor } from "../workspaces/desktopRecordEdits";

const KEPT = { id: "f".repeat(32), path: "trip/Tasks/Untitled.md", field: "Finished on", recordId: null };
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
type Pass = { undone: number; left: number; reverted: number; missing: number; keptFields: KeptAutomationField[]; otherKept: number; errorMessage: string | null };
const NOTHING: Pass = { undone: 0, left: 0, reverted: 0, missing: 0, keptFields: [], otherKept: 0, errorMessage: null };
const SCHEMA = "trip/packing/collection.yaml";
const OWNER: LocalPersonAuthor = { kind: "human", humanId: "user_owner" };

function grant(overrides: Record<string, unknown>) {
  return {
    shareId: "share-1", workspaceId: WORKSPACE_ID, grantId: "grant-edit", recipientUserId: "user_ana",
    access: "edit", revokedAtMs: null, recipientEmail: "ana@example.com", ...overrides,
  };
}

const schemaMoment: VersionedTextMoment = {
  id: "m-schema", workspaceId: WORKSPACE_ID, versionId: "main", objectId: "o-schema", path: SCHEMA, recordedAtMs: 1,
  operation: "write", metadata: { origin: "sync" },
  payload: { before: { path: SCHEMA, text: "name: A\n" }, after: { path: SCHEMA, text: "name: B\n" } },
};

function fixture(options: {
  granted?: unknown[];
  ledger?: Record<string, unknown[]>;
  links?: unknown[][];
  // How many link revokes the relay refuses because the link's dependents changed.
  revokeConflicts?: number;
  // A link revoke that fails for another reason.
  revokeError?: Error;
  moment?: VersionedTextMoment | null;
  protectedMoment?: boolean;
  changed?: boolean;
  restoreError?: Error;
  undoRunsOf?: CollectionAutomations["undoRunsOf"];
  serverRestore?: (definitions: ReadonlyArray<{ collectionPath: string; id: string; definitionHash: string }>, again: boolean) => Promise<Pass>;
  syncNow?: () => Promise<void>;
  ledgerError?: () => Error | null;
} = {}) {
  const handlers = new Map<string, (event: { sender: string }, payload: unknown) => unknown>();
  const calls: Array<{ path: string; method: string }> = [];
  // The account main has settled on; a test signs in as someone else mid-request.
  const account = { person: OWNER };
  const granted = options.granted ?? [
    grant({}),
    grant({ grantId: "grant-view", shareId: "share-2", access: "view" }),
    grant({ grantId: "grant-old", shareId: "share-3", revokedAtMs: 5 }),
    grant({ grantId: "grant-bob", recipientUserId: "user_bob" }),
    grant({ grantId: "grant-elsewhere", workspaceId: "other" }),
    { grantId: "grant-link", principalKind: "link" },
  ];
  const ledger = options.ledger ?? {
    "grant-edit": [{ writes: [{ committedAtMs: 2, files: [{ path: SCHEMA, objectId: "o-schema", momentId: "m-schema", created: false }] }], nextAfterOriginSeq: 0 },
      { writes: [], nextAfterOriginSeq: null }],
  };
  const links = options.links ?? [[]];
  let conflicts = options.revokeConflicts ?? 0;
  const bodies: unknown[] = [];
  const relayJson = vi.fn(async (_credentials: string, path: string, init?: RequestInit): Promise<unknown> => {
    calls.push({ path, method: init?.method ?? "GET" });
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    if (path === "/sync/shares") return { granted, received: [] };
    const page = /\/shares\/links(?:\?cursor=(\d+))?$/.exec(path);
    if (page) {
      const index = page[1] === undefined ? 0 : Number(page[1]);
      return { links: links[index] ?? [], ...(index + 1 < links.length ? { nextCursor: String(index + 1) } : {}) };
    }
    const read = /\/collection-writes\/([^?]+)\?afterOriginSeq=(-?\d+)$/.exec(path);
    const ledgerError = read ? options.ledgerError?.() : null;
    if (ledgerError) throw ledgerError;
    if (read) {
      const pages = ledger[decodeURIComponent(read[1]!)] ?? [{ writes: [], nextAfterOriginSeq: null }];
      return pages[Number(read[2]) + 1];
    }
    return {};
  });
  const endLink = vi.fn(async (_credentials: string, path: string, init: RequestInit): Promise<"ended" | "dependents-changed"> => {
    calls.push({ path, method: init.method ?? "GET" });
    if (typeof init.body === "string") bodies.push(JSON.parse(init.body));
    if (options.revokeError) throw options.revokeError;
    if (conflicts > 0) {
      conflicts -= 1;
      return "dependents-changed";
    }
    for (const list of links) for (const link of list as Array<{ status: string }>) link.status = "revoked";
    return "ended";
  });
  // Each restore's own moment, which puts the file back as it was before the person.
  const restores = new Map<string, VersionedTextMoment>();
  const capture = {
    readMoment: vi.fn(async (momentId: string): Promise<WorkspaceEngineMomentDetail | null> => {
      if (options.protectedMoment) return { protected: true, moment: { ...schemaMoment, momentOrder: 1, protected: true } as never };
      const restore = restores.get(momentId);
      if (restore) return { protected: false, moment: restore };
      return options.moment === null ? null : { protected: false, moment: options.moment ?? schemaMoment };
    }),
    listObjectMomentsAfter: vi.fn(async (objectId: string) =>
      [...restores.values()].filter((restore) => restore.objectId === objectId).map((restore) => restore.id).reverse()),
    restoreFileToBeforeMoment: vi.fn(async (momentId: string, _person: LocalPersonAuthor, _options?: { expectedHeadMomentId?: string }) => {
      if (options.changed) throw new RestoreHeadChangedError(SCHEMA);
      if (options.restoreError) throw options.restoreError;
      const theirs = options.moment ?? schemaMoment;
      const before = theirs.payload.before;
      restores.set(`back-${momentId}`, {
        ...theirs, id: `back-${momentId}`, metadata: { origin: "restore" },
        ...(before ? { payload: { before: theirs.payload.after, after: before } } : { operation: "delete" }),
      });
      return { restored: "text" as const, restoredMomentId: `back-${momentId}`, path: SCHEMA };
    }),
  };
  const queuePull = vi.fn();
  const sharesChanged = vi.fn();
  registerStopAndRestoreIpc<string, { sender: string }, { workspaceId: string; rootPath: string }, {
    workspace: { workspaceId: string; rootPath: string };
    state: { collectionAutomations: CollectionAutomations };
    assertCurrent(): void;
  }, string>({
    registerHandler: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender: () => undefined,
    withRendererWorkspaceOperation: async (_sender, _workspaceId, _message, work) => await work({
      workspace: { workspaceId: WORKSPACE_ID, rootPath: "/missing-root" },
      state: { collectionAutomations: { undoRunsOf: options.undoRunsOf } as CollectionAutomations },
      assertCurrent: () => undefined,
    }),
    remoteForWorkspace: async () => ({ credentials: "token", credentialGeneration: 1 }),
    currentCredentialGeneration: () => 1,
    relayJson: relayJson as <Result>(credentials: string, path: string, init?: RequestInit) => Promise<Result>,
    endLink,
    sharesChanged,
    requireEngineCapture: async () => ({ capture }),
    localPerson: async () => account.person,
    queuePull,
    deletePath: async () => undefined,
    notifyRenderer: () => undefined,
    assertOriginalWorkspace: () => undefined,
    syncNow: async () => { await options.syncNow?.(); },
    serverRuns: { restore: async (_workspaceId, definitions, again) => (await options.serverRestore?.(definitions, again)) ?? NOTHING },
  });
  const call = (channel: string, payload: Record<string, unknown>) =>
    handlers.get(channel)!({ sender: "window" }, { workspaceId: WORKSPACE_ID, ...payload });
  return { call, calls, bodies, capture, queuePull, sharesChanged, account };
}

describe("stop and restore in main", () => {
  it("revokes only the person's grants on this workspace that can write, then restores from every grant's ledger", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toEqual({
      status: "restored",
      restored: [{ path: SCHEMA, restoredMomentId: "back-m-schema" }],
      review: [],
      runsUndone: 0,
      runsLeft: 0,
      runChangesKept: 0,
      wroteAutomations: false,
      sendsMessages: false,
      keptFields: [], fieldsMissing: 0,
      unfinished: null,
    });
    expect(f.capture.restoreFileToBeforeMoment).toHaveBeenCalledWith("m-schema", OWNER, { expectedHeadMomentId: "m-schema" });
    expect(f.calls.filter((call) => call.method === "POST").map((call) => call.path))
      .toEqual(["/sync/shares/share-1/grants/grant-edit/revoke"]);
    expect(f.sharesChanged).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(f.calls.filter((call) => call.path.includes("collection-writes")).map((call) => call.path)).toEqual([
      `/sync/${WORKSPACE_ID}/collection-writes/grant-edit?afterOriginSeq=-1`,
      `/sync/${WORKSPACE_ID}/collection-writes/grant-edit?afterOriginSeq=0`,
      `/sync/${WORKSPACE_ID}/collection-writes/grant-view?afterOriginSeq=-1`,
      `/sync/${WORKSPACE_ID}/collection-writes/grant-old?afterOriginSeq=-1`,
    ]);
  });

  it("undoes the runs of the automations the person wrote here and on the owner's server", async () => {
    const file = "trip/packing/automations.yaml";
    const stamp = {
      id: "stamp", name: "Stamp", enabled: true,
      when: { kind: "record-added", table: null },
      if: null,
      do: [{ kind: "set", values: [{ field: "Status", value: { kind: "literal", value: "New" } }], records: null, operation: null }],
    } as unknown as Automation;
    const written = writeAutomationsFile([{ status: "valid", automation: stamp }]);
    if (written.status !== "ok") throw new Error("The test's automation does not write.");
    const moment: VersionedTextMoment = {
      ...schemaMoment, id: "m-auto", objectId: "o-auto", path: file,
      payload: { before: null, after: { path: file, text: written.text } },
    };
    const definitions = [{ collectionPath: "trip/packing", id: "stamp", definitionHash: definitionHash(stamp) }];
    const undoRunsOf = vi.fn(async (_definitions: unknown, _trash: unknown, again?: boolean) => (again ? NOTHING : { ...NOTHING, undone: 1, reverted: 1 }));
    const serverRestore = vi.fn(async (_definitions: unknown, again: boolean) => (again ? NOTHING : { ...NOTHING, undone: 2, left: 1, reverted: 2, missing: 1 }));
    const f = fixture({
      moment, undoRunsOf, serverRestore,
      ledger: { "grant-edit": [{ writes: [{ committedAtMs: 2, files: [{ path: file, objectId: "o-auto", momentId: "m-auto", created: true }] }], nextAfterOriginSeq: null }] },
    });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({ runsUndone: 3, runsLeft: 1, keptFields: [], fieldsMissing: 1, unfinished: null });
    // A second pass finds nothing kept to try again, and ends.
    expect(undoRunsOf.mock.calls.map((call) => [call[0], call[2]])).toEqual([[definitions, false], [definitions, true]]);
    expect(serverRestore.mock.calls).toEqual([[definitions, false], [definitions, true]]);
  });

  // One field that runs here and on the owner's server wrote in turn. Each
  // computer keeps its own copy, and a sync carries a change through the
  // relay. Each run's Undo follows the executor's rule: a field goes back
  // only while it holds what the run wrote, and a kept field is tried again.
  function twoComputers(runs: { here: ReadonlyArray<readonly [number, number]>; server: ReadonlyArray<readonly [number, number]> }, value: number) {
    const relay = { value };
    const copies = { here: { value, changed: false }, server: { value, changed: false } };
    const push = (copy: { value: number; changed: boolean }) => {
      if (copy.changed) relay.value = copy.value;
      copy.changed = false;
    };
    type Run = { before: number; after: number; done: boolean; kept: boolean };
    const state = (list: ReadonlyArray<readonly [number, number]>): Run[] => list.map(([before, after]) => ({ before, after, done: false, kept: false })).reverse();
    const hosts = { here: state(runs.here), server: state(runs.server) };
    const pass = (host: "here" | "server", again: boolean): Pass => {
      const copy = copies[host];
      const result = { ...NOTHING };
      for (const run of hosts[host]) {
        if (again ? !run.kept : run.done && !run.kept) continue;
        if (!run.done) result.undone += 1;
        run.done = true;
        if (copy.value === run.after) {
          copy.value = run.before;
          copy.changed = true;
          run.kept = false;
          result.reverted += 1;
        } else {
          run.kept = true;
        }
      }
      // The runs write one field, so its hash is the same on both computers.
      return { ...result, keptFields: hosts[host].some((run) => run.kept) ? [{ ...KEPT, path: host === "server" ? "trip/Tasks/Old.md" : KEPT.path }] : [] };
    };
    return {
      relay, copies,
      undoRunsOf: vi.fn(async (_definitions: unknown, _trash: unknown, again?: boolean) => pass("here", again ?? false)),
      serverRestore: vi.fn(async (_definitions: unknown, again: boolean) => {
        copies.server.value = relay.value;
        const result = pass("server", again);
        push(copies.server);
        return result;
      }),
      syncNow: async () => {
        push(copies.here);
        copies.here.value = relay.value;
      },
    };
  }

  function automationsFile() {
    const file = "trip/packing/automations.yaml";
    const stamp = {
      id: "stamp", name: "Stamp", enabled: true, when: { kind: "record-added", table: null }, if: null,
      do: [{ kind: "set", values: [{ field: "Status", value: { kind: "literal", value: "New" } }], records: null, operation: null }],
    } as unknown as Automation;
    const written = writeAutomationsFile([{ status: "valid", automation: stamp }]);
    if (written.status !== "ok") throw new Error("The test's automation does not write.");
    return {
      moment: { ...schemaMoment, id: "m-auto", objectId: "o-auto", path: file, payload: { before: null, after: { path: file, text: written.text } } } satisfies VersionedTextMoment,
      ledger: { "grant-edit": [{ writes: [{ committedAtMs: 2, files: [{ path: file, objectId: "o-auto", momentId: "m-auto", created: true }] }], nextAfterOriginSeq: null }] },
    };
  }

  it.each([
    ["here, then on the server", { here: [[0, 1]], server: [[1, 2]] }],
    ["on the server, then here", { here: [[1, 2]], server: [[0, 1]] }],
  ] as const)("puts back a field that runs wrote %s, whichever computer's Undo goes first", async (_order, runs) => {
    const computers = twoComputers(runs, 2);
    const f = fixture({ ...automationsFile(), ...computers });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }))
      .resolves.toMatchObject({ runsUndone: 2, runsLeft: 0, keptFields: [], fieldsMissing: 0, unfinished: null });
    expect([computers.relay.value, computers.copies.here.value, computers.copies.server.value]).toEqual([0, 0, 0]);
  });

  it("stops undoing when a sync between passes fails, and says so", async () => {
    const computers = twoComputers({ here: [[0, 1]], server: [[1, 2]] }, 2);
    const f = fixture({ ...automationsFile(), ...computers, syncNow: async () => { throw new Error("dohc could not sync this workspace with your server, so it stopped undoing runs part way. Try again."); } });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }))
      .resolves.toMatchObject({ unfinished: { step: "runs", message: "dohc could not sync this workspace with your server, so it stopped undoing runs part way. Try again." } });
    // The server's pass ran; nothing ran here over a copy that did not sync.
    expect(computers.undoRunsOf).not.toHaveBeenCalled();
  });

  it("reports what a pass undid before a sync failed", async () => {
    // The server's run came first, so its Undo keeps the field until the run here is undone.
    const computers = twoComputers({ here: [[1, 2]], server: [[0, 1]] }, 2);
    let syncs = 0;
    // The syncs of the first pass go through; the second pass's first sync fails.
    const syncNow = async () => {
      syncs += 1;
      if (syncs === 3) throw new Error("dohc could not sync this workspace with your server, so it stopped undoing runs part way. Try again.");
      await computers.syncNow();
    };
    const f = fixture({ ...automationsFile(), ...computers, syncNow });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      runsUndone: 2, runsLeft: 0, keptFields: [], unfinished: { step: "runs", message: "dohc could not sync this workspace with your server, so it stopped undoing runs part way. Try again." },
    });
  });

  // Undoing runs goes server, sync, here, sync. A try that one of those
  // stops tells which step it did not finish; trying again continues from
  // where it stopped, counts each run once across the tries, and a third try
  // changes nothing.
  const STOPPED = "dohc stopped here.";
  it("shows a recovery sentence when the server restore contract does not match", async () => {
    const server = createServerRuns(async () => ({
      status: 200, body: { ok: true, ...NOTHING, keptFields: 1 }, asker: { account: "owner", current: () => true },
    }));
    const f = fixture({ ...automationsFile(), serverRestore: async (definitions, again) => server.restore(WORKSPACE_ID, definitions, again) });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      unfinished: { step: "runs", message: "Your server runs a different version of dohc. Update it, then try again." },
    });
  });

  it.each(["../outside", "/outside", "C:/outside", "trip/../outside", "trip\\outside", "trip//outside"])("rejects kept field path %s", (path) => {
    expect(KeptAutomationFieldShape.safeParse({ ...KEPT, path }).success).toBe(false);
  });

  it("accepts normalized Collection and document paths, and an unlocated field", () => {
    for (const path of ["Budget", KEPT.path, null]) expect(KeptAutomationFieldShape.parse({ ...KEPT, path })).toEqual({ ...KEPT, path });
  });

  it("uses the latest finished host's path when this computer's next pass fails", async () => {
    let failing = false;
    const serverField = { ...KEPT, path: "trip/Tasks/moved.md" };
    const f = fixture({
      ...automationsFile(),
      serverRestore: async () => ({ ...NOTHING, keptFields: [failing ? serverField : KEPT] }),
      undoRunsOf: async () => ({ ...NOTHING, keptFields: [KEPT], errorMessage: failing ? STOPPED : null }),
    });
    const stop = () => f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } });
    await expect(stop()).resolves.toMatchObject({ keptFields: [KEPT], unfinished: null });
    failing = true;
    await expect(stop()).resolves.toMatchObject({ keptFields: [serverField], unfinished: { step: "runs", message: STOPPED } });
  });
  it.each([
    ["the server's Undo", 0],
    ["the sync before the Undo here", 1],
    ["the Undo here", 2],
    ["the sync after the Undo here", 3],
  ] as const)("continues after %s stopped a try, and repeats safely", async (_stage, stage) => {
    for (const runs of [{ here: [[0, 1]], server: [[1, 2]] }, { here: [[1, 2]], server: [[0, 1]] }] as const) {
      const computers = twoComputers(runs, 2);
      let failed = false;
      // Fails the first time the try reaches this stage, before it acts.
      const failAt = (at: number) => {
        if (at !== stage || failed) return false;
        failed = true;
        return true;
      };
      let syncs = 0;
      const f = fixture({
        ...automationsFile(),
        serverRestore: async (definitions, again) => failAt(0) ? { ...NOTHING, errorMessage: STOPPED } : await computers.serverRestore(definitions, again),
        undoRunsOf: async (definitions, trash, again) => failAt(2) ? { ...NOTHING, errorMessage: STOPPED } : await computers.undoRunsOf(definitions, trash, again),
        syncNow: async () => {
          syncs += 1;
          if (failAt(syncs % 2 === 1 ? 1 : 3)) throw new Error(STOPPED);
          await computers.syncNow();
        },
      });
      const stop = () => f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }) as Promise<{ runsUndone: number }>;

      const first = await stop();
      expect(first).toMatchObject({ restored: [{ restoredMomentId: "back-m-auto" }], unfinished: { step: "runs", message: STOPPED } });
      const second = await stop();
      expect(second).toMatchObject({ restored: [], review: [], runsLeft: 0, keptFields: [], fieldsMissing: 0, unfinished: null });
      expect(first.runsUndone + second.runsUndone).toBe(2);
      expect([computers.relay.value, computers.copies.here.value, computers.copies.server.value]).toEqual([0, 0, 0]);

      await expect(stop()).resolves.toMatchObject({ restored: [], runsUndone: 0, runsLeft: 0, keptFields: [], unfinished: null });
      expect([computers.relay.value, computers.copies.here.value, computers.copies.server.value]).toEqual([0, 0, 0]);
      // The file went back once; later tries pass it over.
      expect(f.capture.restoreFileToBeforeMoment).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the fields a computer's runs kept when a later try stops before that computer's pass", async () => {
    // Someone set 9 after the runs, so both computers' runs keep the field.
    const computers = twoComputers({ here: [[0, 1]], server: [[1, 2]] }, 9);
    let syncs = 0;
    let serverFails = false;
    const f = fixture({
      ...automationsFile(),
      ...computers,
      serverRestore: async (definitions, again) => serverFails ? { ...NOTHING, errorMessage: STOPPED } : await computers.serverRestore(definitions, again),
      syncNow: async () => {
        syncs += 1;
        // The first try stops at the sync after the Undo here.
        if (syncs === 2) throw new Error(STOPPED);
        await computers.syncNow();
      },
    });
    const stop = () => f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } });
    await expect(stop()).resolves.toMatchObject({ runsUndone: 2, keptFields: [KEPT], unfinished: { step: "runs" } });
    // The next try stops before either computer's pass finishes, and still counts the field.
    serverFails = true;
    await expect(stop()).resolves.toMatchObject({ runsUndone: 0, keptFields: [KEPT], unfinished: { step: "runs" } });
    serverFails = false;
    await expect(stop()).resolves.toMatchObject({ runsUndone: 0, keptFields: [KEPT], unfinished: null });
    expect(computers.relay.value).toBe(9);
  });

  it("reports the fields an earlier try found kept when a retry stops before undoing runs", async () => {
    const computers = twoComputers({ here: [[0, 1]], server: [[1, 2]] }, 9);
    let ledgerFails = false;
    const f = fixture({ ...automationsFile(), ...computers, ledgerError: () => ledgerFails ? new Error("dohc could not reach your server.") : null });
    const stop = () => f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } });
    await expect(stop()).resolves.toMatchObject({ keptFields: [KEPT], unfinished: null });
    ledgerFails = true;
    await expect(stop()).resolves.toMatchObject({
      keptFields: [KEPT], runChangesKept: 1, unfinished: { step: "files", message: "dohc could not reach your server." },
    });
  });

  it("keeps a value someone set after the runs, and counts the field once", async () => {
    // Runs wrote 0 to 1 here and 1 to 2 on the server; then someone set 9.
    const computers = twoComputers({ here: [[0, 1]], server: [[1, 2]] }, 9);
    const f = fixture({ ...automationsFile(), ...computers });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }))
      .resolves.toMatchObject({ runsUndone: 2, runsLeft: 0, keptFields: [KEPT], unfinished: null });
    expect(computers.relay.value).toBe(9);
    // One pass to undo, one that restores nothing and ends.
    expect(computers.serverRestore).toHaveBeenCalledTimes(2);
  });

  it("pulls and restores nothing while a change the person wrote has not arrived", async () => {
    const f = fixture({ moment: null });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toEqual({ status: "waiting" });
    expect(f.queuePull).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
  });

  it("refuses a ledger path that leaves the workspace, and a person with no share here", async () => {
    const f = fixture({ ledger: { "grant-edit": [{ writes: [{ committedAtMs: 1, files: [{ path: "../outside", objectId: "o", momentId: "m", created: true }] }], nextAfterOriginSeq: null }] } });
    // Access already stopped, so the answer says what is still to finish.
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      restored: [], unfinished: { step: "files", message: "dohc could not read the relay's list of their changes." },
    });
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
    await expect(fixture().call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_nobody" } }))
      .rejects.toThrow("dohc found no share of this workspace with this person.");
  });

  it("sends a file the engine finds changed at restore to review", async () => {
    const f = fixture({ changed: true });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      restored: [],
      review: [{ path: SCHEMA, reason: "changed-since" }],
    });
  });

  it("reviews a shared live file History refuses, and reports any other restore failure", async () => {
    const live = fixture({ restoreError: new LiveDocumentMutationError("dohc could not restore it. This action is unavailable for shared live files.") });
    await expect(live.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      review: [{ path: SCHEMA, reason: "restore-refused", detail: "dohc could not restore it. This action is unavailable for shared live files." }],
      unfinished: null,
    });
    const down = fixture({ restoreError: new Error("The workspace engine is not running.") });
    await expect(down.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      review: [],
      unfinished: { step: "files", message: "The workspace engine is not running." },
    });
  });

  it("lists a protected file it cannot restore here for the owner to check, instead of waiting for it", async () => {
    const f = fixture({ protectedMoment: true });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      restored: [],
      review: [{ path: SCHEMA, reason: "restore-refused", detail: "Its contents are protected. Restore it from its History." }],
      unfinished: null,
    });
    expect(f.queuePull).not.toHaveBeenCalled();
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
  });

  it("says access stays stopped when reading their changes fails after it stopped access", async () => {
    const f = fixture({ ledgerError: () => new Error("dohc could not reach your server.") });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toEqual({
      status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0, runChangesKept: 0,
      wroteAutomations: false, sendsMessages: false, keptFields: [], fieldsMissing: 0,
      unfinished: { step: "files", message: "dohc could not reach your server." },
    });
    expect(f.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/sync/shares/share-1/grants/grant-edit/revoke"]);
  });

  const link = (overrides: Record<string, unknown> = {}) => ({
    shareId: "share-link", grantId: "grant-link", status: "active", access: "edit", selector: { paths: ["trip"], versionId: null },
    dependents: [{ grantId: "grant-dep" }], ...overrides,
  });
  const linkLedger = {
    "grant-link": [{ writes: [{ committedAtMs: 2, files: [{ path: SCHEMA, objectId: "o-schema", momentId: "m-schema", created: false }] }], nextAfterOriginSeq: null }],
  };
  const byLink = { target: { kind: "link", grantId: "grant-link" } };

  it("ends a whole link, with its dependents, then restores every write in its ledger", async () => {
    const f = fixture({ links: [[link({ grantId: "grant-other" })], [link()]], ledger: linkLedger });
    await expect(f.call(CHANNELS.stopAndRestore, byLink)).resolves.toMatchObject({
      status: "restored",
      restored: [{ path: SCHEMA, restoredMomentId: "back-m-schema" }],
    });
    expect(f.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/sync/shares/share-link/revoke"]);
    expect(f.bodies).toEqual([{ grantId: "grant-link", workspaceId: WORKSPACE_ID, expectedDependentGrantIds: ["grant-dep"] }]);
    expect(f.sharesChanged).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(f.calls.filter((call) => call.path.includes("collection-writes")).map((call) => call.path))
      .toEqual([`/sync/${WORKSPACE_ID}/collection-writes/grant-link?afterOriginSeq=-1`]);
  });

  it("restores through a link already ended, without ending it again", async () => {
    const f = fixture({ links: [[link({ status: "revoked" })]], ledger: linkLedger });
    await expect(f.call(CHANNELS.stopAndRestore, byLink)).resolves.toMatchObject({ restored: [{ path: SCHEMA }] });
    expect(f.calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(f.sharesChanged).not.toHaveBeenCalled();
  });

  it("lists the link again when someone opened it meanwhile, and gives up after a few tries", async () => {
    const f = fixture({ links: [[link()]], ledger: linkLedger, revokeConflicts: 1 });
    await expect(f.call(CHANNELS.stopAndRestore, byLink)).resolves.toMatchObject({ restored: [{ path: SCHEMA }] });
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(2);

    const busy = fixture({ links: [[link()]], ledger: linkLedger, revokeConflicts: 3 });
    await expect(busy.call(CHANNELS.stopAndRestore, byLink)).rejects.toThrow("People kept opening this link while dohc ended it. Try again.");
    expect(busy.calls.filter((call) => call.method === "POST")).toHaveLength(3);
    expect(busy.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
    expect(busy.sharesChanged).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("stops at once, restoring nothing, when ending the link fails for another reason", async () => {
    const f = fixture({ links: [[link()]], ledger: linkLedger, revokeError: new Error("dohc could not reach your server.") });
    await expect(f.call(CHANNELS.stopAndRestore, byLink)).rejects.toThrow("dohc could not reach your server.");
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
    expect(f.sharesChanged).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("refuses a link this workspace does not have", async () => {
    const f = fixture({ links: [[link({ grantId: "grant-other" })]] });
    await expect(f.call(CHANNELS.stopAndRestore, byLink)).rejects.toThrow("dohc found no share link of this workspace with this id.");
    expect(f.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("undoes the restores newest first", async () => {
    const f = fixture();
    await f.call(CHANNELS.undoStopAndRestore, { restoredMomentIds: ["back-1", "back-2"] });
    expect(f.capture.restoreFileToBeforeMoment.mock.calls).toEqual([["back-2", OWNER], ["back-1", OWNER]]);
  });

  it("names the person signed in here when the request arrived, never one the renderer sends", async () => {
    const f = fixture();
    const mallory = { kind: "human", humanId: "user_mallory" };
    for (const [channel, payload] of [
      [CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" }, person: mallory }],
      [CHANNELS.undoStopAndRestore, { restoredMomentIds: ["back-1"], author: mallory }],
    ] as const) {
      await expect(f.call(channel, payload)).rejects.toThrow();
    }
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();

    // Another account settles while the restore waits on the relay: the restore stays the first person's.
    const restored = f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } });
    f.account.person = { kind: "human", humanId: "user_other" };
    await restored;
    expect(f.capture.restoreFileToBeforeMoment).toHaveBeenCalledWith("m-schema", OWNER, { expectedHeadMomentId: "m-schema" });
  });
});
