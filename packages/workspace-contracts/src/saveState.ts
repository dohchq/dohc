import type { z } from "zod";
import type { SaveStateSchema } from "./saveStateSchema";

export type SaveState = z.infer<typeof SaveStateSchema>;

export const UNKNOWN_SAVE_STATE: SaveState = { kind: "unknown" };
export const SAVING: SaveState = { kind: "saving" };
export const SAVED_HERE: SaveState = { kind: "saved-here" };
export const SAVED_TO_HOST: SaveState = { kind: "saved-to-host" };
export const PENDING_SHARE: SaveState = { kind: "pending-share" };

export function saveStateEqual(a: SaveState, b: SaveState): boolean {
  return a.kind === b.kind &&
    (!("reason" in a) || ("reason" in b && a.reason === b.reason && a.issueId === b.issueId));
}

export function saveProblem(
  kind: "error" | "file-locked" | "changed-on-disk",
  reason: string,
  issueId: string | null = null,
): SaveState {
  return { kind, reason, issueId };
}
