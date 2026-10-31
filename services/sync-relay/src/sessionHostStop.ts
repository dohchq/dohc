import {RelayError, type SessionHostStopRefusal} from "./errors";

/** Adds the host's known state only when the fence needs a missing preparation. */
export function stopWithoutSessionHost<T>(document: {workspaceId: string; objectId: string}, refusal: SessionHostStopRefusal, fence: () => T): T {
  try {return fence();}
  catch (error) {
    if (!(error instanceof RelayError) || error.code !== "host-not-loaded" || error.sessionHost !== undefined) throw error;
    console.error(`Live editing Stop for workspace ${document.workspaceId}, object ${document.objectId}. Session host: ${refusal.sessionHost}`);
    throw new RelayError(refusal.code, undefined, undefined, refusal.sessionHost, refusal.path);
  }
}
