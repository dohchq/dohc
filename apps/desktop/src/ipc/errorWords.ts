import { RESERVED_WORKSPACE_ID_TITLE } from "@dohc/workspace-core";
import type { DaemonErrorCode } from "@dohc/workspace-engine-client";

// Electron hands a rejected handler's error to the renderer as one string,
// `error.toString()`: the class survives, the code does not. `ipcWireError`
// keeps the code (`DaemonRefusalError [OVERLOADED]: …`), and a wait the error
// sets (`… [dataset_reopen_wait] [retryAfterMs=5000]: …`), and `readError`
// turns that string back into words a person can act on.

// `null`: the error names nothing a person can act on, so the caller's own
// sentence stands alone. Copy details still carry the error as it arrived.
type Words = string | null;

const UPDATING = "dohc is still reading this workspace's files. Try again when it finishes.";
const NOT_READ = "dohc has not read this file yet. Try again when it has.";
const TOO_LARGE = "It is too large.";
const UNREADABLE_ANSWER = "The server sent an answer dohc could not read. Try again later.";
const CONTENT_MISSING = "Some file contents are missing on the server.";
const STOPPED = "It stopped before it finished. Try again.";
const REINSTALL = "This copy of dohc is missing a file it needs. Reinstall dohc.";
// Trying again cannot help with this one; updating dohc can.
const NEWER_DOHC = "It needs a newer version of dohc. Update dohc to open it.";

/**
 * The code of macOS refusing dohc a folder the person has not allowed in
 * Privacy & Security. The engine sends it as a refusal's message; main sets
 * it on a file system error (`privacyDenial.ts`).
 */
export const PRIVACY_DENIED = "privacy-denied";
export const PRIVACY_DENIED_WORDS =
  "macOS blocked dohc from this folder. Allow dohc in System Settings › Privacy & Security › Files & Folders.";

/**
 * The engine's refusal when a volume gives a new file sharing permissions it
 * was created without, as a network share can, so a secret or a file's own
 * access could not be kept.
 */
export const VOLUME_SHARES_NEW_FILES_WORDS =
  "The disk this workspace is on adds sharing permissions to new files, so dohc can't keep this file private. Move the workspace to a disk on this Mac.";

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
  RELAY_HTTPS_REQUIRED: "Your server's address does not use https. Disconnect, then connect your server again with its https address.",
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
    "dohc has not read this file yet. Open it again once dohc has read it.": NOT_READ,
    "file-locked": "Another program has this file open. Close it there, then try again.",
    "volume-shares-new-files": VOLUME_SHARES_NEW_FILES_WORDS,
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
  // The process that holds a Collection's records. A failed action's message
  // can carry SQLite's own text, so only these codes reach a person.
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
  // A restore History's current rules refuse. An unreadable rules file's
  // message leads with the files dohc can't read, then the parser's own text,
  // which only Copy details carry. "It" is dohc, the caller's sentence's actor.
  RestorePolicyRefusalError: {
    ".dohc/files.toml": "It can't read .dohc/files.toml. Fix the file, then try again.",
    ".dohc/visibility.toml": "It can't read .dohc/visibility.toml. Fix the file, then try again.",
    ".dohc/files.toml and .dohc/visibility.toml":
      "It can't read .dohc/files.toml and .dohc/visibility.toml. Fix the files, then try again.",
    ".dohc": "It can't read this workspace's .dohc folder. Fix the folder, then try again.",
    "path-not-admitted": "History no longer tracks this file. Track it in .dohc/files.toml, then try again.",
    "*": null,
  },
  // A .dohc/manifest.json dohc will not adopt. Its message names the
  // parser's reason, for Copy details only. "Its" and "it" are the folder
  // the caller's sentence names.
  WorkspaceManifestError: {
    unreadable: "dohc can't read its .dohc/manifest.json. Fix the file, then try again.",
    "newer-version": NEWER_DOHC,
    "*": null,
  },
  // The file system's codes. A plain error with no listed code keeps its
  // message, because dohc writes those for people.
  Error: {
    EACCES: "dohc does not have permission to use this file or folder.",
    EPERM: "dohc does not have permission to use this file or folder.",
    ENOENT: "The file or folder is not there anymore.",
    EBUSY: "Another program is using this file or folder.",
    // Import to SQLite never replaces a file. The caller's sentence names
    // the database's path.
    "Database already exists": "That file already exists. Rename or move it, then try again.",
  },
  TypeError: { "*": null },
  RangeError: { "*": null },
  ReferenceError: { "*": null },
  SyntaxError: { "*": null },
  ZodError: { "*": null },
};

// When nothing else applies and no caller said what failed.
export const UNKNOWN_ERROR_WORDS = "dohc could not finish that.";

// A bare code such as `invalid-input` or `EACCES`, or one that leads a message.
const RAW_CODE = /^(?:\S*[-_]\S*|[A-Z0-9]{3,})$|^[A-Z][A-Z0-9_]+: /;
const IPC_PREFIX = /^Error invoking remote method '[^']*': /;
const CLASS_PREFIX = /^((?:[A-Z][A-Za-z0-9]*)?Error)(?: \[([^\]\s]+)\])?(?: \[retryAfterMs=(\d{1,15})\])?: /;

// The engine client's `wireCode`, the dataset worker's `code`, the compiler's
// `reason`.
function codeOf(error: Error): string | null {
  for (const field of ["wireCode", "code", "reason"]) {
    const value: unknown = Reflect.get(error, field);
    if (typeof value === "string" && /^[A-Za-z][\w-]{0,63}$/.test(value)) return value;
  }
  return null;
}

// How long the error says to wait before trying again, as a Collection's dataset worker sets it.
function retryAfterOf(error: Error): number | null {
  const value: unknown = Reflect.get(error, "retryAfterMs");
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

// The class, the code, and the wait, as the wire carries them before the message.
function wireName(error: Error, code: string): string {
  const wait = retryAfterOf(error);
  return `${error.name} [${code}]${wait === null ? "" : ` [retryAfterMs=${wait}]`}`;
}

/** Main's IPC boundary: keeps the error's code and wait in the one string Electron sends. */
export function ipcWireError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = codeOf(error);
  if (code === null) return error;
  const wire = new Error(error.message, { cause: error });
  wire.name = wireName(error, code);
  return wire;
}

function parse(error: unknown) {
  let text = "";
  if (typeof error === "string") text = error;
  else if (error instanceof Error) {
    const code = codeOf(error);
    text = error.name === "Error" && code === null
      ? error.message
      : `${code === null ? error.name : wireName(error, code)}: ${error.message}`;
  }
  text = text.replace(IPC_PREFIX, "").trim();
  const match = CLASS_PREFIX.exec(text);
  return {
    text,
    name: match?.[1] ?? "Error",
    code: match?.[2],
    retryAfterMs: match?.[3] === undefined ? undefined : Number(match[3]),
    message: (match ? text.slice(match[0].length) : text).trim(),
  };
}

export interface ReadError {
  title?: string;
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
  const { text, name, code, message } = parse(error);
  if (code === PRIVACY_DENIED || (name === "DaemonRefusalError" && message === PRIVACY_DENIED)) {
    return { words: PRIVACY_DENIED_WORDS, mapped: true, cause: text };
  }
  if (name === "DaemonRefusalError" && message.startsWith("capture-file-held: ")) {
    const path = message.slice("capture-file-held: ".length);
    return { words: captureHeldLiveMessage(path), mapped: false, cause: text };
  }
  if (name === "ReservedWorkspaceIdError") {
    return { title: RESERVED_WORKSPACE_ID_TITLE, words: message, mapped: false, cause: text };
  }
  if (name === "DaemonRefusalError" && code === "INVALID_PARAMS" && [
    "Each choice is one line of at most 200 characters.",
    "Each choice appears once.",
  ].includes(message)) {
    return { words: message, mapped: false, cause: text };
  }
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
  if (RAW_CODE.test(message)) {
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

/** A Collection that waits before it reopens, because reopening it kept failing: the supervisor's words and its wait. */
export function readCollectionReopenWait(error: unknown): { words: string; waitMs: number } | null {
  const { name, code, retryAfterMs, message } = parse(error);
  return name === "DatasetReopenWaitError" && code === "dataset_reopen_wait" && retryAfterMs !== undefined
    ? { words: message, waitMs: retryAfterMs } : null;
}

/** macOS refused dohc a folder: System Settings, not dohc, can fix it. */
export function isPrivacyDenied(error: unknown): boolean {
  return readError(error).words === PRIVACY_DENIED_WORDS;
}

/** The volume adds sharing permissions to new files, so dohc refused to write one. */
export function isVolumeSharesNewFiles(error: unknown): boolean {
  return readError(error).words === VOLUME_SHARES_NEW_FILES_WORDS;
}

/** A refusal only a newer dohc can get past, so Try again would do nothing. */
export function needsNewerDohc(error: unknown): boolean {
  return readError(error).words === NEWER_DOHC;
}

/** The engine refuses reads this way while it reads a new workspace's files. */
export function isWorkspaceUpdatingError(error: unknown): boolean {
  const { name, code, message } = parse(error);
  return name === "DaemonRefusalError" && code === "OVERLOADED" &&
    ERROR_WORDS.DaemonRefusalError?.[message] === UPDATING;
}

/** A share's refusal of a write: the file is read-only inside dohc, not on disk. */
export function isShareReadOnlyRefusal(error: unknown): boolean {
  const { name, code } = parse(error);
  return name === "SharedFileReadOnlyError" || (name === "DaemonRefusalError" && code === "SHARE_READ_ONLY");
}

/** The engine refuses to move, delete or restore a shared live file this way. */
export function isSharedLiveFileRefusal(error: unknown): boolean {
  return parse(error).name === "LiveDocumentMutationError";
}

export function isCaptureFileHeldRefusal(error: unknown): boolean {
  const { name, code, message } = parse(error);
  return name === "DaemonRefusalError" && code === "CONFLICT" && message.startsWith("capture-file-held: ");
}

export function captureHeldLiveMessage(path: string): string {
  return `dohc cannot open "${path}" for live editing. dohc cannot represent part of the file, such as a very deeply nested quote. The file is unchanged on this computer. Change that part in another editor.`;
}

/** Access and connection failures can hide a changed grant behind an IPC error. */
export function shouldRecheckShareAccess(error: unknown): boolean {
  const { name, code, message } = parse(error);
  if (["RelayUnauthorizedError", "RelayClaimRefusedError", "RelayWorkspaceUnavailableError",
    "RelayUnreachableError", "SharedFileReadOnlyError", "ShareUnavailableError", "TimeoutError", "NetworkError"].includes(name)) return true;
  if (name === "DaemonRefusalError" && code !== undefined &&
    ["AUTH_FAILED", "FORBIDDEN", "SHARE_UNAVAILABLE", "SHARE_READ_ONLY", "SHARE_OPERATION_REJECTED",
      "SESSION_EXPIRED", "WORKSPACE_UNAVAILABLE", "IDENTITY_NOT_RECOGNIZED"].includes(code)) return true;
  return /\b(?:unauthorized|forbidden|authorization failed|does not have Edit access|access to this share (?:ended|changed)|shared file session changed|share is no longer available|network (?:error|request failed|failure)|fetch failed|failed to fetch|ECONN\w*|ENOTFOUND|ETIMEDOUT)\b|Share request failed \((?:401|403|404)\)/i.test(message);
}
