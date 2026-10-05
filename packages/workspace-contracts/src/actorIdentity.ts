import type { MomentAuthor } from "./engine";

declare const actorKeyBrand: unique symbol;
type ActorKeyBrand = { readonly [actorKeyBrand]: true };

type AccountActorKey = ActorKeyBrand & {
  readonly kind: "account";
  readonly issuer: string;
  readonly userId: string;
};
type InstallationActorKey = ActorKeyBrand & {
  readonly kind: "installation";
  readonly installationId: string;
};
type LegacyHumanActorKey = ActorKeyBrand & {
  readonly kind: "legacy-human";
  readonly identityKind: "account" | "installation";
  readonly humanId: string;
};

/** An admitted person, or an explicitly inferred historical person. */
export type ActorOwnerKey = AccountActorKey | InstallationActorKey | LegacyHumanActorKey;

/** Display grouping only. Never accepts or supplies dataset principalKey authority. */
export type ActorKey = ActorOwnerKey | (ActorKeyBrand & (
  | { readonly kind: "agent"; readonly ownerKey: ActorOwnerKey; readonly claimedName: string }
  | { readonly kind: "automation"; readonly ownerKey: ActorOwnerKey; readonly workspaceId: string; readonly automationId: string }
  | { readonly kind: "remote-automation"; readonly ownerKey: ActorOwnerKey }
  | { readonly kind: "link"; readonly grantId: string; readonly principalId: string }
  | { readonly kind: "public"; readonly grantId: string; readonly principalId: string }
  | { readonly kind: "unknown" }
));

export type ActorOrigin = "renderer" | "cli" | "automation" | "unknown";

/**
 * local: identity captured on this device at admission.
 * relay-verified: chat owner verification or a relay-stamped author.
 * owner-asserted: human participation, agent name, automation kind, or received History claim.
 * inferred: an issuerless historical identity, never verified self.
 * unknown: insufficient admitted identity facts.
 */
export type ActorAssurance = "local" | "relay-verified" | "owner-asserted" | "inferred" | "unknown";

export interface ActorRef {
  readonly key: ActorKey;
  readonly displayName: string;
  readonly origin: ActorOrigin;
  readonly assurance: ActorAssurance;
}

/** Capture these credentials at admission, independently of workspace relay enrollment. */
export interface LocalActorIdentity {
  readonly installationId: string;
  readonly account: { readonly issuer: string; readonly userId: string } | null;
}

type LocalActorClaim =
  | { readonly kind: "human" }
  | { readonly kind: "agent"; readonly claimedName?: string | null }
  | { readonly kind: "automation"; readonly automationId: string };

function branded<T extends object>(value: T): T & ActorKeyBrand {
  return value as T & ActorKeyBrand;
}

/** The admitted handshake name is the claim. Settings names are display labels only. */
export function canonicalClaimedName(handshakeName?: string | null): string {
  return handshakeName === undefined || handshakeName === null || handshakeName === ""
    ? "dohc-mcp"
    : handshakeName;
}

function localOwner(identity: LocalActorIdentity): ActorOwnerKey {
  return identity.account === null
    ? branded({ kind: "installation" as const, installationId: identity.installationId })
    : branded({ kind: "account" as const, issuer: identity.account.issuer, userId: identity.account.userId });
}

function legacyOwner(humanId: string): LegacyHumanActorKey {
  return branded({
    kind: "legacy-human" as const,
    identityKind: humanId.startsWith("local:") ? "installation" as const : "account" as const,
    humanId,
  });
}

function unknownActor(displayName: string, origin: ActorOrigin): ActorRef {
  return { key: branded({ kind: "unknown" as const }), displayName, origin, assurance: "unknown" };
}

/** Trusted local admission only. Persist locally; never add this key to relay payloads. */
export function deriveLocalActor(input: {
  readonly identity: LocalActorIdentity;
  readonly workspaceId: string;
  readonly author: LocalActorClaim;
  readonly displayName: string;
  readonly origin?: ActorOrigin;
}): ActorRef {
  const ownerKey = localOwner(input.identity);
  const origin = input.origin ?? "unknown";
  switch (input.author.kind) {
    case "human":
      return { key: ownerKey, displayName: input.displayName, origin, assurance: origin === "cli" ? "owner-asserted" : "local" };
    case "agent":
      return {
        key: branded({ kind: "agent" as const, ownerKey, claimedName: canonicalClaimedName(input.author.claimedName) }),
        displayName: input.displayName, origin, assurance: "owner-asserted",
      };
    case "automation":
      return {
        key: branded({ kind: "automation" as const, ownerKey, workspaceId: input.workspaceId, automationId: input.author.automationId }),
        displayName: input.displayName, origin, assurance: "owner-asserted",
      };
  }
}

/**
 * Read ingested chat with its thread-bound trusted issuer and relay-verified authorUserId.
 * Names and kinds remain claims. Missing identity never borrows the reader's credentials.
 */
export function deriveRelayChatActor(input: {
  readonly issuer: string | null;
  readonly authorUserId?: string;
  readonly kind: "human" | "agent" | "automation";
  readonly claimedName?: string | null;
  readonly displayName: string;
  readonly origin?: ActorOrigin;
}): ActorRef {
  const origin = input.origin ?? "unknown";
  if (!input.issuer || !input.authorUserId) return unknownActor(input.displayName, origin);
  const ownerKey = branded({ kind: "account" as const, issuer: input.issuer, userId: input.authorUserId });
  switch (input.kind) {
    case "human":
      return { key: ownerKey, displayName: input.displayName, origin, assurance: origin === "cli" ? "owner-asserted" : "relay-verified" };
    case "agent":
      return {
        key: branded({ kind: "agent" as const, ownerKey, claimedName: canonicalClaimedName(input.claimedName) }),
        displayName: input.displayName, origin, assurance: "owner-asserted",
      };
    case "automation":
      return {
        key: branded({ kind: "remote-automation" as const, ownerKey }),
        displayName: input.displayName, origin, assurance: "owner-asserted",
      };
  }
}

type MomentActorContext = {
  readonly origin?: ActorOrigin;
  /** Required for relay-stamped named authors. Not evidence for a received humanId. */
  readonly relayIssuer?: string;
} & (
  | { readonly source: "local"; readonly identity: LocalActorIdentity; readonly workspaceId: string }
  | { readonly source: "received" | "legacy" }
);

/**
 * Projects admitted moment authors without rewriting moments.
 * A local context supplies original admission identity, never the account at read time.
 * A received context accepts named/link/public only after verifying their relay stamp.
 */
export function deriveMomentActor(author: MomentAuthor, context: MomentActorContext, displayName: string): ActorRef {
  const origin = context.origin ?? "unknown";
  if (author.kind === "named") {
    if (!context.relayIssuer) return unknownActor(displayName, origin);
    return {
      key: branded({ kind: "account" as const, issuer: context.relayIssuer, userId: author.userId }),
      displayName, origin, assurance: "relay-verified",
    };
  }
  if (author.kind === "link" || author.kind === "public") {
    return {
      key: branded({ kind: author.kind, grantId: author.grantId, principalId: author.principalId }),
      displayName, origin, assurance: "relay-verified",
    };
  }
  const humanId = author.kind === "human" ? author.humanId : author.onBehalfOf;
  if (!humanId || (context.source === "received" && humanId.startsWith("local:"))) {
    return unknownActor(displayName, origin);
  }
  if (context.source === "local") {
    const admittedId = context.identity.account?.userId ?? context.identity.installationId;
    if (humanId === admittedId) {
      const claim: LocalActorClaim = author.kind === "human" ? { kind: "human" }
        : author.kind === "agent" ? { kind: "agent", claimedName: author.agentId }
        : { kind: "automation", automationId: author.automationId };
      return deriveLocalActor({ ...context, author: claim, displayName });
    }
  }
  const ownerKey = legacyOwner(humanId);
  const assurance = context.source === "received" ? "owner-asserted" : "inferred";
  switch (author.kind) {
    case "human":
      return { key: ownerKey, displayName, origin, assurance };
    case "agent":
      return {
        key: branded({ kind: "agent" as const, ownerKey, claimedName: canonicalClaimedName(author.agentId) }),
        displayName, origin, assurance,
      };
    case "automation":
      // Received or old rows cannot establish a local automation identity.
      return { key: branded({ kind: "remote-automation" as const, ownerKey }), displayName, origin, assurance };
  }
}

/** Color input only; equal colors never make two identities equal. */
export function actorHueInput(key: ActorKey): string | null {
  switch (key.kind) {
    case "account": return key.userId;
    case "installation": return key.installationId;
    case "legacy-human": return key.humanId;
    case "agent": return JSON.stringify(["agent", actorHueInput(key.ownerKey), key.claimedName]);
    case "automation": return JSON.stringify(["automation", actorHueInput(key.ownerKey), key.workspaceId, key.automationId]);
    case "remote-automation": return JSON.stringify(["remote-automation", actorHueInput(key.ownerKey)]);
    // Link sessions remain distinct; their hues share the grant input.
    case "link": return JSON.stringify(["link", key.grantId]);
    case "public": return JSON.stringify(["public", key.grantId, key.principalId]);
    case "unknown": return null;
  }
}
