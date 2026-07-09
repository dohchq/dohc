import { DohcCliError } from "./errors";

export interface IdCandidate {
  id: string;
  aliases?: readonly string[];
  description?: string;
}

function describeCandidate(candidate: IdCandidate): string {
  return candidate.description ? `${candidate.id} (${candidate.description})` : candidate.id;
}

export function resolveIdPrefix<Candidate extends IdCandidate>(
  input: string,
  candidates: readonly Candidate[],
  kind: string,
): Candidate {
  const exact = candidates.filter(
    (candidate) => candidate.id === input || candidate.aliases?.includes(input),
  );
  if (exact.length === 1) return exact[0]!;
  const prefixMatches = candidates.filter((candidate) => candidate.id.startsWith(input));
  if (prefixMatches.length === 1) return prefixMatches[0]!;
  const matches = exact.length > 1 ? exact : prefixMatches;
  if (matches.length === 0) throw new DohcCliError(`unknown ${kind} '${input}'`);
  const choices = [...matches]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(describeCandidate)
    .join(", ");
  throw new DohcCliError(`ambiguous ${kind} '${input}': ${choices}`);
}
