import type {SyncRelayStorage} from "./storage.js";

/**
 * How long a quiet hosted replica of a ready workspace goes without a pull.
 * A relay change the host never noticed reaches it within this.
 */
export const HOSTED_RECOVERY_PROBE_MS = 30_000;

/**
 * Why the host pulled a workspace's hosted replica: an activation's catch-up,
 * opening a dormant document, a workspace that is not ready, work only a pull
 * finishes, a relay change, the first pull of an attachment, a workspace the
 * relay holds no hosted scope for, or the recovery probe.
 */
export type HostedPullReason = "activation" | "open" | "unready" | "pending" | "changed" | "first" | "unscoped" | "probe";

/** What a ready workspace's hosted replica still waits on from its own pulls. Nothing on the relay announces these. */
export interface HostedPullDuties {
  /** How many pulls started, and the number of the last one that succeeded. */
  readonly pulls: number;
  readonly confirmed: number;
  /**
   * For each document announced as departing, the pull that must succeed
   * before it counts as gone, and the last pull whose departed list reached it.
   */
  readonly announced: Iterable<{readonly required: number; readonly reached: number}>;
  /** How the last pull ended, or undefined before the first. */
  readonly last: "done" | "more" | "failed" | undefined;
  /** Whether the next held and departed lists start from the first, and activation heard every page. */
  readonly listsWrapped: boolean;
  /**
   * Whether the last departed list named no document from the first. One the
   * host unloaded leaves the replica only at a later pull's commit.
   */
  readonly departedNone: boolean;
  /** How many of the workspace's documents wait for a later pull, by why. */
  readonly waiting: {readonly parking: number; readonly leaving: number; readonly recovering: number; readonly movedRestores: number;
    readonly retained: number; readonly retiring: number; readonly held: number};
}

/**
 * Whether a ready workspace's replica has nothing for a pull to finish:
 * every pull succeeded with no more pages, every announced departure was
 * confirmed and reached, its lists wrapped with no departed document left, and
 * none of its documents waits on a pull. Only then may it wait for a relay
 * change or the recovery probe.
 */
export function hostedReplicaQuiet(duties: HostedPullDuties): boolean {
  if (duties.last !== "done" || duties.confirmed !== duties.pulls || !duties.listsWrapped || !duties.departedNone) return false;
  for (const {required, reached} of duties.announced) if (duties.confirmed < required || reached < required) return false;
  return Object.values(duties.waiting).every(count => count === 0);
}

/**
 * Everything the relay's hosted feed answers a workspace's replica from: its
 * log head and epoch floor, its identity, and its hosted, departed, shared and
 * settling documents. Equal readings mean a pull would bring nothing new, so a
 * write elsewhere, or one that changes none of these, leaves it unchanged.
 * Undefined while the relay holds no hosted scope for the workspace, or no such
 * workspace: the feed then refuses every read, and nothing here says when that ends.
 */
export function hostedRelayState(storage: SyncRelayStorage, workspaceId: string): string | undefined {
  const scope = storage.readServiceHostFeedScope(workspaceId);
  return scope ? JSON.stringify([storage.automationWorkspaceLogHead(workspaceId), storage.getEpochLogFloor(workspaceId),
    scope.replicationEpoch, scope.streamIdentity, [...scope.hosted], [...scope.departed], [...scope.shared], [...scope.settling]]) : undefined;
}
