import { z } from "zod";
import type { WriteFamily } from "./writeDeclaration";

const PROTECTED_COPY_ID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const PROTECTED_COPY_WRITE_DECLARATIONS = {
  restoreProtectedCopy: {
    access: "write",
    capabilityId: "file.protected.restore",
    ipc: {
      channel: "desktop:restore-protected-copy",
      input: z.object({ id: PROTECTED_COPY_ID }),
      result: z.object({ status: z.literal("restored"), path: z.string().min(1) }),
      inactiveMessage:
        "Versions stopped because this window changed workspaces. Open the workspace and try again.",
    },
    socket: {
      verb: "restoreProtectedCopy",
      input: z.object({ id: PROTECTED_COPY_ID }),
      result: z.union([
        z
          .object({ ok: z.literal(true), status: z.literal("restored"), path: z.string().min(1) })
          .strict(),
        z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
      ]),
      admission: {
        // Protected copies stay on the computer of the workspace that kept them.
        receivedShare: "own-answer",
        readOnlyWorkspace: "handler-decides",
        run: "never-a-run",
        paths: "from-callers-folder",
      },
    },
    cli: { none: "An agent restores a protected file through MCP. A person uses Notices." },
    mcp: {
      tool: "dohc_restore_protected_copy",
      description:
        "Write one entry from `protectedCopies` in dohc_list_kept_copies back to its protected file. Each entry is [path, id, keptAtMs]: a change to a protected file such as `.env` that a sync replaced or deleted, kept on this computer only. The synced text stays in the file's History, so the restore can be reversed there. `status` is `restored` with the file's `path`.",
      levels: ["owner"],
      reason:
        "The copy stays on the computer that kept it, so shared profiles omit this write. Socket read-only admission and per-verb checks remain the gates.",
      // The socket checks the id's shape.
      input: z.object({ id: z.string() }),
    },
  },
} as const satisfies WriteFamily;
