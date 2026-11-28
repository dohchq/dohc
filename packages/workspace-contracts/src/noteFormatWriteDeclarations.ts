import { z } from "zod";
import { ConvertNotesResult } from "./noteFormat";
import type { WriteFamily } from "./writeDeclaration";

export const NOTE_FORMAT_WRITE_DECLARATIONS = {
  convertNotes: {
    access: "write",
    capabilityId: "workspace.notes.convert",
    ipc: {
      channel: "desktop:convert-notes",
      input: z.object({}).strict(),
      result: ConvertNotesResult,
      inactiveMessage:
        "Converting notes stopped because this window changed workspaces. Notes already converted stay converted.",
    },
    socket: {
      verb: "notesConvert",
      input: z.object({}).strict(),
      result: z.union([
        ConvertNotesResult.extend({ ok: z.literal(true) }).strict(),
        z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
      ]),
      admission: {
        receivedShare: "owner",
        readOnlyWorkspace: "refuse-document",
        run: "never-a-run",
        paths: "none",
      },
    },
    cli: {
      command: ["notes", "convert"],
      summary:
        "Convert this workspace's notes to the new format, as Convert notes does in Settings.",
      operands: "",
      notes: [
        "Prints how many notes it converted, then the paths it left as they were and why. Run it again to convert notes that were open or busy.",
        "Every computer and phone must run a dohc that reads the new format first. It cannot be undone.",
      ],
      example: [],
    },
    mcp: {
      tool: "dohc_convert_notes",
      description:
        "Convert the owner's notes in this workspace to the new format, as Convert notes does in Settings › Advanced. Notes open on this computer or elsewhere, held, waiting on a review, or not yet saved stay as they were and are listed in `skipped` with a reason; run it again later to convert them. `doesNotFit` lists notes the new format cannot hold. `sent` is false when dohc converted notes but could not send them to the server yet. `stopped` says why a run stopped partway; the counts say what it did first, and running it again finishes. Every computer and phone must run a dohc that reads the new format first. It cannot be undone. Owner workspace only.",
      levels: ["owner"],
      reason:
        "Only the owner converts a workspace's notes, from their own computer. Shared profiles omit it; main admits the original workspace and the engine refuses anyone else.",
    },
  },
} as const satisfies WriteFamily;
