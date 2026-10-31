export const LIVE_STOP_EDITS_PENDING = "Live editing didn't stop. The server hasn't finished applying edits to this document. Try again in a moment.";
/** A Stop with no answer, which dohc keeps and sends again. The cause stays out of the words. */
export const LIVE_STOP_WAITING = "dohc is waiting for the server to stop live editing and will keep trying.";
/** A server-only document's Stop that a restore on the server holds. */
export const LIVE_STOP_RESTORING = "A restore is still running on the server. dohc will stop live editing when it finishes.";
export const LIVE_STOP_EDITS_PENDING_RESUME = "Live editing didn't stop. Recent edits haven't reached the server yet. Resume live editing to send them, then stop it.";

export const HOST_STOP_REFUSALS = {
  "host-paused": {message: LIVE_STOP_EDITS_PENDING_RESUME, action: "resume"},
  "host-diverged": {message: "Live editing didn't stop. The server's copy of this workspace no longer matches the synced one. Contact the server's operator.", action: "none"},
  "host-no-edit-grant": {message: "Live editing didn't stop. The server may hold recent edits, but it only loads documents shared with Edit access. Share this one with Edit access again, then try again.", action: "retry"},
  "host-moved": {message: "Live editing didn't stop. The server may hold recent edits, but it only loads this document from {path}. Put it back there, then try again.", action: "retry"},
  "host-start-failed": {message: "Live editing didn't stop. The server couldn't load this document and may hold recent edits. Contact the server's operator, then try again.", action: "retry"},
  "host-not-loaded": {message: "Live editing didn't stop. The server hasn't loaded this document yet and may hold recent edits to it. Try again in a moment.", action: "retry"},
} as const;

type HostStopCode = keyof typeof HOST_STOP_REFUSALS;
export type LiveStopRefusal = {
  code: "edits-pending" | HostStopCode;
  sessionHost?: string;
  path?: string;
  resume?: true;
  pending?: "conflict-parent-withheld";
};
type LiveStopRow = {canResume: boolean; reason?: string};

export function liveStopRefusalForRow(refusal: LiveStopRefusal, row?: LiveStopRow): LiveStopRefusal {
  if (refusal.code !== "edits-pending" || row === undefined) return refusal;
  const {resume: _resume, pending: _pending, ...base} = refusal;
  return {...base, ...(row.canResume ? {resume: true as const}
    : row.reason === "conflict-parent-withheld" ? {pending: "conflict-parent-withheld" as const}
    : {})};
}

function isHostStopCode(code: unknown): code is HostStopCode {
  return typeof code === "string" && Object.hasOwn(HOST_STOP_REFUSALS, code);
}

export function liveStopAction(refusal: LiveStopRefusal, row?: LiveStopRow): "resume" | "retry" | "none" {
  if (refusal.code !== "edits-pending") return HOST_STOP_REFUSALS[refusal.code].action;
  const pending = liveStopRefusalForRow(refusal, row);
  return pending.resume ? "resume" : pending.pending === "conflict-parent-withheld" ? "none" : "retry";
}

export function liveStopOffersResume(refusal: LiveStopRefusal, row?: LiveStopRow): boolean {
  return liveStopAction(refusal, row) === "resume";
}

export function liveStopMessage(refusal: LiveStopRefusal, row?: LiveStopRow): string {
  refusal = liveStopRefusalForRow(refusal, row);
  if (refusal.code === "edits-pending") {
    if (refusal.resume) return LIVE_STOP_EDITS_PENDING_RESUME;
    if (refusal.pending === "conflict-parent-withheld") return "Live editing didn't stop. A conflict was resolved in this document, so the server can't resume live editing for it.";
    return LIVE_STOP_EDITS_PENDING;
  }
  const message = HOST_STOP_REFUSALS[refusal.code].message;
  if (refusal.code !== "host-moved") return message;
  if (!refusal.path) return "The server sent an answer dohc could not read. Try again later.";
  return message.replace("{path}", () => refusal.path!);
}

function knownSessionHost(value: unknown, path?: unknown): value is string {
  return typeof value === "string" && (["couldn't start", "starting", "restarting", "running, document not loaded yet",
    "running without this document (paused)", "running without this document (no Edit grant)",
    "running without this document (server copy diverged)"].includes(value) ||
    (typeof path === "string" && path.length > 0 && value === `running without this document (moved from ${path})`));
}

export function liveStopHostCopy(code: HostStopCode, sessionHost: unknown, path?: unknown): string {
  return `${liveStopMessage({code, ...(typeof path === "string" ? {path} : {})})}${knownSessionHost(sessionHost, path) ? `\nServer: ${sessionHost}` : ""}`;
}

const LIVE_STOP_WAITING_ERROR = "LiveStopWaitingError";

/** A Stop with no answer. `cause` stays in main, since Electron passes only the name and message. */
export function liveStopWaitingError(cause: unknown): Error {
  const error = new Error(LIVE_STOP_WAITING, {cause});
  error.name = LIVE_STOP_WAITING_ERROR;
  return error;
}

export function isLiveStopWaiting(error: unknown): boolean {
  return error instanceof Error && `${error.name}: ${error.message}`.includes(`${LIVE_STOP_WAITING_ERROR}: `);
}

// Electron preserves Error.toString(), so keep the code and metadata in its name.
export function liveStopError(refusal: LiveStopRefusal): Error {
  const error = new Error(refusal.code === "edits-pending" ? liveStopMessage(refusal)
    : liveStopHostCopy(refusal.code, refusal.sessionHost, refusal.path));
  error.name = `LiveStopRefusal [${encodeURIComponent(JSON.stringify(refusal))}]`;
  return error;
}

function stopRefusal(data: unknown): LiveStopRefusal | null {
  if (data === null || typeof data !== "object") return null;
  const code: unknown = Reflect.get(data, "code"), sessionHost: unknown = Reflect.get(data, "sessionHost");
  const path: unknown = Reflect.get(data, "path");
  if (code === "edits-pending") {
    const pending: unknown = Reflect.get(data, "pending");
    return {code, ...(Reflect.get(data, "resume") === true ? {resume: true} : {}),
      ...(pending === "conflict-parent-withheld" ? {pending} : {})};
  }
  if (!isHostStopCode(code)) return null;
  if (code === "host-moved" && (typeof path !== "string" || path.length === 0)) return null;
  return {code, ...(knownSessionHost(sessionHost, path) ? {sessionHost} : {}),
    ...(code === "host-moved" && typeof path === "string" ? {path} : {})};
}

export function liveStopRelayError(data: unknown): Error | null {
  const refusal = stopRefusal(data);
  return refusal ? liveStopError(refusal) : null;
}

export function readLiveStopRefusal(error: unknown): LiveStopRefusal | null {
  if (!(error instanceof Error)) return null;
  const wire = /LiveStopRefusal \[([^\]]+)\]/.exec(`${error.name}: ${error.message}`);
  if (wire) {
    try {return stopRefusal(JSON.parse(decodeURIComponent(wire[1]!)));}
    catch {return null;}
  }
  return null;
}

export const SAFE_REFUSAL_MESSAGES = new Set([
  "This share has too many files for live editing.",
  "This server supports up to 64 live documents.",
  "Service host enrollment capacity is full.",
  "The server has no room for more live documents. Stop live editing for unused documents, then try again.",
  "Sync this workspace before enabling live editing.",
  "Service host enrollment belongs to an obsolete workspace identity.",
  "Service host enrollment requires an owner edit share covering this path.",
  "Service host enrollment requires a current main document.",
  "Service host enrollment document moved from its retained path.",
  "Service host enrollment path belongs to another document.",
]);
