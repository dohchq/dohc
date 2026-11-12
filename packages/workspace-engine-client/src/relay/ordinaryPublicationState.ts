import type { WorkspaceDaemonRequester } from "../live/daemonLiveAdapter";
import type { WorkspaceHandle } from "../protocol";
import {
  MAX_PUBLICATION_STAGE_KEYS,
  ORDINARY_PUBLICATION_STATE_METHOD,
  decodeOrdinaryPublicationState,
  type OrdinaryPublicationState,
} from "./ordinarySyncWireContract";

/** Each stage key's receipt in `workspace` and how far its journal rows have been pushed. */
export async function readOrdinaryPublicationState(
  requester: Pick<WorkspaceDaemonRequester, "request">,
  workspace: WorkspaceHandle,
  stageKeys: readonly string[],
  options?: { deadlineMs?: number; cancelSignal?: AbortSignal },
): Promise<OrdinaryPublicationState> {
  if (stageKeys.length > MAX_PUBLICATION_STAGE_KEYS) {
    throw new RangeError(`at most ${MAX_PUBLICATION_STAGE_KEYS} stage keys`);
  }
  const result = await requester.request(
    ORDINARY_PUBLICATION_STATE_METHOD,
    { stageKeys: [...stageKeys] },
    { ...options, workspace },
  );
  return decodeOrdinaryPublicationState(result, stageKeys);
}
