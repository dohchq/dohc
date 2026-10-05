// Compile-only contracts, enforced by the package typecheck.
import type { ActorAssurance, ActorKey, ActorOwnerKey } from "./actorIdentity";

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
groupAuthor({ kind: "account", issuer: "server", userId: "alice" });
// @ts-expect-error A display actor cannot own another actor's claim.
const owner: ActorOwnerKey = actorKey;
void owner;

declare function recordAssurance(assurance: ActorAssurance): void;
recordAssurance("owner-asserted");
// @ts-expect-error Self-display is not an assurance an author can declare.
recordAssurance("verified-self");
