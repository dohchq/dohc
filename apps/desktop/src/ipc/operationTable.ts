import type { CapabilityId } from "@dohc/workspace-contracts/capabilities";
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
  | { readonly capabilityId?: never; readonly capabilityIdsByAction: Readonly<Record<string, CapabilityId>> }
);

export type OperationDefinition =
  // Any trusted window may call it.
  | (OperationRow<z.ZodType> & { readonly guard: "trusted-sender" } & (
      | { readonly scope: "device" }
      // Describes existing handler admission without wrapping its lifetime.
      | { readonly scope: "workspace"; readonly handlerCheck: { readonly check: string; readonly reason: string } }
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

type Reply<Definition> =
  Definition extends { readonly result: infer Result extends z.ZodType }
    ? z.output<Result>
    : void;
type HandlerReply<Definition> =
  Definition extends { readonly result: infer Result extends z.ZodType }
    ? z.input<Result>
    : void;

export type OperationBridge<Table extends OperationTable> = {
  [Name in keyof Table]: (
    payload: z.input<Table[Name]["payload"]>,
  ) => Promise<Reply<Table[Name]>>;
};

type OperationContext<Definition, Event, WorkspaceOperation> =
  Definition extends { readonly guard: "active-workspace" }
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
  handle(
    channel: string,
    listener: (event: Event, payload: unknown) => Promise<unknown>,
  ): void;
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

export function registerOperations<
  Table extends OperationTable,
  Event,
  WorkspaceOperation,
>(
  boundary: OperationBoundary<Event, WorkspaceOperation>,
  table: Table,
  handlers: OperationHandlers<Table, Event, WorkspaceOperation>,
  completions: OperationCompletions<Table, Event> = {},
): void {
  const bodies = handlers as Record<string, LooseHandler<Event, WorkspaceOperation>>;
  const observers = completions as Record<string, ((input: unknown, result: unknown, event: Event) => void) | undefined>;
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
      try { observers[name]?.(input, reply, event); } catch { /* Keep the operation's result. */ }
      return reply;
    });
  }
}
