import { OutsideChangesInput, OutsideChangesResult } from "./outsideChanges";
import type { OperationFamily } from "./operationDeclaration";

export const CAPTURE_DECLARATIONS = {
  outsideChanges: {
    access: "read",
    capabilityId: "capture.outside.read",
    input: OutsideChangesInput,
    result: OutsideChangesResult,
    ipc: {
      channel: "desktop:outside-changes",
      inactiveMessage: "Outside changes stopped because this window changed workspaces.",
    },
    cli: {
      verb: "outsideChanges",
      command: ["document", "outside-changes"],
      summary: "List live notes whose file changed outside dohc.",
      operands: "",
      unavailable: "Outside changes are unavailable.",
      example: [],
    },
    mcp: {
      tool: "dohc_list_outside_changes",
      levels: ["owner"],
      description:
        "List live notes whose file changed outside dohc while the note was live. Neither the note nor History holds those changes. Keep one with dohc_keep_outside_change, which saves the file's bytes as a copy and puts the note's text back in the file.",
    },
  },
} as const satisfies OperationFamily;
