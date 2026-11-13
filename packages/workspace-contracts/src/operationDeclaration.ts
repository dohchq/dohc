import type { z } from "zod";

export type McpAccessLevel = "owner" | "view" | "comment" | "edit";

// One operation as each door offers it: the window's IPC row, the public CLI
// command and its socket verb, and the desktop MCP tool. Those doors derive
// their entries from it. It describes doors and grants nothing: the IPC row
// always runs in the sending window's active workspace, the CLI socket keeps
// its own workspace and received-share rules, and capabilityId stays
// metadata. Declarations import only contract schemas, so the preload can
// load them.
export interface OperationDeclaration {
  readonly capabilityId: string;
  // What every caller sends. The IPC row adds the workspace.
  readonly input: z.ZodObject;
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

// Gives each named declaration one value, under the same name.
export function mapNamed<Name extends string, Declaration, Value>(
  named: Readonly<Record<Name, Declaration>>,
  value: (declaration: Declaration) => Value,
): Readonly<Record<Name, Value>> {
  const values: Partial<Record<Name, Value>> = {};
  for (const name of Object.keys(named) as Name[]) values[name] = value(named[name]);
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
