import type { ServerProblemKind } from "@dohc/interface-words/account";
import { each, isFields, okAnswer, segment, text } from "./api";
import type { ServerClient } from "./client";

export interface SearchHit {
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
}

export interface SearchAnswer {
  readonly results: readonly SearchHit[];
  readonly indexBuilding: boolean;
  readonly truncated: boolean;
  readonly complete: boolean;
}

export interface MatchedSearchAnswer {
  readonly workspaceId: string;
  readonly query: string;
  readonly answer: SearchAnswer;
}

export type SearchUiState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "indexing"; readonly results: readonly SearchHit[] }
  | { readonly kind: "incomplete"; readonly results: readonly SearchHit[] }
  | { readonly kind: "empty"; readonly query: string }
  | { readonly kind: "results"; readonly results: readonly SearchHit[] }
  | { readonly kind: "error" };

export function deriveSearchUiState(input: {
  readonly workspaceId: string | null;
  readonly query: string;
  readonly loading: boolean;
  readonly matched: MatchedSearchAnswer | null;
  readonly problem: ServerProblemKind | null;
}): SearchUiState {
  const trimmed = input.query.trim();
  if (!trimmed || input.workspaceId === null) return { kind: "idle" };
  const answer =
    input.matched !== null &&
    input.matched.workspaceId === input.workspaceId &&
    input.matched.query === trimmed
      ? input.matched.answer
      : null;
  if (input.problem !== null && answer === null) return { kind: "error" };
  if (answer === null) return input.loading ? { kind: "loading" } : { kind: "idle" };
  if (answer.indexBuilding) return { kind: "indexing", results: answer.results };
  if (!answer.complete) return { kind: "incomplete", results: answer.results };
  if (answer.results.length === 0) return { kind: "empty", query: trimmed };
  return { kind: "results", results: answer.results };
}

const readHit = (item: unknown): SearchHit | null =>
  isFields(item) &&
  text(item.path) &&
  typeof item.title === "string" &&
  item.title.length <= 4096 &&
  typeof item.snippet === "string" &&
  item.snippet.length <= 16_384
    ? { path: item.path, title: item.title, snippet: item.snippet }
    : null;

export function readSearchAnswer(body: unknown): SearchAnswer | null {
  const result = okAnswer(okAnswer(body)?.result);
  const results = result ? each(result.results, readHit) : null;
  return result &&
    results &&
    typeof result.indexBuilding === "boolean" &&
    typeof result.truncated === "boolean" &&
    typeof result.complete === "boolean"
    ? {
        results,
        indexBuilding: result.indexBuilding,
        truncated: result.truncated,
        complete: result.complete,
      }
    : null;
}

export function searchWorkspace(
  client: ServerClient,
  workspaceId: string,
  query: string,
  signal: AbortSignal,
  limit = 20,
): Promise<SearchAnswer> {
  return client.send(
    "POST",
    `/sync/${segment(workspaceId)}/ops/searchWorkspace`,
    readSearchAnswer,
    { query, limit },
    { signal },
  );
}
