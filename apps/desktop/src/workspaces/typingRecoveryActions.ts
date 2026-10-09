import { readTypingCheckpoints, retireTypingCheckpoint } from "./outageTypingRecovery";

export async function actOnTypingCopy(input: {
  directory: string;
  workspaceId: string;
  checkpointId: string;
  action: "copy" | "discard";
  wasImported?: () => boolean;
  assertCurrent: () => void;
  copyText: (text: string) => void;
}): Promise<"copied" | "discarded" | "missing" | "imported"> {
  const row = (await readTypingCheckpoints(input.directory, input.workspaceId))
    .find(row => row.checkpoint.checkpointId === input.checkpointId);
  input.assertCurrent();
  if (!row) return input.wasImported?.() ? "imported" : "missing";
  if (input.action === "copy") {
    input.copyText(row.checkpoint.text);
    return "copied";
  }
  await retireTypingCheckpoint(row);
  return "discarded";
}
