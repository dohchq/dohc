import { describe, expect, it } from "vitest";
import {
  actorHueInput,
  canonicalClaimedName,
  deriveLocalActor,
  deriveMomentActor,
  deriveRelayChatActor,
} from "./actorIdentity";

const identity = {
  installationId: "local:installation",
  account: { issuer: "https://server.example", userId: "alice" },
} as const;
const local = { identity, workspaceId: "workspace" };
const received = { source: "received", relayIssuer: identity.account.issuer } as const;

describe("ActorKey derivation", () => {
  it("keeps signed-out installation and signed-in account keys separate", () => {
    const offline = deriveLocalActor({
      ...local, identity: { ...identity, account: null },
      author: { kind: "human" }, displayName: "Alice", origin: "renderer",
    });
    const online = deriveLocalActor({
      ...local, author: { kind: "human" }, displayName: "Alice", origin: "renderer",
    });
    expect(offline).toEqual({
      key: { kind: "installation", installationId: "local:installation" },
      displayName: "Alice", origin: "renderer", assurance: "local",
    });
    expect(online.key).toEqual({ kind: "account", ...identity.account });
    expect(online.assurance).toBe("local");
    expect(online.key).not.toEqual(offline.key);
    // A local write need not have a relay author or an enrolled workspace.
    expect(deriveLocalActor({ ...local, workspaceId: "unsynced", author: { kind: "human" }, displayName: "Alice" }).key)
      .toEqual(online.key);
  });

  it("derives received chat from the verified owner and trusted issuer", () => {
    const input = { issuer: identity.account.issuer, authorUserId: "alice", kind: "human", displayName: "A label" } as const;
    const actor = deriveRelayChatActor(input);
    expect(actor.key).toEqual({ kind: "account", ...identity.account });
    expect(actor.assurance).toBe("relay-verified");
    expect(actor.origin).toBe("unknown");
    expect(deriveRelayChatActor({ ...input, issuer: "https://other.example" }).key).not.toEqual(actor.key);
    const forged = { ...input, actorKey: { kind: "account", issuer: "fake", userId: "bob" } };
    expect(deriveRelayChatActor(forged).key).toEqual(actor.key);
  });

  it("scopes an agent's claimed name to its owner", () => {
    const input = { issuer: identity.account.issuer, authorUserId: "alice", kind: "agent", claimedName: "Opus", displayName: "Agent" } as const;
    const alice = deriveRelayChatActor(input);
    const forger = deriveRelayChatActor({ ...input, authorUserId: "mallory" });
    expect(alice.key).toEqual({
      kind: "agent", ownerKey: { kind: "account", ...identity.account }, claimedName: "Opus",
    });
    expect(alice.assurance).toBe("owner-asserted");
    expect(forger.key).not.toEqual(alice.key);
    expect(forger.key).toMatchObject({ ownerKey: { userId: "mallory" }, claimedName: "Opus" });
    expect(deriveRelayChatActor({ ...input, authorUserId: "mallory", claimedName: "Alice's agent" }).key)
      .toMatchObject({ ownerKey: { userId: "mallory" } });
    expect(deriveRelayChatActor(input).key).toEqual(alice.key);
  });

  it("uses the handshake claim, with one placeholder and no display-label input", () => {
    expect(canonicalClaimedName(undefined)).toBe("dohc-mcp");
    expect(canonicalClaimedName(null)).toBe("dohc-mcp");
    expect(canonicalClaimedName("")).toBe("dohc-mcp");
    expect(canonicalClaimedName(" Opus ")).toBe(" Opus ");
    const chat = deriveLocalActor({ ...local, author: { kind: "agent" }, displayName: "Settings name", origin: "cli" });
    const history = deriveMomentActor({ kind: "agent", agentId: "dohc-mcp", onBehalfOf: "alice" }, {
      ...local, source: "local", origin: "cli",
    }, "Agent");
    expect(chat.key).toEqual(history.key);
    expect(chat.key).toMatchObject({ claimedName: "dohc-mcp" });
    expect(chat.assurance).toBe("owner-asserted");
    expect(chat.origin).toBe("cli");
    expect(deriveLocalActor({ ...local, author: { kind: "agent" }, displayName: "Changed settings" }).key).toEqual(chat.key);
    expect(deriveLocalActor({ ...local, author: { kind: "agent", claimedName: "Sonnet" }, displayName: "Settings name" }).key)
      .not.toEqual(chat.key);
    expect(deriveLocalActor({ ...local, identity: { ...identity, account: null }, author: { kind: "agent" }, displayName: "Agent" }).key)
      .toMatchObject({ ownerKey: { kind: "installation", installationId: identity.installationId }, claimedName: "dohc-mcp" });
    expect(deriveRelayChatActor({ issuer: identity.account.issuer, authorUserId: "alice", kind: "agent", displayName: "Settings name" }).key)
      .toEqual(chat.key);
  });

  it("does not treat a CLI human claim as verified human participation", () => {
    const actor = deriveLocalActor({ ...local, author: { kind: "human" }, displayName: "Alice", origin: "cli" });
    expect(actor.origin).toBe("cli");
    expect(actor.assurance).toBe("owner-asserted");
    expect(deriveRelayChatActor({ issuer: identity.account.issuer, authorUserId: "alice", kind: "human", displayName: "Alice", origin: "cli" }).assurance)
      .toBe("owner-asserted");
  });

  it("keeps local automation identity workspace-scoped and remote automation owner-scoped", () => {
    const input = { ...local, author: { kind: "automation", automationId: "collection:tasks#notify" }, displayName: "Notify", origin: "automation" } as const;
    const actor = deriveLocalActor(input);
    expect(actor.key).toEqual({
      kind: "automation", ownerKey: { kind: "account", ...identity.account },
      workspaceId: "workspace", automationId: "collection:tasks#notify",
    });
    expect(deriveLocalActor({ ...input, workspaceId: "copy" }).key).not.toEqual(actor.key);
    const remoteInput = { issuer: identity.account.issuer, authorUserId: "alice", kind: "automation", displayName: "Notify", automationId: "forged-id" } as const;
    const remote = deriveRelayChatActor(remoteInput);
    expect(remote.key).toEqual({ kind: "remote-automation", ownerKey: { kind: "account", ...identity.account } });
    expect(JSON.stringify(remote.key)).not.toContain("forged-id");
    expect(remote.assurance).toBe("owner-asserted");
    expect(deriveMomentActor({ kind: "automation", automationId: input.author.automationId, onBehalfOf: "alice", depth: 1 }, { ...local, source: "local" }, "Notify").key)
      .toEqual(actor.key);
    const receivedAutomation = deriveMomentActor({ kind: "automation", automationId: "forged-id", onBehalfOf: "alice", depth: 1 }, received, "Notify");
    expect(receivedAutomation.key.kind).toBe("remote-automation");
    expect(JSON.stringify(receivedAutomation.key)).not.toContain("forged-id");
    expect(receivedAutomation.assurance).toBe("owner-asserted");
  });

  it("derives named and link authors from admitted relay stamps", () => {
    const named = deriveMomentActor({ kind: "named", userId: "alice", grantId: "grant", grantGeneration: 2 }, received, "Alice");
    expect(named.key).toEqual({ kind: "account", ...identity.account });
    expect(named.assurance).toBe("relay-verified");
    const link = deriveMomentActor({ kind: "link", grantId: "grant", principalId: "browser", grantGeneration: 2 }, received, "Link holder");
    expect(link.key).toEqual({ kind: "link", grantId: "grant", principalId: "browser" });
    expect(link.assurance).toBe("relay-verified");
    expect(deriveMomentActor({ kind: "link", grantId: "grant", principalId: "other-browser", grantGeneration: 3 }, received, "Claimed name").key)
      .not.toEqual(link.key);
    expect(actorHueInput(deriveMomentActor({ kind: "link", grantId: "grant", principalId: "other-browser", grantGeneration: 3 }, received, "Claimed name").key))
      .toEqual(actorHueInput(link.key));
  });

  it("projects legacy human IDs without an issuer or verified self assurance", () => {
    for (const [humanId, identityKind] of [["alice", "account"], ["local:installation", "installation"]] as const) {
      const actor = deriveMomentActor({ kind: "human", humanId }, { source: "legacy" }, "Alice");
      expect(actor.key).toEqual({ kind: "legacy-human", identityKind, humanId });
      expect(actor.assurance).toBe("inferred");
      expect(actor.origin).toBe("unknown");
    }
    expect(deriveMomentActor({ kind: "agent", agentId: "Opus", onBehalfOf: "alice" }, { source: "legacy" }, "Agent"))
      .toMatchObject({ key: { kind: "agent", ownerKey: { kind: "legacy-human", humanId: "alice" } }, assurance: "inferred" });
    const olderLocalAuthor = deriveMomentActor({ kind: "human", humanId: "bob" }, { ...local, source: "local" }, "Bob");
    expect(olderLocalAuthor.key).toMatchObject({ kind: "legacy-human", humanId: "bob" });
    expect(olderLocalAuthor.assurance).toBe("inferred");
  });

  it("leaves old signed-out chat, missing owners and incomplete projections unknown", () => {
    const input = { issuer: identity.account.issuer, kind: "human", displayName: "Alice" } as const;
    expect(deriveRelayChatActor(input)).toMatchObject({ key: { kind: "unknown" }, assurance: "unknown", origin: "unknown" });
    expect(deriveRelayChatActor({ ...input, issuer: null, authorUserId: "alice" }).key).toEqual({ kind: "unknown" });
    expect(deriveMomentActor({ kind: "agent", agentId: "Opus" }, received, "Agent").key).toEqual({ kind: "unknown" });
    expect(deriveMomentActor({ kind: "human", humanId: "local:installation" }, received, "Alice").key).toEqual({ kind: "unknown" });
    expect(deriveMomentActor({ kind: "named", userId: "alice", grantId: "grant", grantGeneration: 1 }, { source: "received" }, "Alice").key)
      .toEqual({ kind: "unknown" });
  });

  it("keeps a received moment naming this account owner-asserted", () => {
    const author = { kind: "human", humanId: identity.account.userId } as const;
    const actor = deriveMomentActor(author, received, "Alice");
    expect(actor.key).toEqual({ kind: "legacy-human", identityKind: "account", humanId: "alice" });
    expect(actor.assurance).toBe("owner-asserted");
    expect(actor.key).not.toEqual(deriveLocalActor({ ...local, author: { kind: "human" }, displayName: "Alice" }).key);
    expect(deriveMomentActor(author, { ...local, source: "local", origin: "renderer" }, "Alice").assurance).toBe("local");
    // An old owner-asserted agent declaration cannot borrow the relay's identity verification.
    expect(deriveMomentActor({ kind: "agent", agentId: "Opus", onBehalfOf: "alice" }, received, "Agent").assurance)
      .toBe("owner-asserted");
  });

  it("retains only the existing grant-scoped public pseudonym", () => {
    const actor = deriveMomentActor({ kind: "public", grantId: "grant", principalId: "public-pseudonym" }, received, "Someone");
    expect(actor.key).toEqual({ kind: "public", grantId: "grant", principalId: "public-pseudonym" });
    expect(actor.assurance).toBe("relay-verified");
  });

  it("uses the raw person ID for hue while keeping account, installation and legacy keys distinct", () => {
    const account = deriveLocalActor({ ...local, author: { kind: "human" }, displayName: "Alice" }).key;
    const oldAccount = deriveMomentActor({ kind: "human", humanId: "alice" }, { source: "legacy" }, "Old label").key;
    const installation = deriveLocalActor({ ...local, identity: { ...identity, account: null }, author: { kind: "human" }, displayName: "Alice" }).key;
    const oldInstallation = deriveMomentActor({ kind: "human", humanId: "local:installation" }, { source: "legacy" }, "Old label").key;
    expect(account).not.toEqual(oldAccount);
    expect(installation).not.toEqual(oldInstallation);
    expect(actorHueInput(account)).toBe("alice");
    expect(actorHueInput(oldAccount)).toBe("alice");
    expect(actorHueInput(installation)).toBe("local:installation");
    expect(actorHueInput(oldInstallation)).toBe("local:installation");
    expect(actorHueInput(deriveRelayChatActor({ issuer: "other-issuer", authorUserId: "alice", kind: "human", displayName: "Other label" }).key))
      .toBe("alice");
    expect(actorHueInput(deriveRelayChatActor({ issuer: null, kind: "human", displayName: "Unknown" }).key)).toBeNull();
  });
});
