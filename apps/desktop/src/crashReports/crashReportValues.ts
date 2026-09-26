import { constants as osConstants } from "node:os";
import * as dns from "node:dns";
import { DAEMON_ERROR_CODES } from "@dohc/workspace-engine-client";
import { ENGINE_CLIENT_ERROR_CODES } from "@dohc/workspace-engine-client/daemon";

// The only values a crash report copies from an error. Each comes from a
// fixed list, never from the shape of the text, so a field that holds a
// person's words or a secret is withheld however it looks.

export const ERROR_NAMES: ReadonlySet<string> = new Set([
  // JavaScript and the web platform.
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError",
  "AggregateError", "AbortError", "TimeoutError", "DOMException",
  // dohc's engine client.
  "EngineDaemonUnavailableError", "EngineClientError", "EngineRequestError", "EngineRequestDeadlineError",
  "EngineWorkspaceRebindError", "EngineWorkspaceRebuildingError", "EngineWorkspaceRetryDeadlineError",
  "EngineWorkspaceShuttingDownError", "DaemonClientCapabilityError", "DaemonProtocolError",
  "DaemonRefusalError", "ProtocolShapeError", "YdocAdapterError", "YdocOwnerDraftPendingError",
  "VersionedAdapterCapabilityError", "ChatsAdapterCapabilityError", "OwnerYDocOutboxReadChangedError",
]);

// Node's system error codes as this Node knows them, its DNS codes, the
// Node, fetch, and TLS codes a desktop main process meets, and the engine's.
export const ERROR_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(osConstants.errno),
  ...Object.values(dns as Record<string, unknown>)
    .filter((value): value is string => typeof value === "string" && /^E[A-Z]+$/.test(value)),
  "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_OUT_OF_RANGE", "ERR_INVALID_STATE", "ERR_INVALID_URL",
  "ERR_ASSERTION", "ERR_UNHANDLED_ERROR", "ERR_USE_AFTER_CLOSE", "ERR_MODULE_NOT_FOUND", "ERR_REQUIRE_ESM",
  "ERR_STREAM_DESTROYED", "ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_WRITE_AFTER_END", "ERR_STREAM_PUSH_AFTER_EOF",
  "ERR_SOCKET_CLOSED", "ERR_SOCKET_CONNECTION_TIMEOUT", "ERR_HTTP_HEADERS_SENT", "ERR_IPC_CHANNEL_CLOSED",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ERR_SERVER_NOT_RUNNING", "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_WORKER_OUT_OF_MEMORY", "ERR_STRING_TOO_LONG", "ERR_BUFFER_OUT_OF_BOUNDS",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "UND_ERR_ABORTED", "UND_ERR_CLOSED", "UND_ERR_DESTROYED",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  ...ENGINE_CLIENT_ERROR_CODES,
  ...DAEMON_ERROR_CODES,
]);

// The engine's refusal codes, the only values a `wireCode` may carry.
export const WIRE_CODES: ReadonlySet<string> = new Set(DAEMON_ERROR_CODES);

export const SYSCALLS: ReadonlySet<string> = new Set([
  "open", "close", "read", "write", "stat", "lstat", "fstat", "mkdir", "rmdir", "rm", "rename", "unlink",
  "readdir", "scandir", "opendir", "access", "chmod", "chown", "copyfile", "cp", "realpath", "readlink",
  "symlink", "link", "utime", "futime", "fsync", "fdatasync", "ftruncate", "mkdtemp", "watch",
  "spawn", "spawnSync", "kill", "connect", "listen", "bind", "accept", "getaddrinfo", "getnameinfo",
  "queryA", "queryAaaa", "shutdown", "uv_os_homedir", "uv_os_get_passwd", "uv_cwd",
]);

export const SIGNALS: ReadonlySet<string> = new Set(Object.keys(osConstants.signals));
