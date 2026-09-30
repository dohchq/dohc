import type { CollectionGetRecordResult } from "@dohc/workspace-contracts";
import type { GetCollectionRecordHistoryResult } from "./bridgeContract";

type HistoryEntry = CollectionGetRecordResult["history"][number];
type Author = GetCollectionRecordHistoryResult["entries"][number]["author"];

/** How main names a record history's authors, in one workspace. */
export interface RecordHistoryAuthors {
  /** An agent, by the person it acted for: this computer's agent by name, any other as "Agent". */
  agent(onBehalfOf: string | null): string;
  /** An automation's name in its Collection's automations.yaml now, or null. */
  automationName(automationId: string): string | null;
  /** Whether this computer keeps the run. */
  runOnThisComputer(automationId: string, claimId: string): Promise<boolean>;
}

/**
 * A page of record history as the record's History shows it. Each automation
 * run is looked up once, however many of the page's changes it made.
 */
export async function recordHistoryForIpc(
  page: Pick<CollectionGetRecordResult, "history" | "nextBeforeHistoryId">,
  authors: RecordHistoryAuthors,
): Promise<GetCollectionRecordHistoryResult> {
  const runs = new Map<string, Promise<boolean>>();
  const onThisComputer = (automationId: string, claimId: string): Promise<boolean> => {
    const key = JSON.stringify([automationId, claimId]);
    const known = runs.get(key) ?? authors.runOnThisComputer(automationId, claimId);
    runs.set(key, known);
    return known;
  };
  const authorOf = async (entry: HistoryEntry): Promise<Author> => {
    const actor = entry.authorOriginId;
    if (actor === null) return null;
    if (entry.actorKind === "agent") return { kind: "agent", name: authors.agent(entry.onBehalfOf) };
    if (entry.actorKind !== "automation") return null;
    const run = entry.automationRun;
    return {
      kind: "automation",
      automationId: actor,
      name: run?.automationName ?? authors.automationName(actor) ?? actor,
      run: run === null ? null : { claimId: run.claimId, onThisComputer: await onThisComputer(actor, run.claimId) },
    };
  };
  return {
    entries: await Promise.all(page.history.map(async (entry) => ({
      historyId: entry.historyId,
      field: entry.field,
      previous: entry.previous,
      next: entry.next,
      recordedAtMs: entry.recordedAtMs,
      author: await authorOf(entry),
    }))),
    nextBeforeHistoryId: page.nextBeforeHistoryId,
  };
}
