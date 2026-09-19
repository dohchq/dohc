import {parseLiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import type {DesktopOwnerDeliveryDocument} from "./desktopOwnerDelivery";

/** Only authenticated, ready server targets may enter native owner enrollment. */
export function readyOwnerDeliveryDocuments(value: unknown, workspaceId: string): DesktopOwnerDeliveryDocument[] {
  if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true ||
    !("documents" in value) || !Array.isArray(value.documents) || value.documents.length > 64) {
    throw new Error("Invalid owner live document response.");
  }
  const documents: DesktopOwnerDeliveryDocument[] = [];
  const objects = new Set<string>();
  for (const row of value.documents) {
    if (!row || typeof row !== "object" || typeof row.path !== "string" ||
      !["preparing", "ready", "paused", "unavailable"].includes(row.status)) throw new Error("Invalid owner live document status.");
    if (row.status !== "ready") continue;
    if (!row.document || typeof row.document !== "object") throw new Error("Missing owner live document binding.");
    const binding = parseLiveObjectBinding(row.document.binding);
    if (binding.workspaceId !== workspaceId || binding.mainVersionId !== "main" || binding.currentPath !== row.path || objects.has(binding.objectId)) {
      throw new Error("Owner live document binding differs from the requested workspace.");
    }
    objects.add(binding.objectId);
    documents.push({binding, relayDatabaseNamespace: parseLiveUpdateIdentifier(row.document.relayDatabaseNamespace),
      shareId: parseLiveUpdateIdentifier(row.document.shareId)});
  }
  return documents;
}

/** One workspace and one document per pass, with no unbounded concurrent work. */
export function startServerOwnerDelivery(options: {
  workspaceIds(): string[];
  attemptTimeoutMs: number;
  retryDelayMs: number;
  runPass(workspaceId: string, documentIndex: number, signal: AbortSignal): Promise<{documentCount: number; acknowledged: boolean}>;
  onError(error: unknown): void;
}) {
  const lifetime = new AbortController(), nextDocument = new Map<string, number>();
  let nextWorkspace = 0, timer: ReturnType<typeof setTimeout> | undefined, active: Promise<void> | undefined;
  let retryWorkspace: string | undefined;
  function schedule(delay: number) {
    if (!lifetime.signal.aborted) {timer = setTimeout(run, delay); timer.unref();}
  }
  function run() {
    timer = undefined;
    if (lifetime.signal.aborted || active) return;
    let acknowledged = false;
    active = Promise.resolve().then(async () => {
      const workspaces = options.workspaceIds();
      for (const id of nextDocument.keys()) if (!workspaces.includes(id)) nextDocument.delete(id);
      if (!workspaces.length) return;
      if (retryWorkspace && workspaces.includes(retryWorkspace)) nextWorkspace = workspaces.indexOf(retryWorkspace);
      retryWorkspace = undefined;
      const workspaceId = workspaces[nextWorkspace % workspaces.length]!;
      nextWorkspace = (nextWorkspace + 1) % workspaces.length;
      const index = nextDocument.get(workspaceId) ?? 0;
      const result = await options.runPass(workspaceId, index, AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.attemptTimeoutMs)]));
      if (lifetime.signal.aborted) return;
      nextDocument.set(workspaceId, result.documentCount ? (index + 1) % result.documentCount : 0);
      acknowledged = result.acknowledged || index + 1 < result.documentCount;
    }).catch(error => {
      if (!lifetime.signal.aborted) {try {options.onError(error);} catch { /* Keep retrying after a logging failure. */ }}
    }).finally(() => {active = undefined; schedule(acknowledged || retryWorkspace ? 0 : options.retryDelayMs);});
  }
  schedule(0);
  return {
    retry(workspaceId: string) {
      if (lifetime.signal.aborted) return;
      retryWorkspace = workspaceId;
      if (!active) {clearTimeout(timer); schedule(0);}
    },
    async stop() {lifetime.abort(); clearTimeout(timer); await active;},
  };
}
