import { describe, expect, it, vi } from "vitest";
import {
  createRendererWorkspaceOperationRunner,
  type ExactRendererWorkspaceOperation,
  type RendererWorkspaceOperationSession,
} from "../window/rendererWorkspaceOperation";
import {
  createWorkspaceActivity,
  WorkspaceActivityState,
  type ActivityWorkspace,
} from "../workspaces/workspaceActivity";
import { idleObservation } from "../workspaces/workspaceActivity.testSupport";
import { AgentRunStateEvent, agentRunStateOperations } from "./bridgeContract";
import { registerOperations, type OperationHandlers } from "./operationTable";

interface Sender {
  openWorkspaceId: string | null;
}
interface Event {
  sender: Sender;
}
type Operation = ExactRendererWorkspaceOperation<
  ActivityWorkspace,
  { activity: WorkspaceActivityState },
  RendererWorkspaceOperationSession
>;

// main.ts registers this row the same way: the handler reads the projection
// for the workspace the sender's operation holds.
function harness() {
  const pushed: AgentRunStateEvent[] = [];
  const activity = createWorkspaceActivity(() => {}, {
    observationFor: idleObservation,
    onAgentRunState: (event) => pushed.push(AgentRunStateEvent.parse(event)),
  });
  const workspaces = new Map(["ws-a", "ws-b"].map((workspaceId) => [workspaceId, {
    workspace: {
      workspaceId, rootPath: `/${workspaceId}`, attachmentId: Symbol(workspaceId),
      kind: "personal", mode: "local-first",
    } as ActivityWorkspace,
    state: new WorkspaceActivityState(),
  }]));
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<
    Sender, ActivityWorkspace, { activity: WorkspaceActivityState }, RendererWorkspaceOperationSession
  >({
    currentSession: (sender) => {
      const shown = sender.openWorkspaceId === null ? undefined : workspaces.get(sender.openWorkspaceId);
      return shown && {
        workspaceId: shown.workspace.workspaceId,
        attachmentId: shown.workspace.attachmentId,
        generation: 1,
        isCurrent: () => true,
      };
    },
    withPhysicalOperation: async (workspaceId, work) => {
      const found = workspaces.get(workspaceId)!;
      return work({
        workspace: found.workspace,
        state: { activity: found.state },
        signal: new AbortController().signal,
        assertCurrent: () => undefined,
      });
    },
  });
  const read = vi.fn<OperationHandlers<typeof agentRunStateOperations, Event, Operation>["readAgentRunState"]>(
    (_input, { operation }) => activity.agentRunState(operation.workspace, operation.state.activity),
  );
  const listeners = new Map<string, (event: Event, payload: unknown) => Promise<unknown>>();
  registerOperations<typeof agentRunStateOperations, Event, Operation>(
    {
      handle: (channel, listener) => listeners.set(channel, listener),
      assertTrustedSender: () => undefined,
      withActiveWorkspace: (event, workspaceId, inactiveMessage, work) =>
        withRendererWorkspaceOperation(event.sender, workspaceId, inactiveMessage, work),
    },
    agentRunStateOperations,
    { readAgentRunState: read },
  );
  const invoke = (shown: string | null, workspaceId: string) =>
    listeners.get(agentRunStateOperations.readAgentRunState.channel)!(
      { sender: { openWorkspaceId: shown } },
      { workspaceId },
    );
  const start = async (workspaceId: string, agentRunId: string) => {
    const { workspace, state } = workspaces.get(workspaceId)!;
    await activity.open(workspace, state);
    await activity.setAgentRun(workspace, state, { agentId: "dohc-mcp", onBehalfOf: "local", agentRunId, depth: 0 });
  };
  return { pushed, read, invoke, start };
}

describe("agent run state IPC", () => {
  it.each([
    ["another workspace", "ws-b"],
    ["no workspace", null],
  ])("refuses a window showing %s before reading", async (_case, shown) => {
    const { read, invoke } = harness();
    await expect(invoke(shown, "ws-a")).rejects.toThrow(
      agentRunStateOperations.readAgentRunState.inactiveMessage,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("answers from the slot with the revision each push raises", async () => {
    const { pushed, invoke, start } = harness();
    await expect(invoke("ws-a", "ws-a")).resolves.toEqual({ workspaceId: "ws-a", revision: 0, active: false });
    await start("ws-a", "run-a");
    expect(pushed).toEqual([{ workspaceId: "ws-a", revision: 1, active: true }]);
    await expect(invoke("ws-a", "ws-a")).resolves.toEqual({ workspaceId: "ws-a", revision: 1, active: true });
    // A run in another workspace raises the shared revision without changing this answer.
    await start("ws-b", "run-b");
    expect(pushed.at(-1)).toEqual({ workspaceId: "ws-b", revision: 2, active: true });
    await expect(invoke("ws-a", "ws-a")).resolves.toEqual({ workspaceId: "ws-a", revision: 2, active: true });
  });
});
