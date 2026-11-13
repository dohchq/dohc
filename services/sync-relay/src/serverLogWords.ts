import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import {
  ENGINE_CLIENT_ERROR_CODES,
  EngineClientError,
  EngineRequestError,
} from "@dohc/workspace-engine-client/daemon";
import { RelayError } from "./errors";

/**
 * The words the server may show for a refusal or failure, in its log and to a document's owner. Nothing else from an
 * error reaches either, since an error's message can name a file.
 */
export const KNOWN_REFUSAL_WORDS = [
  // Why a live document's activation keeps failing, when no engine code word says more.
  "activation-refused",
  "capture-over-budget",
  "deadline",
  "engine-refused",
  "relay-error",
] as const;
export type KnownRefusalWord = (typeof KNOWN_REFUSAL_WORDS)[number];

const known: ReadonlySet<string> = new Set(KNOWN_REFUSAL_WORDS);

/** The list's word for a refusal's head, if the list has it. */
export function knownRefusalWord(head: string): KnownRefusalWord | undefined {
  return known.has(head) ? (head as KnownRefusalWord) : undefined;
}

/** An engine refusal message's head: the part before the first ": ". The rest can name a file. */
export function refusalHead(message: string): string {
  return message.split(": ", 1)[0]!;
}

// The engine's code-word form: lowercase words joined by hyphens, with no space, dot or slash, so no file name with an
// extension and no folder fits it. The engine adds code words with each new refusal, so a list here would fall behind.
const CODE_WORD = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The engine's wire codes, such as CONFLICT, and the relay's request methods, such as live.apply.
const WIRE_CODE = /^[A-Z][A-Z_]{0,39}$/;
const METHOD = /^[a-zA-Z][a-zA-Z0-9._]{0,63}$/;

/** The value when it has the engine's code-word form. */
export function codeWord(value: unknown): string | undefined {
  return typeof value === "string" && CODE_WORD.test(value) ? value : undefined;
}

/**
 * An engine refusal's words for a log: its code word, the part of its message before the first ": ", and only when that
 * part has the code-word form; the rest can name a file.
 */
export function engineRefusalWords(
  message: string,
  code: string | undefined,
  method?: string,
): string {
  const word = codeWord(refusalHead(message)) ?? "unrecognized-message";
  const wire = code === undefined || WIRE_CODE.test(code) ? code : "unrecognized";
  const shownMethod =
    method === undefined ? "" : `, method ${METHOD.test(method) ? method : "unrecognized"}`;
  return `${word} (code ${wire}${shownMethod})`;
}

/** A relay failure whose message holds only fixed words, code words and ids, so the server log shows it whole. */
export class ServerLogError extends Error {
  override readonly name = "ServerLogError";
}

const ERROR_CLASSES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "EngineClientError",
  "EngineRequestError",
  "DaemonRefusalError",
  "RelayError",
  "DatabaseError",
  "LiveValidatorFailure",
]);

/** The class of a failure for the server log: a known class name, else `Error`. */
export function serverLogClass(name: unknown): string {
  return typeof name === "string" && ERROR_CLASSES.has(name) ? name : "Error";
}

// Node's codes for a failed system call, socket or child process. The message beside one names its path.
const SYSTEM_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EAGAIN",
  "EBADF",
  "EBUSY",
  "ECANCELED",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EHOSTUNREACH",
  "EINVAL",
  "EIO",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENAMETOOLONG",
  "ENETUNREACH",
  "ENFILE",
  "ENOENT",
  "ENOMEM",
  "ENOSPC",
  "ENOTCONN",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTSUP",
  "EPERM",
  "EPIPE",
  "EROFS",
  "ESRCH",
  "ETIMEDOUT",
  "EXDEV",
  "ABORT_ERR",
  "ERR_IPC_CHANNEL_CLOSED",
  "ERR_OUT_OF_RANGE",
  "ERR_SQLITE_ERROR",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
  ...ENGINE_CLIENT_ERROR_CODES,
]);
// SQLite's result code names and Postgres's SQLSTATE codes come from their fixed tables.
const FIXED_TABLE_CODE = /^(?:SQLITE_[A-Z_]{1,40}|[0-9A-Z]{5})$/;

/** A failure's code for the server log: a known system, engine client, SQLite or Postgres code, else nothing. */
export function serverLogCode(code: unknown): string | undefined {
  return typeof code === "string" && (SYSTEM_CODES.has(code) || FIXED_TABLE_CODE.test(code))
    ? code
    : undefined;
}

/**
 * The server log's words for a caught value. An engine refusal shows its `engineRefusalWords`; a relay refusal its
 * code; anything else its class and a known code. It never shows a message, stack, cause or path, since each can
 * name a file, except a `ServerLogError`'s message.
 */
export function serverLogLine(error: unknown): string {
  if (error instanceof ServerLogError) return `${error.name}: ${error.message}`;
  if (error instanceof EngineRequestError) {
    return `EngineRequestError: ${engineRefusalWords(error.message, error.wireError?.code, error.method)}`;
  }
  if (error instanceof DaemonRefusalError) {
    const method = error.cause instanceof EngineRequestError ? error.cause.method : undefined;
    return `DaemonRefusalError: ${engineRefusalWords(error.message, error.wireCode, method)}`;
  }
  if (error instanceof RelayError) return `RelayError: ${error.code}`;
  if (!(error instanceof Error)) return `thrown ${error === null ? "null" : typeof error}`;
  const fault = error as Error & { code?: unknown; errcode?: unknown };
  const name = serverLogClass(
    error instanceof EngineClientError ? "EngineClientError" : error.name,
  );
  const code = serverLogCode(fault.code);
  const errcode = Number.isSafeInteger(fault.errcode)
    ? ` (errcode ${fault.errcode as number})`
    : "";
  return code === undefined ? name : `${name}: ${code}${errcode}`;
}

// The engine's own line for an internal refusal: its wire code and code word. See internal_refusal in
// crates/dohc-workspace-engine/src/rpc/error.rs.
const ENGINE_REFUSAL_LINE = /^engine: internal refusal: [A-Z][A-Z_]{0,39} [a-z0-9][a-z0-9-]{0,63}$/;
const MAX_STDERR_LINE_CHARS = 4096;

/**
 * Reads a child process's stderr into the server log. Only the engine's internal refusal lines pass. Any other line
 * can name a file, so the log shows how many were withheld. It never throws, so the engine client never logs a chunk
 * whole in its place.
 */
export function childStderrLog(
  label: string,
  log: (line: string) => void = (line) => console.error(line),
): (text: string) => void {
  let carry = "",
    skipping = false;
  return (text) => {
    try {
      let withheld = 0;
      if (skipping) {
        const end = text.indexOf("\n");
        if (end < 0) return;
        skipping = false;
        text = text.slice(end + 1);
      }
      const lines = (carry + text).split("\n");
      carry = lines.pop()!;
      if (carry.length > MAX_STDERR_LINE_CHARS) {
        withheld++;
        carry = "";
        skipping = true;
      }
      for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (ENGINE_REFUSAL_LINE.test(line)) log(`${label} ${line}`);
        else if (line.trim() !== "") withheld++;
      }
      if (withheld > 0)
        log(
          `${label} withheld ${withheld} stderr ${withheld === 1 ? "line" : "lines"} that can name files.`,
        );
    } catch {
      /* Reporting must not stop the engine's output. */
    }
  };
}
