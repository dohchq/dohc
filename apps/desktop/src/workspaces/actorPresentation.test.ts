import { describe, expect, it, vi } from "vitest";
import { createActorIssuer, deriveLocalActor, deriveRelayChatActor, serializeActorKey } from "@dohc/workspace-contracts/actor-identity";
import { ACTOR_HUES, actorHueSlot } from "@dohc/workspace-contracts/actor-presentation";
import type { ChatMessage, MomentAuthor } from "@dohc/workspace-contracts/engine";
import type { RegistryEntry } from "./registryStore";
import type { CloudCredentials } from "./cloudCredentialStore";
import { chatLinkMessageForPresentation, chatActorForPresentation, createActorPresentationRequest, createHistoryPresentationRequest, forgetWorkspacePresentation, ownActorPresentation } from "./actorPresentation";

// Count issuer construction while keeping its behavior.
vi.mock("@dohc/workspace-contracts/actor-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dohc/workspace-contracts/actor-identity")>();
  return { ...actual, createActorIssuer: vi.fn(actual.createActorIssuer) };
});

const issuer = createActorIssuer("https://account.test");
const credentials: CloudCredentials = { serverUrl: issuer, email: "alice@example.test", userId: "alice", token: "token", relayUrl: "https://relay.test" };
const identity = { installationId: "device", account: { issuer, userId: "alice" } };
const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  workspaceId: "w", id: "m", threadId: "t", author: { kind: "human", displayName: "Renamed" },
  authorUserId: "alice", body: "Hi", createdAtMs: 0, attachments: [], ...overrides,
});
function local(kind: "human" | "agent" | "automation", origin: "renderer" | "cli" | "automation" | "unknown" = "renderer", account: typeof identity.account | null = identity.account) {
  const actor = deriveLocalActor({ identity: { ...identity, account }, workspaceId: "w", displayName: "Renamed", origin,
    author: kind === "agent" ? { kind, claimedName: "handshake" } : kind === "automation" ? { kind, automationId: "job" } : { kind } });
  return message({ author: { kind, displayName: "Renamed" }, authorActorKey: serializeActorKey(actor.key), ...(origin === "cli" ? { origin } : {}) });
}
function request(remote = true, workspaceId = "w", agentColors: Record<string, "blue" | "rose"> = {}) {
  let workspace: RegistryEntry = { workspaceId, rootPath: "C:/w", kind: "personal", mode: "local-first", lastOpenedAt: 0,
    sharedChannels: [{ shareId: "s", channelWireId: "wire", access: "read-write", granterEmail: null,
      relayUrl: "https://relay.test", recipientUserId: "alice", ...(remote ? { serverUrl: issuer } : {}) }],
    ...(remote ? { remote: { serverUrl: issuer, ownerUserId: "alice" } } : {}) };
  const store = { findThreadChannelId: vi.fn(async () => "channel"), getChannelWireId: vi.fn(async () => "wire") };
  const assertCurrent = vi.fn();
  const present = createActorPresentationRequest({ agentColors: () => agentColors, readWorkspace: () => workspace, store, installationId: "device", credentials, assertCurrent });
  return { present, store, assertCurrent, replace: () => { workspace = { ...workspace, lastOpenedAt: 1 }; } };
}
describe("chat presentation admission", () => {
  it.each([["", "teal"], ["alice", "rose"], ["A😀", "indigo"], ["é", "rust"]])("pins code-point hue %s", (value, hue) => {
    expect(ACTOR_HUES[actorHueSlot(value!)]).toBe(hue);
  });
  it.each([
    [local("human"), "local", "renderer"], [local("human", "cli"), "owner-asserted", "cli"],
    [local("agent"), "owner-asserted", "unknown"], [local("automation"), "owner-asserted", "automation"],
    [message({ authorActorKey: '{"kind":"unknown"}' }), "unknown", "renderer"],
    [message(), "relay-verified", "unknown"], [message({ origin: "cli" }), "owner-asserted", "cli"],
    [message({ author: { kind: "agent", displayName: "claimed" } }), "owner-asserted", "unknown"],
    [message({ author: { kind: "automation", displayName: "job" } }), "owner-asserted", "unknown"],
  ] as const)("preserves admission assurance %#", (row, assurance, origin) => {
    expect(chatActorForPresentation(row, issuer)).toMatchObject({ assurance, origin });
  });
  it("uses the ingested agent's claimed name", () => {
    expect(chatActorForPresentation(message({ author: { kind: "agent", displayName: "claimed" } }), issuer).key)
      .toMatchObject({ kind: "agent", claimedName: "claimed" });
  });
  it("keeps a missing key unknown despite current credentials and author id", async () => {
    const r = request(false);
    expect(chatActorForPresentation(message(), null).assurance).toBe("unknown");
    expect(await r.present(message(), "t")).toMatchObject({ hue: null, self: false });
  });
  it("retries a registry write during the first lookup", async () => {
    const r = request();
    r.store.findThreadChannelId.mockImplementationOnce(async () => { r.replace(); return "channel"; });
    expect(await r.present(message(), "t")).toMatchObject({ hue: "rose", self: true });
    expect(r.store.findThreadChannelId).toHaveBeenCalledTimes(2);
  });
  it("memoizes resolution once per thread, including simultaneous rows", async () => {
    const r = request();
    await Promise.all([r.present(message(), "t"), r.present(message(), "t"), r.present(message(), "other")]);
    expect(r.store.findThreadChannelId).toHaveBeenCalledTimes(2);
    expect(r.assertCurrent).toHaveBeenCalled();
  });
  it("keeps installation and account groups apart while recognizing both and their agents", async () => {
    const r = request();
    const installation = await r.present(local("human", "renderer", null), "t");
    const account = await r.present(local("human"), "t");
    expect(installation.group).not.toBe(account.group);
    expect(installation.self).toBe(true); expect(account.self).toBe(true);
    expect(await r.present(local("agent"), "t")).toMatchObject({ hue: null, self: true });
    expect(await r.present(local("agent", "renderer", null), "t")).toMatchObject({ hue: null, self: true });
    expect(await r.present(local("automation"), "t")).toMatchObject({ hue: null, self: false });
    expect(await r.present(message({ authorUserId: "someone" }), "t")).toMatchObject({ self: false });
    const foreign = local("human", "renderer", { issuer: createActorIssuer("https://other.test"), userId: "alice" });
    expect(await r.present(foreign, "t")).toMatchObject({ self: false });
    expect((await r.present(message({ author: { kind: "human", displayName: "A different label" } }), "t")).group).toBe(account.group);
  });
  it.each([credentials, null])("uses the own message hue for the own token %#", async (account) => {
    const r = request();
    const own = ownActorPresentation("device", account);
    const row = await r.present(local("human", "renderer", account ? identity.account : null), "t");
    expect(own.hue).toBe(row.hue);
    expect(own.self).toBe(true);
  });
  it.each(["https://account.test?query=1", "https://account.test#fragment", "invalid"])("falls back to the installation hue for malformed account URL %s", (serverUrl) => {
    expect(ownActorPresentation("device", { ...credentials, serverUrl })).toEqual(ownActorPresentation("device", null));
  });
  it("retains no unknown-author entries while keeping visible groups stable", async () => {
    const workspaceId = "unknown-churn";
    const r = request(false, workspaceId);
    const alice = message({ authorUserId: "alice", author: { kind: "human", displayName: "Alice" } });
    const first = await r.present(alice, "t");
    const set = vi.spyOn(Map.prototype, "set");
    try {
      for (let i = 0; i < 2000; i++) {
        await r.present(message({ authorUserId: String(i), author: { kind: "human", displayName: "Label " + i } }), "t");
      }
      expect(set.mock.calls.filter(([key]) => typeof key === "string" && key.startsWith('["unknown",'))).toHaveLength(0);
    } finally { set.mockRestore(); }
    expect(await request(false, workspaceId).present(alice, "t")).toEqual(first);
    expect((await r.present(alice, "other-thread")).group).not.toBe(first.group);
    expect((await request(false, "other-workspace").present(alice, "t")).group).not.toBe(first.group);
    forgetWorkspacePresentation(workspaceId);
    expect((await request(false, workspaceId).present(alice, "t")).group).not.toBe(first.group);
  });
  it("groups unknowns by author id and visible name", async () => {
    const r = request(false);
    const alice = message({ authorUserId: undefined, author: { kind: "human", displayName: "Alice" } });
    const first = await r.present(alice, "t");
    expect(await r.present(alice, "t")).toEqual(first);
    expect((await r.present({ ...alice, author: { kind: "human", displayName: "Bob" } }, "t")).group).not.toBe(first.group);
    expect((await r.present({ ...alice, authorUserId: "other" }, "t")).group).not.toBe(first.group);
    expect((await r.present({ ...alice, authorActorKey: '{"kind":"unknown"}' }, "t")).group).toBe(first.group);
  });
  it("scopes groups to a workspace and releases them on close", async () => {
    const first = request(true, "group-first");
    const second = request(true, "group-second");
    const a = await first.present(message(), "t");
    const b = await second.present(message(), "t");
    expect(a.group).not.toBe(b.group);
    forgetWorkspacePresentation("group-first");
    expect((await request(true, "group-first").present(message(), "t")).group).not.toBe(a.group);
    expect((await second.present(message(), "t")).group).toBe(b.group);
  });
  it("never hashes a human into olive", async () => {
    const r = request();
    for (let i = 0; i < 100; i++) expect((await r.present(message({ authorUserId: String(i) }), "t")).hue).not.toBe("olive");
  });
  it("rejects a retired operation rather than retrying it", async () => {
    const r = request(); r.assertCurrent.mockImplementation(() => { throw new Error("retired"); });
    await expect(r.present(message(), "t")).rejects.toThrow("retired");
  });
  it("tells link holders apart by their link principal, never by an account, and never as you", async () => {
    const r = request();
    const link = (principalId: string, displayName = "Guest"): ChatMessage =>
      message({ author: { kind: "link", displayName, grantId: "grant-1", principalId }, authorUserId: undefined });
    expect(chatActorForPresentation(link("p1"), issuer)).toMatchObject({
      key: { kind: "link", grantId: "grant-1", principalId: "p1" }, assurance: "relay-verified",
    });
    const first = await r.present(link("p1"), "t");
    expect(first).toMatchObject({ hue: null, self: false });
    expect(first.group.startsWith("unknown:")).toBe(false);
    // The same principal in another thread, under a new name, is the same link holder.
    expect((await r.present(link("p1", "Renamed"), "other")).group).toBe(first.group);
    expect((await r.present(link("p2"), "t")).group).not.toBe(first.group);
    // A link holder named after you, on your account's server, is still not you.
    expect(await r.present(link("p3", "alice"), "t")).toMatchObject({ self: false });
    expect((await r.present(message(), "t")).group).not.toBe(first.group);
    const entry = { authorKind: "link" as const, authorDisplayName: "Guest", linkGrantId: "grant-1", linkPrincipalId: "p1" };
    expect((await r.present(chatLinkMessageForPresentation(entry), "t")).group).toBe(first.group);
  });
});

describe("History presentation", () => {
  const history = (serverUrl: string | undefined = issuer) => createHistoryPresentationRequest({
    source: "own-store", workspaceId: "w", assertCurrent: () => undefined, serverUrl, synced: serverUrl !== undefined, installationId: "device", credentials,
  });
  const received = () => createHistoryPresentationRequest({ source: "received", workspaceId: "w", assertCurrent: () => undefined });
  const named = (userId: string): MomentAuthor => ({ kind: "named", userId, grantId: "grant", grantGeneration: 1 });
  const agent = (agentId: string, onBehalfOf = "alice"): MomentAuthor => ({ kind: "agent", agentId, onBehalfOf });

  it("matches chat's token for the same account, the same installation, and a person you shared with", async () => {
    const chat = request();
    const [account, installation, sam] = history()([{ kind: "human", humanId: "alice" }, { kind: "human", humanId: "device" }, named("sam")]);
    expect(account).toEqual(await chat.present(local("human"), "t"));
    expect(installation).toEqual(await chat.present(local("human", "renderer", null), "t"));
    expect(sam).toEqual(await chat.present(message({ authorUserId: "sam", author: { kind: "human", displayName: "Sam" } }), "t"));
    // Installation and account self stay apart.
    expect(account!.group).not.toBe(installation!.group);
    expect([account!.self, installation!.self, sam!.self]).toEqual([true, true, false]);
    expect(sam!.hue).toBe(ACTOR_HUES[actorHueSlot("sam")]);
  });

  it("gives a local agent its chat group only when the claimed name matches", async () => {
    const chat = await request().present(local("agent"), "t");
    const [same, renamed, signedOut] = history()([agent("handshake"), agent("dohc-chat-runner"), agent("handshake", "device")]);
    expect(same).toEqual(chat);
    expect(renamed!.group).not.toBe(chat.group);
    expect(signedOut).toEqual(await request().present(local("agent", "renderer", null), "t"));
    for (const token of [same, renamed, signedOut]) expect(token).toMatchObject({ hue: null, self: true });
  });

  it("keeps one token per author, in order, with hues for people only", () => {
    const tokens = history()([
      named("sam"), agent("handshake"), { kind: "human", humanId: "alice" }, { kind: "human", humanId: "someone-else" },
      { kind: "automation", automationId: "collection:Tasks#stamp", onBehalfOf: "alice", depth: 1 },
      { kind: "link", grantId: "grant", grantGeneration: 1, principalId: "holder" },
      { kind: "link", publicPrincipalId: "public_1", label: "Anonymous" },
      { kind: "public", principalId: "public_x", grantId: "grant" },
      { kind: "unattributed" }, agent("Pat", "someone-else"),
    ]);
    expect(tokens.map(token => token.hue)).toEqual([
      ACTOR_HUES[actorHueSlot("sam")], null, "rose", ACTOR_HUES[actorHueSlot("someone-else")], null, null, null, null, null, null,
    ]);
    expect(tokens.map(token => token.self)).toEqual([false, true, true, false, false, false, false, false, false, false]);
    expect(tokens[8]!.group).toMatch(/^unknown:/);
    // The token names nobody.
    expect(JSON.stringify(tokens)).not.toMatch(/alice|device|sam|someone|grant|holder|public|Pat/);
  });

  it.each([["no server", true], ["invalid", false], ["https://account.test?query=1", false]] as const)("leaves named authors neutral for %s", (serverUrl, mine) => {
    const [sam, person] = createHistoryPresentationRequest({ source: "own-store", workspaceId: "w", assertCurrent: () => undefined,
      serverUrl: serverUrl === "no server" ? undefined : serverUrl, synced: serverUrl !== "no server", installationId: "device", credentials,
    })([named("sam"), { kind: "human", humanId: "alice" }]);
    expect(sam).toMatchObject({ hue: null, self: false });
    expect(sam!.group).toMatch(/^unknown:/);
    // An unsynced store has no other server's ids; a server it can't read can't confirm yours.
    expect(person).toMatchObject({ hue: "rose", self: mine });
  });

  it("does not take a person on the workspace's server for you because your account elsewhere has their user id", () => {
    const [person, agentOf, installation, sam] = history("https://other.test")([
      { kind: "human", humanId: "alice" }, agent("handshake"), { kind: "human", humanId: "device" }, named("alice"),
    ]);
    expect(person).toMatchObject({ hue: "rose", self: false });
    expect(agentOf).toMatchObject({ hue: null, self: false });
    expect(installation!.self).toBe(true);
    expect(sam).toMatchObject({ hue: "rose", self: false });
    // The same id on your own server is you.
    expect(history("https://account.test/")([{ kind: "human", humanId: "alice" }])[0]!.self).toBe(true);
  });

  it("does not take an account for you in a folder that synced and has no remote now", () => {
    const [person, installation] = createHistoryPresentationRequest({ source: "own-store", workspaceId: "w", assertCurrent: () => undefined,
      serverUrl: undefined, synced: true, installationId: "device", credentials })([{ kind: "human", humanId: "alice" }, { kind: "human", humanId: "device" }]);
    expect(person).toMatchObject({ hue: "rose", self: false });
    expect(installation!.self).toBe(true);
  });

  it("makes the named-author issuer once per request", () => {
    vi.mocked(createActorIssuer).mockClear();
    const present = history("https://named.test/");
    present(Array.from({ length: 50 }, (_, index) => named(`u${index}`)));
    present([named("sam")]);
    expect(vi.mocked(createActorIssuer).mock.calls.filter(([url]) => url === "https://named.test/")).toHaveLength(1);
    // The other construction is the current account's.
    expect(createActorIssuer).toHaveBeenCalledTimes(2);
  });

  it("never resolves an issuer or self for received History", () => {
    vi.mocked(createActorIssuer).mockClear();
    const tokens = received()([
      named("alice"), { kind: "human", humanId: "alice" }, { kind: "human", humanId: "device" },
      { kind: "human", humanId: "local:device" }, agent("handshake"),
    ]);
    expect(createActorIssuer).not.toHaveBeenCalled();
    expect(tokens.map(token => token.self)).toEqual([false, false, false, false, false]);
    expect(tokens.map(token => token.hue)).toEqual([null, "rose", ACTOR_HUES[actorHueSlot("device")], null, null]);
    expect(tokens[0]!.group).toMatch(/^unknown:/);
    expect(tokens[3]!.group).toMatch(/^unknown:/);
  });

  it("checks the workspace before drawing a group", () => {
    const present = createHistoryPresentationRequest({ source: "received", workspaceId: "closing", assertCurrent: () => { throw new Error("closed"); } });
    expect(() => present([named("sam")])).toThrow("closed");
  });
});


describe("personal agent hues", () => {
  it("colours chat and History by the full agent key, with no effect on other owners or people", async () => {
    const chosen = local("agent");
    const human = local("human");
    const automation = local("automation");
    const colors = { [chosen.authorActorKey!]: "blue", [human.authorActorKey!]: "blue",
      [automation.authorActorKey!]: "rose", malformed: "rose" } as const;
    const chat = request(true, "w", colors);
    const token = await chat.present(chosen, "t");
    expect(token.hue).toBe("blue");
    const history = createHistoryPresentationRequest({ source: "own-store", workspaceId: "w", assertCurrent: () => undefined,
      serverUrl: issuer, synced: true, installationId: "device", credentials, agentColors: () => colors });
    expect(history([{ kind: "agent", agentId: "handshake", onBehalfOf: "alice" }])[0]).toEqual(token);
    const foreign = local("agent", "renderer", { issuer, userId: "sam" });
    expect(await chat.present(foreign, "t")).toMatchObject({ hue: null, self: false });
    expect(await chat.present(human, "t")).toMatchObject({ hue: "rose" });
    expect(await chat.present(automation, "t")).toMatchObject({ hue: null });
    expect(history([{ kind: "agent", agentId: "handshake", onBehalfOf: "sam" }])[0]?.hue).toBeNull();
    expect(history([{ kind: "automation", automationId: "job", depth: 0 }])[0]?.hue).toBeNull();
    expect((await request(true, "w", { malformed: "blue" }).present(chosen, "t")).hue).toBeNull();
  });
});


it("matches dispatch's unnamed run and CLI reply claims on the current base", async () => {
  const { UNNAMED_AGENT_ID } = await import("../agents/activeAgentRun");
  expect(UNNAMED_AGENT_ID).toBe("dohc-mcp");
  const key = serializeActorKey(deriveLocalActor({ identity, workspaceId: "w", author: { kind: "agent" },
    displayName: "Agent", origin: "cli" }).key);
  const colors = { [key]: "blue" } as const;
  const chat = await request(true, "w", colors).present(message({ author: { kind: "agent", displayName: "Agent" }, authorActorKey: key }), "t");
  const [history] = createHistoryPresentationRequest({ source: "own-store", workspaceId: "w", assertCurrent: () => undefined,
    serverUrl: issuer, synced: true, installationId: "device", credentials, agentColors: () => colors })([
    { kind: "agent", agentId: UNNAMED_AGENT_ID, onBehalfOf: "alice" },
  ]);
  expect(history).toEqual(chat);
  expect(history?.hue).toBe("blue");
});


it("resolves an in-flight chat and an unread History page against current settings", async () => {
  const row = local("agent");
  let choices: Record<string, "rose" | "blue"> = { [row.authorActorKey!]: "rose" };
  const chat = createActorPresentationRequest({ readWorkspace: () => ({ workspaceId: "w", rootPath: "C:/w", kind: "personal", mode: "local-first" }),
    store: { findThreadChannelId: async () => null, getChannelWireId: async () => null }, installationId: "device", credentials,
    agentColors: () => choices });
  const history = createHistoryPresentationRequest({ source: "own-store", workspaceId: "w", assertCurrent: () => undefined,
    serverUrl: issuer, synced: true, installationId: "device", credentials, agentColors: () => choices });
  const pending = chat(row, "thread");
  choices = { [row.authorActorKey!]: "blue" };
  expect((await pending).hue).toBe("blue");
  expect(history([{ kind: "agent", agentId: "handshake", onBehalfOf: "alice" }])[0]?.hue).toBe("blue");
  choices = {};
  expect(history([{ kind: "agent", agentId: "handshake", onBehalfOf: "alice" }])[0]?.hue).toBeNull();
});

it.each(["human", "agent", "automation"] as const)("Links and Chat share %s keys and presentation across origins", async kind => {
  const claim = kind === "agent" ? { kind, claimedName: "teammate-agent" } : { kind };
  const input = { issuer, authorUserId: "sam", displayName: "teammate-agent", ...claim };
  const key = serializeActorKey(deriveRelayChatActor(input).key);
  for (const origin of ["renderer", "cli", "automation", "unknown"] as const) {
    expect(serializeActorKey(deriveRelayChatActor({ ...input, origin }).key)).toBe(key);
    expect(serializeActorKey(deriveRelayChatActor({ ...input, issuer: null, origin }).key))
      .toBe(serializeActorKey(deriveRelayChatActor({ ...input, issuer: null }).key));
  }
  const cli = message({ author: { kind, displayName: input.displayName }, authorUserId: input.authorUserId, origin: "cli" });
  const link = chatLinkMessageForPresentation({
    authorKind: kind, authorDisplayName: input.displayName, authorUserId: input.authorUserId,
  });
  expect(chatActorForPresentation(link, issuer).key).toEqual(chatActorForPresentation(cli, issuer).key);
  const present = request(true, "links-origin-" + kind).present;
  expect(await present(link, "t")).toEqual(await present(cli, "t"));
});
