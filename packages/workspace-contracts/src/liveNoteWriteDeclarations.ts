import { z } from "zod";
import { ResumeOwnerLiveDocumentResult } from "./liveNote";
import type { WriteFamily } from "./writeDeclaration";
import { isSafeRelativePath } from "./workspacePaths";

const DOCUMENT_PATH = z.string().min(1).max(4096);

export const LIVE_NOTE_WRITE_DECLARATIONS = {
  resumeOwnerLiveDocument: {
    access: "write",
    capabilityId: "share.live.document.resume",
    ipc: {
      channel: "desktop:resume-owner-live-document",
      input: z
        .object({
          path: DOCUMENT_PATH.refine(
            isSafeRelativePath,
            "path must be a safe workspace-relative path",
          ),
        })
        .strict(),
      result: ResumeOwnerLiveDocumentResult,
      inactiveMessage: "Live editing stopped because this window changed workspaces.",
    },
    socket: {
      verb: "liveResume",
      input: z.object({ path: DOCUMENT_PATH }),
      result: z.discriminatedUnion("ok", [
        z
          .object({
            ok: z.literal(true),
            path: z.string().min(1),
            already: z.literal(true).optional(),
            ended: z.literal(true).optional(),
          })
          .strict(),
        z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
      ]),
      admission: {
        receivedShare: "own-answer",
        readOnlyWorkspace: "handler-decides",
        run: "never-a-run",
        paths: "rebases-path",
      },
    },
    cli: {
      command: ["document", "resume"],
      summary: "Resume live editing for a document, as Resume does in Live documents.",
      operands: "<path>",
      notes: [
        "Accepts a document whose canResume is true in live. dohc sends this computer's unsent changes first, and records the Resume as this agent's when the server says this request resumed it.",
        "already is true when the document was already live. Then dohc records no one.",
        "Run live again to follow it: preparing until the server starts the document, then ready.",
      ],
      example: ["plan.md"],
    },
    mcp: {
      tool: "dohc_resume_live_editing",
      description:
        "Resume live editing for a document, as Resume does in Live documents. Accepts a row whose `canResume` is true in dohc_list_live_documents. dohc sends this computer's unsent changes first, and records the Resume as this agent's when the server says this request resumed it; `already: true` means it was already live, and dohc records no one. `ended: true` means its file was moved, deleted or replaced: the server's pause of it ended and live editing stays off. Then read dohc_list_live_documents: `preparing` until the server starts the document, then `ready`. Owner workspace only.",
      levels: ["owner"],
      reason:
        "Only the original workspace resumes its live editing. Shared profiles omit this owner action; main admits the workspace and the relay checks the owner's account.",
    },
  },
} as const satisfies WriteFamily;
