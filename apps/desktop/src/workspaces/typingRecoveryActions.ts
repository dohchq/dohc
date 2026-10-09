import { readTypingCheckpoints, retireTypingCheckpoint } from "./outageTypingRecovery";
import type { CaptureRecoveryImportResult } from "@dohc/workspace-engine-client";

export type TypingCopyResult = {outcome: "copied" | "discarded" | "missing"}
  | {outcome: "replayed" | "covered"; momentId: null}
  | {outcome: "imported"; momentId: string};

export async function actOnTypingCopy(input: {
  directory: string;
  workspaceId: string;
  checkpointId: string;
  action: "copy" | "discard";
  recovered?: () => CaptureRecoveryImportResult | undefined;
  assertCurrent: () => void;
  copyText: (text: string) => void;
}): Promise<TypingCopyResult> {
  const row = (await readTypingCheckpoints(input.directory, input.workspaceId))
    .find(row => row.checkpoint.checkpointId === input.checkpointId);
  input.assertCurrent();
  if (!row) {
    const recovery = input.recovered?.();
    if (!recovery) return {outcome: "missing"};
    return recovery.outcome === "imported"
      ? {outcome: "imported", momentId: recovery.momentId!}
      : {outcome: recovery.outcome, momentId: null};
  }
  if (input.action === "copy") {
    input.copyText(row.checkpoint.text);
    return {outcome: "copied"};
  }
  await retireTypingCheckpoint(row);
  return {outcome: "discarded"};
}
