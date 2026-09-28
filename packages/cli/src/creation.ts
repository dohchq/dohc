import { z } from "zod";

export const CreationStage = z.enum(["scope", "write", "register", "capture", "index", "bind", "fields", "settle", "close", "verify", "revision"]);
export type CreationStage = z.infer<typeof CreationStage>;
export const CreationPartial = z.object({
  kind: z.literal("partial"),
  created: z.array(z.string().min(1)).min(1),
  failedStage: CreationStage,
  reason: z.string(),
  retry: z.object({
    mode: z.enum(["resume", "remove-and-retry"]),
    instruction: z.string().min(1),
    recordId: z.string().regex(/^rec_[a-z2-7]{26}$/).optional(),
  }).strict(),
}).strict();
export type CreationPartial = z.infer<typeof CreationPartial>;

const stageWords: Record<CreationStage, string> = {
  scope: "confirm creation in the original workspace",
  register: "open the workspace engine",
  write: "finish saving", capture: "capture the files", index: "add the record to the Collection",
  bind: "open the record for editing", fields: "set the record fields", settle: "save the record fields",
  close: "finish editing the record", verify: "verify the saved files", revision: "confirm the Collection rules",
};
export function creationPartialMessage(result: CreationPartial): string {
  return [
    `Created: ${result.created.join(", ")}`,
    `dohc could not ${stageWords[result.failedStage]}.`,
    ...(result.retry.recordId ? [`Record ID: ${result.retry.recordId}`] : []),
    result.reason,
    result.retry.instruction,
  ].filter(Boolean).join("\n");
}

/** The retry or copy control beside this sentence supplies the next action. */
export function creationPartialNotice(result: CreationPartial): string {
  if (result.retry.mode === "remove-and-retry") {
    return result.retry.recordId
      ? "dohc created the record file; copy the details to review it in Files."
      : "dohc created form files; copy the details to review them in Files.";
  }
  return result.retry.recordId
    ? "dohc created the record file but could not finish the record."
    : "dohc created form files but could not finish the form.";
}

export class CreationPartialError extends Error {
  constructor(readonly partial: CreationPartial) {
    super(creationPartialMessage(partial));
    this.name = "CreationPartialError";
  }
}
