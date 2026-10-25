import { relayShareOperations } from "./shareOperations";
import { OwnerRestoreActionResponse } from "./ownerRestoreContract";
import { registerOperations } from "./operationTable";
import { describe, expect, it, vi } from "vitest";
import { createRelaySharesIpcHandlers } from "./relaySharesIpc";
import { createPresencePollRegistry } from "../collab/presencePollRegistry";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import { buildShareCode } from "../workspaces/syncCode";
import { deferred } from "../testing/deferred";

type Sender = { id: number };
type Event = { sender: Sender };
type Workspace = {
  workspaceId: string;
  attachmentId: symbol;
  shareView?: unknown;
};
type Operation = {
  workspace: Workspace;
  assertCurrent(): void;
};
type Dependencies = Parameters<typeof createRelaySharesIpcHandlers<
  Sender, Event, Workspace, Operation
>>[0];

const workspaceId = "workspace";
const linkInput = { workspaceId, paths: ["notes.md"], access: "view" };
const linkResult = {
  ok: true, shareId: "share", grantId: "grant", url: "https://relay.example/link",
};
const pollInput = {
  workspaceId, shareId: "share", since: 0, hold: 30_000, limit: 10,
  pollId: "54df38bc-6863-46a7-964a-820d81e833aa",
};
const activityResult = {
  ok: true, latestRevision: 1, cursorRevision: 1, hasMore: false,
  messages: [], principals: [], linkCommentsPaused: false,
};

function harness() {
  const workspace: Workspace = { workspaceId, attachmentId: Symbol("attachment") };
  const credentials: CloudCredentials = {
    serverUrl: "https://account.example", relayUrl: "https://relay.example",
    userId: "owner", email: "owner@example.com", token: "owner-token",
  };
  let generation = 1;
  let rendererCurrent = true;
  let physicalCurrent = true;
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner({
    currentSession: (_sender: Sender) => ({
      workspaceId, attachmentId: workspace.attachmentId, generation: 1,
      isCurrent: () => rendererCurrent,
    }),
    withPhysicalOperation: async <Result>(
      requestedWorkspaceId: string,
      work: (operation: {
        workspace: Workspace; state: object; signal: AbortSignal; assertCurrent(): void;
      }) => Result | Promise<Result>,
    ) => {
      const attached = requestedWorkspaceId === workspaceId
        ? workspace
        : { ...workspace, workspaceId: requestedWorkspaceId, attachmentId: Symbol("other") };
      return work({
        workspace: attached, state: {}, signal: new AbortController().signal,
        assertCurrent() {
          if (!physicalCurrent) throw new Error("physical workspace retired");
        },
      });
    },
  });
  const workspaceOperations = vi.fn();
  const remote = vi.fn(async (_workspace: Workspace, _options?: { allowPaused: boolean }) => ({ credentials, credentialGeneration: generation }));
  const request = vi.fn<(
    credentials: CloudCredentials, path: string, init?: RequestInit, options?: unknown,
  ) => Promise<unknown>>(async () => linkResult);
  const accountRequest = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(
    async () => ({ granted: [], received: [] }),
  );
  const polls = createPresencePollRegistry();
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const trusted = vi.fn((event: Event) => {
    if (event.sender.id < 0) throw new Error("untrusted sender");
  });
  const warm = vi.fn(async () => undefined);
  const sharesChanged = vi.fn<(workspaceId: string | null) => void>();
  const reconcileReceivedShares = vi.fn<(listing: unknown) => Promise<void>>(async () => undefined);
  let enrolled=true;
  const localStops = vi.fn<Dependencies["listOwnerLiveStops"]>(async () => []);
  const ownerLiveStop=vi.fn<Dependencies["ownerLiveStop"]>(async (_workspace,action,path) => action==="clear" || action==="retired" ? undefined : ({state:action==="release" || !enrolled ? "released" : "requested",relayDatabaseNamespace:enrolled ? "relay" : "",retirementOwed:true,document:{mainVersionId:"main",objectId:"object",currentPath:path},binding:enrolled ? {workspaceId,mainVersionId:"main",objectId:"object",lineageClaimId:"a".repeat(64),currentPath:path,selectorPaths:[path],restoreFenceGeneration:0} : null}));
  const ownerHandlers = createRelaySharesIpcHandlers<Sender, Event, Workspace, Operation>({
    remoteForWorkspace: remote,
    currentCredentialGeneration: () => generation,
    currentCredentials: () => credentials,
    warmCredentialCache: warm,
    relayShareJson: accountRequest as Dependencies["relayShareJson"],
    relayShareJsonWithCredentials: request as Dependencies["relayShareJsonWithCredentials"],
    relayShareErrorCopy: (status) => `sharing failed (${status})`,
    relayShareDiscussionActivityPolls: polls,
    ownerLiveStop,
    listOwnerLiveStops: localStops,
    sharesChanged,
    reconcileReceivedShares,
  });
  registerOperations<typeof relayShareOperations, Event, Operation>({
    handle: (channel, handler) => {
      expect(handlers.has(channel)).toBe(false);
      handlers.set(channel, handler);
    },
    assertTrustedSender: trusted,
    withActiveWorkspace: (event, requestedWorkspaceId, message, work) => {
      workspaceOperations(event.sender, requestedWorkspaceId, message);
      return withRendererWorkspaceOperation(event.sender, requestedWorkspaceId, message, work);
    },
  }, relayShareOperations, ownerHandlers);
  const invoke = async (channel: string, payload?: unknown, senderId = 1) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return handler({ sender: { id: senderId } }, payload);
  };
  return {
    workspace, workspaceOperations, credentials, remote, request, accountRequest, polls, handlers, warm, invoke, sharesChanged,
    reconcileReceivedShares,
    unenrolled:() => {enrolled=false;},
    localStops,
    ownerLiveStop,
    retireRenderer: () => { rendererCurrent = false; },
    retirePhysical: () => { physicalCurrent = false; },
    rotateCredentials: () => { generation += 1; },
  };
}

describe("named browser invitations", () => {
  it.each(["preparing","paused","unavailable","renamed","not-yet-enrolled"])("retires %s documents without claiming a restore generation",async () => {
    const h=harness();h.unenrolled();
    h.request.mockResolvedValue({ok:true,path:"live.md",objectId:"object",status: "retired", acceptedCursor: 0});
    await expect(h.invoke(relayShareOperations.stopOwnerLiveDocument.channel,{workspaceId,path:"live.md"})).resolves.toBeUndefined();
    expect(JSON.parse(h.request.mock.calls[0]![2]!.body as string)).toEqual({path:"live.md",objectId:"object",retire:true});
  });
  it.each([undefined, "https://share.example.test/s/edit/exact-grant"])("preserves the grant and optional server URL %s", async browserInvitationUrl => {
    const h = harness();
    h.request.mockResolvedValue({shareId: "share", grantId: "exact-grant", ...(browserInvitationUrl ? {browserInvitationUrl} : {})});
    const result = await h.invoke(relayShareOperations.createRelayShare.channel, {workspaceId, paths: ["docs"], recipientEmail: "friend@dohc.test", access: "edit"});
    expect(result).toEqual({shareId: "share", grantId: "exact-grant", browserInvitationUrl,
      shareCode: buildShareCode({shareId: "share", relayUrl: h.credentials.relayUrl!}), recipientEmail: "friend@dohc.test"});
    expect(h.request.mock.lastCall?.[2]?.body).toBe(JSON.stringify({recipientEmail: "friend@dohc.test", access: "edit", paths: ["docs"]}));
  });
  it("retains the listed grant URL without deriving it from desktop credentials", async () => {
    const h = harness(), browserInvitationUrl = "https://share.example.test/s/edit/exact-grant";
    h.accountRequest.mockResolvedValue({granted: [{shareId: "share", workspaceId: "remote-workspace", grantId: "exact-grant", generation: 1,
      recipientUserId: "friend", recipientEmail: "friend@dohc.test", selector: {paths: ["docs"], versionId: null}, access: "edit",
      createdAtMs: 1, revokedAtMs: null, browserInvitationUrl}]});
    expect(await h.invoke(relayShareOperations.listRelayShares.channel)).toMatchObject({granted: [{grantId: "exact-grant", browserInvitationUrl,
      shareCode: buildShareCode({shareId: "share", relayUrl: h.credentials.relayUrl!})}]});
  });
});

describe("owner live document enrollment", () => {
  it("offers Resume after a half success and clears the deferred Stop on retry", async () => {
    const h=harness();
    const saved={state:"released",binding:null,document:{mainVersionId:"main",objectId:"object",currentPath:"live.md"},retirementOwed:false,relayDatabaseNamespace:"relay",deferred:{unsentEdits:1,editable:true}};
    h.localStops.mockResolvedValue([saved]);
    h.request.mockImplementation(async (_credentials,path,init) => init?.method==="POST" ? {ok:true,path:"live.md",status:"ready"} : path.includes("retired=1") ? {ok:true,documents:[],nextCursor:null} : {ok:true,documents:[{path:"live.md",status:"ready"}]});
    h.ownerLiveStop.mockRejectedValueOnce(new Error("local clear failed"));
    await expect(h.invoke(relayShareOperations.resumeOwnerLiveDocument.channel,{workspaceId,path:"live.md"})).rejects.toThrow("local clear failed");
    const listed=await h.invoke(relayShareOperations.listOwnerLiveDocuments.channel,{workspaceId});
    expect(listed).toMatchObject({documents:[{path:"live.md",status:"ready",canResume:true,deferredStop:saved.deferred}]});
    h.ownerLiveStop.mockImplementationOnce(async (_workspace,action) => {
      expect(action).toBe("clear");h.localStops.mockResolvedValue([]);return undefined;
    });
    await h.invoke(relayShareOperations.resumeOwnerLiveDocument.channel,{workspaceId,path:"live.md"});
    expect(h.request.mock.calls.filter(([, ,init])=>init?.method==="POST")).toHaveLength(2);
    expect(h.ownerLiveStop).toHaveBeenLastCalledWith(h.workspace,"clear","live.md");
    expect(await h.invoke(relayShareOperations.listOwnerLiveDocuments.channel,{workspaceId})).toEqual({documents:[{path:"live.md",status:"ready",canResume:false}],nextCursor:null});
  });
  it("keeps the local Stop until Resume's POST succeeds", async () => {
    const h=harness(),posting=deferred<unknown>();
    h.request.mockReturnValueOnce(posting.promise);
    const resume=h.invoke(relayShareOperations.resumeOwnerLiveDocument.channel,{workspaceId,path:"live.md"});
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(1));
    expect(h.ownerLiveStop).not.toHaveBeenCalled();
    posting.reject(new Error("offline"));
    await expect(resume).rejects.toThrow("offline");
    expect(h.ownerLiveStop).not.toHaveBeenCalled();
    h.request.mockResolvedValueOnce({ok:true,path:"live.md",status:"ready"});
    await h.invoke(relayShareOperations.resumeOwnerLiveDocument.channel,{workspaceId,path:"live.md"});
    expect(h.ownerLiveStop).toHaveBeenCalledWith(h.workspace,"clear","live.md");
  });
  it("adds only deferred counts and editability to a stopped row",async () => {
    const h=harness();
    h.localStops.mockResolvedValue([{state:"released",binding:{workspaceId,mainVersionId:"main",objectId:"object",lineageClaimId:"a".repeat(64),currentPath:"old.md",selectorPaths:["old.md"],restoreFenceGeneration:0},document:{mainVersionId:"main",objectId:"object",currentPath:"old.md"},retirementOwed:false,relayDatabaseNamespace:"relay",deferred:{unsentEdits:65,editable:false}}]);
    h.request.mockImplementation(async (_credentials,path)=>path.includes("retired=1") ? {ok:true,documents:[{path:"old.md",objectId:"object",status: "retired", acceptedCursor: 0}],nextCursor:null} : {ok:true,documents:[]});
    await expect(h.invoke(relayShareOperations.listOwnerLiveDocuments.channel,{workspaceId})).resolves.toEqual({documents:[{path:"old.md",status: "retired",canResume:true,deferredStop:{unsentEdits:65,editable:false}}],nextCursor:null});
  });
  // Proves: a document stopped on a diverged server copy keeps the reason and
  // offers no Resume, whether its Stop finished or waits on this computer.
  it("offers no Resume for a document stopped on a diverged server copy, deferred or not",async () => {
    const h=harness();
    h.localStops.mockResolvedValue([{state:"released",binding:null,document:{mainVersionId:"main",objectId:"object",currentPath:"deferred.md"},retirementOwed:false,relayDatabaseNamespace:"relay",deferred:{unsentEdits:2,editable:true}}]);
    h.request.mockImplementation(async (_credentials,path)=>path.includes("retired=1")
      ? {ok:true,documents:[{path:"deferred.md",status:"retired",reason:"session-host-diverged"},{path:"stopped.md",status:"retired",reason:"session-host-diverged"}],nextCursor:null}
      : {ok:true,diverged:true,documents:[]});
    await expect(h.invoke(relayShareOperations.listOwnerLiveDocuments.channel,{workspaceId})).resolves.toEqual({documents:[
      {path:"deferred.md",status:"retired",reason:"session-host-diverged",canResume:false,deferredStop:{unsentEdits:2,editable:true}},
      {path:"stopped.md",status:"retired",reason:"session-host-diverged",canResume:false},
    ],nextCursor:null});
  });
  // Proves: a deferred Stop does not offer Resume on a document whose server
  // copy misses an edit made while live editing was off.
  it("offers no Resume for a deferred Stop on a document edited while live editing was off",async () => {
    const h=harness();
    h.localStops.mockResolvedValue([{state:"released",binding:null,document:{mainVersionId:"main",objectId:"object",currentPath:"edited.md"},retirementOwed:false,relayDatabaseNamespace:"relay",deferred:{unsentEdits:1,editable:true}}]);
    h.request.mockImplementation(async (_credentials,path)=>path.includes("retired=1")
      ? {ok:true,documents:[],nextCursor:null}
      : {ok:true,documents:[{path:"edited.md",status:"unavailable",reason:"live-edit-unadmitted"}]});
    await expect(h.invoke(relayShareOperations.listOwnerLiveDocuments.channel,{workspaceId})).resolves.toEqual({documents:[
      {path:"edited.md",status:"unavailable",reason:"live-edit-unadmitted",canResume:false,deferredStop:{unsentEdits:1,editable:true}},
    ],nextCursor:null});
  });
  const refusal = {shareId: "share", paths: ["docs"], code: "live_document_limit", message: "This server reached its live document limit."};

  it("lists bounded owner refusals without treating an empty candidate page as complete", async () => {
    const h = harness();
    h.request.mockResolvedValue({ok: true, refusals: [refusal], nextCursor: "other-share"});
    await expect(h.invoke(relayShareOperations.listOwnerLiveRefusals.channel, {workspaceId, after: "prior/share"})).resolves.toEqual({refusals: [refusal], nextCursor: "other-share"});
    expect(h.request).toHaveBeenCalledWith(h.credentials, "/sync/workspace/live-host?refusals=1&after=prior%2Fshare");
    h.request.mockResolvedValue({ok: true, refusals: [], nextCursor: "next-share"});
    await expect(h.invoke(relayShareOperations.listOwnerLiveRefusals.channel, {workspaceId})).resolves.toEqual({refusals: [], nextCursor: "next-share"});
  });

  it("retries enrollment using only the share identity and owner session", async () => {
    const h = harness(); h.request.mockResolvedValue({ok: true, documents: [{path: "docs/live.md", status: "preparing"}]});
    await expect(h.invoke(relayShareOperations.retryOwnerLiveShare.channel, {workspaceId, shareId: "share"})).resolves.toBeUndefined();
    expect(h.request).toHaveBeenCalledWith(h.credentials, "/sync/workspace/live-host", {method: "POST", body: JSON.stringify({shareId: "share", retry: true})});
    h.request.mockResolvedValue({ok: true, documents: [{path: "docs/live.md", status: "unavailable"}]});
    await expect(h.invoke(relayShareOperations.retryOwnerLiveShare.channel, {workspaceId, shareId: "share"})).rejects.toThrow("could not start");
  });

  it.each([relayShareOperations.listOwnerLiveRefusals.channel, relayShareOperations.retryOwnerLiveShare.channel])("rejects untrusted or shared-view %s before loading credentials", async channel => {
    const h = harness(), input = channel === relayShareOperations.listOwnerLiveRefusals.channel ? {workspaceId} : {workspaceId, shareId: "share"};
    await expect(h.invoke(channel, input, -1)).rejects.toThrow("untrusted sender");
    await expect(h.invoke(channel, {...input, credentials: h.credentials})).rejects.toThrow();
    h.workspace.shareView = {};
    await expect(h.invoke(channel, input)).rejects.toThrow("original workspace");
    expect(h.remote).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
  });

  it.each(["retireRenderer", "retirePhysical", "rotateCredentials"] as const)("discards refusal and retry responses after %s", async invalidate => {
    for (const channel of [relayShareOperations.listOwnerLiveRefusals.channel, relayShareOperations.retryOwnerLiveShare.channel]) {
      const h = harness(), response = deferred<unknown>(), started = deferred();
      h.request.mockImplementation(() => {started.resolve(); return response.promise;});
      const input = channel === relayShareOperations.listOwnerLiveRefusals.channel ? {workspaceId} : {workspaceId, shareId: "share"};
      const pending = h.invoke(channel, input);
      await started.promise; h[invalidate]();
      const read = vi.fn(() => true);
      response.resolve({get ok() {return read();}, refusals: [refusal], nextCursor: null, documents: []});
      await expect(pending).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
    }
  });

  it("rejects nonadvancing cursors and unsafe or oversized refusal responses", async () => {
    const h = harness();
    for (const result of [
      {ok: true, refusals: [], nextCursor: "same"},
      {ok: true, refusals: [{...refusal, paths: ["../secret"]}], nextCursor: null},
      {ok: true, refusals: Array(65).fill(refusal), nextCursor: null},
      {ok: true, refusals: [{...refusal, token: "server-secret"}], nextCursor: null},
    ]) {
      h.request.mockResolvedValue(result);
      await expect(h.invoke(relayShareOperations.listOwnerLiveRefusals.channel, {workspaceId, after: "same"})).rejects.toThrow();
    }
  });

  it("lists active and retired rows without exposing bindings", async () => {
    const h = harness();
    h.request.mockImplementation(async (_credentials, path) => path.includes("retired=1")
      ? {ok: true, documents: [{path: "old.md", objectId:"object", status: "retired", acceptedCursor: 0}], nextCursor: "old.md"}
      : {ok: true, documents: [
        {path: "live.md", status: "ready", document: {shareId: "secret"}},
        {path: "paused.md", status: "paused"},
        {path: "moved.md", status: "paused", reason: "document-unavailable"},
        {path: "changed.md", status: "unavailable", reason: "workspace-changed"},
        {path: "refused.md", status: "unavailable", reason: "session-host-refused"},
        {path: "unopened.md", status: "unavailable", reason: "live-document-without-lineage"},
        {path: "diverged.md", status: "unavailable", reason: "session-host-diverged"},
        {path: "edited.md", status: "unavailable", reason: "live-edit-unadmitted"},
      ]});
    await expect(h.invoke(relayShareOperations.listOwnerLiveDocuments.channel, {workspaceId, retiredAfter: "older.md"})).resolves.toEqual({
      documents: [
        {path: "old.md", status: "retired", canResume: true},
        {path: "live.md", status: "ready", canResume: false},
        {path: "paused.md", status: "paused", canResume: true},
        {path: "moved.md", status: "paused", reason: "document-unavailable", canResume: false},
        {path: "changed.md", status: "unavailable", reason: "workspace-changed", canResume: false},
        {path: "refused.md", status: "unavailable", reason: "session-host-refused", canResume: true},
        {path: "unopened.md", status: "unavailable", reason: "live-document-without-lineage", canResume: true},
        // Only the server's operator can continue a diverged server copy.
        {path: "diverged.md", status: "unavailable", reason: "session-host-diverged", canResume: false},
        // A Resume can't continue a server copy that misses an edit made while live editing was off.
        {path: "edited.md", status: "unavailable", reason: "live-edit-unadmitted", canResume: false},
      ], nextCursor: "old.md",
    });
    expect(h.request.mock.calls.map((call) => call[1])).toEqual([
      "/sync/workspace/live-host", "/sync/workspace/live-host?retired=1&after=older.md",
    ]);
  });

  it("uses the server owner credential session for retire and resume", async () => {
    const h = harness();
    h.request.mockImplementation(async (_credentials, path, init) => {
      expect(path).toBe("/sync/workspace/live-host");
      return init?.method === "DELETE"
        ? {ok: true, path: "live.md", objectId:"object", status: "retired", acceptedCursor: 37}
        : {ok: true, path: "live.md", status: "ready", document: {shareId: "server-only"}};
    });
    await expect(h.invoke(relayShareOperations.stopOwnerLiveDocument.channel, {workspaceId, path: "live.md"})).resolves.toBeUndefined();
    expect(h.ownerLiveStop).toHaveBeenCalledWith(h.workspace,"release","live.md",expect.objectContaining({objectId:"object"}),37);
    await expect(h.invoke(relayShareOperations.resumeOwnerLiveDocument.channel, {workspaceId, path: "live.md"})).resolves.toBeUndefined();
    expect(h.request.mock.calls.map((call) => [call[0], call[2]?.method, call[2]?.body])).toEqual([
      [h.credentials, "DELETE", JSON.stringify({path: "live.md", objectId:"object", retire: true, restoreFenceGeneration: 0})],
      [h.credentials, "POST", JSON.stringify({path: "live.md"})],
    ]);
  });

  it("rejects renderer identity, unsafe paths, and unavailable resumes", async () => {
    const h = harness();
    await expect(h.invoke(relayShareOperations.listOwnerLiveDocuments.channel, {workspaceId, credentials: h.credentials})).rejects.toThrow();
    await expect(h.invoke(relayShareOperations.stopOwnerLiveDocument.channel, {workspaceId, path: "../secret"})).rejects.toThrow();
    h.request.mockResolvedValue({ok: true, path: "live.md", status: "unavailable"});
    await expect(h.invoke(relayShareOperations.resumeOwnerLiveDocument.channel, {workspaceId, path: "live.md"})).rejects.toThrow("could not resume");
    expect(h.request.mock.calls.at(-1)?.[0]).toBe(h.credentials);
  });

  it.each([relayShareOperations.listOwnerLiveDocuments.channel, relayShareOperations.stopOwnerLiveDocument.channel, relayShareOperations.resumeOwnerLiveDocument.channel])(
    "refuses a shared view before loading credentials for %s", async channel => {
      const h = harness(); h.workspace.shareView = {};
      const input = channel === relayShareOperations.listOwnerLiveDocuments.channel ? {workspaceId} : {workspaceId, path: "live.md"};
      await expect(h.invoke(channel, input)).rejects.toThrow("original workspace");
      expect(h.remote).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
    });

  it("refuses mismatched action responses instead of claiming another file stopped", async () => {
    const h = harness(); h.request.mockResolvedValue({ok: true, path: "other.md", objectId:"other-object", status: "retired", acceptedCursor: 0});
    await expect(h.invoke(relayShareOperations.stopOwnerLiveDocument.channel, {workspaceId, path: "live.md"})).rejects.toThrow();
  });

  it("refuses invalid retired paging cursors and malformed document paths", async () => {
    const h = harness();
    h.request.mockImplementation(async (_credentials, path) => path.includes("retired=1")
      ? {ok: true, documents: [{path: "old.md", objectId:"object", status: "retired", acceptedCursor: 0}], nextCursor: "old.md"}
      : {ok: true, documents: []});
    await expect(h.invoke(relayShareOperations.listOwnerLiveDocuments.channel, {workspaceId, retiredAfter: "old.md"})).rejects.toThrow("list changed");
    h.request.mockResolvedValue({ok: true, documents: [{path: "../outside", status: "ready"}]});
    await expect(h.invoke(relayShareOperations.listOwnerLiveDocuments.channel, {workspaceId})).rejects.toThrow();
  });
});

describe("registered owner restore handler", () => {
  const document = {workspaceId, mainVersionId: "main", objectId: "object", lineageClaimId: "lineage"};
  const intent = {deliveryKind: "owner", operationId: "restore", document, shareId: "share", grantId: "grant",
    expectedGrantGeneration: 4, expectedDependentGrantIds: [], expectedFence: 1,
    restorePointCursor: 0, restorePointReceiptDigest: "a".repeat(64)};
  const status = {operationId: "restore", document, path: "notes.md", phase: "authority-invalidated", intent, proposalDigest: null};
  const statusInput = {workspaceId, action: "status", operationId: "restore"};

  it("rejects untrusted senders and caller-supplied identity before any remote work", async () => {
    const h = harness();
    await expect(h.invoke(relayShareOperations.ownerRestore.channel, statusInput, -1)).rejects.toThrow("untrusted sender");
    for (const input of [{...statusInput, ownerUserId: "owner"}, {...statusInput, credentials: h.credentials},
      {workspaceId, action: "begin", intent: {...intent, ownerUserId: "owner"}}]) {
      await expect(h.invoke(relayShareOperations.ownerRestore.channel, input)).rejects.toThrow();
    }
    expect(h.remote).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
  });

  it("keeps owner restore bound to the sender's original workspace", async () => {
    const h = harness();
    await expect(h.invoke(relayShareOperations.ownerRestore.channel, {...statusInput, workspaceId: "other"}))
      .rejects.toThrow("Sharing stopped because this window changed workspaces.");
    h.workspace.shareView = {};
    await expect(h.invoke(relayShareOperations.ownerRestore.channel, statusInput)).rejects.toThrow("original workspace");
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it("uses the original workspace and credential snapshot without forwarding owner identity", async () => {
    const h = harness(); h.request.mockResolvedValue(status);
    await expect(h.invoke(relayShareOperations.ownerRestore.channel, {workspaceId, action: "begin", intent})).resolves.toEqual(status);
    expect(h.request).toHaveBeenCalledWith(h.credentials, "/sync/workspace/live-restores",
      {method: "POST", body: JSON.stringify({intent})}, {retainRestoreConflict: true});
    h.workspace.shareView = {};
    await expect(h.invoke(relayShareOperations.ownerRestore.channel, statusInput)).rejects.toThrow("original workspace");
    expect(h.request).toHaveBeenCalledOnce();
  });

  it.each(["retireRenderer", "retirePhysical", "rotateCredentials"] as const)("rejects %s before request and before response parsing", async invalidate => {
    const loading = harness(), loaded = deferred<{credentials: CloudCredentials; credentialGeneration: number}>(), started = deferred();
    loading.remote.mockImplementation(() => {started.resolve(); return loaded.promise;});
    const pending = loading.invoke(relayShareOperations.ownerRestore.channel, statusInput);
    await started.promise; loading[invalidate](); loaded.resolve({credentials: loading.credentials, credentialGeneration: 1});
    await expect(pending).rejects.toThrow(); expect(loading.request).not.toHaveBeenCalled();

    const h = harness(), response = deferred<unknown>(), requested = deferred();
    h.request.mockImplementation(() => {requested.resolve(); return response.promise;});
    const result = h.invoke(relayShareOperations.ownerRestore.channel, statusInput);
    await requested.promise; h[invalidate]();
    const read = vi.fn(() => "restore"); response.resolve({...status, get operationId() {return read();}});
    await expect(result).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });

  it("keeps every action reply equal to its per-action parse", async () => {
    const options = {document, path: "notes.md", grants: [], points: [], authors: [], nextBeforeCursor: null, nextGrantCursor: null, pendingOperation: null};
    const plan = {intent, path: "notes.md", recipients: []};
    const digest = "a".repeat(64);
    const review = {operationId: "restore", workspaceId, binding: {...document, currentPath: "notes.md", selectorPaths: ["notes.md"], restoreFenceGeneration: 1},
      proposalDigest: digest, candidateDigest: digest, recordedAtMs: 1, point: {journalCursor: 0, receiptDigest: digest, markdownDigest: digest},
      selectedPointReceivedAtMs: null, selectedPointAuthority: null, frozenTerminal: null, selectedEventCount: 0, acceptedEventCount: 0,
      selectedHistoryDigest: digest, acceptedHistoryDigest: digest, nativeSourceManifestDigest: digest,
      content: {frozenMarkdown: "", restoredMarkdown: "", frozenMarkdownDigest: digest, restoredMarkdownDigest: digest, frozenMarkdownByteLength: 0, restoredMarkdownByteLength: 0},
      acceptedEvents: [], priorRestoreCuts: [], nativeSources: []};
    const inputs = {
      options: {workspaceId, action: "options", path: "notes.md"},
      plan: {workspaceId, action: "plan", document, shareId: "share", grantId: "grant", restorePointCursor: 0, restorePointReceiptDigest: "a".repeat(64)},
      begin: {workspaceId, action: "begin", intent},
      status: statusInput,
      prepare: {...statusInput, action: "prepare"},
      review: {...statusInput, action: "review"},
      confirm: {...statusInput, action: "confirm", proposalDigest: "b".repeat(64)},
      decline: {...statusInput, action: "decline"},
      unfinished: {workspaceId, action: "unfinished"},
    };
    for (const action of Object.keys(inputs) as (keyof typeof inputs)[]) {
      const responses = action === "options" ? [options] : action === "plan" ? [plan]
        : action === "begin" || action === "status" ? [status]
        : action === "decline" ? [{status: {...status, phase: "declined"}, result: {kind: "declined"}}, {status, result: {kind: "refused"}}]
        : action === "unfinished" ? [{restores: [{operationId: "restore", path: "notes.md", phase: "fenced", proposalDigest: null}], unreadable: 1, nextCursor: "restore"}]
        : [{status, result: {kind: "pending"}}, {status, result: {kind: "review-required"}},
          ...(action === "prepare" ? [{status, result: {kind: "prepared", proposalDigest: "b".repeat(64), candidateDigest: "c".repeat(64), recordedAtMs: 1, replayed: false}}]
            : action === "review" ? [{status, result: null}, {status, result: review}]
            : [false, true].map(moved => ({status, result: {kind: "resumed", proposalDigest: "b".repeat(64), receipt: {accepted: true}, moved}})))];
      for (const response of responses) {
        const h = harness();
        h.request.mockResolvedValue({...response, ignored: "stripped"});
        const parsed = OwnerRestoreActionResponse[action].parse(response);
        expect(relayShareOperations.ownerRestore.result.parse(parsed)).toEqual(parsed);
        await expect(h.invoke(relayShareOperations.ownerRestore.channel, inputs[action])).resolves.toEqual(parsed);
      }
    }
  });

  // Decline ends one restore; the listing reads the workspace's unfinished
  // restores page by page, and never claims a finished one is waiting.
  it("sends Decline and the unfinished listing to their routes", async () => {
    const h = harness();
    h.request.mockResolvedValue({status: {...status, phase: "declined"}, result: {kind: "declined"}});
    await h.invoke(relayShareOperations.ownerRestore.channel, {...statusInput, action: "decline"});
    expect(h.request).toHaveBeenLastCalledWith(h.credentials, "/sync/workspace/live-restores/restore/decline",
      {method: "POST", body: "{}"}, {retainRestoreConflict: true});
    h.request.mockResolvedValue({restores: [], unreadable: 0, nextCursor: null});
    await h.invoke(relayShareOperations.ownerRestore.channel, {workspaceId, action: "unfinished", after: "a/b"});
    expect(h.request).toHaveBeenLastCalledWith(h.credentials, "/sync/workspace/live-restores/unfinished?after=a%2Fb", undefined, {retainRestoreConflict: true});
    h.request.mockResolvedValue({restores: [{operationId: "restore", path: "notes.md", phase: "resumed", proposalDigest: null}], unreadable: 0, nextCursor: null});
    await expect(h.invoke(relayShareOperations.ownerRestore.channel, {workspaceId, action: "unfinished"})).rejects.toThrow();
  });

  it("preserves the retained conflict body as pending work rather than completion", async () => {
    const h = harness();
    for (const [action, kind] of [["prepare", "pending"], ["confirm", "review-required"]] as const) {
      const response = {status, result: {kind}}; h.request.mockResolvedValue(response);
      const input = {...statusInput, action, ...(action === "confirm" ? {proposalDigest: "b".repeat(64)} : {})};
      await expect(h.invoke(relayShareOperations.ownerRestore.channel, input)).resolves.toEqual(response);
      expect(h.request.mock.lastCall?.[3]).toEqual({retainRestoreConflict: true});
    }
    h.request.mockResolvedValue({status, result: {kind: "resumed"}});
    await expect(h.invoke(relayShareOperations.ownerRestore.channel, {...statusInput, action: "confirm", proposalDigest: "b".repeat(64)})).rejects.toThrow();
  });

  it.each(["workspace", "operation", "top-operation", "top-document", "point", "path"])("rejects substituted %s coordinates", async substitution => {
    const h = harness();
    let input: unknown = statusInput, response: unknown = structuredClone(status);
    if (substitution === "workspace") response = {...status, intent: {...intent, document: {...document, workspaceId: "other"}}};
    if (substitution === "operation") response = {...status, intent: {...intent, operationId: "other"}};
    if (substitution === "top-operation") response = {...status, operationId: "other"};
    if (substitution === "top-document") response = {...status, document: {...document, objectId: "other"}};
    if (substitution === "point") {
      input = {workspaceId, action: "plan", document, shareId: "share", grantId: "grant", restorePointCursor: 0, restorePointReceiptDigest: "a".repeat(64)};
      response = {intent: {...intent, restorePointCursor: 1}, path: "notes.md", recipients: []};
    }
    if (substitution === "path") {
      input = {workspaceId, action: "options", path: "notes.md"};
      response = {document, path: "other.md", grants: [], points: [], authors: [], nextBeforeCursor: null, nextGrantCursor: null, pendingOperation: null};
    }
    h.request.mockResolvedValue(response);
    await expect(h.invoke(relayShareOperations.ownerRestore.channel, input)).rejects.toThrow();
  });
});

describe("registered relay share handlers", () => {
  it.each([
    ["comment", {ok: true, access: "comment", url: "https://relay.example/new"}, {outcome: "widened", url: "https://relay.example/new"}],
    ["edit", {ok: true, access: "edit", url: "https://relay.example/new"}, {outcome: "widened", url: "https://relay.example/new"}],
    ["comment", {ok: true, access: "comment"}, {outcome: "narrowed"}],
    ["view", {ok: true, access: "view"}, {outcome: "narrowed"}],
  ])("reports the relay's actual credential transition for %s", async (access, response, expected) => {
    const h = harness();
    h.request.mockResolvedValue({kind: "success", body: response});
    await expect(h.invoke(relayShareOperations.retuneRelayShareLink.channel, {
      workspaceId, shareId: "share", grantId: "grant", expectedDependentGrantIds: [], access,
    })).resolves.toEqual(expected);
  });

  it.each([
    {ok: true, access: "view"},
    {ok: true, access: "edit", url: "https://relay.example/new"},
    {ok: true, access: "comment", url: "not a URL"},
    {ok: true, access: "comment", url: null},
    {ok: false, access: "comment", url: "https://relay.example/new"},
  ])("rejects a malformed or mismatched retune response %j", async response => {
    const h = harness();
    h.request.mockResolvedValue({kind: "success", body: response});
    await expect(h.invoke(relayShareOperations.retuneRelayShareLink.channel, {
      workspaceId, shareId: "share", grantId: "grant", expectedDependentGrantIds: [], access: "comment",
    })).rejects.toThrow("sharing failed (500)");
  });

  it("rejects a replacement URL for View and an unknown access level before making a request", async () => {
    const h = harness();
    h.request.mockResolvedValue({kind: "success", body: {ok: true, access: "view", url: "https://relay.example/new"}});
    const payload = {workspaceId, shareId: "share", grantId: "grant", expectedDependentGrantIds: []};
    await expect(h.invoke(relayShareOperations.retuneRelayShareLink.channel, {...payload, access: "view"})).rejects.toThrow();
    h.request.mockClear();
    await expect(h.invoke(relayShareOperations.retuneRelayShareLink.channel, {...payload, access: "owner"})).rejects.toThrow();
    expect(h.request).not.toHaveBeenCalled();
  });

  it("registers only this family and authenticates every channel before parsing or work", async () => {
    const h = harness();
    expect([...h.handlers.keys()]).toEqual([
      relayShareOperations.ownerRestore.channel,
      relayShareOperations.listOwnerLiveDocuments.channel,
      relayShareOperations.listOwnerLiveRefusals.channel,
      relayShareOperations.retryOwnerLiveShare.channel,
      relayShareOperations.stopOwnerLiveDocument.channel,
      relayShareOperations.resumeOwnerLiveDocument.channel,
      relayShareOperations.createRelayShare.channel,
      relayShareOperations.listRelayShares.channel,
      relayShareOperations.getRelayReceivedShare.channel,
      relayShareOperations.revokeRelayShare.channel,
      relayShareOperations.undoRelayShare.channel,
      relayShareOperations.createRelayShareLink.channel,
      relayShareOperations.addRelayShareLink.channel,
      relayShareOperations.listRelayShareLinks.channel,
      relayShareOperations.retuneRelayShareLink.channel,
      relayShareOperations.rotateRelayShareLink.channel,
      relayShareOperations.revokeRelayShareLink.channel,
      relayShareOperations.listRelayShareDiscussion.channel,
      relayShareOperations.pollRelayShareDiscussionActivity.channel,
      relayShareOperations.cancelRelayShareDiscussionActivity.channel,
      relayShareOperations.appendRelayShareDiscussion.channel,
      relayShareOperations.deleteRelayShareDiscussionMessage.channel,
      relayShareOperations.blockRelayShareDiscussionPrincipal.channel,
      relayShareOperations.unblockRelayShareDiscussionPrincipal.channel,
      relayShareOperations.pauseRelayShareDiscussion.channel,
      relayShareOperations.resumeRelayShareDiscussion.channel,
      relayShareOperations.promoteRelayShareGrant.channel,
      relayShareOperations.revokeRelayShareGrant.channel,
    ]);
    expect(h.handlers.size).toBe(28);
    for (const channel of h.handlers.keys()) {
      await expect(h.invoke(channel, null, -1)).rejects.toThrow("untrusted sender");
    }
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.accountRequest).not.toHaveBeenCalled();
    expect(h.polls.activeCount()).toBe(0);
  });

  it.each(["retireRenderer", "retirePhysical", "rotateCredentials"] as const)(
    "rejects %s while credentials load before starting the registered link request",
    async (invalidate) => {
      const h = harness();
      const loading = deferred<{ credentials: CloudCredentials; credentialGeneration: number }>();
      const started = deferred();
      h.remote.mockImplementation(() => { started.resolve(); return loading.promise; });
      const result = h.invoke(relayShareOperations.createRelayShareLink.channel, linkInput);
      await started.promise;
      h[invalidate]();
      loading.resolve({ credentials: h.credentials, credentialGeneration: 1 });
      await expect(result).rejects.toThrow();
      expect(h.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    [relayShareOperations.listOwnerLiveDocuments.channel, {workspaceId}],
    [relayShareOperations.stopOwnerLiveDocument.channel, {workspaceId, path: "live.md"}],
    [relayShareOperations.resumeOwnerLiveDocument.channel, {workspaceId, path: "live.md"}],
    [relayShareOperations.createRelayShareLink.channel, linkInput],
    [relayShareOperations.promoteRelayShareGrant.channel, {
      workspaceId, shareId: "share", grantId: "grant", expectedParentGrantId: "parent",
      expectedParentGeneration: 2,
    }],
    [relayShareOperations.pauseRelayShareDiscussion.channel, { workspaceId, shareId: "share" }],
  ] as const)("checks currentness after the relay resolves for %s", async (channel, payload) => {
    for (const invalidate of ["retireRenderer", "retirePhysical", "rotateCredentials"] as const) {
      const h = harness();
      const response = deferred<unknown>();
      const started = deferred();
      h.request.mockImplementation(() => { started.resolve(); return response.promise; });
      const result = h.invoke(channel, payload);
      await started.promise;
      h[invalidate]();
      const readResult = vi.fn(() => true);
      response.resolve({ get ok() { return readResult(); } });
      await expect(result).rejects.toThrow();
      expect(readResult).not.toHaveBeenCalled();
      expect(h.request).toHaveBeenCalledTimes(channel === relayShareOperations.listOwnerLiveDocuments.channel ? 2 : 1);
    }
  });

  it("creates a link using the authorized workspace and credential snapshot", async () => {
    const h = harness();
    await expect(h.invoke(relayShareOperations.createRelayShareLink.channel, linkInput)).resolves.toEqual({
      shareId: "share", grantId: "grant", url: linkResult.url,
    });
    expect(h.request).toHaveBeenCalledWith(h.credentials, "/sync/workspace/shares/links", {
      method: "POST", body: JSON.stringify({ paths: ["notes.md"], access: "view" }),
    });
  });

  it("rejects a shared view and unauthorized remote before relay mutation", async () => {
    const h = harness();
    h.workspace.shareView = {};
    await expect(h.invoke(relayShareOperations.createRelayShareLink.channel, linkInput)).rejects.toThrow("original workspace");
    expect(h.remote).not.toHaveBeenCalled();
    h.workspace.shareView = undefined;
    h.remote.mockRejectedValue(new Error("wrong account"));
    await expect(h.invoke(relayShareOperations.createRelayShareLink.channel, linkInput)).rejects.toThrow("wrong account");
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each(["grant revoked", "grant does not belong to this workspace"])(
    "preserves relay refusal: %s", async (reason) => {
      const h = harness();
      h.request.mockRejectedValue(new Error(reason));
      await expect(h.invoke(relayShareOperations.promoteRelayShareGrant.channel, {
        workspaceId, shareId: "share", grantId: "grant", expectedParentGrantId: "parent",
        expectedParentGeneration: 2,
      })).rejects.toThrow(reason);
      expect(h.request).toHaveBeenCalledWith(h.credentials,
        "/sync/shares/share/grants/grant/promote", {
          method: "POST", body: JSON.stringify({
            workspaceId, expectedParentGrantId: "parent", expectedParentGeneration: 2,
          }),
        });
    },
  );

  it("retains dependent-set conflicts instead of reporting a successful link rotation", async () => {
    const h = harness();
    h.request.mockResolvedValue({
      kind: "dependents-changed", status: 409,
      body: { ok: false, code: "dependents_changed", dependents: [] },
    });
    await expect(h.invoke(relayShareOperations.rotateRelayShareLink.channel, {
      workspaceId, shareId: "share", grantId: "grant", expectedDependentGrantIds: [],
    })).resolves.toEqual({ outcome: "dependents-changed", dependents: [] });
    expect(h.request.mock.calls[0]?.[3]).toEqual({ retainDependentSetConflict: true });
  });

  it("requires the declared moderation transition in the relay response", async () => {
    const h = harness();
    h.request.mockResolvedValue({ ok: true, linkCommentsPaused: false });
    await expect(h.invoke(relayShareOperations.pauseRelayShareDiscussion.channel, {
      workspaceId, shareId: "share",
    })).rejects.toThrow("sharing failed (500)");
    h.request.mockResolvedValue({ ok: true, linkCommentsPaused: true });
    await expect(h.invoke(relayShareOperations.pauseRelayShareDiscussion.channel, {
      workspaceId, shareId: "share",
    })).resolves.toEqual({ linkCommentsPaused: true });
  });
});

const undo = {undoId: "undo-1", expiresAtMs: 600_000};

it.each([
  [relayShareOperations.revokeRelayShareGrant.channel, { workspaceId, shareId: "share", grantId: "grant" },
    { ok: true, grantId: "grant", access: "edit", generation: 2, parentGrantId: null, status: "revoked", revokedAtMs: 5, undo }],
  [relayShareOperations.revokeRelayShareLink.channel, { workspaceId, shareId: "share", grantId: "grant", expectedDependentGrantIds: [] },
    { kind: "success", body: { ok: true, undo } }],
] as const)("allows paused owner control for %s without enabling content sync", async (channel, payload, result) => {
  const h = harness();
  h.remote.mockImplementation(async (_workspace, options) => {
    if (!options?.allowPaused) throw new Error("Sync this workspace before sharing.");
    return { credentials: h.credentials, credentialGeneration: 1 };
  });
  h.request.mockResolvedValue(result);
  await h.invoke(channel, payload);
  expect(h.remote).toHaveBeenCalledWith(h.workspace, { allowPaused: true });
  await expect(h.invoke(relayShareOperations.createRelayShareLink.channel, linkInput)).rejects.toThrow("Sync this workspace");
  h.remote.mockRejectedValueOnce(new Error("wrong account"));
  await expect(h.invoke(channel, payload)).rejects.toThrow("wrong account");
  expect(h.request).toHaveBeenCalledOnce();
});

describe("share roster refresh", () => {
  const grantBody = {grantId: "grant", access: "edit", generation: 2, parentGrantId: null};
  const linkPayload = {workspaceId, shareId: "share", grantId: "grant", expectedDependentGrantIds: []};

  it.each([
    [relayShareOperations.createRelayShare.channel, {workspaceId, paths: ["Trip"], recipientEmail: "ana@dohc.test", access: "edit"},
      {shareId: "share", grantId: "grant"}],
    [relayShareOperations.promoteRelayShareGrant.channel, {workspaceId, shareId: "share", grantId: "grant", expectedParentGrantId: "parent", expectedParentGeneration: 2},
      {ok: true, ...grantBody, status: "active", revokedAtMs: null}],
    [relayShareOperations.revokeRelayShareGrant.channel, {workspaceId, shareId: "share", grantId: "grant"},
      {ok: true, ...grantBody, status: "revoked", revokedAtMs: 5, undo}],
    [relayShareOperations.revokeRelayShareLink.channel, linkPayload, {kind: "success", body: {ok: true, undo}}],
    [relayShareOperations.retuneRelayShareLink.channel, {...linkPayload, access: "view"}, {kind: "success", body: {ok: true, access: "view"}}],
  ] as const)("refreshes after %s even when the window moved on while the relay answered", async (channel, payload, body) => {
    for (const invalidate of ["retireRenderer", "retirePhysical", "rotateCredentials"] as const) {
      const h = harness();
      const response = deferred<unknown>();
      const started = deferred();
      h.request.mockImplementation(() => { started.resolve(); return response.promise; });
      const result = h.invoke(channel, payload);
      await started.promise;
      h[invalidate]();
      response.resolve(body);
      await expect(result).rejects.toThrow();
      expect(h.sharesChanged, invalidate).toHaveBeenCalledWith(workspaceId);
    }
  });

  it("does not refresh when the relay refuses a share", async () => {
    const h = harness();
    h.request.mockRejectedValue(new Error("recipient not found"));
    await expect(h.invoke(relayShareOperations.createRelayShare.channel, {workspaceId, paths: ["Trip"], recipientEmail: "ana@dohc.test", access: "edit"}))
      .rejects.toThrow("recipient not found");
    expect(h.sharesChanged).not.toHaveBeenCalled();
  });

  it("refreshes every open workspace after ending or restoring a share, which names none", async () => {
    const h = harness();
    h.accountRequest.mockResolvedValue({ok: true, undo});
    await h.invoke(relayShareOperations.revokeRelayShare.channel, {shareId: "share"});
    h.accountRequest.mockResolvedValue({ok: true, shareId: "share"});
    await h.invoke(relayShareOperations.undoRelayShare.channel, {shareId: "share", undoId: "undo-1"});
    expect(h.sharesChanged.mock.calls).toEqual([[null], [null]]);
  });

  it("refreshes after a link ends or changes level, because its dependents follow it", async () => {
    const h = harness();
    h.request.mockResolvedValue({kind: "success", body: {ok: true, undo}});
    await h.invoke(relayShareOperations.revokeRelayShareLink.channel, linkPayload);
    h.request.mockResolvedValue({kind: "success", body: {ok: true, access: "view"}});
    await h.invoke(relayShareOperations.retuneRelayShareLink.channel, {...linkPayload, access: "view"});
    expect(h.sharesChanged.mock.calls).toEqual([[workspaceId], [workspaceId]]);
  });

  it("does not refresh for a new link, which has no dependents yet", async () => {
    const h = harness();
    h.request.mockResolvedValue(linkResult);
    await h.invoke(relayShareOperations.createRelayShareLink.channel, linkInput);
    expect(h.sharesChanged).not.toHaveBeenCalled();
  });
});

describe("registered account share handlers", () => {
  const received = {
    shareId: "share", granterEmail: "owner@example.com", genericChatWritable: false,
    grantId: "grant", generation: 1, createdAtMs: 1,
    selector: { paths: ["notes.md"], versionId: null }, access: "view",
  };

  it("lists account shares without requiring a local workspace and preserves lane filtering", async () => {
    const h = harness();
    h.retireRenderer();
    const damaged = {
      shareId: "damaged", workspaceId: "remote-only", recipientUserId: null,
      recipientEmail: "recipient@example.com", grantId: "damaged-grant", generation: 1,
      createdAtMs: 1, revokedAtMs: null, selector: null, damaged: true, access: "unknown",
    };
    h.accountRequest.mockResolvedValue({
      granted: [damaged, { selector: { kind: "chat" } }],
      received: [received, { selector: { kind: "chat" } }],
    });
    await expect(h.invoke(relayShareOperations.listRelayShares.channel)).resolves.toEqual({
      granted: [{ ...damaged, shareCode: buildShareCode({
        shareId: "damaged", relayUrl: h.credentials.relayUrl!,
      }) }],
      received: [{ ...received, shareCode: buildShareCode({
        shareId: "share", relayUrl: h.credentials.relayUrl!,
      }) }],
      removed: [],
    });
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.accountRequest).toHaveBeenCalledWith("/sync/shares");
  });

  it("applies every account listing to this machine's received shares", async () => {
    const h = harness();
    const listing = { granted: [], received: [received], removed: [] };
    h.accountRequest.mockResolvedValue(listing);
    await h.invoke(relayShareOperations.listRelayShares.channel);
    expect(h.reconcileReceivedShares).toHaveBeenCalledWith(listing);
  });

  it("waits for reconciliation before returning the received inventory", async () => {
    const h = harness(), started = deferred(), reconciled = deferred();
    h.reconcileReceivedShares.mockImplementation(() => { started.resolve(); return reconciled.promise; });
    let answered = false;
    const pending = h.invoke(relayShareOperations.listRelayShares.channel).then(result => { answered = true; return result; });
    await started.promise;
    expect(answered).toBe(false);
    reconciled.resolve();
    await pending;
    expect(answered).toBe(true);
  });

  it("rejects a credential switch during exact-share reconciliation", async () => {
    const h = harness(), started = deferred(), reconciled = deferred();
    h.reconcileReceivedShares.mockImplementation(() => { started.resolve(); return reconciled.promise; });
    const pending = h.invoke(relayShareOperations.listRelayShares.channel);
    await started.promise;
    h.rotateCredentials();
    reconciled.resolve();
    await expect(pending).rejects.toThrow("session changed");
  });

  it("keeps the verified removal explanation without depending on the capped account listing", async () => {
    const h = harness();
    h.request.mockResolvedValue({ kind: "missing", removed: true });
    await expect(h.invoke(relayShareOperations.getRelayReceivedShare.channel, { shareId: "share" }))
      .resolves.toEqual({ found: false, removed: { message: "The owner removed your access." } });
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("does not reconcile a listing returned after an account switch", async () => {
    const h = harness(), started = deferred(), response = deferred<unknown>();
    h.accountRequest.mockImplementation(() => { started.resolve(); return response.promise; });
    const result = h.invoke(relayShareOperations.listRelayShares.channel);
    await started.promise;
    h.rotateCredentials();
    response.resolve({ granted: [], received: [received] });
    await expect(result).rejects.toThrow("session changed");
    expect(h.reconcileReceivedShares).not.toHaveBeenCalled();
  });

  it("retains exact received-share missing and mismatched identity outcomes", async () => {
    const h = harness();
    h.request.mockResolvedValue({ kind: "missing", removed: false });
    await expect(h.invoke(relayShareOperations.getRelayReceivedShare.channel, { shareId: "share" }))
      .resolves.toEqual({ found: false });
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.reconcileReceivedShares).not.toHaveBeenCalled();
    h.request.mockResolvedValue({ kind: "success", body: { ...received, shareId: "other" } });
    await expect(h.invoke(relayShareOperations.getRelayReceivedShare.channel, { shareId: "share" }))
      .rejects.toThrow("Invalid exact received share response");
    expect(h.request.mock.calls[0]?.[3]).toEqual({ retainNotFound: true });
  });

  it("rejects an exact received-share result after the credential generation changes", async () => {
    const h = harness();
    const started = deferred();
    const response = deferred<unknown>();
    h.request.mockImplementation(() => { started.resolve(); return response.promise; });
    const result = h.invoke(relayShareOperations.getRelayReceivedShare.channel, { shareId: "share" });
    await started.promise;
    h.rotateCredentials();
    response.resolve({ kind: "success", body: received });
    await expect(result).rejects.toThrow("session changed");
  });

  it("revokes an account share through the account transport and keeps the relay's undo receipt", async () => {
    const h = harness();
    h.retirePhysical();
    h.accountRequest.mockResolvedValue({ ok: true, undo });
    await expect(h.invoke(relayShareOperations.revokeRelayShare.channel, { shareId: "share" })).resolves.toEqual({ undo });
    expect(h.accountRequest).toHaveBeenCalledWith("/sync/shares/share/revoke", { method: "POST" });
    expect(h.remote).not.toHaveBeenCalled();
  });

  it("accepts an already-ended share without an undo receipt", async () => {
    const h = harness();
    h.accountRequest.mockResolvedValue({ ok: true });
    await expect(h.invoke(relayShareOperations.revokeRelayShare.channel, { shareId: "share" })).resolves.toEqual({});
  });

  it("restores a removal through the account transport with the receipt's id", async () => {
    const h = harness();
    h.retirePhysical();
    h.accountRequest.mockResolvedValue({ ok: true, shareId: "share" });
    await expect(h.invoke(relayShareOperations.undoRelayShare.channel, { shareId: "share", undoId: "undo-1" }))
      .resolves.toEqual({ shareId: "share" });
    expect(h.accountRequest).toHaveBeenCalledWith("/sync/shares/share/undo", {
      method: "POST", body: JSON.stringify({ undoId: "undo-1" }),
    });
    expect(h.remote).not.toHaveBeenCalled();
  });

  it("rejects an undo answer that names another share", async () => {
    const h = harness();
    h.accountRequest.mockResolvedValue({ ok: true, shareId: "other" });
    await expect(h.invoke(relayShareOperations.undoRelayShare.channel, { shareId: "share", undoId: "undo-1" }))
      .rejects.toThrow("sharing failed (500)");
  });

  it("keeps the relay's removed lane beside the active received lane", async () => {
    const h = harness();
    const removed = { shareId: "gone", grantId: "gone-grant", message: "The owner removed your access.", removedAtMs: 5 };
    h.accountRequest.mockResolvedValue({ granted: [], received: [received], removed: [removed] });
    await expect(h.invoke(relayShareOperations.listRelayShares.channel)).resolves.toMatchObject({
      received: [{ shareId: "share" }], removed: [removed],
    });
  });
});

describe("registered discussion poll lifetime", () => {
  it("returns current discussion activity and releases the completed poll", async () => {
    const h = harness();
    h.request.mockResolvedValue(activityResult);
    await expect(h.invoke(relayShareOperations.pollRelayShareDiscussionActivity.channel, pollInput)).resolves.toEqual({
      latestRevision: 1, cursorRevision: 1, hasMore: false,
      messages: [], principals: [], linkCommentsPaused: false,
    });
    expect(h.request).toHaveBeenCalledWith(h.credentials,
      "/sync/shares/share/discussion/activity?workspaceId=workspace&since=0&hold=30000&limit=10",
      { signal: expect.any(AbortSignal) });
    expect(h.polls.activeCount()).toBe(0);
  });

  it("cancels only the sender's poll and keeps presence polling independent", async () => {
    const h = harness();
    const presence = createPresencePollRegistry();
    const presencePoll = presence.begin(1, pollInput.pollId, "presence");
    const started = deferred<AbortSignal>();
    h.request.mockImplementation((_credentials, _path, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("missing poll signal");
      started.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const result = h.invoke(relayShareOperations.pollRelayShareDiscussionActivity.channel, pollInput);
    const signal = await started.promise;
    await h.invoke(relayShareOperations.cancelRelayShareDiscussionActivity.channel, { pollId: pollInput.pollId }, 2);
    expect(signal.aborted).toBe(false);
    await h.invoke(relayShareOperations.cancelRelayShareDiscussionActivity.channel, { pollId: pollInput.pollId });
    await expect(result).rejects.toThrow("aborted");
    expect(h.polls.activeCount()).toBe(0);
    expect(presencePoll.signal.aborted).toBe(false);
    presencePoll.release();
  });

  it.each(["retireRenderer", "retirePhysical", "rotateCredentials"] as const)(
    "rejects %s while the poll response is held and releases its registry entry", async (invalidate) => {
      const h = harness();
      const started = deferred();
      const response = deferred<unknown>();
      h.request.mockImplementation(() => { started.resolve(); return response.promise; });
      const result = h.invoke(relayShareOperations.pollRelayShareDiscussionActivity.channel, pollInput);
      await started.promise;
      h[invalidate]();
      response.resolve(activityResult);
      await expect(result).rejects.toThrow();
      expect(h.polls.activeCount()).toBe(0);
    },
  );

  it("checks cancellation after a relay ignores the abort and returns a valid response", async () => {
    const h = harness();
    const started = deferred();
    const response = deferred<unknown>();
    h.request.mockImplementation(() => { started.resolve(); return response.promise; });
    const result = h.invoke(relayShareOperations.pollRelayShareDiscussionActivity.channel, pollInput);
    await started.promise;
    await h.invoke(relayShareOperations.cancelRelayShareDiscussionActivity.channel, { pollId: pollInput.pollId });
    response.resolve(activityResult);
    await expect(result).rejects.toThrow("aborted");
    expect(h.polls.activeCount()).toBe(0);
  });

  it("registers a poll before an immediate cancel can run", async () => {
    const h = harness();
    const result = h.invoke(relayShareOperations.pollRelayShareDiscussionActivity.channel, pollInput);
    expect(h.polls.activeCount()).toBe(1);
    const cancelled = h.invoke(relayShareOperations.cancelRelayShareDiscussionActivity.channel, {pollId: pollInput.pollId});
    await expect(result).rejects.toThrow("aborted");
    await cancelled;
    expect(h.request).not.toHaveBeenCalled();
    expect(h.polls.activeCount()).toBe(0);
  });

  it("leaves no registry entry when workspace binding refuses a poll", async () => {
    const h = harness();
    const earlier = h.polls.begin(1, pollInput.pollId, JSON.stringify([workspaceId, "share"]));
    await expect(h.invoke(relayShareOperations.pollRelayShareDiscussionActivity.channel, {...pollInput, workspaceId: "other"}))
      .rejects.toThrow("Sharing stopped because this window changed workspaces.");
    expect(h.polls.activeCount()).toBe(1);
    expect(earlier.signal.aborted).toBe(false);
    earlier.release();
    expect(h.polls.activeCount()).toBe(0);
    expect(h.remote).not.toHaveBeenCalled();
  });

  it("does not issue a poll cancelled during credential loading", async () => {
    const h = harness();
    const started = deferred();
    const loading = deferred<{ credentials: CloudCredentials; credentialGeneration: number }>();
    h.remote.mockImplementation(() => { started.resolve(); return loading.promise; });
    const result = h.invoke(relayShareOperations.pollRelayShareDiscussionActivity.channel, pollInput);
    await started.promise;
    await h.invoke(relayShareOperations.cancelRelayShareDiscussionActivity.channel, { pollId: pollInput.pollId });
    loading.resolve({ credentials: h.credentials, credentialGeneration: 1 });
    await expect(result).rejects.toThrow("aborted");
    expect(h.request).not.toHaveBeenCalled();
    expect(h.polls.activeCount()).toBe(0);
  });
});

const ownerInputs = {
  ownerRestore: {workspaceId, action: "options", path: "notes.md"},
  listOwnerLiveDocuments: {workspaceId},
  listOwnerLiveRefusals: {workspaceId},
  retryOwnerLiveShare: {workspaceId, shareId: "share"},
  stopOwnerLiveDocument: {workspaceId, path: "live.md"},
  resumeOwnerLiveDocument: {workspaceId, path: "live.md"},
  listRelayShares: undefined,
  getRelayReceivedShare: {shareId: "share"},
  revokeRelayShare: {shareId: "share"},
  undoRelayShare: {shareId: "share", undoId: "undo-1"},
  pollRelayShareDiscussionActivity: pollInput,
  cancelRelayShareDiscussionActivity: {pollId: pollInput.pollId},
  createRelayShare: {workspaceId, paths: ["docs"], recipientEmail: "friend@dohc.test", access: "edit"},
  createRelayShareLink: linkInput,
  addRelayShareLink: {workspaceId, shareId: "share", access: "view"},
  listRelayShareLinks: {workspaceId},
  retuneRelayShareLink: {workspaceId, shareId: "share", grantId: "grant", expectedDependentGrantIds: [], access: "view"},
  rotateRelayShareLink: {workspaceId, shareId: "share", grantId: "grant", expectedDependentGrantIds: []},
  revokeRelayShareLink: {workspaceId, shareId: "share", grantId: "grant", expectedDependentGrantIds: []},
  listRelayShareDiscussion: {workspaceId, shareId: "share", direction: "newest-first"},
  appendRelayShareDiscussion: {workspaceId, shareId: "share", body: "Hello", idempotencyKey: "54df38bc-6863-46a7-964a-820d81e833aa"},
  deleteRelayShareDiscussionMessage: {workspaceId, shareId: "share", messageId: "message"},
  blockRelayShareDiscussionPrincipal: {workspaceId, shareId: "share", principalId: "principal"},
  unblockRelayShareDiscussionPrincipal: {workspaceId, shareId: "share", principalId: "principal"},
  pauseRelayShareDiscussion: {workspaceId, shareId: "share"},
  resumeRelayShareDiscussion: {workspaceId, shareId: "share"},
  promoteRelayShareGrant: {workspaceId, shareId: "share", grantId: "grant", expectedParentGrantId: "parent", expectedParentGeneration: 2},
  revokeRelayShareGrant: {workspaceId, shareId: "share", grantId: "grant"},
} satisfies Record<keyof typeof relayShareOperations, unknown>;
const ownerRows = Object.entries(relayShareOperations).map(([name, row]) => ({
  name, row, input: ownerInputs[name as keyof typeof ownerInputs],
}));
const workspaceRows = ownerRows.filter(
  (entry): entry is typeof entry & {row: Extract<typeof entry.row, {guard: "active-workspace"}>} =>
    entry.row.guard === "active-workspace",
);

describe("owner operation admission", () => {
  it.each(ownerRows.filter(({row}) => row.guard === "trusted-sender"))("runs $name without a workspace operation", async ({name, row, input}) => {
    const h = harness();
    h.retireRenderer();
    if (name === "getRelayReceivedShare") h.request.mockResolvedValue({kind: "missing", removed: false});
    if (name === "revokeRelayShare") h.accountRequest.mockResolvedValue({ok: true});
    if (name === "undoRelayShare") h.accountRequest.mockResolvedValue({ok: true, shareId: "share"});
    await h.invoke(row.channel, input);
    expect(h.workspaceOperations).not.toHaveBeenCalled();
    expect(h.remote).not.toHaveBeenCalled();
  });

  it.each(workspaceRows)("binds $name to the sender's workspace before remote access", async ({row, input}) => {
    const h = harness();
    await expect(h.invoke(row.channel, {...input, workspaceId: "another-workspace"})).rejects.toThrow(
      row.inactiveMessage,
    );
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.accountRequest).not.toHaveBeenCalled();
  });

  it.each(workspaceRows)("refuses $name in a shared view before remote access", async ({row, input}) => {
    const h = harness();
    h.workspace.shareView = {};
    h.remote.mockRejectedValue(new Error("remote reached"));
    await expect(h.invoke(row.channel, input)).rejects.toThrow("original workspace");
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each(["listRelayShareLinks", "rotateRelayShareLink"] as const)(
    "refuses %s in a received share view with the owner refusal before remote access",
    async (name) => {
      const h = harness();
      h.workspace.shareView = {};
      h.remote.mockRejectedValue(new Error("Sync this workspace before sharing."));
      await expect(h.invoke(relayShareOperations[name].channel, ownerInputs[name])).rejects.toThrow(
        "This is a shared view — only the original workspace can be shared.",
      );
      expect(h.remote).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
      expect(h.accountRequest).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{}, "Pick a file, folder, or version to share."],
    [{paths: ["shared-with-me/friend/docs"]}, "This came to you through a share — copy it into your own files to share it onward."],
  ] as const)("keeps create-share input refusals after workspace binding: %j", async (selection, message) => {
    const h = harness();
    const input = {workspaceId, recipientEmail: "friend@dohc.test", access: "edit", ...selection};
    await expect(h.invoke(relayShareOperations.createRelayShare.channel, input)).rejects.toThrow(message);
    await expect(h.invoke(relayShareOperations.createRelayShare.channel, {...input, workspaceId: "another-workspace"})).rejects.toThrow(
      "Sharing stopped because this window changed workspaces.",
    );
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
});
