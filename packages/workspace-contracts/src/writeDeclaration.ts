import type { z } from "zod";
import type { EnvelopeField, McpAccessLevel } from "./operationDeclaration";

// What a caller sends to one door. The type refuses a shape that names an
// envelope field, and allWriteDeclarations.ts refuses one at load.
type Fields = z.ZodObject<
  Readonly<Record<string, z.core.$ZodType>> & { readonly [Field in EnvelopeField]?: never }
>;

// The socket's rule for a request from a folder others share with you: it runs,
// is refused as an owner or a chat command, or gives the answer cliServer.ts
// keeps for the verb.
const RECEIVED_SHARE_RULES = ["anywhere", "owner", "chat", "own-answer"] as const;
// The socket's rule for a read-only shared view. A "refuse-…" rule refuses with
// that kind's sentence before the workspace opens. "handler-decides" opens the
// workspace, and the handler refuses or runs.
const READ_ONLY_RULES = [
  "refuse-chat",
  "refuse-document",
  "refuse-collection",
  "refuse-file",
  "handler-decides",
] as const;
// Whether a request may name the agent run it belongs to. The socket records a
// run proven by its secret as the agent, and lets it write only in its own workspace.
const RUN_RULES = ["may-name-its-run", "never-a-run"] as const;
// Whether the socket resolves the caller's folder before the handler runs, and
// refuses a folder it cannot resolve.
const PATH_RULES = ["from-callers-folder", "none"] as const;

export interface SocketAdmission {
  readonly receivedShare: (typeof RECEIVED_SHARE_RULES)[number];
  readonly readOnlyWorkspace: (typeof READ_ONLY_RULES)[number];
  readonly run: (typeof RUN_RULES)[number];
  readonly paths: (typeof PATH_RULES)[number];
}
export const ADMISSION_RULES = {
  receivedShare: RECEIVED_SHARE_RULES,
  readOnlyWorkspace: READ_ONLY_RULES,
  run: RUN_RULES,
  paths: PATH_RULES,
} as const satisfies { readonly [Rule in keyof SocketAdmission]: readonly SocketAdmission[Rule][] };

// A door that does not offer the write says why.
interface NoDoor {
  readonly none: string;
}

// One command that changes data, as each door offers it: the window's IPC row,
// the CLI socket verb with its admission rules, the public CLI command, and the
// desktop MCP tool. Those entries derive from it. The IPC handler, the socket
// handler, the CLI parser, and the CLI's printed line stay hand-written, and
// each handler keeps its own checks. The doors take different inputs on
// purpose: the window names a run, and an agent names a thread.
export interface WriteDeclaration {
  readonly access: "write";
  readonly capabilityId: string;
  // The row takes the declaration's key as its name, adds the workspace, and
  // always runs in the sending window's active workspace.
  readonly ipc:
    | {
        readonly channel: `desktop:${string}`;
        readonly input: Fields;
        readonly result: z.ZodType;
        readonly inactiveMessage: string;
      }
    | NoDoor;
  // The verb the public CLI command and the MCP tool both send.
  readonly socket: {
    readonly verb: string;
    readonly input: Fields;
    readonly result: z.ZodType;
    // Each rule is required and comes from its list above.
    readonly admission: SocketAdmission;
  };
  readonly cli:
    | {
        readonly command: readonly [group: string, name: string];
        readonly summary: string;
        readonly operands: string;
        readonly notes?: readonly string[];
        // Arguments after the command that reach the socket; the CLI inventory parses them.
        readonly example: readonly string[];
      }
    | NoDoor;
  readonly mcp:
    | {
        readonly tool: string;
        readonly description: string;
        // The share levels at which the MCP server registers the tool, and why only those.
        readonly levels: readonly McpAccessLevel[];
        readonly reason: string;
        // What the tool takes, when that is not the socket's input. tools.ts
        // then turns it into the socket's input by hand.
        readonly input?: Fields;
      }
    | NoDoor;
}

export type WriteFamily = Readonly<Record<string, WriteDeclaration>>;
