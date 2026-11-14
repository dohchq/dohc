import { z } from "zod";
import type { WriteFamily } from "./writeDeclaration";

const OPAQUE_ID = z.string().min(1).max(200);

export const STOPPED_RUN_WRITE_DECLARATIONS = {
  retryStoppedRun: {
    access: "write",
    capabilityId: "agent.run.retry",
    ipc: {
      channel: "desktop:retry-stopped-run",
      input: z.object({ threadId: OPAQUE_ID, runId: OPAQUE_ID }).strict(),
      // False when the run can't be tried again any more, as after a second press.
      result: z.object({ queued: z.boolean() }).strict(),
      inactiveMessage: "This window changed workspaces.",
    },
    socket: {
      verb: "chatRetry",
      input: z.object({ thread: z.string().min(1) }),
      // Try again for a conversation's stopped agent request: queued, or why not.
      result: z.union([
        z
          .object({ ok: z.literal(true), status: z.literal("queued"), threadId: z.string().min(1) })
          .strict(),
        z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
      ]),
      admission: {
        receivedShare: "chat",
        readOnlyWorkspace: "refuse-chat",
        run: "may-name-its-run",
        paths: "none",
      },
    },
    cli: {
      command: ["chat", "retry"],
      summary: "Run an agent's stopped request in a conversation again, as Try again does.",
      operands: "<thread>",
      notes: [
        "dohc chat show reports a stopped run under dispatch.lastRun.",
        "Each request gets two attempts. Only the computer that ran it can run it again, and only someone who may post in the conversation.",
      ],
      example: ["thread"],
    },
    mcp: {
      tool: "dohc_retry_chat_run",
      description:
        "Run an agent's stopped request in a dohc Chat thread again, as Try again does under its message. dohc_read_chat reports a stopped run under dispatch.lastRun. Each request gets two attempts. Only the computer that ran it can run it again, and only for someone who may post in the thread.",
      levels: ["owner"],
      reason: "Only the computer that ran a request can run it again. Shared profiles omit it.",
      input: z.object({ threadId: z.string().min(1).max(200) }),
    },
  },
} as const satisfies WriteFamily;
