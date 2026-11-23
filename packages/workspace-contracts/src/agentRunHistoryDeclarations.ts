import { PlanUndoAgentRunInput, PlanUndoAgentRunResult } from "./agentRunUndo";
import type { OperationFamily } from "./operationDeclaration";

export const AGENT_RUN_HISTORY_DECLARATIONS = {
  planUndoAgentRun: {
    access: "read",
    capabilityId: "history.agent.run.plan",
    input: PlanUndoAgentRunInput,
    result: PlanUndoAgentRunResult,
    ipc: {
      channel: "desktop:plan-undo-agent-run",
      inactiveMessage: "History stopped because this window changed workspaces.",
    },
    cli: {
      verb: "planUndoAgentRun",
      command: ["history", "agent-run-plan"],
      summary: "List which files saved during an agent run can be safely undone.",
      operands: "<agent-run-id>",
      unavailable: "Agent run undo planning is unavailable.",
      example: ["run-1"],
    },
    mcp: {
      tool: "dohc_plan_agent_run_undo",
      levels: ["owner"],
      description:
        "Inspect which files saved during one agent run can be safely restored to before the run, and which files would be skipped because of later edits, renames, path collisions, live editing, or protection.",
    },
  },
} as const satisfies OperationFamily;
