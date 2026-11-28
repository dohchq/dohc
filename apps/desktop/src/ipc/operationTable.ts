import { DECLARATION_FAMILIES } from "@dohc/workspace-contracts/all-declarations";
import type { CapabilityId } from "@dohc/workspace-contracts/capabilities";
import type {
  OperationDeclaration,
  OperationFamily,
} from "@dohc/workspace-contracts/operation-declaration";
import type { WriteDeclaration, WriteFamily } from "@dohc/workspace-contracts/write-declaration";
import { WRITE_DECLARATION_FAMILIES } from "@dohc/workspace-contracts/all-write-declarations";
import type { z } from "zod";

// One row per renderer-to-main operation: the channel, the payload main
// parses, the result main parses before it replies, and the guard main applies
// first. A row without a result replies undefined. The preload's bridge
// methods, the DohcDesktopBridge members, and main's registration all derive
// from the row, so none can drift from it.
type OperationRow<Payload extends z.ZodType> = {
  readonly channel: `desktop:${string}`;
  readonly payload: Payload;
  readonly result?: z.ZodType;
} & (
  | { readonly capabilityId: CapabilityId; readonly capabilityIdsByAction?: never }
  | {
      readonly capabilityId?: never;
      readonly capabilityIdsByAction: Readonly<Record<string, CapabilityId>>;
    }
);

export type OperationDefinition =
  // Any trusted window may call it.
  | (OperationRow<z.ZodType> & { readonly guard: "trusted-sender" } & (
        | { readonly scope: "device" }
        // Describes existing handler admission without wrapping its lifetime.
        | {
            readonly scope: "workspace";
            readonly handlerCheck: { readonly check: string; readonly reason: string };
          }
      ))
  // The handler runs inside the sending window's workspace operation. It fails
  // with inactiveMessage, before or after the handler, unless the payload's
  // workspace is the one open in that window.
  | (OperationRow<z.ZodType<{ readonly workspaceId: string }>> & {
      readonly guard: "active-workspace";
      readonly scope: "workspace";
      readonly inactiveMessage: string;
    });

export type OperationTable = Readonly<Record<string, OperationDefinition>>;

type InWorkspace<Input> = (Input extends Record<string, never> ? unknown : Input) & {
  workspaceId: string;
};
type DeclaredRow<Declaration extends OperationDeclaration> = {
  readonly capabilityId: CapabilityId;
  readonly channel: Declaration["ipc"]["channel"];
  readonly scope: "workspace";
  readonly guard: "active-workspace";
  readonly inactiveMessage: string;
  readonly payload: z.ZodType<
    InWorkspace<z.output<Declaration["input"]>>,
    InWorkspace<z.input<Declaration["input"]>>
  >;
  readonly result: Declaration["ipc"] extends { readonly result: infer Result extends z.ZodType }
    ? Result
    : Declaration["result"];
};

type Families = typeof DECLARATION_FAMILIES;
type DeclaredRows<Family> = {
  readonly [Name in keyof Family]: Family[Name] extends OperationDeclaration
    ? DeclaredRow<Family[Name]>
    : never;
};

// The rows of one listed family, named by its key in DECLARATION_FAMILIES, so
// a family that is not listed there gets no IPC rows. Each row runs inside the
// sending window's active workspace; a declaration cannot choose another guard.
export function declaredRows<Key extends keyof Families>(
  key: Key,
  workspaceId: z.ZodType<string>,
): DeclaredRows<Families[Key]> {
  if (!Object.hasOwn(DECLARATION_FAMILIES, key)) throw new Error(`${key} is not a listed family.`);
  const family: OperationFamily = DECLARATION_FAMILIES[key];
  const rows: Record<string, unknown> = Object.fromEntries(
    Object.entries(family).map(([name, declaration]) => [
      name,
      {
        capabilityId: declaration.capabilityId,
        channel: declaration.ipc.channel,
        scope: "workspace",
        guard: "active-workspace",
        inactiveMessage: declaration.ipc.inactiveMessage,
        payload: declaration.input.extend({ workspaceId }),
        result: declaration.ipc.result ?? declaration.result,
      },
    ]),
  );
  return rows as DeclaredRows<Families[Key]>;
}

// The window's row of each declared write that the app offers.
type WriteFamilies = typeof WRITE_DECLARATION_FAMILIES;
type WrittenInApp = { readonly ipc: { readonly channel: string } };
type Fields<Input> = string extends keyof Input ? Record<never, never> : Input;
type DeclaredWriteRow<Declaration> = Declaration extends {
  readonly ipc: {
    readonly channel: infer Channel extends `desktop:${string}`;
    readonly input: infer Input extends z.ZodType;
    readonly result: infer Result extends z.ZodType;
  };
}
  ? {
      readonly capabilityId: CapabilityId;
      readonly channel: Channel;
      readonly scope: "workspace";
      readonly guard: "active-workspace";
      readonly inactiveMessage: string;
      readonly payload: z.ZodType<
        Fields<z.output<Input>> & { workspaceId: string },
        Fields<z.input<Input>> & { workspaceId: string }
      >;
      readonly result: Result;
    }
  : never;
type DeclaredWriteRows<Family> = {
  readonly [
    Name in keyof Family as Family[Name] extends WrittenInApp ? Name : never
  ]: DeclaredWriteRow<Family[Name]>;
};

// The rows of one listed write family. A declaration cannot choose a guard:
// each row runs inside the sending window's active workspace.
export function declaredWriteRows<Key extends keyof WriteFamilies>(
  key: Key,
  workspaceId: z.ZodType<string>,
): DeclaredWriteRows<WriteFamilies[Key]> {
  if (!Object.hasOwn(WRITE_DECLARATION_FAMILIES, key))
    throw new Error(`${key} is not a listed family.`);
  const family: WriteFamily = WRITE_DECLARATION_FAMILIES[key];
  const rows: Record<string, unknown> = {};
  for (const [name, declaration] of Object.entries<WriteDeclaration>(family)) {
    const { ipc } = declaration;
    if ("none" in ipc) continue;
    rows[name] = {
      capabilityId: declaration.capabilityId,
      channel: ipc.channel,
      scope: "workspace",
      guard: "active-workspace",
      inactiveMessage: ipc.inactiveMessage,
      payload: ipc.input.extend({ workspaceId }),
      result: ipc.result,
    };
  }
  return rows as DeclaredWriteRows<WriteFamilies[Key]>;
}

type Reply<Definition> = Definition extends { readonly result: infer Result extends z.ZodType }
  ? z.output<Result>
  : void;
type HandlerReply<Definition> = Definition extends {
  readonly result: infer Result extends z.ZodType;
}
  ? z.input<Result>
  : void;

export type OperationBridge<Table extends OperationTable> = {
  [Name in keyof Table]: (payload: z.input<Table[Name]["payload"]>) => Promise<Reply<Table[Name]>>;
};

type OperationContext<Definition, Event, WorkspaceOperation> = Definition extends {
  readonly guard: "active-workspace";
}
  ? { readonly event: Event; readonly operation: WorkspaceOperation }
  : { readonly event: Event };

export type OperationHandlers<
  Table extends OperationTable,
  Event = unknown,
  WorkspaceOperation = unknown,
> = {
  readonly [Name in keyof Table]: (
    input: z.output<Table[Name]["payload"]>,
    context: OperationContext<Table[Name], Event, WorkspaceOperation>,
  ) => HandlerReply<Table[Name]> | Promise<HandlerReply<Table[Name]>>;
};

export interface OperationBoundary<Event, WorkspaceOperation> {
  handle(channel: string, listener: (event: Event, payload: unknown) => Promise<unknown>): void;
  assertTrustedSender(event: Event): void;
  withActiveWorkspace<Result>(
    event: Event,
    workspaceId: string,
    inactiveMessage: string,
    work: (operation: WorkspaceOperation) => Promise<Result>,
  ): Promise<Result>;
}

export type OperationCompletions<Table extends OperationTable, Event> = {
  readonly [Name in keyof Table]?: (
    input: z.output<Table[Name]["payload"]>,
    result: Reply<Table[Name]>,
    event: Event,
  ) => void;
};

type LooseHandler<Event, WorkspaceOperation> = (
  input: unknown,
  context: { readonly event: Event; readonly operation?: WorkspaceOperation },
) => unknown;

// Main parses the result, so the preload forwards it unparsed and the table
// supplies its type.
export function operationBridge<Table extends OperationTable>(
  table: Table,
  invoke: (channel: string, payload: unknown) => Promise<unknown>,
): OperationBridge<Table> {
  const bridge: Record<string, (payload: unknown) => Promise<unknown>> = {};
  for (const [name, { channel }] of Object.entries(table)) {
    bridge[name] = (payload) => invoke(channel, payload);
  }
  return bridge as OperationBridge<Table>;
}

export function registerOperations<Table extends OperationTable, Event, WorkspaceOperation>(
  boundary: OperationBoundary<Event, WorkspaceOperation>,
  table: Table,
  handlers: OperationHandlers<Table, Event, WorkspaceOperation>,
  completions: OperationCompletions<Table, Event> = {},
): void {
  const bodies = handlers as Record<string, LooseHandler<Event, WorkspaceOperation>>;
  const observers = completions as Record<
    string,
    ((input: unknown, result: unknown, event: Event) => void) | undefined
  >;
  for (const [name, definition] of Object.entries<OperationDefinition>(table)) {
    const handler = bodies[name]!;
    boundary.handle(definition.channel, async (event, payload) => {
      boundary.assertTrustedSender(event);
      let input: unknown;
      let result: unknown;
      if (definition.guard === "trusted-sender") {
        input = definition.payload.parse(payload);
        result = await handler(input, { event });
      } else {
        const workspaceInput = definition.payload.parse(payload);
        input = workspaceInput;
        result = await boundary.withActiveWorkspace(
          event,
          workspaceInput.workspaceId,
          definition.inactiveMessage,
          async (operation) => await handler(input, { event, operation }),
        );
      }
      const reply = definition.result?.parse(result);
      // Measurement cannot change the reply or bypass admission and validation.
      try {
        observers[name]?.(input, reply, event);
      } catch {
        /* Keep the operation's result. */
      }
      return reply;
    });
  }
}
