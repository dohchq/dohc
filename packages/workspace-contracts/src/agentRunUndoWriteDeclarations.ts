import {
  UndoAgentRunIpcInput,
  UndoAgentRunResult,
  UndoAgentRunSocketInput,
  UndoAgentRunSocketResult,
} from "./agentRunUndo";
import type { WriteFamily } from "./writeDeclaration";

export const AGENT_RUN_UNDO_WRITE_DECLARATIONS = {
  undoAgentRun: {
    access: "write",
    capabilityId: "history.agent.run.undo",
    ipc: {
      channel: "desktop:undo-agent-run",
      input: UndoAgentRunIpcInput,
      result: UndoAgentRunResult,
      inactiveMessage: "History stopped because this window changed workspaces.",
    },
    socket: {
      verb: "undoAgentRun",
      input: UndoAgentRunSocketInput,
      result: UndoAgentRunSocketResult,
      admission: {
        receivedShare: "owner",
        readOnlyWorkspace: "refuse-file",
        run: "never-a-run",
        paths: "none",
      },
    },
    cli: {
      command: ["history", "undo-agent-run"],
      summary: "Undo safe file changes saved during an agent run.",
      operands: "<agent-run-id> <plan-token>",
      notes: [
        "Pass the planToken returned by `dohc history agent-run-plan <agent-run-id>`.",
        "Only a person can run this command; requests from agents or active runs are refused.",
        "Skips files with later edits, renames, path collisions, live editors, open desktop windows, Collections, created drawings, or protection.",
      ],
      example: ["run-1", "plan-token"],
    },
    mcp: {
      none: "Undoing an entire agent run is a human recovery action from desktop History or the CLI, not an MCP tool.",
    },
  },
} as const satisfies WriteFamily;
