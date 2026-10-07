import {isDeepStrictEqual} from "node:util";
import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import type {OwnerYDocDraftCursor} from "@dohc/workspace-engine-client/daemon";
import type {AutomationReplica} from "./automationReplicas";
import type {SyncRelayStorage} from "./storage";

/** Keeps enrolled records current before ordinary replication applies their artifacts. */
export function createAutomationAcceptedRecords(options: {
  replica: Pick<AutomationReplica, "client" | "workspace" | "workspaceId" | "ownerUserId" | "nextRequestId" | "signal" | "withRecordWork">;
  namespace: string;
  storage: Pick<SyncRelayStorage, "automationRecordBinding" | "automationRecordJournalCursor" | "readLiveUpdateJournalCut">;
  synchronize(binding: LiveObjectBinding, signal: AbortSignal): Promise<void>;
  onError(path: string, error: unknown): void;
}) {
  const {replica, storage} = options;
  const records = new Map<string, {binding: LiveObjectBinding; acceptedCursor: number}>();
  const key = (binding: LiveObjectBinding) => JSON.stringify([binding.mainVersionId, binding.objectId, binding.lineageClaimId]);
  const request = () => ({id: replica.nextRequestId(), workspace: replica.workspace, deadlineMs: 30_000});
  let initializing: Promise<void> | undefined;

  function remember(binding: LiveObjectBinding, acceptedCursor: number): void {
    const previous = records.get(key(binding));
    records.set(key(binding), {binding, acceptedCursor: previous && isDeepStrictEqual(previous.binding, binding)
      ? Math.max(previous.acceptedCursor, acceptedCursor) : acceptedCursor});
  }

  // Scan once per opened replica. Writes add their own enrollment below.
  function initialize(): Promise<void> {
    return initializing ??= (async () => {
      let after: OwnerYDocDraftCursor | null = null;
      do {
        const page = await replica.client.ownerYDocListDrafts(request(), {after, limit: 64}, replica.signal);
        for (const draft of page.drafts) remember(draft.binding, draft.acceptedCursor);
        after = page.next;
      } while (after !== null);
    })().catch(error => {initializing = undefined; throw error;});
  }

  // Call inside the write's record lane, after enrollment/delivery advanced it.
  async function track(binding: LiveObjectBinding): Promise<void> {
    const state = await replica.client.ownerYDocReadState(request(), {binding, relayDatabaseNamespace: options.namespace}, replica.signal);
    remember(binding, state.acceptedCursor);
  }

  async function refresh(path: string): Promise<void> {
    await initialize();
    await replica.withRecordWork(async () => {
      const current = storage.automationRecordBinding(replica.workspaceId, replica.ownerUserId, path);
      if (!current) return;
      const known = records.get(key(current.binding));
      const cursor = storage.automationRecordJournalCursor(current.binding);
      if (known && isDeepStrictEqual(known.binding, current.binding) && known.acceptedCursor >= cursor) return;
      await options.synchronize(current.binding, replica.signal);
      await track(current.binding);
    });
  }

  async function refreshChanged(): Promise<void> {
    await initialize();
    // The relay has already authenticated these bytes. Use its accepted feed
    // without entering the draft lane or asking an offline host for a cut.
    for (const {binding, acceptedCursor} of [...records.values()]) {
      try {
        if (acceptedCursor >= storage.automationRecordJournalCursor(binding)) continue;
        const {workspaceId, mainVersionId, objectId, lineageClaimId} = binding;
        const result = storage.readLiveUpdateJournalCut({document: {workspaceId, mainVersionId, objectId, lineageClaimId}});
        if (result.kind !== "cut") throw new Error(`Accepted record refresh refused: ${result.reason}`);
        const {cut} = result;
        if (cut.currentPath !== binding.currentPath || cut.restoreFenceGeneration !== binding.restoreFenceGeneration) {
          throw new Error("Accepted record binding changed before refresh.");
        }
        const target = {binding, relayDatabaseNamespace: options.namespace};
        let state = await replica.client.ownerYDocReadState(request(), target, replica.signal);
        const frames = [
          ...(cut.checkpoint.cursor === null ? [] : [{cursor: cut.checkpoint.cursor, bytes: cut.checkpoint.bytes}]),
          ...cut.suffix,
        ];
        for (const frame of frames) {
          if (frame.cursor <= state.acceptedCursor) continue;
          // Optimistic native guards settle a race with a foreground writer.
          // A failed guard leaves this record for the next pass, never sync.
          const next = await replica.client.ownerYDocApplyAcceptedFrame(request(), {...target, expectedRevision: state.revision,
            expectedNativeHeadSequence: state.nativeHeadSequence, previousAcceptedCursor: state.acceptedCursor,
            journalCursor: frame.cursor, updateBytes: frame.bytes}, replica.signal);
          state = {...state, ...next};
        }
        remember(binding, state.acceptedCursor);
      }
      catch (error) {options.onError(binding.currentPath, error);}
    }
  }
  return {initialize, track, refresh, refreshChanged};
}
