import { describe, expect, it, vi } from "vitest";
import { createActorIssuer, deriveLocalActor, serializeActorKey } from "@dohc/workspace-contracts/actor-identity";
import { ACTOR_HUES, actorHueSlot } from "@dohc/workspace-contracts/actor-presentation";
import type { ChatMessage } from "@dohc/workspace-contracts/engine";
import type { RegistryEntry } from "./registryStore";
import type { CloudCredentials } from "./cloudCredentialStore";
import { chatActorForPresentation, createActorPresentationRequest, forgetWorkspacePresentation, ownActorPresentation } from "./actorPresentation";

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
function request(remote = true, workspaceId = "w") {
  let workspace: RegistryEntry = { workspaceId, rootPath: "C:/w", kind: "personal", mode: "local-first", lastOpenedAt: 0,
    sharedChannels: [{ shareId: "s", channelWireId: "wire", access: "read-write", granterEmail: null,
      relayUrl: "https://relay.test", recipientUserId: "alice", ...(remote ? { serverUrl: issuer } : {}) }],
    ...(remote ? { remote: { serverUrl: issuer, ownerUserId: "alice" } } : {}) };
  const store = { findThreadChannelId: vi.fn(async () => "channel"), getChannelWireId: vi.fn(async () => "wire") };
  const assertCurrent = vi.fn();
  const present = createActorPresentationRequest({ readWorkspace: () => workspace, store, installationId: "device", credentials, assertCurrent });
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
});
