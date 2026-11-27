import { AGENT_RUN_UNDO_WRITE_DECLARATIONS } from "./agentRunUndoWriteDeclarations";
import { AGENT_SETUP_WRITE_DECLARATIONS } from "./agentSetupWriteDeclarations";
import { DRAWING_WRITE_DECLARATIONS } from "./drawingWriteDeclarations";
import { INBOX_WRITE_DECLARATIONS } from "./inboxWriteDeclarations";
import { LIVE_NOTE_WRITE_DECLARATIONS } from "./liveNoteWriteDeclarations";
import { MEMBER_APPS_WRITE_DECLARATIONS } from "./memberAppsWriteDeclarations";
import { NOTE_FORMAT_WRITE_DECLARATIONS } from "./noteFormatWriteDeclarations";
import { ENVELOPE_FIELDS } from "./operationDeclaration";
import { PROTECTED_COPY_WRITE_DECLARATIONS } from "./protectedCopyWriteDeclarations";
import { STOPPED_RUN_WRITE_DECLARATIONS } from "./stoppedRunWriteDeclarations";
import { ADMISSION_RULES, type SocketAdmission, type WriteFamily } from "./writeDeclaration";

// Every declared write family, listed once. The capability table, the CLI, the
// CLI socket, the MCP server, and the IPC tables take their families from here,
// so each door loads the checks below.
export const WRITE_DECLARATION_FAMILIES = {
  agentRunUndo: AGENT_RUN_UNDO_WRITE_DECLARATIONS,
  stoppedRun: STOPPED_RUN_WRITE_DECLARATIONS,
  protectedCopy: PROTECTED_COPY_WRITE_DECLARATIONS,
  inbox: INBOX_WRITE_DECLARATIONS,
  liveNote: LIVE_NOTE_WRITE_DECLARATIONS,
  memberApps: MEMBER_APPS_WRITE_DECLARATIONS,
  drawing: DRAWING_WRITE_DECLARATIONS,
  agentSetup: AGENT_SETUP_WRITE_DECLARATIONS,
  noteFormat: NOTE_FORMAT_WRITE_DECLARATIONS,
} as const;

// The type refuses these, but a cast can hide one from it.
for (const family of Object.values<WriteFamily>(WRITE_DECLARATION_FAMILIES)) {
  for (const [name, { access, ipc, socket, mcp }] of Object.entries(family)) {
    if (access !== "write")
      throw new Error(`${name} is declared as ${String(access)}. Only writes are declared here.`);
    for (const rule of Object.keys(ADMISSION_RULES) as (keyof SocketAdmission)[]) {
      const allowed: readonly string[] = ADMISSION_RULES[rule];
      if (!allowed.includes(socket.admission[rule]))
        throw new Error(`${name} has no listed ${rule} rule.`);
    }
    // An input that reaches the socket cannot name a run id either: only the run rule adds one.
    const socketInputs = [socket.input];
    if (!("none" in mcp) && mcp.input) socketInputs.push(mcp.input);
    const inputs = "none" in ipc ? socketInputs : [...socketInputs, ipc.input];
    for (const input of inputs) {
      const field = [...ENVELOPE_FIELDS, ...(socketInputs.includes(input) ? ["runId"] : [])].find(
        (envelope) => Object.hasOwn(input.shape, envelope),
      );
      if (field) throw new Error(`${name} input names ${field}, which its doors set.`);
    }
  }
}
