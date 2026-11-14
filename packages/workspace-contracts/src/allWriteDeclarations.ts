import { ENVELOPE_FIELDS } from "./operationDeclaration";
import { PROTECTED_COPY_WRITE_DECLARATIONS } from "./protectedCopyWriteDeclarations";
import { STOPPED_RUN_WRITE_DECLARATIONS } from "./stoppedRunWriteDeclarations";
import { ADMISSION_RULES, type SocketAdmission, type WriteFamily } from "./writeDeclaration";

// Every declared write family, listed once. The capability table, the CLI, the
// CLI socket, the MCP server, and the IPC tables take their families from here,
// so each door loads the checks below.
export const WRITE_DECLARATION_FAMILIES = {
  stoppedRun: STOPPED_RUN_WRITE_DECLARATIONS,
  protectedCopy: PROTECTED_COPY_WRITE_DECLARATIONS,
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
    const inputs = [socket.input];
    if (!("none" in ipc)) inputs.push(ipc.input);
    if (!("none" in mcp) && mcp.input) inputs.push(mcp.input);
    for (const input of inputs) {
      const field = ENVELOPE_FIELDS.find((envelope) => Object.hasOwn(input.shape, envelope));
      if (field) throw new Error(`${name} input names ${field}, which its doors set.`);
    }
  }
}
