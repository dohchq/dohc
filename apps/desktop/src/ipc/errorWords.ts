import type { DaemonErrorCode } from "@dohc/workspace-engine-client";

// Electron hands a rejected handler's error to the renderer as one string,
// `error.toString()`: the class survives, the code does not. `ipcWireError`
// keeps the code (`DaemonRefusalError [OVERLOADED]: …`) and `readError` turns
// that string back into words a person can act on.

// `null`: the error names nothing a person can act on, so the caller's own
// sentence stands alone. Copy details still carry the error as it arrived.
type Words = string | null;

const UPDATING = "dohc is still reading this workspace's files. Try again when it finishes.";
const TOO_LARGE = "It is too large.";
const UNREADABLE_ANSWER = "The server sent an answer dohc could not read. Try again later.";
const CONTENT_MISSING = "Some file contents are missing on the server.";
const STOPPED = "It stopped before it finished. Try again.";

// Every code the engine refuses with: `ErrorCode` in dohc-engine-protocol.
const ENGINE_CODE_WORDS = {
  AUTH_FAILED: "The server did not accept your sign-in. Sign in again.",
  PROTOCOL_VERSION_UNSUPPORTED: null,
  MALFORMED_FRAME: null,
  LIMIT_EXCEEDED: TOO_LARGE,
  INVALID_ENVELOPE: null,
  METHOD_NOT_FOUND: null,
  INVALID_PARAMS: null,
  DEADLINE_EXCEEDED: "dohc did not answer in time. Try again.",
  CANCELLED: STOPPED,
  OVERLOADED: "dohc is busy. Try again in a moment.",
  SESSION_EXPIRED: "dohc lost its connection to this workspace. Try again.",
  WORKSPACE_UNAVAILABLE: "dohc could not reach this workspace. Try again.",
  CONFLICT: "It changed while dohc was working on it. Try again.",
  ORIGIN_DIVERGED: "The server has a different history for this workspace.",
  SHARE_UNAVAILABLE: "This share is no longer available.",
  KEY_ENVELOPE_MISSING: null,
  EPOCH_SUPERSEDED: null,
  IDENTITY_NOT_RECOGNIZED: "The server does not recognize this device.",
  FORBIDDEN: "You do not have access to this.",
  SHARE_READ_ONLY: "This share is read-only.",
  SHARE_OPERATION_REJECTED: "This change is outside what was shared.",
  PAYLOAD_TOO_LARGE: TOO_LARGE,
  QUOTA_EXCEEDED: "This workspace has reached its limit on the server.",
  RELAY_NO_PROGRESS: UNREADABLE_ANSWER,
  BLOB_MISSING: CONTENT_MISSING,
  BLOB_REFERENCE_MISSING: CONTENT_MISSING,
  BLOB_INVALID: "Some file contents are damaged.",
  IDENTITY_REQUIRED: "Sign in to your server first.",
  STREAM_IDENTITY_MISMATCH: null,
  AUTHORSHIP_MISMATCH: null,
  UNKNOWN_CHAT_OPERATION: null,
  PRESENCE_CAPACITY: "Too many people are connected right now. Try again later.",
  SELF_SHARE: "You cannot share with yourself.",
  AMBIGUOUS_SELECTOR: null,
  INVALID_CHANNEL: "This channel cannot be shared.",
  RELAY_METHOD_NOT_ALLOWED: "The server does not support this.",
  RELAY_INVALID_RESPONSE: UNREADABLE_ANSWER,
  INTERNAL: null,
} as const satisfies Record<DaemonErrorCode, Words>;

// The one map from an error's class, then its message or code, to words. A
// class listed here writes its messages for developers, so none of them
// reaches a person. Keys are tried in order: the message, the code, then "*".
export const ERROR_WORDS: Readonly<Record<string, Readonly<Record<string, Words>>>> = {
  DaemonRefusalError: {
    ...ENGINE_CODE_WORDS,
    "Workspace is still updating. Try again.": UPDATING,
    "History is still updating. Try again.": UPDATING,
    "file-locked": "Another program has this file open. Close it there, then try again.",
    "workspace-owned": "Another copy of dohc has this workspace open. Close it there, then try again.",
    "share-read-only": ENGINE_CODE_WORDS.SHARE_READ_ONLY,
    "relay-origin-diverged": ENGINE_CODE_WORDS.ORIGIN_DIVERGED,
    "*": null,
  },
  EngineDaemonUnavailableError: { "*": "The workspace engine is not running. Restart dohc." },
  EngineRequestDeadlineError: { "*": ENGINE_CODE_WORDS.DEADLINE_EXCEEDED },
  EngineWorkspaceRetryDeadlineError: { "*": "dohc could not reach this workspace in time. Try again." },
  EngineWorkspaceRebuildingError: { "*": "dohc is rebuilding this workspace's data store. Try again in a moment." },
  EngineWorkspaceShuttingDownError: { "*": "dohc is quitting." },
  EngineWorkspaceRebindError: { "*": null },
  EngineWorkspaceSessionsClosedError: { "*": null },
  EngineRequestError: { "*": null },
  EngineClientError: { "*": null },
  DaemonProtocolError: { "*": null },
  DaemonClientCapabilityError: { "*": null },
  CompilerProcessError: {
    exit: "The app's code did not build.",
    timeout: "Building the app took too long. Try again.",
    input: "The app's code is too large to build.",
    output: "The app's build output is too large.",
    stderr: "The app's build reported too many problems.",
    spawn: "dohc could not start building the app. Restart dohc and try again.",
    cancelled: "Building the app stopped before it finished. Try again.",
    "*": null,
  },
  // The Collection worker, whose messages speak of datasets and journals.
  PersistentRuntimeError: {
    worker_deadline: "It took too long to finish. Try again.",
    worker_stopped: STOPPED,
    worker_closed: STOPPED,
    worker_aborted: STOPPED,
    queue_full: "dohc is busy with other Collection work. Try again in a moment.",
    queue_deadline: "dohc is busy with other Collection work. Try again in a moment.",
    stale_revision: "The Collection changed while dohc was working on it. Try again.",
    "*": null,
  },
  // The file system's codes. A plain error with no listed code keeps its
  // message, because dohc writes those for people.
  Error: {
    EACCES: "dohc does not have permission to use this file or folder.",
    EPERM: "dohc does not have permission to use this file or folder.",
    ENOENT: "The file or folder is not there anymore.",
    EBUSY: "Another program is using this file or folder.",
  },
  TypeError: { "*": null },
  RangeError: { "*": null },
  ReferenceError: { "*": null },
  SyntaxError: { "*": null },
  ZodError: { "*": null },
};

// When nothing else applies and no caller said what failed.
export const UNKNOWN_ERROR_WORDS = "dohc could not finish that.";

// Names for dohc's internals. The person's nouns are Collection and history.
const INTERNAL_NOUNS = /\b(?:datasets?|journals?|materializations?|checkpoints?)\b/i;
// A bare code such as `invalid-input` or `EACCES`, or one that leads a message.
const RAW_CODE = /^(?:\S*[-_]\S*|[A-Z0-9]{3,})$|^[A-Z][A-Z0-9_]+: /;
const IPC_PREFIX = /^Error invoking remote method '[^']*': /;
const CLASS_PREFIX = /^((?:[A-Z][A-Za-z0-9]*)?Error)(?: \[([^\]\s]+)\])?: /;

// The engine client's `wireCode`, the dataset worker's `code`, the compiler's
// `reason`.
function codeOf(error: Error): string | null {
  for (const field of ["wireCode", "code", "reason"]) {
    const value: unknown = Reflect.get(error, field);
    if (typeof value === "string" && /^[A-Za-z][\w-]{0,63}$/.test(value)) return value;
  }
  return null;
}

/** Main's IPC boundary: keeps the error's code in the one string Electron sends. */
export function ipcWireError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = codeOf(error);
  if (code === null) return error;
  const wire = new Error(error.message, { cause: error });
  wire.name = `${error.name} [${code}]`;
  return wire;
}

function parse(error: unknown) {
  let text = "";
  if (typeof error === "string") text = error;
  else if (error instanceof Error) {
    const code = codeOf(error);
    text = error.name === "Error" && code === null
      ? error.message
      : `${error.name}${code === null ? "" : ` [${code}]`}: ${error.message}`;
  }
  text = text.replace(IPC_PREFIX, "").trim();
  const match = CLASS_PREFIX.exec(text);
  return {
    text,
    name: match?.[1] ?? "Error",
    code: match?.[2],
    message: (match ? text.slice(match[0].length) : text).trim(),
  };
}

export interface ReadError {
  /** What a person reads, or null when only the caller's sentence applies. */
  words: string | null;
  /** The error as it arrived, for Copy details; null when `words` says it all. */
  cause: string | null;
}

export function readError(error: unknown): ReadError {
  const { text, name, code, message } = parse(error);
  const plain = name === "Error" && code === undefined;
  const entry = ERROR_WORDS[name];
  const key = entry && [message, code, "*"].find(
    (candidate) => candidate !== undefined && Object.hasOwn(entry, candidate),
  );
  if (entry && key !== undefined) return { words: entry[key] ?? null, cause: text };
  if (!message) return { words: null, cause: null };
  if (RAW_CODE.test(message) || INTERNAL_NOUNS.test(message)) {
    return { words: null, cause: plain ? message : text };
  }
  return { words: message, cause: plain ? null : text };
}

/** The engine refuses reads this way while it reads a new workspace's files. */
export function isWorkspaceUpdatingError(error: unknown): boolean {
  const { name, code, message } = parse(error);
  return name === "DaemonRefusalError" && code === "OVERLOADED" &&
    ERROR_WORDS.DaemonRefusalError?.[message] === UPDATING;
}
