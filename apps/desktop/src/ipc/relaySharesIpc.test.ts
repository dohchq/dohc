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
  });
  const invoke = async (channel: string, payload?: unknown, senderId = 1) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return handler({ sender: { id: senderId } }, payload);
  };
  return {
    workspace, credentials, remote, request, accountRequest, polls, handlers, warm, invoke,
    retireRenderer: () => { rendererCurrent = false; },
    retirePhysical: () => { physicalCurrent = false; },
    rotateCredentials: () => { generation += 1; },
  };
}

describe("registered relay share handlers", () => {
  it("registers only this family and authenticates every channel before parsing or work", async () => {
    const h = harness();
    expect([...h.handlers.keys()]).toEqual([
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
      expect(h.request).toHaveBeenCalledOnce();
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
