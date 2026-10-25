import { RESERVED_WORKSPACE_ID_TITLE } from "@dohc/workspace-core";
import type { DaemonErrorCode } from "@dohc/workspace-engine-client";

// Electron hands a rejected handler's error to the renderer as one string,
// `error.toString()`: the class survives, the code does not. `ipcWireError`
// keeps the code (`DaemonRefusalError [OVERLOADED]: …`), a wait the error
// sets (`… [dataset_reopen_wait] [retryAfterMs=5000]: …`), and the computer
// that keeps a workspace's Collections (`… [computer=Studio%20Mac]: …`), and
// `readError` turns that string back into words a person can act on.

// `null`: the error names nothing a person can act on, so the caller's own
// sentence stands alone. Copy details still carry the error as it arrived.
type Words = string | null;

export const APP_COMPILER_TIMEOUT_WORDS = "The app took too long to build. Remove files the app does not use, then try again.";

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

/**
 * The engine's refusal to open a workspace whose `.dohc`, engine folder, a
 * store file in it, or this computer's `.dohc/local` is a link, the wrong
 * kind of item, another user's, on a disk or system dohc can't check, or, on
 * Windows, has permissions dohc can't use. The message names the reason,
 * then the path from the workspace's root: one of the paths below, and
 * nothing else.
 */
const ENGINE_FOLDER_NOT_PRIVATE =
  /^engine-folder-not-private: ([a-z-]+) (\.dohc(?:\/engine(?:\/engine\.db(?:-wal|-shm|-journal)?)?|\/local)?)$/;
// What is there, and the fix that keeps everything in it. Only an item dohc
// never puts there can be moved without losing anything of dohc's.
const NOT_PRIVATE_WORDS = new Map<string, readonly [fact: string, fix: string]>([
  ["link", ["is a link", "Put what it links to in its place, then try again."]],
  ["not-folder", ["is not a folder", "Rename or move it, then try again."]],
  ["not-file", ["is not a file", "Rename or move it, then try again."]],
  ["other-owner", ["belongs to another user", "Make it yours again, then try again."]],
  ["unchecked-volume", ["is on a disk dohc can't check", "Move the workspace to a disk formatted as APFS, then try again."]],
  ["not-changeable", ["has permissions dohc can't use", "Give your account full control of this folder and everything in it, then try again."]],
  ["unchecked-system", ["is on a system where dohc can't check it", "Run dohc where it can read its own /proc/self/fd, then try again."]],
]);
// What `sudo` makes in a folder is another user's too, so a folder's fix
// covers everything in it.
const OTHER_OWNER_FOLDER_FIX = "Make it and everything in it yours again, then try again.";

/** What keeps a workspace's History, or this computer's own data, from being private, and what to do. */
function engineFolderNotPrivateWords(message: string): string | null {
  const [, reason = "", path] = ENGINE_FOLDER_NOT_PRIVATE.exec(message) ?? [];
  const words = NOT_PRIVATE_WORDS.get(reason);
  if (words === undefined) return null;
  const [fact, fix] = words;
  const folder = path === ".dohc" || path === ".dohc/engine" || path === ".dohc/local";
  const fixed = reason === "other-owner" && folder ? OTHER_OWNER_FOLDER_FIX : fix;
  const kept = path === ".dohc/local" ? "this computer's own data" : "its History";
  return `This workspace's ${path} ${fact}, so dohc can't keep ${kept} private. ${fixed}`;
}

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

const CHAT_MENTION_PAGE_CHANGED_WORDS = {
  "chat-mention-access-changed": "Chat access changed. Try again.",
  "chat-mention-version-changed": ENGINE_CODE_WORDS.CONFLICT,
} as const;

// The one map from an error's class, then its message or code, to words. A
// class listed here writes its messages for developers, so none of them
// reaches a person. Keys are tried in order: the message, the message before
// its first ": " (where it names a path or a detail), the code, then "*".
export const ERROR_WORDS: Readonly<Record<string, Readonly<Record<string, Words>>>> = {
  DaemonRefusalError: {
    ...ENGINE_CODE_WORDS,
    ...CHAT_MENTION_PAGE_CHANGED_WORDS,
    "Workspace is still updating. Try again.": UPDATING,
    "History is still updating. Try again.": UPDATING,
    "dohc has not read this file yet. Open it again once dohc has read it.": NOT_READ,
    "file-locked": "Another program has this file open. Close it there, then try again.",
    "ydoc-session-busy": "This file is open for editing. Close its tabs, then try again.",
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
  AppCompilerTimeoutError: { "*": APP_COMPILER_TIMEOUT_WORDS },
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
  // A file from another person that dohc could not prepare to open in
  // another app. Its message is the system's own, for Copy details only.
  MarkedCopyError: { "*": null },
  // The file system's codes. A plain error with no listed code keeps its
  // message, because dohc writes those for people.
  Error: {
    ...CHAT_MENTION_PAGE_CHANGED_WORDS,
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
// Data, such as the JSON a validation error sends as its message, or a stack.
// A sentence can start with a bracket, as a button named "[Send]" does.
function isDump(message: string): boolean {
  if (message.includes("\n")) return true;
  if (!/^[[{]/.test(message)) return false;
  try { return typeof JSON.parse(message) === "object"; } catch { return false; }
}
const IPC_PREFIX = /^Error invoking remote method '[^']*': /;
const CLASS_PREFIX = /^((?:[A-Z][A-Za-z0-9]*)?Error)(?: \[([^\]\s]+)\])?(?: \[retryAfterMs=(\d{1,15})\])?(?: \[computer=([^\]\s]+)\])?: /;

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

// The name of the computer that keeps a workspace's Collections, as a Collections refusal sets it.
function computerLabelOf(error: Error): string | null {
  const value: unknown = Reflect.get(error, "computerLabel");
  return typeof value === "string" && value !== "" ? value : null;
}

// The class, the code, the wait, and the computer, as the wire carries them before the message.
function wireName(error: Error, code: string): string {
  const wait = retryAfterOf(error), computer = computerLabelOf(error);
  return `${error.name} [${code}]${wait === null ? "" : ` [retryAfterMs=${wait}]`}${computer === null ? "" : ` [computer=${encodeURIComponent(computer)}]`}`;
}

// A name that does not decode names no computer.
function decodedComputer(wire: string | undefined): string | null {
  if (wire === undefined) return null;
  try { return decodeURIComponent(wire) || null; } catch { return null; }
}

/** Main's IPC boundary: keeps the error's code, wait and computer in the one string Electron sends. */
export function ipcWireError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = codeOf(error);
  // Electron sends only toString(). Keep safe compiler facts in Copy details,
  // while readError maps this name back to the unchanged sentence above.
  const details: unknown = error.name === "AppCompilerTimeoutError"
    ? Reflect.get(error, "details") : undefined;
  if (code === null && typeof details !== "string") return error;
  const wire = new Error(`${error.message}${typeof details === "string" ? `\n${details}` : ""}`, { cause: error });
  wire.name = code === null ? error.name : wireName(error, code);
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
    computer: decodedComputer(match?.[4]),
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
  const notPrivate = name === "DaemonRefusalError" ? engineFolderNotPrivateWords(message) : null;
  if (notPrivate !== null) return { words: notPrivate, mapped: true, cause: text };
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
  if (RAW_CODE.test(message) || isDump(message)) {
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

/**
 * Why this computer cannot use a workspace's Collections: no computer keeps
 * them yet, another one keeps them, dohc cannot read which one, the store
 * this computer keeps is not there or was replaced, or the record changed
 * while dohc wrote it.
 */
export const COLLECTIONS_REFUSAL_KINDS = ["unclaimed", "elsewhere", "unreadable", "missing", "replaced", "changed"] as const;
/** Refusals that keeping the Collections here can answer, after the person confirms where needed. */
export const KEEPABLE_COLLECTIONS_REFUSALS: readonly CollectionsRefusalKind[] = ["unclaimed", "elsewhere"];
export type CollectionsRefusalKind = typeof COLLECTIONS_REFUSAL_KINDS[number];
export const COLLECTIONS_REFUSAL_CODE = "collections-";
/** The control that keeps a workspace's Collections on this computer. */
export const USE_THIS_COMPUTER = "Use this computer";

/**
 * Where another computer keeps a workspace's Collections, and the two ways
 * on. `others`: this computer lists some of them from its server.
 */
export function collectionsElsewhereWords(computer: { label: string; sameName: boolean }, others = false): string {
  const where = computer.sameName ? `${computer.label}, another installation of dohc with this computer's name` : computer.label;
  return `${others ? "Other" : "These"} Collections are on ${where}. Open this workspace there to use them, or to move them to a server.`;
}

/**
 * The computer that keeps the Collections this computer doesn't list, whether
 * it lists others, and the sentence that says so. `computer` is null when the
 * error that said so named none.
 */
export interface CollectionsElsewhere { computer: string | null; others: boolean; words: string }

/**
 * The code of a Collections list this computer's server didn't give, where
 * another computer keeps the workspace's own Collections.
 */
export const SERVER_COLLECTIONS_UNAVAILABLE = "server-collections-unavailable";

/**
 * main's words for that list: on the first line, where the workspace's
 * Collections are. After it, the server's error, which reads as it would alone.
 */
export function readServerCollectionsUnavailable(error: unknown): { elsewhere: string; computer: string | null; failure: string } | null {
  const { name, code, computer, message } = parse(error);
  if (name !== "ServerCollectionsUnavailableError" || code !== SERVER_COLLECTIONS_UNAVAILABLE) return null;
  const [elsewhere = "", ...failure] = message.split("\n");
  return elsewhere ? { elsewhere, computer, failure: failure.join("\n") } : null;
}

/**
 * main's refusal to use a workspace's Collections here, with its words.
 * Another computer's refusal names it, or null when the error named none.
 */
export type CollectionsRefusalRead =
  | { kind: Exclude<CollectionsRefusalKind, "elsewhere">; words: string }
  | { kind: "elsewhere"; words: string; computer: string | null };

export function readCollectionsRefusal(error: unknown): CollectionsRefusalRead | null {
  const { name, code, computer, message } = parse(error);
  if (name !== "CollectionsRefusalError" || !code?.startsWith(COLLECTIONS_REFUSAL_CODE) || !message) return null;
  const kind = COLLECTIONS_REFUSAL_KINDS.find((candidate) => code === `${COLLECTIONS_REFUSAL_CODE}${candidate}`);
  if (kind === "elsewhere") return { kind, words: message, computer };
  return kind === undefined ? null : { kind, words: message };
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

/** Main refused to run an app's code because the workspace is in Restricted Mode. */
export function isWorkspaceRestricted(error: unknown): boolean {
  return parse(error).name === "WorkspaceRestrictedError";
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

/** A chat page cursor lost its access or version binding. Restart the walk once. */
export function isChatMentionPageChanged(error: unknown): boolean {
  const { name, code, message } = parse(error);
  return ((name === "DaemonRefusalError" && code === "CONFLICT") || (name === "Error" && code === undefined)) &&
    Object.hasOwn(CHAT_MENTION_PAGE_CHANGED_WORDS, message);
}

export function isCaptureFileHeldRefusal(error: unknown): boolean {
  const { name, code, message } = parse(error);
  return name === "DaemonRefusalError" && code === "CONFLICT" && message.startsWith("capture-file-held: ");
}

// A note changed outside dohc closed, but capture has not recorded the new
// version, so the note did not open again. Try again sits beside it.
export function outsideVersionWaitingMessage(path: string): string {
  return `dohc could not open the new version of "${path}". History has not recorded it yet.`;
}

// Capture holds every refused outside edit with one reason, so these words
// name each form it refuses. Restoring the file's earlier bytes lets capture record it again.
export const CAPTURE_HELD_WORDS = "dohc cannot take in this file's Markdown. Causes include nested lists in workspaces that sync, or deeply nested quotes. The file on this computer still has the outside edit. Restore the file's exact contents from before that edit. For nested lists, make the edit in dohc after the file opens again.";

export function captureHeldLiveMessage(path: string): string {
  return `dohc cannot open "${path}" for live editing. ${CAPTURE_HELD_WORDS}`;
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
