import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SyncRelayStorage } from "./storage";
import { createServiceHostReplication } from "./serviceHostReplication";
import { referencedBlobShas } from "./storage/blobReferences";

export const REPLICA_READ_PREFIX = "dohc-replica-read-v1.";
export type ReplicaStanding = NonNullable<ReturnType<SyncRelayStorage["readReplicaStanding"]>>;
export interface ReplicaReadLease extends ReplicaStanding {
  readonly incarnation: string;
  readonly bearer: string;
}

/** Process-local credentials enter only the internal replication handler. */
export function createReplicaReadPrincipal(storage: SyncRelayStorage) {
  const leases = new Map<string, { lease: ReplicaReadLease; blobs: Set<string> }>();
  const current = (lease: ReplicaReadLease) => {
    if (storage.unavailable.aborted) return false;
    // Undo or a replacement share cannot resurrect a lease whose original grants ended.
    const standing = storage.readReplicaStanding(lease.workspaceId, lease.shareGrantBindings);
    return leases.get(lease.workspaceId)?.lease === lease && standing &&
      standing.ownerUserId === lease.ownerUserId && standing.replicationEpoch === lease.replicationEpoch &&
      standing.streamIdentity === lease.streamIdentity;
  };
  const authorizedLease = (input: {workspaceId: string; bearer: string; method: string}) => {
    const state = leases.get(input.workspaceId), lease = state?.lease;
    if (!lease || input.method !== "GET") return null;
    const actual = Buffer.from(input.bearer), expected = Buffer.from(lease.bearer);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || !current(lease)) return null;
    return state!;
  };
  const handle = createServiceHostReplication({ storage, prefix: REPLICA_READ_PREFIX, authorize(input) {
    const state = authorizedLease(input);
    if (!state) return null;
    const parts = input.pathname.split("/");
    const allowed = parts.length === 4 && ["bootstrap", "log"].includes(parts[3]!) ||
      parts.length === 6 && parts[3] === "log" && /^\d+$/.test(parts[5]!);
    const blob = parts.length === 5 && parts[3] === "blobs" && /^[a-f0-9]{64}$/.test(parts[4]!) &&
      state.blobs.has(parts[4]!);
    return allowed || blob ? state.lease.ownerUserId : null;
  },
  // The guard rechecks standing. Immutable served references need only one membership check.
  revalidate: input => authorizedLease(input)?.lease.ownerUserId ?? null,
  onLogRead(input, rows) {
    const state = leases.get(input.workspaceId);
    if (!state || state.lease.bearer !== input.bearer) return;
    const shas = rows.flatMap(row => referencedBlobShas(row.opKind, row.payloadJson, {
      workspaceId: row.workspaceId, recordedAtMs: row.recordedAtMs,
    }));
    for (const sha of shas) state.blobs.add(sha);
  } });
  return {
    handle,
    issue(workspaceId: string, incarnation: string): ReplicaReadLease {
      const standing = storage.readReplicaStanding(workspaceId);
      if (!standing) throw new Error("Replica requires a current share and replication identity.");
      const lease = Object.freeze({ ...standing, incarnation, bearer: REPLICA_READ_PREFIX + randomBytes(32).toString("base64url") });
      leases.set(workspaceId, { lease, blobs: new Set() });
      return lease;
    },
    current,
    revoke(lease: ReplicaReadLease) { if (leases.get(lease.workspaceId)?.lease === lease) leases.delete(lease.workspaceId); },
  };
}
