import { describe, expect, it, vi } from "vitest";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { writeAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import { collectionAutomationId, definitionHash } from "@dohc/automation-executor/automation-plan";
import type { CollectionAutomations } from "@dohc/automation-executor/collection-automations";
import { CHANNELS } from "./channels";
import { registerStopAndRestoreIpc } from "./stopAndRestoreIpc";
import {
  LiveDocumentMutationError,
  RestoreHeadChangedError,
  type WorkspaceEngineMomentDetail,
} from "../workspaces/workspaceEngineCapture";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
type Pass = { undone: number; left: number; reverted: number; missing: number; keptFields: string[]; otherKept: number; errorMessage: string | null };
const NOTHING: Pass = { undone: 0, left: 0, reverted: 0, missing: 0, keptFields: [], otherKept: 0, errorMessage: null };
const SCHEMA = "trip/packing/collection.yaml";

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
} = {}) {
  const handlers = new Map<string, (event: { sender: string }, payload: unknown) => unknown>();
  const calls: Array<{ path: string; method: string }> = [];
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
  const capture = {
    readMoment: vi.fn(async (): Promise<WorkspaceEngineMomentDetail | null> => {
      if (options.protectedMoment) return { protected: true, moment: { ...schemaMoment, momentOrder: 1, protected: true } as never };
      return options.moment === null ? null : { protected: false, moment: options.moment ?? schemaMoment };
    }),
    listObjectMomentsAfter: vi.fn(async () => []),
    restoreFileToBeforeMoment: vi.fn(async (momentId: string, _options?: { expectedHeadMomentId?: string }) => {
      if (options.changed) throw new RestoreHeadChangedError(SCHEMA);
      if (options.restoreError) throw options.restoreError;
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
    queuePull,
    deletePath: async () => undefined,
    notifyRenderer: () => undefined,
    assertOriginalWorkspace: () => undefined,
    syncNow: async () => { await options.syncNow?.(); },
    serverRuns: { restore: async (_workspaceId, definitions, again) => (await options.serverRestore?.(definitions, again)) ?? NOTHING },
  });
  const call = (channel: string, payload: Record<string, unknown>) =>
    handlers.get(channel)!({ sender: "window" }, { workspaceId: WORKSPACE_ID, ...payload });
  return { call, calls, bodies, capture, queuePull, sharesChanged };
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
      fieldsKept: 0, fieldsMissing: 0,
      errorMessage: null,
    });
    expect(f.capture.restoreFileToBeforeMoment).toHaveBeenCalledWith("m-schema", { expectedHeadMomentId: "m-schema" });
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
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({ runsUndone: 3, runsLeft: 1, fieldsKept: 0, fieldsMissing: 1, errorMessage: null });
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
      return { ...result, keptFields: hosts[host].some((run) => run.kept) ? ["f".repeat(32)] : [] };
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
      .resolves.toMatchObject({ runsUndone: 2, runsLeft: 0, fieldsKept: 0, fieldsMissing: 0, errorMessage: null });
    expect([computers.relay.value, computers.copies.here.value, computers.copies.server.value]).toEqual([0, 0, 0]);
  });

  it("stops undoing when a sync between passes fails, and says so", async () => {
    const computers = twoComputers({ here: [[0, 1]], server: [[1, 2]] }, 2);
    const f = fixture({ ...automationsFile(), ...computers, syncNow: async () => { throw new Error("dohc could not sync this workspace with your server, so it stopped undoing runs part way. Try again."); } });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }))
      .resolves.toMatchObject({ errorMessage: "dohc could not sync this workspace with your server, so it stopped undoing runs part way. Try again." });
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
      runsUndone: 2, runsLeft: 0, fieldsKept: 0, errorMessage: "dohc could not sync this workspace with your server, so it stopped undoing runs part way. Try again.",
    });
  });

  it("keeps a value someone set after the runs, and counts the field once", async () => {
    // Runs wrote 0 to 1 here and 1 to 2 on the server; then someone set 9.
    const computers = twoComputers({ here: [[0, 1]], server: [[1, 2]] }, 9);
    const f = fixture({ ...automationsFile(), ...computers });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }))
      .resolves.toMatchObject({ runsUndone: 2, runsLeft: 0, fieldsKept: 1, errorMessage: null });
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
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).rejects.toThrow();
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
      errorMessage: null,
    });
    const down = fixture({ restoreError: new Error("The workspace engine is not running.") });
    await expect(down.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      review: [],
      errorMessage: "The workspace engine is not running.",
    });
  });

  it("names a protected file it cannot restore, instead of waiting for it", async () => {
    const f = fixture({ protectedMoment: true });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }))
      .rejects.toThrow(`dohc cannot restore ${SCHEMA} here because its contents are protected. Restore it from its History.`);
    expect(f.queuePull).not.toHaveBeenCalled();
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
    expect(f.capture.restoreFileToBeforeMoment.mock.calls.map(([id]) => id)).toEqual(["back-2", "back-1"]);
  });
});
