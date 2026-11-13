import type { z } from "zod";

export type McpAccessLevel = "owner" | "view" | "comment" | "edit";

// The fields a door sets around a declared input: the CLI request and its args
// (requestBase and argsBase in packages/cli/src/protocol.ts), and the IPC row's
// workspace. An input that named one could let a caller replace the value the
// server sets.
export const ENVELOPE_FIELDS = ["token", "protocolVersion", "door", "runSecret", "cwd", "actor", "agentId", "workspaceId"] as const;
export type EnvelopeField = (typeof ENVELOPE_FIELDS)[number];

// One read as each door offers it: the window's IPC row, the public CLI
// command and its socket verb, and the desktop MCP tool. Those entries derive
// from it; the CLI parser, socket reader, and IPC handler stay hand-written.
// The IPC row always runs in the sending window's active workspace, and the
// CLI socket keeps its own workspace and received-share rules. mcp.levels
// decides at which share levels the MCP server registers the tool, and a
// socket request carries no share level. Declarations import only contract
// schemas, so the preload can load them.
export interface OperationDeclaration {
  readonly capabilityId: string;
  // Only reads are declared. The CLI socket gives a declared verb no write
  // admission and its reader no actor. The type refuses another access, and
  // allDeclarations.ts refuses one hidden by a cast when it loads.
  readonly access: "read";
  // What every caller sends. The IPC row adds the workspace. The type refuses a
  // shape that names an envelope field, and allDeclarations.ts refuses one at load.
  readonly input: z.ZodObject<Readonly<Record<string, z.core.$ZodType>> & { readonly [Field in EnvelopeField]?: never }>;
  readonly result: z.ZodType;
  readonly ipc: {
    readonly channel: `desktop:${string}`;
    readonly inactiveMessage: string;
    // What main parses before it replies, when that is not result.
    readonly result?: z.ZodType;
  };
  readonly cli: {
    readonly verb: string;
    readonly command: readonly [group: string, name: string];
    readonly summary: string;
    readonly operands: string;
    readonly flags?: readonly { readonly name: string; readonly value?: string; readonly text: string }[];
    // The socket's refusal when the app offers no reader for the verb.
    readonly unavailable: string;
    // Arguments after the command that reach the socket; the CLI inventory parses them.
    readonly example: readonly string[];
  };
  readonly mcp: {
    readonly tool: string;
    readonly description: string;
    readonly levels: readonly McpAccessLevel[];
  };
}

export type OperationFamily = Readonly<Record<string, OperationDeclaration>>;

export const EVERY_MCP_LEVEL = ["owner", "view", "comment", "edit"] as const;
export const CURSOR_FLAG = { name: "--cursor", value: "cursor", text: "Continue the previous page." } as const;

// Names each declaration by a name its door must not repeat, such as a socket
// verb or a tool, and fails at load on a repeat.
export function byName<Declaration, Name extends string>(
  declarations: readonly Declaration[],
  name: (declaration: Declaration) => Name,
): Readonly<Record<Name, Declaration>> {
  const named: Partial<Record<Name, Declaration>> = {};
  for (const declaration of declarations) {
    const key = name(declaration);
    if (Object.hasOwn(named, key)) throw new Error(`${key} is declared twice.`);
    named[key] = declaration;
  }
  return named as Record<Name, Declaration>;
}

// Gives each named entry one value, under the same name.
export function mapNamed<Name extends string, Entry, Value>(
  named: Readonly<Record<Name, Entry>>,
  value: (entry: Entry, name: Name) => Value,
): Readonly<Record<Name, Value>> {
  const values: Partial<Record<Name, Value>> = {};
  for (const name of Object.keys(named) as Name[]) values[name] = value(named[name], name);
  return values as Record<Name, Value>;
}

// Joins two tables that must not share a name. A shared name fails the
// typecheck where both are known, and fails at load where they are not.
export function distinct<A extends object, B extends object>(
  first: A,
  second: B & { readonly [Name in keyof A & keyof B]: never },
): A & B {
  for (const name of Object.keys(second)) {
    if (Object.hasOwn(first, name)) throw new Error(`${name} is declared twice.`);
  }
  return { ...first, ...second };
}
