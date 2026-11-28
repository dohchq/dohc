import type { ServerProblemKind } from "@dohc/interface-words/account";
import { each, isFields, okAnswer, segment, text } from "./api";
import type { ServerClient } from "./client";

export type SearchUiState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "indexing"; readonly results: readonly SearchHit[] }
  | { readonly kind: "empty"; readonly query: string }
  | { readonly kind: "results"; readonly results: readonly SearchHit[] }
  | { readonly kind: "error"; readonly problem: ServerProblemKind };

export function deriveSearchUiState(input: {
  readonly query: string;
  readonly loading: boolean;
  readonly answer: SearchAnswer | null;
  readonly problem: ServerProblemKind | null;
}): SearchUiState {
  const trimmed = input.query.trim();
  if (!trimmed) return { kind: "idle" };
  if (input.problem !== null && input.answer === null)
    return { kind: "error", problem: input.problem };
  if (input.answer === null) return input.loading ? { kind: "loading" } : { kind: "idle" };
  if (input.answer.indexBuilding) return { kind: "indexing", results: input.answer.results };
  if (input.answer.results.length === 0) return { kind: "empty", query: trimmed };
  return { kind: "results", results: input.answer.results };
}

export interface SearchHit {
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
  readonly objectId?: string;
}

export interface SearchAnswer {
  readonly results: readonly SearchHit[];
  readonly indexBuilding: boolean;
  readonly truncated: boolean;
  readonly complete: boolean;
}

const readHit = (item: unknown): SearchHit | null =>
  isFields(item) &&
  text(item.path) &&
  typeof item.title === "string" &&
  item.title.length <= 4096 &&
  typeof item.snippet === "string" &&
  item.snippet.length <= 16_384 &&
  (item.objectId === undefined || text(item.objectId, 256))
    ? {
        path: item.path,
        title: item.title,
        snippet: item.snippet,
        ...(item.objectId !== undefined ? { objectId: item.objectId } : {}),
      }
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
