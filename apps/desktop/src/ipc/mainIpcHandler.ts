type Awaitable<Value> = Value | Promise<Value>;

export type MainIpcHandler<Event, Result = unknown> = (
  event: Event,
  payload: unknown,
) => Promise<Result>;

export type MainIpcHandlerRecord<Event> = Readonly<
  Record<string, MainIpcHandler<Event>>
>;

export type MainIpcGate<Context, Payload> =
  | { readonly kind: "read-only" }
  | {
      readonly kind: "write";
      readonly assert: (
        context: Context,
        payload: Payload,
      ) => Awaitable<void>;
    };

export function createMainIpcHandler<
  Event,
  Sender,
  Payload,
  Context,
  RawResult,
  Result,
>(input: {
  requireTrustedSender: (event: Event) => Sender;
  parsePayload: (payload: unknown) => Payload;
  authorize: (sender: Sender, payload: Payload) => Awaitable<Context>;
  gate: MainIpcGate<Context, Payload>;
  run: (context: Context, payload: Payload) => Awaitable<RawResult>;
  parseResult: (result: RawResult) => Result;
}): MainIpcHandler<Event, Result> {
  return async (event, rawPayload) => {
    const sender = input.requireTrustedSender(event);
    const payload = input.parsePayload(rawPayload);
    const context = await input.authorize(sender, payload);
    if (input.gate.kind === "write") {
      await input.gate.assert(context, payload);
    }
    const result = await input.run(context, payload);
    return input.parseResult(result);
  };
}
