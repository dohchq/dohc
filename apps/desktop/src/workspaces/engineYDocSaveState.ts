import {
  PENDING_SHARE, SAVED_HERE, SAVED_TO_HOST, SAVING, UNKNOWN_SAVE_STATE, saveProblem,
  type SaveState,
} from "@dohc/workspace-contracts/save-state";
import type { EngineYDocSaveStateName } from "../ipc/channels";

export function engineSaveState(state: EngineYDocSaveStateName, refusal?: { requestId: string; message: string }): {
  state: SaveState;
  access?: "read-only" | "deleted" | "object-changed";
} {
  switch (state) {
    case "saved": return { state: SAVED_HERE };
    case "saved-to-host": return { state: SAVED_TO_HOST };
    case "settling": return { state: SAVING };
    case "pending-share": return { state: PENDING_SHARE };
    case "file-locked": return { state: saveProblem(state, "The file is in use.") };
    case "changed-on-disk": return { state: saveProblem(state, "The file changed on disk.") };
    case "error": return { state: saveProblem(state, refusal?.message ?? "dohc could not confirm the file was saved.", refusal?.requestId ?? null) };
    case "read-only":
    case "deleted":
    case "object-changed": return { state: UNKNOWN_SAVE_STATE, access: state };
  }
}
