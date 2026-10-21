import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import { listMoveRecoveries, readMoveRecovery, type FileMoveRecoveryRecord } from "./workspaceMoveRecovery";
import { saveRecoveryRecord } from "./workspaceDeleteRecovery";

export type LinkRewriteContext = {
  workspaceId: string;
  signal?: AbortSignal;
  history: Pick<VersionedLiveAdapter, "rewriteHistoryLinks">;
};
type Pass = { cancel: AbortController; answer: Promise<unknown> };
type State = { undo: number; pass?: Pass; scheduled?: boolean };
const states = new Map<string, State>();
const keyFor = (root: string, id: string) => JSON.stringify([root, id]);
const stateFor = (root: string, id: string) => {
  const key = keyFor(root, id);
  let state = states.get(key);
  if (!state) { state = { undo: 0 }; states.set(key, state); }
  return state;
};
const eligible = (record: FileMoveRecoveryRecord) => record.tracked && !record.replaced &&
  record.from.toLowerCase() !== record.to.toLowerCase() && record.links?.state === "updating" &&
  !!record.linkRewrite && !record.engine && !record.progress && !record.result;

// Register inside the move lock. The next event-loop turn is after the visible result.
export function scheduleLinkRewrite(root: string, record: FileMoveRecoveryRecord, context: LinkRewriteContext): void {
  if (!eligible(record) || context.signal?.aborted) return;
  const state = stateFor(root, record.operationId);
  if (state.undo || state.pass || state.scheduled) return;
  state.scheduled = true;
  setImmediate(() => {
    if (!state.scheduled) return;
    state.scheduled = false;
    if (state.undo || context.signal?.aborted) return;
    const cancel = new AbortController();
    const retired = () => cancel.abort();
    context.signal?.addEventListener("abort", retired, { once: true });
    const answer = context.history.rewriteHistoryLinks({workspaceId: context.workspaceId, operationId: record.operationId,
      ...record.linkRewrite!, cancelSignal: cancel.signal});
    const pass = { cancel, answer };
    state.pass = pass;
    void answer.then(async receipt => {
      if (context.signal?.aborted) return;
      await withExclusiveWorkspaceOperation(root, async () => {
        const current = await readMoveRecovery(root, record.operationId);
        if (!current || "noUndo" in current || !eligible(current) || context.signal?.aborted) return;
        current.links = { state: "done", documents: receipt.documents, unchecked: receipt.unchecked, uncheckedCount: receipt.uncheckedCount };
        await saveRecoveryRecord(root, current, "move");
      }, {markOnSuccess: false});
    }).catch(() => {
      // A cancelled or interrupted pass stays updating for refusal/open recovery.
    }).finally(() => {
      context.signal?.removeEventListener("abort", retired);
      if (state.pass === pass) delete state.pass;
      if (!state.undo && !state.scheduled && !state.pass) states.delete(keyFor(root, record.operationId));
    });
  });
}

// Mark before waiting for the move lock, so open recovery cannot start another call.
export async function pauseLinkRewrite(root: string, id: string): Promise<() => void> {
  const state = stateFor(root, id);
  state.undo++;
  state.scheduled = false;
  const pass = state.pass;
  pass?.cancel.abort();
  await pass?.answer.catch(() => undefined);
  if (state.pass === pass) delete state.pass;
  return () => {
    state.undo--;
    if (!state.undo && !state.scheduled && !state.pass) states.delete(keyFor(root, id));
  };
}

export async function resumeWorkspaceLinkRewrites(root: string, context: LinkRewriteContext): Promise<void> {
  for (const id of await listMoveRecoveries(root)) {
    if (context.signal?.aborted) return;
    await withExclusiveWorkspaceOperation(root, async () => {
      const record = await readMoveRecovery(root, id);
      if (record && !("noUndo" in record)) scheduleLinkRewrite(root, record, context);
    }, {markOnSuccess: false});
  }
}
