// Small production seam around Electron IPC registration. main.ts supplies
// the real parsers, workspace lookup, policy checks, and operations; tests can
// register and invoke these same callbacks without booting Electron's entire
// app lifecycle.

interface WorkspacePayload {
  workspaceId: string;
}

interface WorkspaceContext {
  workspace: { workspaceId: string };
}

export type MainChatIpcHandler<Event, Result> = (
  event: Event,
  payload: unknown,
) => Promise<Result>;

export function createWritableChatIpcHandler<
  Event,
  Payload extends WorkspacePayload,
  Context extends WorkspaceContext,
  Result,
>(input: {
  assertTrustedSender: (event: Event) => void;
  parsePayload: (payload: unknown) => Payload;
  requireContext: (workspaceId: string) => Promise<Context>;
  assertWritableWorkspace: (workspace: Context["workspace"]) => void;
  run: (context: Context, payload: Payload) => Promise<Result>;
  afterWrite?: Array<(context: Context, payload: Payload, result: Result) => void>;
}): MainChatIpcHandler<Event, Result> {
  return async (event, rawPayload) => {
    input.assertTrustedSender(event);
    const payload = input.parsePayload(rawPayload);
    const context = await input.requireContext(payload.workspaceId);
    input.assertWritableWorkspace(context.workspace);
    const result = await input.run(context, payload);
    for (const effect of input.afterWrite ?? []) effect(context, payload, result);
    return result;
  };
}

export function createReadAwareChatIpcHandler<
  Event,
  Payload extends WorkspacePayload,
  Context extends WorkspaceContext,
  Result,
>(input: {
  assertTrustedSender: (event: Event) => void;
  parsePayload: (payload: unknown) => Payload;
  requireContext: (workspaceId: string) => Promise<Context>;
  isReadOnly: (workspace: Context["workspace"]) => boolean;
  run: (context: Context, payload: Payload, readOnly: boolean) => Promise<Result>;
}): MainChatIpcHandler<Event, Result> {
  return async (event, rawPayload) => {
    input.assertTrustedSender(event);
    const payload = input.parsePayload(rawPayload);
    const context = await input.requireContext(payload.workspaceId);
    return input.run(context, payload, input.isReadOnly(context.workspace));
  };
}

export function createChatChannelIpcHandler<
  Event,
  Payload extends WorkspacePayload,
  Context extends WorkspaceContext,
  Result,
>(input: {
  assertTrustedSender: (event: Event) => void;
  parsePayload: (payload: unknown) => Payload;
  requireContext: (workspaceId: string) => Promise<Context>;
  assertWritableWorkspace: (workspace: Context["workspace"]) => void;
  run: (context: Context, payload: Payload) => Promise<Result>;
  queueCloudSync: (workspaceId: string) => void;
}): MainChatIpcHandler<Event, Result> {
  return createWritableChatIpcHandler({
    ...input,
    afterWrite: [({ workspace }) => input.queueCloudSync(workspace.workspaceId)],
  });
}

export function createSharedChannelWritableChatIpcHandler<
  Event,
  Payload extends WorkspacePayload,
  Context extends WorkspaceContext,
  Result,
>(input: {
  assertTrustedSender: (event: Event) => void;
  parsePayload: (payload: unknown) => Payload;
  requireContext: (workspaceId: string) => Promise<Context>;
  assertWritableWorkspace: (workspace: Context["workspace"]) => void;
  assertSharedChannelWritable: (
    context: Context,
    payload: Payload,
  ) => Promise<void>;
  run: (context: Context, payload: Payload) => Promise<Result>;
}): MainChatIpcHandler<Event, Result> {
  return createWritableChatIpcHandler({
    ...input,
    run: async (context, payload) => {
      await input.assertSharedChannelWritable(context, payload);
      return input.run(context, payload);
    },
  });
}

export function createSetChatReactionIpcHandler<
  Event,
  Payload extends WorkspacePayload,
  Context extends WorkspaceContext,
  Result,
>(input: {
  assertTrustedSender: (event: Event) => void;
  parsePayload: (payload: unknown) => Payload;
  requireContext: (workspaceId: string) => Promise<Context>;
  assertWritableWorkspace: (workspace: Context["workspace"]) => void;
  run: (context: Context, payload: Payload) => Promise<Result>;
  syncJoinedChannels: (workspaceId: string) => void;
  queueCloudSync: (workspaceId: string) => void;
}): MainChatIpcHandler<Event, Result> {
  return createWritableChatIpcHandler({
    ...input,
    afterWrite: [
      ({ workspace }) => input.syncJoinedChannels(workspace.workspaceId),
      ({ workspace }) => input.queueCloudSync(workspace.workspaceId),
    ],
  });
}
