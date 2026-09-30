import type { CollectionGetRecordResult } from "@dohc/workspace-contracts";
import type { GetCollectionRecordHistoryResult, LocateRecordHistoryRunResult } from "./bridgeContract";
import type { ServerAsker } from "../automations/serverRuns";

type HistoryEntry = CollectionGetRecordResult["history"][number];
type Author = GetCollectionRecordHistoryResult["entries"][number]["author"];

/** How main names a record history's authors, in one workspace. */
export interface RecordHistoryAuthors {
  /** An agent, by the person it acted for: this computer's agent by name, any other as "Agent". */
  agent(onBehalfOf: string | null): string;
  /** An automation's name in its Collection's automations.yaml now, or null. */
  automationName(automationId: string): string | null;
  /** Whether the person can open the run without asking the server. */
  runAvailable(automationId: string, claimId: string): Promise<boolean>;
}

/**
 * Where a person can open a run: on this computer, or on the workspace
 * owner's server through the relay's owner-only route. The relay decides who
 * the owner is. Runs do not move, so a run the server showed stays available
 * for the rest of the session, to the account it was shown to only.
 */
export function createRunLocator(dependencies: {
  onThisComputer(workspaceId: string, automationId: string, claimId: string): Promise<boolean>;
  /** Whether the server shows the run, and who asked; null when this computer cannot ask. Throws when dohc could not ask. */
  onServer(workspaceId: string, automationId: string, claimId: string): Promise<{ shown: boolean; asker: ServerAsker } | null>;
  /** The signed-in account now, or null when signed out. */
  signedInAccount(): string | null;
}) {
  const shownByServer = new Set<string>();
  const keyOf = (account: string, workspaceId: string, automationId: string, claimId: string) =>
    JSON.stringify([account, workspaceId, automationId, claimId]);
  const available = async (workspaceId: string, automationId: string, claimId: string): Promise<boolean> => {
    const account = dependencies.signedInAccount();
    return (account !== null && shownByServer.has(keyOf(account, workspaceId, automationId, claimId))) ||
      await dependencies.onThisComputer(workspaceId, automationId, claimId);
  };
  return {
    available,
    async locate(workspaceId: string, automationId: string, claimId: string): Promise<LocateRecordHistoryRunResult["location"]> {
      if (await available(workspaceId, automationId, claimId)) return "available";
      const answer = await dependencies.onServer(workspaceId, automationId, claimId);
      if (answer === null) return "unavailable";
      // An answer, yes or no, for a sign-in that has since ended or changed is no answer.
      if (!answer.asker.current()) throw new Error("Your sign-in changed while dohc checked this run.");
      if (!answer.shown) return "unavailable";
      shownByServer.add(keyOf(answer.asker.account, workspaceId, automationId, claimId));
      return "available";
    },
  };
}

/**
 * A page of record history as the record's History shows it. Each automation
 * run is looked up once, however many of the page's changes it made. The
 * page never waits on the server.
 */
export async function recordHistoryForIpc(
  page: Pick<CollectionGetRecordResult, "history" | "nextBeforeHistoryId">,
  authors: RecordHistoryAuthors,
): Promise<GetCollectionRecordHistoryResult> {
  const runs = new Map<string, Promise<boolean>>();
  const available = (automationId: string, claimId: string): Promise<boolean> => {
    const key = JSON.stringify([automationId, claimId]);
    const known = runs.get(key) ?? authors.runAvailable(automationId, claimId);
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
      run: run === null ? null : { claimId: run.claimId, location: await available(actor, run.claimId) ? "available" : "unchecked" },
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
