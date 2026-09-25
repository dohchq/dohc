import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { RelayConflictError, SharedFileReadOnlyError, ShareUnavailableError, type ShareProposalOp } from "@dohc/workspace-contracts/relay";
import { CHANNELS } from "./channels";
import { registerShareProposalsIpcHandlers } from "./shareProposalsIpc";
import { CredentialSessionCache } from "../workspaces/credentialSessionCache";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { EngineRelayWorkspaceClient } from "../workspaces/engineRelayClient";
import { createWorkspaceAuthorityOwner, type PhysicalWorkspace } from "../workspaces/workspaceAuthorityOwner";
import { createRendererWorkspaceOperationRunner, type ExactRendererWorkspaceOperation } from "../window/rendererWorkspaceOperation";
import { withStaleSensitiveWorkspaceOperation } from "../workspaces/workspaceAssets";
import { WORKSPACE_TEXT_EDITOR_MAX_BYTES } from "../workspaces/workspaceTextLimits";
import { deferred } from "../testing/deferred";

const credentials: CloudCredentials = {
  serverUrl: "https://account.example.test", relayUrl: "https://relay.example.test",
  token: "token", userId: "owner", email: "owner@example.test",
};
const op: ShareProposalOp = {
  opIndex: 0, basedOnPath: "before.md", operation: "write", afterPath: "after.md",
  afterBlobSha256: "a".repeat(64), afterContentKind: "text", afterByteLength: 8,
  currentPath: "current.md", drifted: false,
};
const proposal = { proposalId: "proposal", shareId: "share", proposedByEmail: "sender@example.test", createdAtMs: 1, ops: [op] };

async function harness() {
  const workspace: RegistryEntry = {
    workspaceId: "workspace", rootPath: resolve("/share-proposals"), kind: "personal", mode: "local-first",
    remote: { serverUrl: credentials.serverUrl, ownerUserId: credentials.userId },
  };
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id: string) => id === workspace.workspaceId ? workspace : null,
    canonicalizeRoot: (root: string) => root, createState: () => ({}),
  });
  const attachmentId = await authorities.withOperation(workspace.workspaceId, operation => operation.workspace.attachmentId);
  let rendererCurrent = true;
  const session = { workspaceId: workspace.workspaceId, attachmentId, generation: 1, isCurrent: () => rendererCurrent };
  type Event = { sender: string; trusted: boolean };
  type Workspace = PhysicalWorkspace<RegistryEntry>;
  type Operation = ExactRendererWorkspaceOperation<Workspace, object, typeof session>;
  type Dependencies = Parameters<typeof registerShareProposalsIpcHandlers<string, Event, Operation>>[0];
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<string, Workspace, object, typeof session>({
    currentSession: () => session, withPhysicalOperation: (id, work) => authorities.withOperation(id, work),
  });
  const cache = new CredentialSessionCache<CloudCredentials>();
  cache.set(credentials);
  const warm = vi.fn<() => Promise<void>>(async () => undefined);
  const list = vi.fn<Dependencies["listShareProposals"]>(async () => [{ ...proposal, ops: 1 }]);
  const read = vi.fn<Dependencies["readShareProposal"]>(async () => proposal);
  const readOp = vi.fn<Dependencies["readShareProposalOp"]>(async () => op);
  const settle = vi.fn<Dependencies["settleShareProposal"]>(async () => ({ proposalId: "proposal", state: "accepted" }));
  const listMine = vi.fn<Dependencies["listMyShareProposals"]>(async () => [{ proposalId: "proposal", state: "open", createdAtMs: 1, settledAtMs: null, ops: 2 }]);
  const withdraw = vi.fn<Dependencies["withdrawShareProposal"]>(async () => ({ proposalId: "proposal", state: "withdrawn" }));
  const readText = vi.fn<Dependencies["readOwnedWorkspaceTextFor"]>(async () => ({ text: "current", truncated: false, contentHash: "hash" }));
  const queue = vi.fn();
  const reconcile = vi.fn<Dependencies["shareViewFiles"]["reconcile"]>(async () => ({
    kind: "settle", capturedPaths: 2, repairedPaths: 1, unjournalablePaths: [], collisionRecordQuarantined: false,
  }));
  const submit = vi.fn<EngineRelayWorkspaceClient["submitShareProposal"]>(async () => ({ submitted: 1, proposalId: "proposal", skippedOutsideShare: 0, morePending: false }));
  const pushDirect = vi.fn<EngineRelayWorkspaceClient["pushDirectWrites"]>(async () => ({ writes: [], morePending: false }));
  const relayFor = vi.fn<Dependencies["receivedShareEngine"]["relayFor"]>(() => ({ submitShareProposal: submit, pushDirectWrites: pushDirect } as unknown as EngineRelayWorkspaceClient));
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const reported = vi.fn<Dependencies["reportDirectWrites"]>(() => true);
  const directWrites = registerShareProposalsIpcHandlers<string, Event, Operation>({
    registerHandler: (channel, handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    assertTrustedSender: (event) => { if (!event.trusted) throw new Error("untrusted"); },
    withRendererWorkspaceOperation, warmCredentialCache: warm,
    withWorkspaceAuthority: (id, work) => authorities.withOperation(id, work),
    reportDirectWrites: reported,
    currentCredentials: () => cache.snapshot().credentials, currentCredentialGeneration: () => cache.snapshot().generation,
    normalizeServerUrl: url => url.replace(/\/+$/u, ""),
    isRecordValue: (value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value),
    readOwnedWorkspaceTextFor: readText, activity: { queueCloudSync: queue },
    listShareProposals: list, readShareProposal: read, readShareProposalOp: readOp, settleShareProposal: settle,
    listMyShareProposals: listMine, withdrawShareProposal: withdraw,
    withStaleSensitiveWorkspaceOperation, shareViewFiles: { reconcile }, receivedShareEngine: { relayFor },
  });
  const invoke = (channel: string, payload: unknown = { workspaceId: "workspace" }, trusted = true) =>
    Promise.resolve().then(() => handlers.get(channel)!({ sender: "window", trusted }, payload));
  const recipient = (access: "view" | "comment" | "edit" = "edit", ended = false) => {
    delete workspace.remote;
    workspace.shareView = {
      shareId: "pinned-share", granterEmail: "granter@example.test", genericChatWritable: false,
      grantedSelector: { paths: ["docs"], versionId: null, access }, relayUrl: credentials.relayUrl, ended,
    };
  };
  return { workspace, authorities, attachmentId, cache, warm, list, read, readOp, settle, listMine, withdraw,
    readText, queue, reconcile, submit, pushDirect, relayFor, handlers, invoke, recipient, reported, directWrites,
    retireRenderer: () => { rendererCurrent = false; } };
}

afterEach(() => vi.unstubAllGlobals());

describe("registered share proposal handlers", () => {
  it("preserves registration order and trusts the sender before parsing or loading credentials", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual([
      CHANNELS.listShareProposals, CHANNELS.readShareProposalChanges, CHANNELS.readShareProposalFileContent,
      CHANNELS.settleShareProposal, CHANNELS.submitShareChanges, CHANNELS.pushShareDirectWrites,
      CHANNELS.listMyShareChanges, CHANNELS.withdrawShareChanges,
    ]);
    for (const channel of h.handlers.keys()) await expect(h.invoke(channel, null, false)).rejects.toThrow("untrusted");
    await expect(h.invoke(CHANNELS.listShareProposals, { workspaceId: "" })).rejects.toThrow();
    expect(h.warm).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });

  it("refuses a received view or a foreign owner before using owner proposal routes", async () => {
    const h = await harness();
    h.workspace.remote!.ownerUserId = "someone-else";
    await expect(h.invoke(CHANNELS.listShareProposals)).rejects.toThrow("account that synced");
    h.recipient();
    await expect(h.invoke(CHANNELS.listShareProposals)).rejects.toThrow("workspace you shared from");
    expect(h.list).not.toHaveBeenCalled();
  });

  it("stops before relay work if the renderer retires while credentials warm", async () => {
    const h = await harness();
    const started = deferred(); const held = deferred();
    h.warm.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.listShareProposals);
    await started.promise; h.retireRenderer(); held.resolve();
    await expect(result).rejects.toThrow("changed workspaces");
    expect(h.list).not.toHaveBeenCalled();
  });

  it.each(["credentials", "renderer", "authority", "remote"] as const)("rejects an owner relay response after %s changes", async (change) => {
    const h = await harness();
    const started = deferred(); const held = deferred<Awaited<ReturnType<typeof h.list>>>();
    h.list.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.listShareProposals);
    await started.promise;
    let drained: Promise<void> | undefined;
    if (change === "credentials") h.cache.set({ ...credentials });
    if (change === "renderer") h.retireRenderer();
    if (change === "authority") drained = h.authorities.invalidate("workspace");
    if (change === "remote") h.workspace.remote!.ownerUserId = "new-owner";
    held.resolve([{ ...proposal, ops: 1 }]);
    await expect(result).rejects.toThrow(); await drained;
  });

  it("lists public counts and builds file rows only for paths the proposal names", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.listShareProposals)).resolves.toEqual({ proposals: [{ ...proposal, ops: 1 }] });
    h.read.mockResolvedValue({ ...proposal, ops: [op, { ...op, opIndex: 1, afterPath: null, basedOnPath: null, currentPath: null }] });
    await expect(h.invoke(CHANNELS.readShareProposalChanges, { workspaceId: "workspace", proposalId: "proposal" })).resolves.toEqual({
      proposedByEmail: proposal.proposedByEmail,
      files: [{ opIndex: 0, path: "after.md", operation: "write", drifted: false, afterByteLength: 8 }],
    });
  });

  it("reads the current attachment and treats unreadable or oversized previews as absent", async () => {
    const h = await harness();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("incoming"));
    vi.stubGlobal("fetch", fetch);
    const payload = { workspaceId: "workspace", proposalId: "proposal", opIndex: 0 };
    await expect(h.invoke(CHANNELS.readShareProposalFileContent, payload)).resolves.toEqual({ currentText: "current", incomingText: "incoming" });
    expect(h.readText).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: h.attachmentId }), "current.md");
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/sync/workspace/blobs/"), expect.objectContaining({ headers: { authorization: "Bearer token" } }));
    h.readText.mockResolvedValue({ text: "prefix", truncated: true, contentHash: null });
    fetch.mockResolvedValue(new Response(new Uint8Array(WORKSPACE_TEXT_EDITOR_MAX_BYTES + 1)));
    await expect(h.invoke(CHANNELS.readShareProposalFileContent, payload)).resolves.toEqual({ currentText: null, incomingText: null });
  });

  it("does not fetch an incoming preview after credentials change during the current-text read", async () => {
    const h = await harness();
    const started = deferred(); const held = deferred<Awaited<ReturnType<typeof h.readText>>>();
    const fetch = vi.fn<typeof globalThis.fetch>(); vi.stubGlobal("fetch", fetch);
    h.readText.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.readShareProposalFileContent, { workspaceId: "workspace", proposalId: "proposal", opIndex: 0 });
    await started.promise; h.cache.clear(); held.resolve({ text: "old", truncated: false, contentHash: "hash" });
    await expect(result).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });

  it("queues a pull only for a current accepted proposal and preserves raced settlement states", async () => {
    const h = await harness(); const payload = { workspaceId: "workspace", proposalId: "proposal", decision: "accept" };
    await expect(h.invoke(CHANNELS.settleShareProposal, payload)).resolves.toEqual({ state: "accepted" });
    expect(h.queue).toHaveBeenCalledWith("workspace"); h.queue.mockClear();
    h.settle.mockResolvedValue({ proposalId: "proposal", state: "withdrawn" });
    await expect(h.invoke(CHANNELS.settleShareProposal, payload)).rejects.toThrow("no longer open");
    expect(h.queue).not.toHaveBeenCalled();
    const started = deferred(); const held = deferred<Awaited<ReturnType<typeof h.settle>>>();
    h.settle.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.settleShareProposal, payload);
    await started.promise; h.cache.set(credentials); held.resolve({ proposalId: "proposal", state: "accepted" });
    await expect(result).rejects.toThrow("cloud binding changed"); expect(h.queue).not.toHaveBeenCalled();
  });

  it.each(["view", "comment"] as const)("keeps listing and withdrawal available after downgrade to %s", async (access) => {
    const h = await harness(); h.recipient(access, true);
    await expect(h.invoke(CHANNELS.submitShareChanges)).rejects.toThrow();
    expect(h.reconcile).not.toHaveBeenCalled();
    await expect(h.invoke(CHANNELS.listMyShareChanges)).resolves.toEqual({ proposals: [{ proposalId: "proposal", state: "open", createdAtMs: 1, files: 2 }] });
    await expect(h.invoke(CHANNELS.withdrawShareChanges, { workspaceId: "workspace", proposalId: "proposal", shareId: "forged" })).resolves.toEqual({ state: "withdrawn" });
    expect(h.withdraw).toHaveBeenCalledWith(expect.objectContaining({ shareId: "pinned-share" }));
  });

  it("settles local changes before submitting the pinned grant and uses a new submit id each time", async () => {
    const h = await harness(); h.recipient();
    const payload = { workspaceId: "workspace", shareId: "forged", grantedSelector: { paths: ["/"] } };
    await expect(h.invoke(CHANNELS.submitShareChanges, payload)).resolves.toEqual({ ok: true, submitted: 1, skippedOutsideShare: 0, morePending: false, capturedLocalChanges: 3 });
    expect(h.reconcile).toHaveBeenCalledWith(expect.anything(), { kind: "standalone", workspaceId: "workspace" }, "settle");
    expect(h.relayFor).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: h.attachmentId, engineWorkspaceId: "workspace" }));
    expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({ shareId: "pinned-share", grantedSelector: { paths: ["docs"], versionId: null, access: "edit" } }));
    await h.invoke(CHANNELS.submitShareChanges, payload);
    expect(h.submit.mock.calls[0]![0].submitId).not.toBe(h.submit.mock.calls[1]![0].submitId);
    h.submit.mockRejectedValue(new Error("offline"));
    await expect(h.invoke(CHANNELS.submitShareChanges)).resolves.toEqual({ ok: false, capturedLocalChanges: 3, errorMessage: "offline" });
  });

  it("pushes direct writes through the pinned grant without settling files first", async () => {
    const h = await harness(); h.recipient();
    h.pushDirect
      .mockResolvedValueOnce({
        writes: [
          { paths: ["docs/packing/collection.yaml"], result: "written" },
          { paths: ["docs/ideas/collection.yaml"], result: "stale", stalePath: "docs/ideas", currentBlobSha256: null },
        ],
        morePending: true,
      })
      .mockResolvedValueOnce({
        writes: [{ paths: ["docs/packing/automations.yaml"], result: "refused", reason: "not valid" }],
        morePending: false,
      });
    await expect(h.invoke(CHANNELS.pushShareDirectWrites, { workspaceId: "workspace", shareId: "forged" })).resolves.toEqual({
      status: "pushed",
      writes: [
        { paths: ["docs/packing/collection.yaml"], result: "written" },
        { paths: ["docs/ideas/collection.yaml"], result: "stale", stalePath: "docs/ideas" },
        { paths: ["docs/packing/automations.yaml"], result: "refused", reason: "not valid" },
      ],
    });
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.pushDirect).toHaveBeenCalledTimes(2);
    expect(h.pushDirect).toHaveBeenCalledWith({
      shareId: "pinned-share", grantedSelector: { paths: ["docs"], versionId: null, access: "edit" },
    });
  });

  it("reports a failed push with the writes answered before it, and whether trying again can help", async () => {
    const h = await harness(); h.recipient();
    h.pushDirect
      .mockResolvedValueOnce({
        writes: [{ paths: ["docs/packing/automations.yaml"], result: "refused", reason: "not valid" }],
        morePending: true,
      })
      .mockRejectedValueOnce(new Error("offline"));
    await expect(h.invoke(CHANNELS.pushShareDirectWrites)).resolves.toEqual({
      status: "failed",
      writes: [{ paths: ["docs/packing/automations.yaml"], result: "refused", reason: "not valid" }],
      errorMessage: "offline",
      lasting: false,
    });
    h.pushDirect.mockRejectedValueOnce(new SharedFileReadOnlyError());
    await expect(h.invoke(CHANNELS.pushShareDirectWrites)).resolves.toMatchObject({ status: "failed", lasting: true });
    h.pushDirect.mockRejectedValueOnce(Object.assign(new Error("too large"), { wireCode: "PAYLOAD_TOO_LARGE" }));
    await expect(h.invoke(CHANNELS.pushShareDirectWrites)).resolves.toMatchObject({ status: "failed", lasting: true });
    h.pushDirect.mockRejectedValueOnce(new RelayConflictError());
    await expect(h.invoke(CHANNELS.pushShareDirectWrites)).resolves.toMatchObject({ status: "failed", lasting: true });
    h.pushDirect.mockRejectedValueOnce(Object.assign(new Error("busy"), { wireCode: "OVERLOADED" }));
    await expect(h.invoke(CHANNELS.pushShareDirectWrites)).resolves.toMatchObject({ status: "failed", lasting: false });
  });

  it("says when the relay does not take direct writes, and stops asking", async () => {
    const h = await harness(); h.recipient();
    h.pushDirect.mockRejectedValueOnce(new ShareUnavailableError());
    await expect(h.invoke(CHANNELS.pushShareDirectWrites)).resolves.toEqual({ status: "unavailable" });
    await expect(h.invoke(CHANNELS.pushShareDirectWrites)).resolves.toEqual({ status: "unavailable" });
    expect(h.pushDirect).toHaveBeenCalledTimes(1);
  });

  it("pushes after a save in main, after the window left the view, and reports the answer", async () => {
    vi.useFakeTimers();
    try {
      const h = await harness(); h.recipient();
      h.pushDirect.mockResolvedValueOnce({
        writes: [{ paths: ["docs/packing/automations.yaml"], result: "refused", reason: "not valid" }],
        morePending: false,
      });
      h.directWrites.shareViewEdited("workspace");
      h.directWrites.shareViewEdited("workspace");
      h.retireRenderer();
      await vi.advanceTimersByTimeAsync(800);
      await vi.waitFor(() => expect(h.reported).toHaveBeenCalledTimes(1));
      expect(h.pushDirect).toHaveBeenCalledTimes(1);
      expect(h.reported).toHaveBeenCalledWith("workspace", {
        status: "pushed",
        writes: [{ paths: ["docs/packing/automations.yaml"], result: "refused", reason: "not valid" }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends rows past one answer's bound to the windows as an answer of their own", async () => {
    const h = await harness(); h.recipient();
    const page = (count: number, morePending = true) => ({
      writes: Array.from({ length: count }, (_, index) => ({ paths: [`docs/c${index}/collection.yaml`], result: "refused" as const, reason: "" })),
      morePending,
    });
    h.pushDirect.mockResolvedValueOnce(page(2_000)).mockResolvedValueOnce(page(501)).mockResolvedValueOnce(page(1, false));
    const result = await h.invoke(CHANNELS.pushShareDirectWrites) as { status: string; writes: unknown[] };
    expect(h.pushDirect).toHaveBeenCalledTimes(3);
    expect(h.reported).toHaveBeenCalledTimes(1);
    const [workspaceId, first] = h.reported.mock.calls[0]!;
    expect(workspaceId).toBe("workspace");
    expect(first.status === "pushed" && first.writes).toHaveLength(2_500);
    expect(result.status).toBe("pushed");
    expect(result.writes).toHaveLength(2);
  });

  it.each(["view", "comment"] as const)("pushes nothing from a %s share", async (access) => {
    const h = await harness(); h.recipient(access);
    await expect(h.invoke(CHANNELS.pushShareDirectWrites)).rejects.toThrow();
    expect(h.pushDirect).not.toHaveBeenCalled();
  });

  it("refuses a changed grant after local reconciliation without submitting", async () => {
    const h = await harness(); h.recipient();
    const started = deferred(); const held = deferred<Awaited<ReturnType<typeof h.reconcile>>>();
    h.reconcile.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.submitShareChanges);
    await started.promise; h.recipient("view");
    held.resolve({ kind: "settle", capturedPaths: 0, repairedPaths: 0, unjournalablePaths: [], collisionRecordQuarantined: false });
    await expect(result).rejects.toThrow(); expect(h.submit).not.toHaveBeenCalled();
  });

  it("refuses a recipient on another relay and rejects grant changes during its listing", async () => {
    const h = await harness(); h.recipient();
    h.cache.set({ ...credentials, relayUrl: "https://other.example.test" });
    await expect(h.invoke(CHANNELS.listMyShareChanges)).rejects.toThrow("server this share came from");
    expect(h.listMine).not.toHaveBeenCalled();
    h.cache.set(credentials);
    const started = deferred(); const held = deferred<Awaited<ReturnType<typeof h.listMine>>>();
    h.listMine.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.listMyShareChanges);
    await started.promise; h.recipient("comment"); held.resolve([]);
    await expect(result).rejects.toThrow("shared view changed");
  });

  it("refuses unsafe reconciliation and reports a raced withdrawal honestly", async () => {
    const h = await harness(); h.recipient();
    h.reconcile.mockResolvedValue({ kind: "settle", capturedPaths: 0, repairedPaths: 0, unjournalablePaths: [], collisionRecordQuarantined: true });
    await expect(h.invoke(CHANNELS.submitShareChanges)).rejects.toThrow("damaged shared file recovery");
    h.reconcile.mockResolvedValue({ kind: "settle", capturedPaths: 0, repairedPaths: 0, unjournalablePaths: [{ path: "docs/file", reason: "unreadable" }], collisionRecordQuarantined: false });
    await expect(h.invoke(CHANNELS.submitShareChanges)).rejects.toThrow(); expect(h.submit).not.toHaveBeenCalled();
    h.withdraw.mockResolvedValue({ proposalId: "proposal", state: "accepted" });
    await expect(h.invoke(CHANNELS.withdrawShareChanges, { workspaceId: "workspace", proposalId: "proposal" })).rejects.toThrow("already answered");
  });
});
