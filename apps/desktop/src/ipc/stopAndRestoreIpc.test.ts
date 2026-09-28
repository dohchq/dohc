import { describe, expect, it, vi } from "vitest";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import type { CollectionAutomations } from "@dohc/automation-executor/collection-automations";
import { CHANNELS } from "./channels";
import { registerStopAndRestoreIpc } from "./stopAndRestoreIpc";
import {
  LiveDocumentMutationError,
  RestoreHeadChangedError,
  type WorkspaceEngineMomentDetail,
} from "../workspaces/workspaceEngineCapture";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
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
      state: { collectionAutomations: {} as CollectionAutomations },
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
