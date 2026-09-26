import type { CliResultByVerb } from "@dohc/cli/protocol";
import type { AwaitableAgentDispatchStore } from "./awaitableAgentDispatchStore";

export async function readThreadDispatchState(
  store: AwaitableAgentDispatchStore,
  workspaceId: string,
  threadId: string,
): Promise<CliResultByVerb["show"]["dispatch"]> {
  const [pause, run] = await Promise.all([
    store.getThreadDispatchPauseState(workspaceId, threadId),
    store.latestRunForThread(workspaceId, threadId),
  ]);
  const failureReason = run?.failureReason ?? (
    run?.endedAtMs !== undefined && run.exitCode === 0 && run.failureNotePosted
      ? "no-reply"
      : null
  );
  return {
    paused: pause?.paused ? "budget" : null,
    lastRun: run ? {
      state: run.endedAtMs === undefined ? "running" : failureReason || run.exitCode !== 0 ? "failed" : "completed",
      failureReason,
      exitCode: run.exitCode ?? null,
    } : null,
  };
}
