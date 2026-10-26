import { z } from "zod";

export const HistoryOperationId = z.string().regex(/^dohc-operation:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
export const OperationRecovery = z.object({
  operationId: HistoryOperationId,
  undo: z.union([z.object({ available: z.literal(true) }), z.object({ available: z.literal(false), reason: z.string(), paths: z.array(z.string()) })]),
});
export const HistoryOperationReadResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true), operationId: HistoryOperationId,
    members: z.array(z.object({ momentId: z.string(), operation: z.enum(["write", "delete", "rename"]), path: z.string(), beforePath: z.string().optional() })).max(50),
    withoutHistory: z.array(z.string()).optional(), nextCursor: z.string().nullable() }),
]);
// Why main refused an Undo, so a caller words it in its own voice while
// `reason` keeps main's text. "unexplained" is any refusal main cannot name.
export const UndoRefusal = z.union([
  z.object({ code: z.literal("old-path-occupied"), path: z.string() }),
  z.object({ code: z.literal("unexplained") }),
]);
export const HistoryOperationUndoResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string(), refusal: UndoRefusal }),
  z.object({ ok: z.literal(true), tracked: z.object({ state: z.enum(["restoring", "restored"]), momentCount: z.number() }),
    restored: z.array(z.string()), remaining: z.array(z.object({ path: z.string(), reason: z.string(), retry: z.boolean() })) }),
]);
