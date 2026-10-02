import {
  LIVE_AUTHOR_CHECKPOINT_BYTES,
  LIVE_AUTHOR_CHECKPOINT_IDENTITIES,
  MAX_LIVE_AUTHOR_BYTES,
  MAX_LIVE_AUTHOR_IDENTITIES,
  MAX_LIVE_AUTHOR_ENTRY_BYTES,
  liveAuthorIdentity,
  type AdmittedLiveUpdateMetadata,
  type LiveAuthorEntry,
  type LiveAuthorSnapshot,
  type LiveCheckpointAuthorCoverage,
  type LiveUpdateStructRange,
} from "@dohc/live-session-contract";
import type { ServerDerivedLiveUpdateAuthority } from "@dohc/live-session-contract/live-update-admission";

interface AuthorCoverage {
  author: LiveAuthorEntry;
  structRanges: LiveUpdateStructRange[];
  deletionRanges: LiveUpdateStructRange[];
}

function unionRanges(ranges: readonly LiveUpdateStructRange[]): LiveUpdateStructRange[] {
  const sorted = [...ranges].sort((a, b) => a.clientId - b.clientId || a.startClock - b.startClock || a.endClock - b.endClock);
  const result: LiveUpdateStructRange[] = [];
  for (const range of sorted) {
    const prior = result.at(-1);
    if (prior && prior.clientId === range.clientId && range.startClock <= prior.endClock) {
      result[result.length - 1] = {...prior, endClock: Math.max(prior.endClock, range.endClock)};
    } else {
      result.push({...range});
    }
  }
  return result;
}

function admissionBytes(authors: readonly LiveAuthorEntry[]): number {
  return Buffer.byteLength(JSON.stringify(authors), "utf8") + authors.reduce((reserve, author) => {
    if (author.kind !== "agent") return reserve;
    return reserve + (author.depth === undefined ? ',"depth":64'.length : 2 - Math.min(String(author.depth).length, 2));
  }, 0);
}

export function liveAuthorCoverageCheckpointDue(coverage: readonly LiveCheckpointAuthorCoverage[]): boolean {
  return coverage.length >= LIVE_AUTHOR_CHECKPOINT_IDENTITIES ||
    admissionBytes(coverage.map(entry => entry.author)) >= LIVE_AUTHOR_CHECKPOINT_BYTES;
}

/** Reserve enough validation state for a candidate with a principal and an agent. */
export function liveAuthorCheckpointAnticipated(suffix: readonly AdmittedLiveUpdateMetadata[]): boolean {
  const authors = new Map<string, LiveAuthorEntry>();
  for (const metadata of suffix) {
    if (metadata.firstSeen.length === 0 && (metadata.firstSeenDeletes?.length ?? 0) === 0) continue;
    for (const author of metadata.authorSnapshot ?? []) {
      const identity = liveAuthorIdentity(author), prior = authors.get(identity);
      if (!prior || (prior.kind === "agent" && author.kind === "agent" && (author.depth ?? 0) > (prior.depth ?? 0))) {
        authors.set(identity, prior?.kind === "agent" && author.kind === "agent" ? {...prior, depth: author.depth} : author);
      }
    }
  }
  return authors.size >= LIVE_AUTHOR_CHECKPOINT_IDENTITIES - 2 ||
    admissionBytes([...authors.values()]) >= LIVE_AUTHOR_CHECKPOINT_BYTES - 2 * (MAX_LIVE_AUTHOR_ENTRY_BYTES + 12);
}

/** Each authenticated principal may introduce 16 declared-agent identities per window.
 * Further declarations keep the principal's credit but omit agent identity; content is still admitted.
 */
export function limitLiveDeclaredAgents(suffix: readonly AdmittedLiveUpdateMetadata[],
  authority: ServerDerivedLiveUpdateAuthority, snapshot: LiveAuthorSnapshot): LiveAuthorSnapshot {
  const agent = snapshot.find(author => author.kind === "agent");
  if (!agent) return snapshot;
  const identities = new Set<string>();
  for (const metadata of suffix) {
    const prior = metadata.accepted.authority;
    if (prior.principalId !== authority.principalId || (prior.principalKind === "link") !== (authority.principalKind === "link") ||
      (authority.principalKind === "link" && prior.grantId !== authority.grantId) ||
      (metadata.firstSeen.length === 0 && (metadata.firstSeenDeletes?.length ?? 0) === 0)) continue;
    for (const author of metadata.authorSnapshot ?? []) if (author.kind === "agent") identities.add(liveAuthorIdentity(author));
  }
  return identities.has(liveAuthorIdentity(agent)) || identities.size < 16 ? snapshot : snapshot.filter(author => author.kind !== "agent");
}

/** Assess only the suffix after the consumed checkpoint boundary. */
export function assessLiveAuthorWindow(
  suffix: readonly AdmittedLiveUpdateMetadata[],
  candidate: {
    authorSnapshot: LiveAuthorSnapshot;
    firstSeen: readonly LiveUpdateStructRange[];
    firstSeenDeletes: readonly LiveUpdateStructRange[];
  },
): {
  refused: boolean;
  checkpointDue: boolean;
  coverage: readonly LiveCheckpointAuthorCoverage[];
  identityCount: number;
  authorBytes: number;
} {
  const authors = new Map<string, AuthorCoverage>();
  function add(snapshot: LiveAuthorSnapshot, structs: readonly LiveUpdateStructRange[], deletes: readonly LiveUpdateStructRange[]): boolean {
    if (structs.length === 0 && deletes.length === 0) return false;
    let introduced = false;
    for (const author of snapshot) {
      const identity = liveAuthorIdentity(author);
      const existing = authors.get(identity);
      if (existing) {
        if (existing.author.kind === "agent" && author.kind === "agent" && (author.depth ?? 0) > (existing.author.depth ?? 0)) {
          existing.author = {...existing.author, depth: author.depth};
        }
        existing.structRanges.push(...structs);
        existing.deletionRanges.push(...deletes);
      } else {
        authors.set(identity, {author: {...author}, structRanges: [...structs], deletionRanges: [...deletes]});
        introduced = true;
      }
    }
    return introduced;
  }

  for (const metadata of suffix) add(metadata.authorSnapshot ?? [], metadata.firstSeen, metadata.firstSeenDeletes ?? []);
  const introduced = add(candidate.authorSnapshot, candidate.firstSeen, candidate.firstSeenDeletes);
  const coverage = [...authors.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, entry]) => ({
    author: entry.author,
    structRanges: unionRanges(entry.structRanges),
    deletionRanges: unionRanges(entry.deletionRanges),
  }));
  const identityCount = coverage.length;
  const authorBytes = admissionBytes(coverage.map(entry => entry.author));
  return {
    refused: introduced && (identityCount > MAX_LIVE_AUTHOR_IDENTITIES || authorBytes > MAX_LIVE_AUTHOR_BYTES),
    checkpointDue: identityCount >= LIVE_AUTHOR_CHECKPOINT_IDENTITIES || authorBytes >= LIVE_AUTHOR_CHECKPOINT_BYTES,
    coverage,
    identityCount,
    authorBytes,
  };
}
