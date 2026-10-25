import type { MomentAuthor } from "./engine";

declare const actorKeyBrand: unique symbol;
type ActorKeyBrand = { readonly [actorKeyBrand]: true };
declare const actorIssuerBrand: unique symbol;
export type ActorIssuer = string & { readonly [actorIssuerBrand]: true };
declare const actorHueInputBrand: unique symbol;
export type ActorHueInput = {
  readonly value: string;
  readonly [actorHueInputBrand]: true;
};

/** One account issuer form for credentials, stored workspace servers, and joined Groups. */
export function createActorIssuer(serverUrl: string): ActorIssuer {
  const url = new URL(serverUrl);
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("An actor issuer must be an HTTP or HTTPS server URL without credentials, query, or fragment.");
  }
  // URL normalizes scheme, host, and default ports. Preserve a server's path and non-default port.
  return url.href.replace(/\/+$/u, "") as ActorIssuer;
}

type AccountActorKey = ActorKeyBrand & {
  readonly kind: "account";
  readonly issuer: ActorIssuer;
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
  | { readonly kind: "automation"; readonly ownerKey: ActorOwnerKey | null; readonly workspaceId: string; readonly automationId: string }
  | { readonly kind: "remote-automation"; readonly ownerKey: ActorOwnerKey }
  | { readonly kind: "link"; readonly grantId: string; readonly principalId: string }
  | { readonly kind: "link"; readonly publicPrincipalId: string }
  | { readonly kind: "public"; readonly grantId: string; readonly principalId: string }
  | { readonly kind: "unknown" }
));

export type ActorOrigin = "renderer" | "cli" | "automation" | "unknown";

/**
 * local: renderer admission, or an installation History human with renderer or unknown origin.
 * relay-verified: chat owner verification or a relay-stamped author in the own store.
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

/**
 * Trusted credentials and installation identity, independently of workspace relay enrollment.
 * Snapshot at admission for writes; use the current account for own-store History projection.
 */
export interface LocalActorIdentity {
  readonly installationId: string;
  readonly account: { readonly issuer: ActorIssuer; readonly userId: string } | null;
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
    : branded({ kind: "account" as const, issuer: createActorIssuer(identity.account.issuer), userId: identity.account.userId });
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
  readonly origin: ActorOrigin;
}): ActorRef {
  const ownerKey = localOwner(input.identity);
  const origin = input.origin;
  switch (input.author.kind) {
    case "human":
      return { key: ownerKey, displayName: input.displayName, origin, assurance: origin === "renderer" ? "local" : "owner-asserted" };
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
 * Until agent registration exists, another device's authorDisplayName is its claimedName.
 * That device's original handshake claim is unavailable. Do not invent a placeholder here.
 * A link holder is its link grant and link principal, which only the relay writes; it has no account.
 */
export function deriveRelayChatActor(input: {
  readonly issuer: ActorIssuer | null;
  readonly authorUserId?: string;
  readonly displayName: string;
  readonly origin?: ActorOrigin;
} & (
  | { readonly kind: "agent"; readonly claimedName: string }
  | { readonly kind: "human" | "automation" }
  | { readonly kind: "link"; readonly grantId: string; readonly principalId: string }
)): ActorRef {
  const origin = input.origin ?? "unknown";
  if (input.kind === "link") {
    if (!input.grantId || !input.principalId || input.authorUserId !== undefined) return unknownActor(input.displayName, origin);
    return {
      key: branded({ kind: "link" as const, grantId: input.grantId, principalId: input.principalId }),
      displayName: input.displayName, origin, assurance: "relay-verified",
    };
  }
  if (!input.issuer || !input.authorUserId) return unknownActor(input.displayName, origin);
  const ownerKey = branded({ kind: "account" as const, issuer: createActorIssuer(input.issuer), userId: input.authorUserId });
  switch (input.kind) {
    case "human":
      return { key: ownerKey, displayName: input.displayName, origin, assurance: origin === "cli" ? "owner-asserted" : "relay-verified" };
    case "agent":
      if (!input.claimedName) return unknownActor(input.displayName, origin);
      return {
        key: branded({ kind: "agent" as const, ownerKey, claimedName: input.claimedName }),
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
  /** Required for named authors. An issuer supplies no assurance for received History claims. */
  readonly relayIssuer?: ActorIssuer;
} & (
  | { readonly source: "own-store"; readonly identity: LocalActorIdentity; readonly workspaceId: string }
  | { readonly source: "received" | "legacy" }
);

/**
 * Projects admitted moment authors without rewriting moments.
 * own-store means this workspace's own store, never a received share. Moments record no device.
 * Match both this installation and the current account. Installation humans are local self
 * only with renderer or unknown origin. Moments record no origin, so unknown is normal.
 * CLI and automation origins are owner-asserted, even when they match this installation.
 * An account human is at most owner-asserted, even when it names the current account.
 * Own-store automation keys retain the workspace and definition ID; assurance is owner-asserted.
 * An absent automation owner stays null. Received named/link authors are also owner-asserted.
 */
export function deriveMomentActor(author: MomentAuthor, context: MomentActorContext, displayName: string): ActorRef {
  const origin = context.origin ?? "unknown";
  if (author.kind === "unattributed") return unknownActor(displayName, origin);
  if (author.kind === "named") {
    if (!context.relayIssuer) return unknownActor(displayName, origin);
    return {
      key: branded({ kind: "account" as const, issuer: createActorIssuer(context.relayIssuer), userId: author.userId }),
      displayName, origin, assurance: context.source === "received" ? "owner-asserted" : "relay-verified",
    };
  }
  if (author.kind === "link" || author.kind === "public") {
    return {
      key: "publicPrincipalId" in author
        ? branded({ kind: "link" as const, publicPrincipalId: author.publicPrincipalId })
        : author.kind === "link"
          ? branded({ kind: "link" as const, grantId: author.grantId, principalId: author.principalId })
          : branded({ kind: "public" as const, grantId: author.grantId, principalId: author.principalId }),
      displayName, origin, assurance: context.source === "received" ? "owner-asserted" : "relay-verified",
    };
  }
  const humanId = author.kind === "human" ? author.humanId : author.onBehalfOf;
  if (context.source === "own-store") {
    const ownerKey = humanId === context.identity.installationId
      ? localOwner({ ...context.identity, account: null })
      : humanId && humanId === context.identity.account?.userId
        ? localOwner(context.identity)
        : humanId ? legacyOwner(humanId) : null;
    if (author.kind === "automation") {
      return {
        key: branded({ kind: "automation" as const, ownerKey, workspaceId: context.workspaceId, automationId: author.automationId }),
        displayName, origin, assurance: "owner-asserted",
      };
    }
    if (ownerKey && ownerKey.kind !== "legacy-human") {
      return author.kind === "human"
        ? {
            key: ownerKey, displayName, origin,
            assurance: ownerKey.kind === "installation" && (origin === "renderer" || origin === "unknown")
              ? "local" : "owner-asserted",
          }
        : {
            key: branded({ kind: "agent" as const, ownerKey, claimedName: canonicalClaimedName(author.agentId) }),
            displayName, origin, assurance: "owner-asserted",
          };
    }
  }
  if (!humanId || (context.source === "received" && humanId.startsWith("local:"))) {
    return unknownActor(displayName, origin);
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

function hasFields(row: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(row).length === fields.length && fields.every(field => Object.hasOwn(row, field));
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function decodeOwnerKey(value: unknown): ActorOwnerKey | null {
  if (typeof value !== "object" || value === null || !("kind" in value) ||
    (value.kind !== "account" && value.kind !== "installation" && value.kind !== "legacy-human")) return null;
  const key = decodeActorKey(value);
  return key && (key.kind === "account" || key.kind === "installation" || key.kind === "legacy-human") ? key : null;
}

// Reconstruct every variant in canonical order. Serialized fields contain no brand or assurance.
function decodeActorKey(value: unknown): ActorKey | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  switch (row.kind) {
    case "account":
      if (!hasFields(row, ["kind", "issuer", "userId"]) || !nonempty(row.issuer) || !nonempty(row.userId)) return null;
      return branded({ kind: "account" as const, issuer: createActorIssuer(row.issuer), userId: row.userId });
    case "installation":
      if (!hasFields(row, ["kind", "installationId"]) || !nonempty(row.installationId)) return null;
      return branded({ kind: "installation" as const, installationId: row.installationId });
    case "legacy-human": {
      if (!hasFields(row, ["kind", "identityKind", "humanId"]) || !nonempty(row.humanId)) return null;
      const key = legacyOwner(row.humanId);
      return key.identityKind === row.identityKind ? key : null;
    }
    case "agent": {
      if (!hasFields(row, ["kind", "ownerKey", "claimedName"]) || !nonempty(row.claimedName)) return null;
      const ownerKey = decodeOwnerKey(row.ownerKey);
      return ownerKey ? branded({ kind: "agent" as const, ownerKey, claimedName: row.claimedName }) : null;
    }
    case "automation": {
      if (!hasFields(row, ["kind", "ownerKey", "workspaceId", "automationId"]) || !nonempty(row.workspaceId) || !nonempty(row.automationId)) return null;
      const ownerKey = row.ownerKey === null ? null : decodeOwnerKey(row.ownerKey);
      if (row.ownerKey !== null && ownerKey === null) return null;
      return branded({ kind: "automation" as const, ownerKey, workspaceId: row.workspaceId, automationId: row.automationId });
    }
    case "remote-automation": {
      if (!hasFields(row, ["kind", "ownerKey"])) return null;
      const ownerKey = decodeOwnerKey(row.ownerKey);
      return ownerKey ? branded({ kind: "remote-automation" as const, ownerKey }) : null;
    }
    case "link":
      if (hasFields(row, ["kind", "publicPrincipalId"]) && nonempty(row.publicPrincipalId)) {
        return branded({ kind: "link" as const, publicPrincipalId: row.publicPrincipalId });
      }
      // A direct link write names its grant and internal participant.
      if (!hasFields(row, ["kind", "grantId", "principalId"]) || !nonempty(row.grantId) || !nonempty(row.principalId)) return null;
      return branded({ kind: "link" as const, grantId: row.grantId, principalId: row.principalId });
    case "public":
      if (!hasFields(row, ["kind", "grantId", "principalId"]) || !nonempty(row.grantId) || !nonempty(row.principalId)) return null;
      return branded({ kind: row.kind, grantId: row.grantId, principalId: row.principalId });
    case "unknown":
      return hasFields(row, ["kind"]) ? branded({ kind: "unknown" as const }) : null;
    default: return null;
  }
}

// The property list fixes field order for every variant, including nested owner objects.
const actorKeyFields = [
  "kind", "issuer", "userId", "installationId", "identityKind", "humanId",
  "ownerKey", "claimedName", "workspaceId", "automationId", "grantId", "principalId", "publicPrincipalId",
];

/** Local storage only. Branded keys already carry normalized issuers; serialization does not parse them again. */
export function serializeActorKey(key: ActorKey): string {
  return JSON.stringify(key, actorKeyFields);
}

/**
 * Only for keys this device serialized into its own local store column, never keys received from elsewhere.
 * Restore the display-key brand, never authority or assurance. Malformed input returns null.
 */
export function parseActorKey(serialized: string): ActorKey | null {
  try {
    return decodeActorKey(JSON.parse(serialized));
  } catch {
    return null;
  }
}

/** Compare identity independently of object or serialized field order. */
export function actorKeysEqual(left: ActorKey, right: ActorKey): boolean {
  return serializeActorKey(left) === serializeActorKey(right);
}

/** A value object prevents hue input from being passed as a string principalKey. */
function hueInput(value: string): ActorHueInput {
  return { value } as ActorHueInput;
}

/** Color input only; equal colors never make two identities equal. Hash the returned value. */
export function actorHueInput(key: ActorKey): ActorHueInput | null {
  switch (key.kind) {
    case "account": return hueInput(key.userId);
    case "installation": return hueInput(key.installationId);
    case "legacy-human": return hueInput(key.humanId);
    case "agent": return hueInput(JSON.stringify(["agent", actorHueInput(key.ownerKey)?.value, key.claimedName]));
    case "automation": return hueInput(JSON.stringify(["automation", key.ownerKey ? actorHueInput(key.ownerKey)?.value : null, key.workspaceId, key.automationId]));
    case "remote-automation": return hueInput(JSON.stringify(["remote-automation", actorHueInput(key.ownerKey)?.value]));
    // Link sessions remain distinct; their hues share the grant input.
    case "link": return hueInput(JSON.stringify(["link", "publicPrincipalId" in key ? key.publicPrincipalId : key.grantId]));
    case "public": return hueInput(JSON.stringify(["public", key.grantId, key.principalId]));
    case "unknown": return null;
  }
}
