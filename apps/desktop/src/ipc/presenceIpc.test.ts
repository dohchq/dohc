import { afterEach, describe, expect, it, vi } from "vitest";
import { createPresenceIpc } from "./presenceIpc";
import { CHANNELS } from "./channels";
import type { PresenceScopeInput } from "./bridgeContract";
import { createDesktopRendererWorkspaceRetirement } from "../mainRendererWorkspaceRetirement";
import { createPresencePollRegistry } from "../collab/presencePollRegistry";
import { RendererWorkspaceSessionOwner } from "../window/rendererWorkspaceSessionOwner";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import { deferred } from "../testing/deferred";

const DOCUMENT = "123e4567-e89b-42d3-a456-426614174001";
const OLD_INCARNATION = "123e4567-e89b-42d3-a456-426614174002";
const NEW_INCARNATION = "123e4567-e89b-42d3-a456-426614174003";
const scope: PresenceScopeInput = { kind: "workspace", workspaceId: "workspace-a" };
const shareScope: PresenceScopeInput = { kind: "share", workspaceId: "workspace-a", shareId: "share-1" };
const publishPayload = {
  scope, topic: "chat:thread:one", clientId: "client", incarnationId: OLD_INCARNATION,
  rendererDocumentId: DOCUMENT, state: { typing: true },
};
const pollPayload = { scope, topic: publishPayload.topic, since: 0, pollId: "poll" };
const snapshot = { version: 1, peers: [] };
const success = { ok: true, snapshot };
const unavailable = { ok: false, reason: "unavailable" };
const aborted = { ok: false, reason: "aborted" };
const emptySuccess = { ok: true, snapshot: { version: 0, peers: [] } };
const cleanup: Array<() => Promise<void>> = [];

function sender(id: number) {
  return {
    id,
    isDestroyed: () => false,
    once(_event: "destroyed", _listener: () => void) { return this; },
  };
}
type Sender = ReturnType<typeof sender>;
type Event = { sender: Sender; trusted?: boolean };

async function harness() {
  let credentials: CloudCredentials | null = {
    serverUrl: "https://cloud.example.test", relayUrl: "https://relay.example.test/",
    userId: "owner", email: "owner@example.test", token: "private-token",
  };
  const entries = new Map<string, RegistryEntry>(["workspace-a", "workspace-b"].map(workspaceId => [workspaceId, {
    workspaceId, rootPath: `/${workspaceId}`, kind: "personal", mode: "local-first",
    remote: { serverUrl: "https://cloud.example.test", ownerUserId: "owner" },
    sharedChannels: [{
      shareId: "share-1", channelWireId: "channel", access: "read-write",
      granterEmail: null, relayUrl: "https://relay.example.test", recipientUserId: "owner",
    }],
  }]));
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json(snapshot));
  vi.stubGlobal("fetch", fetchMock);
  const warmCredentialCache = vi.fn<() => Promise<void>>(async () => undefined);
  const capability = createPresenceIpc<Sender>({
    warmCredentialCache, currentCredentials: () => credentials,
    normalizeServerUrl: url => url.replace(/\/+$/u, ""),
    findWorkspace: workspaceId => entries.get(workspaceId) ?? null,
  });
  const discussionPolls = createPresencePollRegistry();
  const cleanupError = vi.fn();
  const sessions = new RendererWorkspaceSessionOwner<Sender>({
    retirement: createDesktopRendererWorkspaceRetirement({
      engineYDoc: { retireSender: async () => undefined },
      sitePreviews: { cancelSender: () => undefined, stopWorkspace: async () => undefined },
      pluginSurfaces: { stop: async () => undefined },
      pluginRuntimes: { stop: async (_workspace, beforeDispose) => beforeDispose() },
      workspaceSearch: { disposeSender: async () => undefined },
      presencePolls: { disposeSender: id => {
        capability.presencePollRegistry.disposeSender(id);
        discussionPolls.disposeSender(id);
      } },
      presenceMutations: capability.presenceMutationOwner,
      onCleanupError: cleanupError,
    }),
  });
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  capability.registerPresenceIpcHandlers<Event>({
    registerHandler: (channel, handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    },
    assertTrustedSender: event => { if (event.trusted === false) throw new Error("untrusted"); },
    rendererWorkspaceSessions: sessions,
  });
  const first = sender(1);
  const second = sender(2);
  const attachments = new Map(["workspace-a", "workspace-b"].map(id => [id, Symbol(id)]));
  const open = (value: Sender, workspaceId = "workspace-a") => sessions.open(
    value, { workspaceId, attachmentId: attachments.get(workspaceId)! }, DOCUMENT,
  );
  await open(first);
  await open(second);
  cleanup.push(async () => {
    fetchMock.mockImplementation(async () => Response.json(snapshot));
    await Promise.all([sessions.retireAfterCrash(first), sessions.retireAfterCrash(second)]);
    expect(cleanupError).not.toHaveBeenCalled();
  });
  return {
    ...capability, discussionPolls, sessions, handlers, first, second, entries, fetchMock,
    warmCredentialCache, open, setCredentials: (next: CloudCredentials | null) => { credentials = next; },
    invoke: async (channel: string, payload: unknown, value = first, trusted = true) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing handler: ${channel}`);
      return handler({ sender: value, trusted }, payload);
    },
  };
}

function heldFetch(abortable = true) {
  const reached = deferred<AbortSignal>();
  const response = deferred<Response>();
  const run: typeof fetch = async (_url, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error("Missing request signal");
    if (abortable) {
      signal.addEventListener("abort", () => response.reject(signal.reason), { once: true });
      if (signal.aborted) response.reject(signal.reason);
    }
    reached.resolve(signal);
    return response.promise;
  };
  return { reached: reached.promise, response, run };
}

afterEach(async () => {
  try { for (const dispose of cleanup.splice(0)) await dispose(); }
  finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
});

describe("registered presence IPC", () => {
  it("registers three handlers and rejects trust and payload failures before warming", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual([CHANNELS.presencePublish, CHANNELS.presencePoll, CHANNELS.presenceCancel]);
    for (const [channel, payload] of [
      [CHANNELS.presencePublish, publishPayload], [CHANNELS.presencePoll, pollPayload],
      [CHANNELS.presenceCancel, { pollId: "poll" }],
    ] as const) {
      await expect(h.invoke(channel, payload, h.first, false)).rejects.toThrow("untrusted");
      await expect(h.invoke(channel, {})).rejects.toThrow();
    }
    expect(h.warmCredentialCache).not.toHaveBeenCalled();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("requires the renderer workspace and uses a document ID only for publish", async () => {
    const h = await harness();
    const absent = sender(3);
    await expect(h.invoke(CHANNELS.presencePublish, publishPayload, absent)).resolves.toEqual(unavailable);
    await expect(h.invoke(CHANNELS.presencePoll, pollPayload, absent)).resolves.toEqual(aborted);
    await expect(h.invoke(CHANNELS.presenceCancel, { pollId: "poll" }, absent)).resolves.toBeUndefined();
    await expect(h.invoke(CHANNELS.presencePublish, { ...publishPayload, rendererDocumentId: NEW_INCARNATION })).resolves.toEqual(unavailable);
    const wrongScope = { kind: "workspace", workspaceId: "workspace-b" };
    await expect(h.invoke(CHANNELS.presencePublish, { ...publishPayload, scope: wrongScope })).resolves.toEqual(unavailable);
    await expect(h.invoke(CHANNELS.presencePoll, { ...pollPayload, scope: wrongScope })).resolves.toEqual(aborted);
    expect(h.warmCredentialCache).not.toHaveBeenCalled();
    expect(h.fetchMock).not.toHaveBeenCalled();
    await expect(h.invoke(CHANNELS.presencePoll, { ...pollPayload, rendererDocumentId: NEW_INCARNATION })).resolves.toEqual(success);
  });

  it.each(["signed-out", "no-relay", "no-enrollment", "wrong-owner", "wrong-server", "missing-share", "ended-share"])("refuses unavailable transport: %s", async reason => {
    const h = await harness();
    const entry = h.entries.get("workspace-a")!;
    let selectedScope = scope;
    if (reason === "signed-out") h.setCredentials(null);
    if (reason === "no-relay") h.setCredentials({ serverUrl: "https://cloud.example.test", userId: "owner", email: "owner@example.test", token: "secret" });
    if (reason === "no-enrollment") delete entry.remote;
    if (reason === "wrong-owner") entry.remote!.ownerUserId = "other";
    if (reason === "wrong-server") entry.remote!.serverUrl = "https://other.example.test";
    if (reason === "missing-share" || reason === "ended-share") {
      selectedScope = shareScope;
      if (reason === "missing-share") entry.sharedChannels = [];
      else entry.sharedChannels![0]!.ended = true;
    }
    await expect(h.invoke(CHANNELS.presencePublish, { ...publishPayload, scope: selectedScope })).resolves.toEqual(unavailable);
    await expect(h.invoke(CHANNELS.presencePoll, { ...pollPayload, scope: selectedScope })).resolves.toEqual(unavailable);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.presencePollRegistry.activeCount()).toBe(0);
  });

  it.each([scope, shareScope])("keeps bearer credentials in main for $kind routes", async selectedScope => {
    const h = await harness();
    const payload = { ...publishPayload, scope: selectedScope };
    await expect(h.invoke(CHANNELS.presencePublish, payload)).resolves.toEqual(success);
    await expect(h.invoke(CHANNELS.presencePoll, { ...pollPayload, scope: selectedScope, since: 7 })).resolves.toEqual(success);
    await expect(h.invoke(CHANNELS.presencePublish, { ...payload, leave: true })).resolves.toEqual(emptySuccess);
    const path = selectedScope.kind === "workspace" ? "/sync/workspace-a/presence" : "/sync/shares/share-1/presence";
    for (const [url, init] of h.fetchMock.mock.calls) {
      const parsed = new URL(String(url));
      expect(parsed.origin + parsed.pathname).toBe(`https://relay.example.test${path}`);
      expect(parsed.searchParams.get("topic")).toBe(payload.topic);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-token");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.parse(String(h.fetchMock.mock.calls[0]![1]!.body))).toEqual({ clientId: "client", state: { typing: true } });
    expect(new URL(String(h.fetchMock.mock.calls[1]![0])).searchParams.get("since")).toBe("7");
    expect(JSON.parse(String(h.fetchMock.mock.calls[2]![1]!.body))).toEqual({ clientId: "client", leave: true });
  });

  it("registers before warming so another sender cannot cancel and the owner can", async () => {
    const h = await harness();
    const reached = deferred();
    const release = deferred();
    h.warmCredentialCache.mockImplementation(async () => { reached.resolve(); await release.promise; });
    const result = h.invoke(CHANNELS.presencePoll, pollPayload);
    await reached.promise;
    expect(h.presencePollRegistry.activeCount()).toBe(1);
    await h.invoke(CHANNELS.presenceCancel, { pollId: "poll" }, h.second);
    expect(h.presencePollRegistry.activeCount()).toBe(1);
    await h.invoke(CHANNELS.presenceCancel, { pollId: "poll" });
    release.resolve();
    await expect(result).resolves.toEqual(aborted);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.presencePollRegistry.activeCount()).toBe(0);
  });

  it("keeps the same poll ID independent across senders", async () => {
    const h = await harness();
    const first = heldFetch();
    const second = heldFetch();
    h.fetchMock.mockImplementationOnce(first.run).mockImplementationOnce(second.run);
    const a = h.invoke(CHANNELS.presencePoll, pollPayload);
    const aSignal = await first.reached;
    const b = h.invoke(CHANNELS.presencePoll, pollPayload, h.second);
    const bSignal = await second.reached;
    await h.invoke(CHANNELS.presenceCancel, { pollId: "poll" }, h.second);
    expect(aSignal.aborted).toBe(false);
    expect(bSignal.aborted).toBe(true);
    await expect(b).resolves.toEqual(aborted);
    expect(h.presencePollRegistry.activeCount()).toBe(1);
    first.response.resolve(Response.json(snapshot));
    await expect(a).resolves.toEqual(success);
    expect(h.presencePollRegistry.activeCount()).toBe(0);
  });

  it("reads live credentials after warming completes", async () => {
    const h = await harness();
    const reached = deferred();
    const release = deferred();
    h.warmCredentialCache.mockImplementation(async () => { reached.resolve(); await release.promise; });
    const result = h.invoke(CHANNELS.presencePoll, pollPayload);
    await reached.promise;
    h.setCredentials({
      serverUrl: "https://cloud.example.test", relayUrl: "https://replacement-relay.example.test/",
      userId: "owner", email: "owner@example.test", token: "replacement-token",
    });
    release.resolve();
    await expect(result).resolves.toEqual(success);
    const [url, init] = h.fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).origin).toBe("https://replacement-relay.example.test");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer replacement-token");
  });

  it.each(["poll", "replacement"])("preserves replacement %s when the superseded poll releases", async pollId => {
    const h = await harness();
    const old = heldFetch();
    const replacement = heldFetch();
    h.fetchMock.mockImplementationOnce(old.run).mockImplementationOnce(replacement.run);
    const first = h.invoke(CHANNELS.presencePoll, pollPayload);
    const oldSignal = await old.reached;
    const next = h.invoke(CHANNELS.presencePoll, { ...pollPayload, pollId });
    const nextSignal = await replacement.reached;
    await expect(first).resolves.toEqual(aborted);
    expect(oldSignal.aborted).toBe(true);
    expect(nextSignal.aborted).toBe(false);
    expect(h.presencePollRegistry.activeCount()).toBe(1);
    await h.invoke(CHANNELS.presenceCancel, { pollId });
    await expect(next).resolves.toEqual(aborted);
    expect(h.presencePollRegistry.activeCount()).toBe(0);
  });

  it("retires both registries and suppresses a response from the old workspace", async () => {
    const h = await harness();
    const held = heldFetch(false);
    h.fetchMock.mockImplementationOnce(held.run);
    const result = h.invoke(CHANNELS.presencePoll, pollPayload);
    const signal = await held.reached;
    const discussion = h.discussionPolls.begin(h.first.id, "discussion", "thread");
    await h.open(h.first, "workspace-b");
    expect(signal.aborted).toBe(true);
    expect(discussion.signal.aborted).toBe(true);
    expect(h.presencePollRegistry.activeCount()).toBe(0);
    expect(h.discussionPolls.activeCount()).toBe(0);
    held.response.resolve(Response.json(snapshot));
    await expect(result).resolves.toEqual(aborted);
  });

  it("aborts a stalled relay at 35 seconds and releases its timer and entry", async () => {
    vi.useFakeTimers();
    const h = await harness();
    const held = heldFetch();
    h.fetchMock.mockImplementationOnce(held.run);
    const result = h.invoke(CHANNELS.presencePoll, pollPayload);
    const signal = await held.reached;
    await vi.advanceTimersByTimeAsync(34_999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(aborted);
    expect(signal.aborted).toBe(true);
    expect(h.presencePollRegistry.activeCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports ordinary relay failures as unavailable", async () => {
    const h = await harness();
    h.fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(h.invoke(CHANNELS.presencePoll, pollPayload)).resolves.toEqual(unavailable);
    expect(h.presencePollRegistry.activeCount()).toBe(0);
    h.fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(h.invoke(CHANNELS.presencePublish, publishPayload)).resolves.toEqual(unavailable);
  });

  it("serializes an explicit leave behind a held publish", async () => {
    const h = await harness();
    const held = heldFetch(false);
    const order: string[] = [];
    h.fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      order.push(body.leave ? "leave" : "other-sender-publish");
      return Response.json(snapshot);
    }).mockImplementationOnce(async (...args) => {
      const response = await held.run(...args);
      order.push("publish-response");
      return response;
    });
    const publishing = h.invoke(CHANNELS.presencePublish, publishPayload);
    await held.reached;
    const leaving = h.invoke(CHANNELS.presencePublish, { ...publishPayload, leave: true });
    try {
      await expect(h.invoke(CHANNELS.presencePublish, publishPayload, h.second)).resolves.toEqual(success);
      expect(order).toEqual(["other-sender-publish"]);
      expect(h.fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      held.response.resolve(Response.json(snapshot));
    }
    await expect(publishing).resolves.toEqual(success);
    await expect(leaving).resolves.toEqual(emptySuccess);
    expect(order).toEqual(["other-sender-publish", "publish-response", "leave"]);
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(h.fetchMock.mock.calls[2]![1]!.body))).toEqual({ clientId: "client", leave: true });
  });

  it("drops a queued old leave after a new incarnation claims the same key", async () => {
    const h = await harness();
    const held = heldFetch(false);
    h.fetchMock.mockImplementationOnce(held.run);
    const old = h.invoke(CHANNELS.presencePublish, publishPayload);
    await held.reached;
    const leaving = h.invoke(CHANNELS.presencePublish, { ...publishPayload, leave: true });
    const next = h.invoke(CHANNELS.presencePublish, { ...publishPayload, incarnationId: NEW_INCARNATION, state: { typing: false } });
    held.response.resolve(Response.json(snapshot));
    await expect(old).resolves.toEqual(unavailable);
    await expect(leaving).resolves.toEqual(emptySuccess);
    await expect(next).resolves.toEqual(success);
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(h.fetchMock.mock.calls[1]![1]!.body))).toEqual({ clientId: "client", state: { typing: false } });
  });

  it("retires mutation admission while credentials are warming", async () => {
    const h = await harness();
    const reached = deferred();
    const release = deferred();
    h.warmCredentialCache.mockImplementation(async () => { reached.resolve(); await release.promise; });
    const result = h.invoke(CHANNELS.presencePublish, publishPayload);
    await reached.promise;
    const retiring = h.sessions.retireAfterCrash(h.first);
    release.resolve();
    await expect(result).resolves.toEqual(unavailable);
    await retiring;
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("admits the next workspace while cleanup uses the retired publish's captured token", async () => {
    const h = await harness();
    const publish = heldFetch(false);
    const leave = heldFetch(false);
    h.fetchMock.mockImplementationOnce(publish.run).mockImplementationOnce(leave.run);
    const result = h.invoke(CHANNELS.presencePublish, publishPayload);
    await publish.reached;
    const retiredSession = h.sessions.current(h.first)!;
    await h.open(h.first, "workspace-b");
    expect(retiredSession.isCurrent()).toBe(false);
    expect(h.sessions.current(h.first)?.workspaceId).toBe("workspace-b");
    h.setCredentials({ serverUrl: "https://other.example.test", relayUrl: "https://other-relay.example.test", userId: "other", email: "other@example.test", token: "new-token" });
    publish.response.resolve(Response.json(snapshot));
    await expect(result).resolves.toEqual(unavailable);
    await leave.reached;
    const [url, init] = h.fetchMock.mock.calls[1]!;
    expect(new URL(String(url)).origin).toBe("https://relay.example.test");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-token");
    expect(JSON.parse(String(init?.body))).toEqual({ clientId: "client", leave: true });
    leave.response.resolve(Response.json(snapshot));
    await h.presenceMutationOwner.retireSender(retiredSession);
  });
});
