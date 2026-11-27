import { DrawingCreateInput, DrawingEditInput, DrawingWriteResult } from "./drawing";
import type { SocketAdmission, WriteFamily } from "./writeDeclaration";

const OWNER_ONLY = {
  receivedShare: "owner",
  readOnlyWorkspace: "refuse-document",
  run: "never-a-run",
  paths: "rebases-path",
} as const satisfies SocketAdmission;
const NO_IPC = { none: "The canvas edits drawings through its own live session." };
const UNDO =
  "Undo Run in History skips a drawing an agent created, because removing a drawing can also remove linked assets: delete it individually from History. It also skips a drawing open in an editor until it closes.";
const ELEMENT_NOTE =
  "Each element is { type: rectangle|ellipse|diamond|text|arrow|line|frame, x, y } with optional id, width, height, text, strokeColor, backgroundColor, points, link, groupIds, and frameId. A text element with containerId sits inside that shape or arrow. An arrow or line takes start and end element ids to bind its ends.";
const REASON =
  "Only the original workspace edits drawings: shared views never open them live. Shared profiles omit it; the socket refuses received shares and read-only workspaces, and the handler resolves the path again.";

export const DRAWING_WRITE_DECLARATIONS = {
  drawingCreate: {
    access: "write",
    capabilityId: "drawing.create",
    ipc: NO_IPC,
    socket: {
      verb: "drawingCreate",
      input: DrawingCreateInput,
      result: DrawingWriteResult,
      admission: OWNER_ONLY,
    },
    cli: {
      command: ["drawing", "create"],
      summary: "Create a drawing, optionally with elements.",
      operands: "<path> [elements-json]",
      flags: [{ name: "--request-id", value: "id", text: "Create it at most once for this id." }],
      notes: [ELEMENT_NOTE, UNDO],
      example: ["plan.excalidraw", '[{"type":"rectangle","x":0,"y":0}]'],
    },
    mcp: {
      tool: "dohc_create_drawing",
      levels: ["owner"],
      reason: REASON,
      description: `Create a new .excalidraw drawing, optionally with elements, without replacing an existing file. History records it as yours. ${ELEMENT_NOTE} The answer lists each element's id and version. ${UNDO} Owner workspace only.`,
    },
  },
  drawingEdit: {
    access: "write",
    capabilityId: "drawing.edit",
    ipc: NO_IPC,
    socket: {
      verb: "drawingEdit",
      input: DrawingEditInput,
      result: DrawingWriteResult,
      admission: OWNER_ONLY,
    },
    cli: {
      command: ["drawing", "edit"],
      summary: "Add, change, or delete a drawing's elements.",
      operands: "<path> <edit-json>",
      flags: [{ name: "--request-id", value: "id", text: "Apply it at most once for this id." }],
      notes: [
        "edit-json is { add, update, delete }. update and delete name each element's id and the expectedVersion drawing read gave; dohc refuses the whole edit when someone changed that element since.",
        ELEMENT_NOTE,
        UNDO,
      ],
      example: ["plan.excalidraw", '{"update":[{"id":"a","expectedVersion":1,"x":10}]}'],
    },
    mcp: {
      tool: "dohc_edit_drawing",
      levels: ["owner"],
      reason: REASON,
      description: `Change an .excalidraw drawing: add elements, update fields of existing ones, or delete them. An open canvas shows the change at once and keeps what the person draws meanwhile. update and delete need each element's id and the version from dohc_read_drawing as expectedVersion; the whole edit is refused if someone changed one of those elements since, so read again and retry. Deleting a shape deletes its text too. ${ELEMENT_NOTE} Send requestId to retry safely: the same id answers again without applying twice. ${UNDO} Owner workspace only.`,
    },
  },
} as const satisfies WriteFamily;
