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
  return {
    paused: pause?.paused ? "budget" : null,
    lastRun: run ? {
      state: run.endedAtMs === undefined ? "running" : run.failureReason || run.exitCode !== 0 ? "failed" : "completed",
      failureReason: run.failureReason ?? null,
      exitCode: run.exitCode ?? null,
    } : null,
  };
}
