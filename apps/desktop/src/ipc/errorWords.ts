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
const REINSTALL = "This copy of dohc is missing a file it needs. Reinstall dohc.";

// Every code the engine refuses with: `ErrorCode` in dohc-engine-protocol.
const ENGINE_CODE_WORDS = {
  AUTH_FAILED: "The server did not accept your sign-in. Sign in again.",
  PROTOCOL_VERSION_UNSUPPORTED: null,
  MALFORMED_FRAME: null,
  LIMIT_EXCEEDED: null,
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
  IDENTITY_REQUIRED: "Connect to your server first.",
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
// reaches a person. Keys are tried in order: the message, the message before
// its first ": " (where it names a path or a detail), the code, then "*".
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
  // dohc restarts its engine by itself, except while quitting or when this
  // copy of dohc has no engine to start.
  EngineDaemonUnavailableError: {
    "Rust engine lifecycle is already stopping.": null,
    "Rust engine binary not found": REINSTALL,
    "Electron resources path is unavailable for the packaged Rust engine.": REINSTALL,
    "*": "Try again in a moment.",
  },
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

// The Collection host's plain errors that describe its own internals
// (app-backend-runtime and localDatasetHost), as complete sentences, or as
// the fixed words before ": " where one ends in a path. Only replies on the
// Collection channel are read this way. Any other message keeps its words,
// so a field, Collection or file a person named keeps its name and its
// instruction.
const COLLECTION_CHANNEL = "desktop:dataset";
const COLLECTION_HOST_TEXT: ReadonlySet<string> = new Set([
  "A fenced dataset cannot be archived.",
  "A fenced dataset cannot be restored in place.",
  "A newer materialization is already installed.",
  "A protected file read requires a read-only dataset operation.",
  "Active checkpoints cannot be discarded.",
  "Checkpoint callbacks must be synchronous.",
  "Checkpoint chunk integrity check failed.",
  "Checkpoint chunks are incomplete.",
  "Checkpoint chunks must be appended once, in order.",
  "Checkpoint exceeds its size limit.",
  "Checkpoint integrity check failed.",
  "Checkpoint is already active.",
  "Checkpoint is not available for activation.",
  "Checkpoint is not sealed for this dataset.",
  "Checkpoint manifest is damaged.",
  "Checkpoint revision is not available.",
  "Checkpoint stage changed or is unavailable.",
  "Checkpoint stage changed.",
  "Compiled dataset operations exceed the host limit.",
  "Dataset access is not permitted.",
  "Dataset access needs approval for the current revision.",
  "Dataset already exists at the recovery target.",
  "Dataset app binding exceeds its size limit.",
  "Dataset approval changed after migration. Reload it.",
  "Dataset approval changed during migration.",
  "Dataset approval changed. Reload it before retrying.",
  "Dataset approval or host changed.",
  "Dataset artifacts are corrupt.",
  "Dataset authority checks must be synchronous.",
  "Dataset authority is already active.",
  "Dataset authority is no longer active on this host.",
  "Dataset authority was transferred.",
  "Dataset catalog and journal approval differ.",
  "Dataset catalog is missing.",
  "Dataset changed after the migration was approved. Preview it again.",
  "Dataset changed after this preview. Preview it again.",
  "Dataset changed before preview. Preview it again.",
  "Dataset changed before the protected file was read. Retry it.",
  "Dataset changed during materialization maintenance.",
  "Dataset changed during migration. Preview it again.",
  "Dataset changed during preview. Preview it again.",
  "Dataset changed during the read. Retry it.",
  "Dataset checkpoint is invalid.",
  "Dataset checkpoint range is invalid.",
  "Dataset checkpoint write made no progress.",
  "Dataset claim changed during activation.",
  "Dataset cursor changed during checkpoint transition.",
  "Dataset cursor changed during commit.",
  "Dataset cursor changed.",
  "Dataset data grant needs approval for the current revision.",
  "Dataset export attachment count exceeds its bound.",
  "Dataset export attachment hash differs.",
  "Dataset export attachment inventory does not match its committed history.",
  "Dataset export capture must be synchronous.",
  "Dataset export checkpoint hash differs.",
  "Dataset export chunk exceeds its bound.",
  "Dataset export exceeds its storage reservation.",
  "Dataset export history blob hash differs.",
  "Dataset export history is incomplete.",
  "Dataset export pending submissions exceed their bound.",
  "Dataset export permission snapshot exceeds its bound.",
  "Dataset export was disposed.",
  "Dataset export write stopped.",
  "Dataset head changed during recovery.",
  "Dataset host callbacks must be synchronous.",
  "Dataset host closed.",
  "Dataset host is closed.",
  "Dataset host is fenced.",
  "Dataset host queue is full. Retry this operation.",
  "Dataset initialization differs from its approved state.",
  "Dataset is archived.",
  "Dataset is not initialized.",
  "Dataset lifecycle changed during restore.",
  "Dataset maintenance was cancelled.",
  "Dataset materialization is ahead of its journal.",
  "Dataset migration requires checkpoint staging quota accounting.",
  "Dataset operation expired before execution.",
  "Dataset operation expired while waiting for a worker.",
  "Dataset operation queue is full. Retry this operation.",
  "Dataset ownership path is not a regular file",
  "Dataset ownership record exceeds its limit",
  "Dataset ownership record is damaged; inspect it before cleanup",
  "Dataset recovery attachments require capture and read callbacks.",
  "Dataset recovery history is incomplete.",
  "Dataset recovery installation is not configured.",
  "Dataset recovery record exceeds its metadata bound.",
  "Dataset recovery storage is not configured.",
  "Dataset revision transition does not match the current approval.",
  "Dataset rules are already approved. Use a revision transition to change them.",
  "Dataset schema changed. Recover from its current checkpoint.",
  "Dataset was permanently deleted.",
  "Dataset worker belongs to an expired host session.",
  "Dataset worker directory is not a regular directory",
  "Dataset worker directory is outside its owned root",
  "Dataset worker manifest belongs to another session.",
  "Dataset worker ownership is busy or unavailable",
  "Dataset worker ownership is closed.",
  "Dataset worker ownership is missing or damaged; inspect it before cleanup",
  "Dataset workers are busy. Retry this operation.",
  "Discarding this checkpoint requires quota accounting.",
  "Implicit rowid access is unavailable for journaled datasets.",
  "Initial dataset revision must be 1. Schema changes require a revision transition.",
  "Invalid checkpoint chunk.",
  "Invalid checkpoint identity.",
  "Invalid checkpoint range.",
  "Invalid checkpoint size or digest.",
  "Invalid checkpoint stage page size.",
  "Invalid dataset access path.",
  "Invalid dataset data grant.",
  "Invalid dataset export attachment metadata.",
  "Invalid dataset export storage reservation.",
  "Invalid dataset identifier.",
  "Invalid dataset page size.",
  "Invalid dataset recovery",
  "Invalid dataset scope.",
  "Invalid dataset worker limit.",
  "Invalid dataset worker path.",
  "Materialization checkpoint is no longer pending.",
  "Materialization cursor changed authority or checkpoint.",
  "Materialization cursor differs from its committed worker.",
  "Materialization exceeds its reserved capacity.",
  "Materialization is truncated.",
  "Migration checkpoint differs from its source dataset.",
  "Migration checkpoint exceeds its storage reservation.",
  "Migration checkpoint is truncated.",
  "Migration preview checkpoint changed.",
  "Migration preview differs from its source dataset.",
  "Recovery checkpoint is missing.",
  "Recovery checkpoint staging is incomplete.",
  "Recovery dataset differs from the requested dataset.",
  "The Collection copy belongs to another dataset.",
  "The dataset compiler must be an installed absolute path.",
  "The operation expired while waiting for the dataset worker.",
  "Too many files in dataset operation.",
  "Transfer requires a fenced source dataset.",
  "TypeScript dataset operations require the configured host compiler.",
  "Unknown dataset ownership file; inspect it before cleanup",
  "Unknown dataset worker directory; inspect it before cleanup",
  "Unsupported dataset compiler installation.",
  "Unsupported dataset compiler version.",
  "journal write failed",
]);
// A bare code such as `invalid-input` or `EACCES`, or one that leads a message.
const RAW_CODE = /^(?:\S*[-_]\S*|[A-Z0-9]{3,})$|^[A-Z][A-Z0-9_]+: /;
const IPC_PREFIX = /^Error invoking remote method '([^']*)': /;
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
  const channel = IPC_PREFIX.exec(text)?.[1];
  text = text.replace(IPC_PREFIX, "").trim();
  const match = CLASS_PREFIX.exec(text);
  return {
    channel,
    text,
    name: match?.[1] ?? "Error",
    code: match?.[2],
    message: (match ? text.slice(match[0].length) : text).trim(),
  };
}

export interface ReadError {
  /** What a person reads, or null when only the caller's sentence applies. */
  words: string | null;
  /**
   * The words come from the map above. They say why and what to do next,
   * not what failed, so the caller's sentence goes first.
   */
  mapped: boolean;
  /** The error as it arrived, for Copy details; null when `words` says it all. */
  cause: string | null;
}

export function readError(error: unknown): ReadError {
  const { channel, text, name, code, message } = parse(error);
  const plain = name === "Error" && code === undefined;
  const entry = ERROR_WORDS[name];
  const lead = message.split(": ")[0];
  const key = entry && [message, lead, code, "*"].find(
    (candidate) => candidate !== undefined && Object.hasOwn(entry, candidate),
  );
  if (entry && key !== undefined) {
    const words = entry[key] ?? null;
    return { words, mapped: words !== null, cause: text };
  }
  if (!message) return { words: null, mapped: false, cause: null };
  if (RAW_CODE.test(message) || (channel === COLLECTION_CHANNEL && (COLLECTION_HOST_TEXT.has(message) || COLLECTION_HOST_TEXT.has(lead)))) {
    return { words: null, mapped: false, cause: plain ? message : text };
  }
  return { words: message, mapped: false, cause: plain ? null : text };
}

/** A caller's sentence, then the error's words when they add to it. */
export function withErrorWords(sentence: string, error: unknown): string {
  const { words } = readError(error);
  return words && words !== sentence && !words.startsWith(`${sentence} `)
    ? `${sentence} ${words}`
    : words || sentence;
}

/** The engine refuses reads this way while it reads a new workspace's files. */
export function isWorkspaceUpdatingError(error: unknown): boolean {
  const { name, code, message } = parse(error);
  return name === "DaemonRefusalError" && code === "OVERLOADED" &&
    ERROR_WORDS.DaemonRefusalError?.[message] === UPDATING;
}
