// Compile-only contracts, enforced by the package typecheck.
import { actorHueInput, createActorIssuer, deriveLocalActor, deriveRelayChatActor, parseActorKey } from "./actorIdentity";
import type { ActorAssurance, ActorHueInput, ActorIssuer, ActorKey, ActorOwnerKey } from "./actorIdentity";

declare const actorKey: ActorKey;
// DatasetAuthority.principalKey is a string. Keep this package independent of its consumer.
declare const grant: { principalKey: string };
declare function authorize(principalKey: typeof grant.principalKey): void;
declare function groupAuthor(key: ActorKey): void;

// @ts-expect-error Display identity must never authorize a dataset grant.
authorize(actorKey);
// @ts-expect-error A dataset authority key is not display identity.
groupAuthor(grant.principalKey);
// @ts-expect-error A structurally matching object still lacks the ActorKey brand.
groupAuthor({ kind: "account", issuer: createActorIssuer("https://server.example"), userId: "alice" });
// @ts-expect-error A display actor cannot own another actor's claim.
const owner: ActorOwnerKey = actorKey;
void owner;

declare function recordAssurance(assurance: ActorAssurance): void;
recordAssurance("owner-asserted");
// @ts-expect-error Self-display is not an assurance an author can declare.
recordAssurance("verified-self");

const hue = actorHueInput(actorKey);
if (hue !== null) {
  // @ts-expect-error Hue input is not a dataset principalKey, even when its value is the same ID.
  authorize(hue);
}
// @ts-expect-error Hue input requires its own brand.
const forgedHue: ActorHueInput = { value: "alice" };
void forgedHue;
// @ts-expect-error Issuers must pass through the canonical constructor.
const rawIssuer: ActorIssuer = "https://server.example/";
void rawIssuer;

const identity = { installationId: "local:installation", account: null };
// @ts-expect-error Local admission must state its origin.
deriveLocalActor({ identity, workspaceId: "workspace", author: { kind: "human" }, displayName: "Alice" });
// @ts-expect-error A remote agent must supply the displayed-name claim.
deriveRelayChatActor({ issuer: createActorIssuer("https://server.example"), authorUserId: "alice", kind: "agent", displayName: "Opus" });
const parsed = parseActorKey('{"kind":"unknown"}');
if (parsed !== null) groupAuthor(parsed);
