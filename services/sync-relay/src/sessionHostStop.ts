import {RelayError, type SessionHostState} from "./errors";

/** Adds the host's known state only when the fence needs a missing preparation. */
export function stopWithoutSessionHost<T>(document: {workspaceId: string; objectId: string}, state: SessionHostState, fence: () => T): T {
  try {return fence();}
  catch (error) {
    if (!(error instanceof RelayError) || error.code !== "host-offline") throw error;
    const code = state === "not running" ? "host-offline" : "host-not-loaded";
    console.error(`Live editing Stop for workspace ${document.workspaceId}, object ${document.objectId}. Session host: ${state}`);
    throw new RelayError(code, undefined, undefined, state);
  }
}
