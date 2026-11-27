import { DrawingReadInput, DrawingReadResult } from "./drawing";
import type { OperationFamily } from "./operationDeclaration";

export const DRAWING_DECLARATIONS = {
  drawingRead: {
    access: "read",
    capabilityId: "drawing.read",
    input: DrawingReadInput,
    result: DrawingReadResult,
    ipc: {
      channel: "desktop:drawing-read",
      inactiveMessage: "Drawing read stopped because this window changed workspaces.",
    },
    cli: {
      verb: "drawingRead",
      command: ["drawing", "read"],
      summary: "Read a drawing's elements, as an open canvas holds them.",
      operands: "<path>",
      flags: [{ name: "--points", text: "Include line, arrow, and freehand points." }],
      unavailable: "Drawings are unavailable.",
      example: ["plan.excalidraw"],
    },
    mcp: {
      tool: "dohc_read_drawing",
      levels: ["owner"],
      description:
        "Read an .excalidraw drawing as a compact element list: id, type, version, position, size, text, colors, links, groups, frames, text containers, and arrow bindings, plus its app state. An open canvas answers with what it holds now (live: true). Line, arrow, and freehand points are left out unless points is true; pointCount says how many there are. Pass each element's version as expectedVersion to dohc_edit_drawing. Owner workspace only.",
    },
  },
} as const satisfies OperationFamily;
