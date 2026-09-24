import { describe, expect, it, vi } from "vitest";
import { registerRelaySharesIpcHandlers } from "./relaySharesIpc";
import { CHANNELS } from "./channels";
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
type Dependencies = Parameters<typeof registerRelaySharesIpcHandlers<
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
      expect(requestedWorkspaceId).toBe(workspaceId);
      return work({
        workspace, state: {}, signal: new AbortController().signal,
        assertCurrent() {
          if (!physicalCurrent) throw new Error("physical workspace retired");
        },
      });
    },
  });
  const remote = vi.fn(async () => ({ credentials, credentialGeneration: generation }));
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
  registerRelaySharesIpcHandlers<Sender, Event, Workspace, Operation>({
    registerHandler: (channel, handler) => {
      expect(handlers.has(channel)).toBe(false);
      handlers.set(channel, handler);
    },
    assertTrustedSender: trusted,
    withRendererWorkspaceOperation,
    remoteForWorkspace: remote,
    currentCredentialGeneration: () => generation,
    currentCredentials: () => credentials,
    warmCredentialCache: warm,
    relayShareJson: accountRequest as Dependencies["relayShareJson"],
    relayShareJsonWithCredentials: request as Dependencies["relayShareJsonWithCredentials"],
    relayShareErrorCopy: (status) => `sharing failed (${status})`,
    relayShareDiscussionActivityPolls: polls,
    sharesChanged,
  });
  const invoke = async (channel: string, payload?: unknown, senderId = 1) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return handler({ sender: { id: senderId } }, payload);
  };
  return {
    workspace, credentials, remote, request, accountRequest, polls, handlers, warm, invoke, sharesChanged,
    retireRenderer: () => { rendererCurrent = false; },
    retirePhysical: () => { physicalCurrent = false; },
    rotateCredentials: () => { generation += 1; },
  };
}

describe("named browser invitations", () => {
  it.each([undefined, "https://share.example.test/s/edit/exact-grant"])("preserves the grant and optional server URL %s", async browserInvitationUrl => {
    const h = harness();
    h.request.mockResolvedValue({shareId: "share", grantId: "exact-grant", ...(browserInvitationUrl ? {browserInvitationUrl} : {})});
    const result = await h.invoke(CHANNELS.createRelayShare, {workspaceId, paths: ["docs"], recipientEmail: "friend@dohc.test", access: "edit"});
    expect(result).toEqual({shareId: "share", grantId: "exact-grant", browserInvitationUrl,
      shareCode: buildShareCode({shareId: "share", relayUrl: h.credentials.relayUrl!}), recipientEmail: "friend@dohc.test"});
    expect(h.request.mock.lastCall?.[2]?.body).toBe(JSON.stringify({recipientEmail: "friend@dohc.test", access: "edit", paths: ["docs"]}));
  });
  it("retains the listed grant URL without deriving it from desktop credentials", async () => {
    const h = harness(), browserInvitationUrl = "https://share.example.test/s/edit/exact-grant";
    h.accountRequest.mockResolvedValue({granted: [{shareId: "share", workspaceId: "remote-workspace", grantId: "exact-grant", generation: 1,
      recipientUserId: "friend", recipientEmail: "friend@dohc.test", selector: {paths: ["docs"], versionId: null}, access: "edit",
      createdAtMs: 1, revokedAtMs: null, browserInvitationUrl}]});
    expect(await h.invoke(CHANNELS.listRelayShares)).toMatchObject({granted: [{grantId: "exact-grant", browserInvitationUrl,
      shareCode: buildShareCode({shareId: "share", relayUrl: h.credentials.relayUrl!})}]});
  });
});

describe("owner live document enrollment", () => {
  const refusal = {shareId: "share", paths: ["docs"], code: "live_document_limit", message: "This server reached its live document limit."};

  it("lists bounded owner refusals without treating an empty candidate page as complete", async () => {
    const h = harness();
    h.request.mockResolvedValue({ok: true, refusals: [refusal], nextCursor: "other-share"});
    await expect(h.invoke(CHANNELS.listOwnerLiveRefusals, {workspaceId, after: "prior/share"})).resolves.toEqual({refusals: [refusal], nextCursor: "other-share"});
    expect(h.request).toHaveBeenCalledWith(h.credentials, "/sync/workspace/live-host?refusals=1&after=prior%2Fshare");
    h.request.mockResolvedValue({ok: true, refusals: [], nextCursor: "next-share"});
    await expect(h.invoke(CHANNELS.listOwnerLiveRefusals, {workspaceId})).resolves.toEqual({refusals: [], nextCursor: "next-share"});
  });

  it("retries enrollment using only the share identity and owner session", async () => {
    const h = harness(); h.request.mockResolvedValue({ok: true, documents: [{path: "docs/live.md", status: "preparing"}]});
    await expect(h.invoke(CHANNELS.retryOwnerLiveShare, {workspaceId, shareId: "share"})).resolves.toBeUndefined();
    expect(h.request).toHaveBeenCalledWith(h.credentials, "/sync/workspace/live-host", {method: "POST", body: JSON.stringify({shareId: "share", retry: true})});
    h.request.mockResolvedValue({ok: true, documents: [{path: "docs/live.md", status: "unavailable"}]});
    await expect(h.invoke(CHANNELS.retryOwnerLiveShare, {workspaceId, shareId: "share"})).rejects.toThrow("could not start");
  });

  it.each([CHANNELS.listOwnerLiveRefusals, CHANNELS.retryOwnerLiveShare])("rejects untrusted or shared-view %s before loading credentials", async channel => {
    const h = harness(), input = channel === CHANNELS.listOwnerLiveRefusals ? {workspaceId} : {workspaceId, shareId: "share"};
    await expect(h.invoke(channel, input, -1)).rejects.toThrow("untrusted sender");
    await expect(h.invoke(channel, {...input, credentials: h.credentials})).rejects.toThrow();
    h.workspace.shareView = {};
    await expect(h.invoke(channel, input)).rejects.toThrow("original workspace");
    expect(h.remote).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
  });

  it.each(["retireRenderer", "retirePhysical", "rotateCredentials"] as const)("discards refusal and retry responses after %s", async invalidate => {
    for (const channel of [CHANNELS.listOwnerLiveRefusals, CHANNELS.retryOwnerLiveShare]) {
      const h = harness(), response = deferred<unknown>(), started = deferred();
      h.request.mockImplementation(() => {started.resolve(); return response.promise;});
      const input = channel === CHANNELS.listOwnerLiveRefusals ? {workspaceId} : {workspaceId, shareId: "share"};
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
      await expect(h.invoke(CHANNELS.listOwnerLiveRefusals, {workspaceId, after: "same"})).rejects.toThrow();
    }
  });

  it("lists active and retired rows without exposing bindings", async () => {
    const h = harness();
    h.request.mockImplementation(async (_credentials, path) => path.includes("retired=1")
      ? {ok: true, documents: [{path: "old.md", status: "retired"}], nextCursor: "old.md"}
      : {ok: true, documents: [{path: "live.md", status: "ready", document: {shareId: "secret"}}]});
    await expect(h.invoke(CHANNELS.listOwnerLiveDocuments, {workspaceId, retiredAfter: "older.md"})).resolves.toEqual({
      documents: [
        {path: "old.md", status: "retired", canResume: true},
        {path: "live.md", status: "ready", canResume: false},
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
        ? {ok: true, path: "live.md", status: "retired"}
        : {ok: true, path: "live.md", status: "ready", document: {shareId: "server-only"}};
    });
    await expect(h.invoke(CHANNELS.stopOwnerLiveDocument, {workspaceId, path: "live.md"})).resolves.toBeUndefined();
    await expect(h.invoke(CHANNELS.resumeOwnerLiveDocument, {workspaceId, path: "live.md"})).resolves.toBeUndefined();
    expect(h.request.mock.calls.map((call) => [call[0], call[2]?.method, call[2]?.body])).toEqual([
      [h.credentials, "DELETE", JSON.stringify({path: "live.md", retire: true})],
      [h.credentials, "POST", JSON.stringify({path: "live.md"})],
    ]);
  });

  it("rejects renderer identity, unsafe paths, and unavailable resumes", async () => {
    const h = harness();
    await expect(h.invoke(CHANNELS.listOwnerLiveDocuments, {workspaceId, credentials: h.credentials})).rejects.toThrow();
    await expect(h.invoke(CHANNELS.stopOwnerLiveDocument, {workspaceId, path: "../secret"})).rejects.toThrow();
    h.request.mockResolvedValue({ok: true, path: "live.md", status: "unavailable"});
    await expect(h.invoke(CHANNELS.resumeOwnerLiveDocument, {workspaceId, path: "live.md"})).rejects.toThrow("could not resume");
    expect(h.request.mock.calls.at(-1)?.[0]).toBe(h.credentials);
  });

  it.each([CHANNELS.listOwnerLiveDocuments, CHANNELS.stopOwnerLiveDocument, CHANNELS.resumeOwnerLiveDocument])(
    "refuses a shared view before loading credentials for %s", async channel => {
      const h = harness(); h.workspace.shareView = {};
      const input = channel === CHANNELS.listOwnerLiveDocuments ? {workspaceId} : {workspaceId, path: "live.md"};
      await expect(h.invoke(channel, input)).rejects.toThrow("original workspace");
      expect(h.remote).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
    });

  it("refuses mismatched action responses instead of claiming another file stopped", async () => {
    const h = harness(); h.request.mockResolvedValue({ok: true, path: "other.md", status: "retired"});
    await expect(h.invoke(CHANNELS.stopOwnerLiveDocument, {workspaceId, path: "live.md"})).rejects.toThrow();
  });

  it("refuses invalid retired paging cursors and malformed document paths", async () => {
    const h = harness();
    h.request.mockImplementation(async (_credentials, path) => path.includes("retired=1")
      ? {ok: true, documents: [{path: "old.md", status: "retired"}], nextCursor: "old.md"}
      : {ok: true, documents: []});
    await expect(h.invoke(CHANNELS.listOwnerLiveDocuments, {workspaceId, retiredAfter: "old.md"})).rejects.toThrow("list changed");
    h.request.mockResolvedValue({ok: true, documents: [{path: "../outside", status: "ready"}]});
    await expect(h.invoke(CHANNELS.listOwnerLiveDocuments, {workspaceId})).rejects.toThrow();
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
    await expect(h.invoke(CHANNELS.ownerRestore, statusInput, -1)).rejects.toThrow("untrusted sender");
    for (const input of [{...statusInput, ownerUserId: "owner"}, {...statusInput, credentials: h.credentials},
      {workspaceId, action: "begin", intent: {...intent, ownerUserId: "owner"}}]) {
      await expect(h.invoke(CHANNELS.ownerRestore, input)).rejects.toThrow();
    }
    expect(h.remote).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
  });

  it("uses the original workspace and credential snapshot without forwarding owner identity", async () => {
    const h = harness(); h.request.mockResolvedValue(status);
    await expect(h.invoke(CHANNELS.ownerRestore, {workspaceId, action: "begin", intent})).resolves.toEqual(status);
    expect(h.request).toHaveBeenCalledWith(h.credentials, "/sync/workspace/live-restores",
      {method: "POST", body: JSON.stringify({intent})}, {retainRestoreConflict: true});
    h.workspace.shareView = {};
    await expect(h.invoke(CHANNELS.ownerRestore, statusInput)).rejects.toThrow("original workspace");
    expect(h.request).toHaveBeenCalledOnce();
  });

  it.each(["retireRenderer", "retirePhysical", "rotateCredentials"] as const)("rejects %s before request and before response parsing", async invalidate => {
    const loading = harness(), loaded = deferred<{credentials: CloudCredentials; credentialGeneration: number}>(), started = deferred();
    loading.remote.mockImplementation(() => {started.resolve(); return loaded.promise;});
    const pending = loading.invoke(CHANNELS.ownerRestore, statusInput);
    await started.promise; loading[invalidate](); loaded.resolve({credentials: loading.credentials, credentialGeneration: 1});
    await expect(pending).rejects.toThrow(); expect(loading.request).not.toHaveBeenCalled();

    const h = harness(), response = deferred<unknown>(), requested = deferred();
    h.request.mockImplementation(() => {requested.resolve(); return response.promise;});
    const result = h.invoke(CHANNELS.ownerRestore, statusInput);
    await requested.promise; h[invalidate]();
    const read = vi.fn(() => "restore"); response.resolve({...status, get operationId() {return read();}});
    await expect(result).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });

  it("preserves the retained conflict body as pending work rather than completion", async () => {
    const h = harness();
    for (const [action, kind] of [["prepare", "pending"], ["confirm", "review-required"]] as const) {
      const response = {status, result: {kind}}; h.request.mockResolvedValue(response);
      const input = {...statusInput, action, ...(action === "confirm" ? {proposalDigest: "b".repeat(64)} : {})};
      await expect(h.invoke(CHANNELS.ownerRestore, input)).resolves.toEqual(response);
      expect(h.request.mock.lastCall?.[3]).toEqual({retainRestoreConflict: true});
    }
    h.request.mockResolvedValue({status, result: {kind: "resumed"}});
    await expect(h.invoke(CHANNELS.ownerRestore, {...statusInput, action: "confirm", proposalDigest: "b".repeat(64)})).rejects.toThrow();
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
      response = {document, path: "other.md", grants: [], points: [], nextBeforeCursor: null, nextGrantCursor: null, pendingOperation: null};
    }
    h.request.mockResolvedValue(response);
    await expect(h.invoke(CHANNELS.ownerRestore, input)).rejects.toThrow();
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
    await expect(h.invoke(CHANNELS.retuneRelayShareLink, {
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
    await expect(h.invoke(CHANNELS.retuneRelayShareLink, {
      workspaceId, shareId: "share", grantId: "grant", expectedDependentGrantIds: [], access: "comment",
    })).rejects.toThrow("sharing failed (500)");
  });

  it("rejects a replacement URL for View and an unknown access level before making a request", async () => {
    const h = harness();
    h.request.mockResolvedValue({kind: "success", body: {ok: true, access: "view", url: "https://relay.example/new"}});
    const payload = {workspaceId, shareId: "share", grantId: "grant", expectedDependentGrantIds: []};
    await expect(h.invoke(CHANNELS.retuneRelayShareLink, {...payload, access: "view"})).rejects.toThrow();
    h.request.mockClear();
    await expect(h.invoke(CHANNELS.retuneRelayShareLink, {...payload, access: "owner"})).rejects.toThrow();
    expect(h.request).not.toHaveBeenCalled();
  });

  it("registers only this family and authenticates every channel before parsing or work", async () => {
    const h = harness();
    expect([...h.handlers.keys()]).toEqual([
      CHANNELS.listOwnerLiveDocuments, CHANNELS.listOwnerLiveRefusals, CHANNELS.retryOwnerLiveShare,
      CHANNELS.stopOwnerLiveDocument, CHANNELS.resumeOwnerLiveDocument,
      CHANNELS.ownerRestore,
      CHANNELS.createRelayShare, CHANNELS.listRelayShares, CHANNELS.getRelayReceivedShare,
      CHANNELS.revokeRelayShare, CHANNELS.createRelayShareLink, CHANNELS.addRelayShareLink,
      CHANNELS.listRelayShareLinks, CHANNELS.retuneRelayShareLink, CHANNELS.rotateRelayShareLink,
      CHANNELS.revokeRelayShareLink, CHANNELS.listRelayShareDiscussion,
      CHANNELS.pollRelayShareDiscussionActivity, CHANNELS.cancelRelayShareDiscussionActivity,
      CHANNELS.appendRelayShareDiscussion, CHANNELS.deleteRelayShareDiscussionMessage,
      CHANNELS.blockRelayShareDiscussionPrincipal, CHANNELS.unblockRelayShareDiscussionPrincipal,
      CHANNELS.pauseRelayShareDiscussion, CHANNELS.resumeRelayShareDiscussion,
      CHANNELS.promoteRelayShareGrant, CHANNELS.revokeRelayShareGrant,
    ]);
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
      const result = h.invoke(CHANNELS.createRelayShareLink, linkInput);
      await started.promise;
      h[invalidate]();
      loading.resolve({ credentials: h.credentials, credentialGeneration: 1 });
      await expect(result).rejects.toThrow();
      expect(h.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    [CHANNELS.listOwnerLiveDocuments, {workspaceId}],
    [CHANNELS.stopOwnerLiveDocument, {workspaceId, path: "live.md"}],
    [CHANNELS.resumeOwnerLiveDocument, {workspaceId, path: "live.md"}],
    [CHANNELS.createRelayShareLink, linkInput],
    [CHANNELS.promoteRelayShareGrant, {
      workspaceId, shareId: "share", grantId: "grant", expectedParentGrantId: "parent",
      expectedParentGeneration: 2,
    }],
    [CHANNELS.pauseRelayShareDiscussion, { workspaceId, shareId: "share" }],
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
      expect(h.request).toHaveBeenCalledTimes(channel === CHANNELS.listOwnerLiveDocuments ? 2 : 1);
    }
  });

  it("creates a link using the authorized workspace and credential snapshot", async () => {
    const h = harness();
    await expect(h.invoke(CHANNELS.createRelayShareLink, linkInput)).resolves.toEqual({
      shareId: "share", grantId: "grant", url: linkResult.url,
    });
    expect(h.request).toHaveBeenCalledWith(h.credentials, "/sync/workspace/shares/links", {
      method: "POST", body: JSON.stringify({ paths: ["notes.md"], access: "view" }),
    });
  });

  it("rejects a shared view and unauthorized remote before relay mutation", async () => {
    const h = harness();
    h.workspace.shareView = {};
    await expect(h.invoke(CHANNELS.createRelayShareLink, linkInput)).rejects.toThrow("original workspace");
    expect(h.remote).not.toHaveBeenCalled();
    h.workspace.shareView = undefined;
    h.remote.mockRejectedValue(new Error("wrong account"));
    await expect(h.invoke(CHANNELS.createRelayShareLink, linkInput)).rejects.toThrow("wrong account");
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each(["grant revoked", "grant does not belong to this workspace"])(
    "preserves relay refusal: %s", async (reason) => {
      const h = harness();
      h.request.mockRejectedValue(new Error(reason));
      await expect(h.invoke(CHANNELS.promoteRelayShareGrant, {
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
    await expect(h.invoke(CHANNELS.rotateRelayShareLink, {
      workspaceId, shareId: "share", grantId: "grant", expectedDependentGrantIds: [],
    })).resolves.toEqual({ outcome: "dependents-changed", dependents: [] });
    expect(h.request.mock.calls[0]?.[3]).toEqual({ retainDependentSetConflict: true });
  });

  it("requires the declared moderation transition in the relay response", async () => {
    const h = harness();
    h.request.mockResolvedValue({ ok: true, linkCommentsPaused: false });
    await expect(h.invoke(CHANNELS.pauseRelayShareDiscussion, {
      workspaceId, shareId: "share",
    })).rejects.toThrow("sharing failed (500)");
    h.request.mockResolvedValue({ ok: true, linkCommentsPaused: true });
    await expect(h.invoke(CHANNELS.pauseRelayShareDiscussion, {
      workspaceId, shareId: "share",
    })).resolves.toEqual({ linkCommentsPaused: true });
  });
});

describe("share roster refresh", () => {
  const grantBody = {grantId: "grant", access: "edit", generation: 2, parentGrantId: null};
  const linkPayload = {workspaceId, shareId: "share", grantId: "grant", expectedDependentGrantIds: []};

  it.each([
    [CHANNELS.createRelayShare, {workspaceId, paths: ["Trip"], recipientEmail: "ana@dohc.test", access: "edit"},
      {shareId: "share", grantId: "grant"}],
    [CHANNELS.promoteRelayShareGrant, {workspaceId, shareId: "share", grantId: "grant", expectedParentGrantId: "parent", expectedParentGeneration: 2},
      {ok: true, ...grantBody, status: "active", revokedAtMs: null}],
    [CHANNELS.revokeRelayShareGrant, {workspaceId, shareId: "share", grantId: "grant"},
      {ok: true, ...grantBody, status: "revoked", revokedAtMs: 5}],
    [CHANNELS.revokeRelayShareLink, linkPayload, {kind: "success", body: {ok: true}}],
    [CHANNELS.retuneRelayShareLink, {...linkPayload, access: "view"}, {kind: "success", body: {ok: true, access: "view"}}],
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
    await expect(h.invoke(CHANNELS.createRelayShare, {workspaceId, paths: ["Trip"], recipientEmail: "ana@dohc.test", access: "edit"}))
      .rejects.toThrow("recipient not found");
    expect(h.sharesChanged).not.toHaveBeenCalled();
  });

  it("refreshes every open workspace after ending a share, which names none", async () => {
    const h = harness();
    await h.invoke(CHANNELS.revokeRelayShare, {shareId: "share"});
    expect(h.sharesChanged).toHaveBeenCalledWith(null);
  });

  it("refreshes after a link ends or changes level, because its dependents follow it", async () => {
    const h = harness();
    h.request.mockResolvedValue({kind: "success", body: {ok: true}});
    await h.invoke(CHANNELS.revokeRelayShareLink, linkPayload);
    h.request.mockResolvedValue({kind: "success", body: {ok: true, access: "view"}});
    await h.invoke(CHANNELS.retuneRelayShareLink, {...linkPayload, access: "view"});
    expect(h.sharesChanged.mock.calls).toEqual([[workspaceId], [workspaceId]]);
  });

  it("does not refresh for a new link, which has no dependents yet", async () => {
    const h = harness();
    h.request.mockResolvedValue(linkResult);
    await h.invoke(CHANNELS.createRelayShareLink, linkInput);
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
      granted: [damaged, { selector: { kind: "chat-channel" } }],
      received: [received, { selector: { kind: "chat-channel" } }],
    });
    await expect(h.invoke(CHANNELS.listRelayShares)).resolves.toEqual({
      granted: [{ ...damaged, shareCode: buildShareCode({
        shareId: "damaged", relayUrl: h.credentials.relayUrl!,
      }) }],
      received: [{ ...received, shareCode: buildShareCode({
        shareId: "share", relayUrl: h.credentials.relayUrl!,
      }) }],
    });
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.accountRequest).toHaveBeenCalledWith("/sync/shares");
  });

  it("retains exact received-share missing and mismatched identity outcomes", async () => {
    const h = harness();
    h.request.mockResolvedValue({ kind: "missing" });
    await expect(h.invoke(CHANNELS.getRelayReceivedShare, { shareId: "share" }))
      .resolves.toEqual({ found: false });
    h.request.mockResolvedValue({ kind: "success", body: { ...received, shareId: "other" } });
    await expect(h.invoke(CHANNELS.getRelayReceivedShare, { shareId: "share" }))
      .rejects.toThrow("Invalid exact received share response");
    expect(h.request.mock.calls[0]?.[3]).toEqual({ retainNotFound: true });
  });

  it("rejects an exact received-share result after the credential generation changes", async () => {
    const h = harness();
    const started = deferred();
    const response = deferred<unknown>();
    h.request.mockImplementation(() => { started.resolve(); return response.promise; });
    const result = h.invoke(CHANNELS.getRelayReceivedShare, { shareId: "share" });
    await started.promise;
    h.rotateCredentials();
    response.resolve({ kind: "success", body: received });
    await expect(result).rejects.toThrow("session changed");
  });

  it("revokes an account share through the account transport without a workspace operation", async () => {
    const h = harness();
    h.retirePhysical();
    await expect(h.invoke(CHANNELS.revokeRelayShare, { shareId: "share" })).resolves.toBeUndefined();
    expect(h.accountRequest).toHaveBeenCalledWith("/sync/shares/share/revoke", { method: "POST" });
    expect(h.remote).not.toHaveBeenCalled();
  });
});

describe("registered discussion poll lifetime", () => {
  it("returns current discussion activity and releases the completed poll", async () => {
    const h = harness();
    h.request.mockResolvedValue(activityResult);
    await expect(h.invoke(CHANNELS.pollRelayShareDiscussionActivity, pollInput)).resolves.toEqual({
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
    const result = h.invoke(CHANNELS.pollRelayShareDiscussionActivity, pollInput);
    const signal = await started.promise;
    await h.invoke(CHANNELS.cancelRelayShareDiscussionActivity, { pollId: pollInput.pollId }, 2);
    expect(signal.aborted).toBe(false);
    await h.invoke(CHANNELS.cancelRelayShareDiscussionActivity, { pollId: pollInput.pollId });
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
      const result = h.invoke(CHANNELS.pollRelayShareDiscussionActivity, pollInput);
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
    const result = h.invoke(CHANNELS.pollRelayShareDiscussionActivity, pollInput);
    await started.promise;
    await h.invoke(CHANNELS.cancelRelayShareDiscussionActivity, { pollId: pollInput.pollId });
    response.resolve(activityResult);
    await expect(result).rejects.toThrow("aborted");
    expect(h.polls.activeCount()).toBe(0);
  });

  it("does not issue a poll cancelled during credential loading", async () => {
    const h = harness();
    const started = deferred();
    const loading = deferred<{ credentials: CloudCredentials; credentialGeneration: number }>();
    h.remote.mockImplementation(() => { started.resolve(); return loading.promise; });
    const result = h.invoke(CHANNELS.pollRelayShareDiscussionActivity, pollInput);
    await started.promise;
    await h.invoke(CHANNELS.cancelRelayShareDiscussionActivity, { pollId: pollInput.pollId });
    loading.resolve({ credentials: h.credentials, credentialGeneration: 1 });
    await expect(result).rejects.toThrow("aborted");
    expect(h.request).not.toHaveBeenCalled();
    expect(h.polls.activeCount()).toBe(0);
  });
});
