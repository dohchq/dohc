import { z } from "zod";

const OPAQUE_ID = z.string().min(1).max(200);
const PATH_STRING = z.string().min(1).max(2048);

export const MAX_AGENT_RUN_UNDO_FILES = 1000;
export const AGENT_RUN_SCAN_MAX_PAGES = 250;

export const AgentRunUndoPlanItem = z
  .object({
    objectId: OPAQUE_ID,
    path: PATH_STRING,
    earliestMomentId: OPAQUE_ID,
    latestMomentId: OPAQUE_ID,
    momentCount: z.number().int().positive(),
    action: z.enum(["restore", "delete"]),
  })
  .strict();
export type AgentRunUndoPlanItem = z.infer<typeof AgentRunUndoPlanItem>;

const AgentRunUndoSkipReason = z.enum([
  "later-edits",
  "renamed",
  "path-collision",
  "protected",
  "untracked",
  "live-editing",
  "local-changes",
  "other-window",
  "not-in-plan",
  "unchanged",
  "collection",
  "drawing",
  "batch-limit",
]);

export const AgentRunUndoSkippedItem = z
  .object({
    path: PATH_STRING,
    reason: AgentRunUndoSkipReason,
    detail: z.string().min(1),
  })
  .strict();
export type AgentRunUndoSkippedItem = z.infer<typeof AgentRunUndoSkippedItem>;

export const PlanUndoAgentRunInput = z
  .object({
    agentRunId: OPAQUE_ID,
  })
  .strict();
export type PlanUndoAgentRunInput = z.infer<typeof PlanUndoAgentRunInput>;

export const PlanUndoAgentRunResult = z
  .object({
    agentRunId: OPAQUE_ID,
    agentName: z.string().min(1).nullable(),
    planToken: OPAQUE_ID,
    truncated: z.boolean(),
    scannedChanges: z.number().int().nonnegative(),
    restorable: z.array(AgentRunUndoPlanItem),
    skipped: z.array(AgentRunUndoSkippedItem),
    policyUnreadable: z.array(PATH_STRING).optional(),
  })
  .strict();
export type PlanUndoAgentRunResult = z.infer<typeof PlanUndoAgentRunResult>;

export const UndoAgentRunTarget = z
  .object({
    objectId: OPAQUE_ID,
    path: PATH_STRING,
    earliestMomentId: OPAQUE_ID,
    latestMomentId: OPAQUE_ID,
    action: z.enum(["restore", "delete"]),
  })
  .strict();
export type UndoAgentRunTarget = z.infer<typeof UndoAgentRunTarget>;

export const UndoAgentRunIpcInput = z
  .object({
    agentRunId: OPAQUE_ID,
    expectedTargets: z.array(UndoAgentRunTarget).max(MAX_AGENT_RUN_UNDO_FILES),
    reviewPaths: z.array(PATH_STRING).max(MAX_AGENT_RUN_UNDO_FILES).optional(),
  })
  .strict();
export type UndoAgentRunIpcInput = z.infer<typeof UndoAgentRunIpcInput>;

export const UndoAgentRunSocketInput = z
  .object({
    agentRunId: OPAQUE_ID,
    planToken: OPAQUE_ID,
  })
  .strict();
export type UndoAgentRunSocketInput = z.infer<typeof UndoAgentRunSocketInput>;

export const UndoAgentRunRestoredItem = z
  .object({
    path: PATH_STRING,
    restored: z.enum(["text", "deleted"]),
    restoredMomentId: OPAQUE_ID,
  })
  .strict();
export type UndoAgentRunRestoredItem = z.infer<typeof UndoAgentRunRestoredItem>;

export const UndoAgentRunFailedItem = z
  .object({
    path: PATH_STRING,
    detail: z.string().min(1),
  })
  .strict();
export type UndoAgentRunFailedItem = z.infer<typeof UndoAgentRunFailedItem>;

export const UndoAgentRunResult = z
  .object({
    agentRunId: OPAQUE_ID,
    correlationId: OPAQUE_ID.nullable(),
    truncated: z.boolean(),
    restored: z.array(UndoAgentRunRestoredItem),
    skipped: z.array(AgentRunUndoSkippedItem),
    failed: z.array(UndoAgentRunFailedItem),
    policyUnreadable: z.array(PATH_STRING).optional(),
  })
  .strict();
export type UndoAgentRunResult = z.infer<typeof UndoAgentRunResult>;

export const UndoAgentRunSocketResult = z.union([
  UndoAgentRunResult.extend({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
]);
export type UndoAgentRunSocketResult = z.infer<typeof UndoAgentRunSocketResult>;
