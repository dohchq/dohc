import {
  LIVE_AUTHOR_CHECKPOINT_BYTES,
  LIVE_AUTHOR_CHECKPOINT_IDENTITIES,
  MAX_LIVE_AUTHOR_BYTES,
  MAX_LIVE_AUTHOR_IDENTITIES,
  liveAuthorIdentity,
  type AdmittedLiveUpdateMetadata,
  type LiveAuthorEntry,
  type LiveAuthorSnapshot,
  type LiveCheckpointAuthorCoverage,
  type LiveUpdateStructRange,
} from "@dohc/live-session-contract";

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
