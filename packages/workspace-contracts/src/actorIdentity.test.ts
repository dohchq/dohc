import { describe, expect, it, vi } from "vitest";
import type { MomentAuthor } from "./engine";
import {
  actorHueInput,
  actorKeysEqual,
  createActorIssuer,
  parseActorKey,
  serializeActorKey,
  canonicalClaimedName,
  deriveLocalActor,
  deriveMomentActor,
  deriveRelayChatActor,
} from "./actorIdentity";

const identity = {
  installationId: "local:installation",
  account: { issuer: createActorIssuer("https://server.example"), userId: "alice" },
} as const;
const local = { identity, workspaceId: "workspace", origin: "renderer" } as const;
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
    expect(deriveRelayChatActor({ ...input, issuer: createActorIssuer("https://other.example") }).key).not.toEqual(actor.key);
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
      ...local, source: "own-store", origin: "cli",
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
    expect(deriveRelayChatActor({ issuer: identity.account.issuer, authorUserId: "alice", kind: "agent", claimedName: "Settings name", displayName: "Settings name" }).key)
      .not.toEqual(chat.key);
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
    expect(deriveMomentActor({ kind: "automation", automationId: input.author.automationId, onBehalfOf: "alice", depth: 1 }, { ...local, source: "own-store" }, "Notify").key)
      .toEqual(actor.key);
    const receivedAutomation = deriveMomentActor({ kind: "automation", automationId: "forged-id", onBehalfOf: "alice", depth: 1 }, received, "Notify");
    expect(receivedAutomation.key.kind).toBe("remote-automation");
    expect(JSON.stringify(receivedAutomation.key)).not.toContain("forged-id");
    expect(receivedAutomation.assurance).toBe("owner-asserted");
  });

  it("derives received named and link authors as claims", () => {
    const named = deriveMomentActor({ kind: "named", userId: "alice", grantId: "grant", grantGeneration: 2 }, received, "Alice");
    expect(named.key).toEqual({ kind: "account", ...identity.account });
    expect(named.assurance).toBe("owner-asserted");
    const link = deriveMomentActor({ kind: "link", grantId: "grant", principalId: "browser", grantGeneration: 2 }, received, "Link holder");
    expect(link.key).toEqual({ kind: "link", grantId: "grant", principalId: "browser" });
    expect(link.assurance).toBe("owner-asserted");
    expect(deriveMomentActor({ kind: "link", grantId: "grant", principalId: "other-browser", grantGeneration: 3 }, received, "Claimed name").key)
      .not.toEqual(link.key);
    expect(actorHueInput(deriveMomentActor({ kind: "link", grantId: "grant", principalId: "other-browser", grantGeneration: 3 }, received, "Claimed name").key))
      .toEqual(actorHueInput(link.key));
  });

  it("keeps a live link's public identity without inventing a grant or internal participant", () => {
    const actor = deriveMomentActor({ kind: "link", publicPrincipalId: "public-ana", label: "Ana" }, received, "Ana");
    expect(actor.key).toEqual({ kind: "link", publicPrincipalId: "public-ana" });
    expect(parseActorKey(serializeActorKey(actor.key))).toEqual(actor.key);
    expect(actor.assurance).toBe("owner-asserted");
    const other = deriveMomentActor({ kind: "link", publicPrincipalId: "public-bea", label: "Ana" }, received, "Ana");
    expect(actorKeysEqual(actor.key, other.key)).toBe(false);
    expect(actorHueInput(actor.key)).not.toEqual(actorHueInput(other.key));
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
    const olderLocalAuthor = deriveMomentActor({ kind: "human", humanId: "bob" }, { ...local, source: "own-store" }, "Bob");
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
    expect(deriveMomentActor(author, { ...local, source: "own-store", origin: "renderer" }, "Alice").assurance).toBe("owner-asserted");
    // An old owner-asserted agent declaration cannot borrow the relay's identity verification.
    expect(deriveMomentActor({ kind: "agent", agentId: "Opus", onBehalfOf: "alice" }, received, "Agent").assurance)
      .toBe("owner-asserted");
  });

  it("keys a live snapshot's link holder by its public principal, with no grant", () => {
    const author = { kind: "link", publicPrincipalId: "public_1", label: "Anonymous" } as const;
    for (const [context, assurance] of [
      [received, "owner-asserted"],
      [{ ...local, source: "own-store" } as const, "relay-verified"],
    ] as const) {
      const actor = deriveMomentActor(author, context, "Link holder Anonymous");
      expect(actor.key).toEqual({ kind: "link", publicPrincipalId: "public_1" });
      expect(actor.assurance).toBe(assurance);
    }
    // The same identifier as a grant's link participant is another identity.
    const grantLink = deriveMomentActor({ kind: "link", grantId: "grant", grantGeneration: 1, principalId: "public_1" }, received, "Link holder");
    expect(actorKeysEqual(deriveMomentActor(author, received, "Link holder Anonymous").key, grantLink.key)).toBe(false);
  });

  it("retains only the existing grant-scoped public pseudonym", () => {
    const actor = deriveMomentActor({ kind: "public", grantId: "grant", principalId: "public-pseudonym" }, received, "Someone");
    expect(actor.key).toEqual({ kind: "public", grantId: "grant", principalId: "public-pseudonym" });
    expect(actor.assurance).toBe("owner-asserted");
  });

  it("uses the raw person ID for hue while keeping account, installation and legacy keys distinct", () => {
    const account = deriveLocalActor({ ...local, author: { kind: "human" }, displayName: "Alice" }).key;
    const oldAccount = deriveMomentActor({ kind: "human", humanId: "alice" }, { source: "legacy" }, "Old label").key;
    const installation = deriveLocalActor({ ...local, identity: { ...identity, account: null }, author: { kind: "human" }, displayName: "Alice" }).key;
    const oldInstallation = deriveMomentActor({ kind: "human", humanId: "local:installation" }, { source: "legacy" }, "Old label").key;
    expect(account).not.toEqual(oldAccount);
    expect(installation).not.toEqual(oldInstallation);
    expect(actorHueInput(account)?.value).toBe("alice");
    expect(actorHueInput(oldAccount)?.value).toBe("alice");
    expect(actorHueInput(installation)?.value).toBe("local:installation");
    expect(actorHueInput(oldInstallation)?.value).toBe("local:installation");
    expect(actorHueInput(deriveRelayChatActor({ issuer: createActorIssuer("https://other.example"), authorUserId: "alice", kind: "human", displayName: "Other label" }).key)?.value)
      .toBe("alice");
    expect(actorHueInput(deriveRelayChatActor({ issuer: null, kind: "human", displayName: "Unknown" }).key)).toBeNull();
  });
});

it("does not rate an omitted local admission origin as local", () => {
  const input = { identity, workspaceId: "workspace", author: { kind: "human" }, displayName: "Alice" } as const;
  // Deliberately exercise an untyped caller that omitted the required origin.
  // @ts-expect-error Local admission must provide an origin.
  expect(deriveLocalActor(input).assurance).not.toBe("local");
});

it.each(["cli", "automation", "unknown"] as const)("does not rate %s local admission as local", origin => {
  expect(deriveLocalActor({ ...local, author: { kind: "human" }, displayName: "Alice", origin }).assurance).not.toBe("local");
});

it("recognizes own-store installation moments while signed in", () => {
  const actor = deriveMomentActor({ kind: "human", humanId: identity.installationId }, { ...local, source: "own-store" }, "Alice");
  expect(actor.assurance).toBe("local");
  expect(actor.key).toEqual({ kind: "installation", installationId: identity.installationId });
});

it.each([
  ["renderer", "local"],
  ["unknown", "local"],
  [undefined, "local"],
  ["cli", "owner-asserted"],
  ["automation", "owner-asserted"],
] as const)("rates installation History origin %s as %s", (origin, assurance) => {
  const actor = deriveMomentActor({ kind: "human", humanId: identity.installationId }, {
    ...local, source: "own-store", origin,
  }, "Alice");
  expect(actor.assurance).toBe(assurance);
});

it("does not rate synced own-store account moments as local", () => {
  expect(deriveMomentActor({ kind: "human", humanId: "alice" }, { ...local, source: "own-store" }, "Alice").assurance).toBe("owner-asserted");
});

it.each([
  { kind: "named", userId: "alice", grantId: "grant", grantGeneration: 1 },
  { kind: "link", grantId: "grant", principalId: "browser", grantGeneration: 1 },
] as const)("does not verify a received $kind History claim", author => {
  expect(deriveMomentActor(author, { source: "received", relayIssuer: identity.account.issuer }, "Alice").assurance).toBe("owner-asserted");
});

it("normalizes trailing slashes in account issuers", () => {
  const actor = deriveLocalActor({ ...local, author: { kind: "human" }, displayName: "Alice" });
  const alternate = deriveLocalActor({ ...local, identity: { ...identity, account: { ...identity.account, issuer: createActorIssuer("https://server.example/") } }, author: { kind: "human" }, displayName: "Alice" });
  expect(alternate.key).toEqual(actor.key);
});

it("does not invent a placeholder for a received agent's missing claim", () => {
  const input = { issuer: identity.account.issuer, authorUserId: "alice", kind: "agent", displayName: "Opus" } as const;
  // @ts-expect-error An agent row must provide the remote displayed-name claim.
  expect(deriveRelayChatActor(input).key).toEqual({ kind: "unknown" });
});

it("keeps synced own-store automation keys local to the workspace, at owner-asserted assurance", () => {
  for (const onBehalfOf of ["alice", identity.installationId, "another-account", undefined]) {
    const actor = deriveMomentActor({ kind: "automation", automationId: "collection:tasks#notify", onBehalfOf, depth: 1 }, { ...local, source: "own-store" }, "Notify");
    expect(actor.key).toMatchObject({ kind: "automation", workspaceId: "workspace", automationId: "collection:tasks#notify" });
    expect(actor.assurance).toBe("owner-asserted");
    if (onBehalfOf === undefined) expect(actor.key).toMatchObject({ ownerKey: null });
    const copiedWorkspace = deriveMomentActor({ kind: "automation", automationId: "collection:tasks#notify", onBehalfOf, depth: 1 }, { ...local, workspaceId: "copy", source: "own-store" }, "Notify");
    expect(actorKeysEqual(actor.key, copiedWorkspace.key)).toBe(false);
  }
});

it("does not give verified self assurance to a received named author with the recipient's account ID", () => {
  const named = { kind: "named", userId: identity.account.userId, grantId: "grant", grantGeneration: 1 } as const;
  const actor = deriveMomentActor(named, received, "Alice");
  expect(actor.key).toEqual(deriveLocalActor({ ...local, author: { kind: "human" }, displayName: "Alice" }).key);
  expect(actor.assurance).toBe("owner-asserted");
  expect(deriveMomentActor(named, { ...received, source: "own-store", ...local }, "Alice").assurance).toBe("relay-verified");
});

it("keeps two named agents of one owner from another device distinct", () => {
  const input = { issuer: identity.account.issuer, authorUserId: "alice", kind: "agent", origin: "cli" } as const;
  const opus = deriveRelayChatActor({ ...input, displayName: "Opus", claimedName: "Opus" });
  const sonnet = deriveRelayChatActor({ ...input, displayName: "Sonnet", claimedName: "Sonnet" });
  expect(opus.key).toMatchObject({ kind: "agent", claimedName: "Opus" });
  expect(sonnet.key).toMatchObject({ kind: "agent", claimedName: "Sonnet" });
  expect(actorKeysEqual(opus.key, sonnet.key)).toBe(false);
  expect(deriveRelayChatActor({ ...input, displayName: "Opus", claimedName: "" }).key.kind).toBe("unknown");
});

it("normalizes issuer scheme, host, trailing slashes and default ports in every derivation", () => {
  const plain = createActorIssuer("https://s.example");
  for (const raw of ["https://s.example/", "HTTPS://S.EXAMPLE:443/", "https://s.example///"]) {
    const issuer = createActorIssuer(raw);
    expect(issuer).toBe(plain);
    const actor = deriveLocalActor({ ...local, identity: { ...identity, account: { issuer, userId: "alice" } }, author: { kind: "human" }, displayName: "Alice" });
    expect(actor.key).toEqual(deriveRelayChatActor({ issuer: plain, authorUserId: "alice", kind: "human", displayName: "Alice" }).key);
    expect(actor.key).toEqual(deriveMomentActor({ kind: "named", userId: "alice", grantId: "grant", grantGeneration: 1 }, { source: "received", relayIssuer: issuer }, "Alice").key);
  }
  expect(createActorIssuer("HTTP://S.EXAMPLE:80/base/")).toBe("http://s.example/base");
  expect(createActorIssuer("https://S.EXAMPLE:8443/CaseSensitive/")).toBe("https://s.example:8443/CaseSensitive");
  expect(() => createActorIssuer("not a server URL")).toThrow();
});

describe("ActorKey storage", () => {
  const moments: readonly MomentAuthor[] = [
    { kind: "unattributed" },
    { kind: "human", humanId: "alice" },
    { kind: "human", humanId: identity.installationId },
    { kind: "agent", agentId: "Opus", onBehalfOf: "alice" },
    { kind: "link", grantId: "grant", principalId: "browser", grantGeneration: 1 },
    { kind: "public", grantId: "grant", principalId: "pseudonym" },
    { kind: "automation", automationId: "collection:tasks#notify", depth: 1 },
  ];

  it("serializes and compares normalized keys without parsing URLs", () => {
    const actor = deriveLocalActor({ ...local, author: { kind: "agent", claimedName: "Opus" }, displayName: "Agent" });
    const copy = parseActorKey(serializeActorKey(actor.key));
    if (copy === null) throw new Error("Expected a restored key");
    const OriginalURL = globalThis.URL;
    let urlParses = 0;
    vi.stubGlobal("URL", class extends OriginalURL {
      constructor(url: string | URL, base?: string | URL) {
        super(url, base);
        urlParses += 1;
      }
    });
    try {
      expect(serializeActorKey(copy)).toBe(serializeActorKey(actor.key));
      expect(actorKeysEqual(copy, actor.key)).toBe(true);
      expect(urlParses).toBe(0);
    } finally {
      vi.stubGlobal("URL", OriginalURL);
    }
  });

  it("round-trips every variant and restores keys accepted by the typed equality helper", () => {
    const keys = [
      deriveLocalActor({ ...local, author: { kind: "human" }, displayName: "Alice" }).key,
      deriveLocalActor({ ...local, identity: { ...identity, account: null }, author: { kind: "human" }, displayName: "Alice" }).key,
      deriveLocalActor({ ...local, author: { kind: "agent", claimedName: "Opus" }, displayName: "Agent" }).key,
      deriveLocalActor({ ...local, author: { kind: "automation", automationId: "collection:tasks#notify" }, displayName: "Notify" }).key,
      deriveRelayChatActor({ issuer: identity.account.issuer, authorUserId: "alice", kind: "automation", displayName: "Notify" }).key,
      deriveRelayChatActor({ issuer: null, kind: "human", displayName: "Unknown" }).key,
      ...moments.map(author => deriveMomentActor(author, { source: "legacy" }, "Old author").key),
      deriveMomentActor(moments[5]!, { ...local, source: "own-store" }, "Notify").key,
    ];
    for (const key of keys) {
      const encoded = serializeActorKey(key);
      const parsed = parseActorKey(encoded);
      expect(parsed).toEqual(key);
      if (parsed === null) throw new Error("Expected a restored ActorKey");
      expect(actorKeysEqual(parsed, key)).toBe(true);
      expect(serializeActorKey(parsed)).toBe(encoded);
    }
  });

  it("compares and serializes keys independently of field order, including nested owners", () => {
    const reordered = parseActorKey('{"claimedName":"Opus","ownerKey":{"userId":"alice","issuer":"HTTPS://SERVER.EXAMPLE:443/","kind":"account"},"kind":"agent"}');
    const actor = deriveLocalActor({ ...local, author: { kind: "agent", claimedName: "Opus" }, displayName: "Agent" });
    if (reordered === null) throw new Error("Expected a valid reordered ActorKey");
    expect(actorKeysEqual(reordered, actor.key)).toBe(true);
    expect(serializeActorKey(reordered)).toBe('{"kind":"agent","ownerKey":{"kind":"account","issuer":"https://server.example","userId":"alice"},"claimedName":"Opus"}');
    const reversedObject = { ...actor.key };
    for (const [name, value] of Object.entries(actor.key).reverse()) { Reflect.deleteProperty(reversedObject, name); Reflect.set(reversedObject, name, value); }
    expect(serializeActorKey(reversedObject)).toBe(serializeActorKey(actor.key));
  });

  it.each([
    "corrupt", "null", "[]", "{}", '{"kind":"unknown","userId":"alice"}',
    '{"kind":"account","issuer":"https://s.example"}',
    '{"kind":"account","issuer":"bad URL","userId":"alice"}',
    '{"kind":"account","issuer":"https://s.example","userId":""}',
    '{"kind":"installation","installationId":12}',
    '{"kind":"legacy-human","identityKind":"account","humanId":"local:installation"}',
    '{"kind":"agent","ownerKey":{"kind":"unknown"},"claimedName":"Opus"}',
    '{"kind":"agent","ownerKey":{"kind":"installation","installationId":"local:installation"},"claimedName":""}',
    '{"kind":"automation","ownerKey":null,"workspaceId":"","automationId":"rule"}',
    '{"kind":"remote-automation","ownerKey":null}',
    '{"kind":"link","grantId":"grant"}',
    '{"kind":"public","grantId":"grant","principalId":false}',
    '{"kind":"account","issuer":"https://s.example","userId":"alice","assurance":"local"}',
  ])("rejects malformed serialized keys: %s", serialized => {
    expect(parseActorKey(serialized)).toBeNull();
  });
});
