import { OwnerAppBackendRequest, OwnerAppBackendDescribe, OwnerAppBackendInvoke, OwnerAppBackendExport, OwnerAppBackendHelper, OwnerAppBackendRestore } from "@dohc/cli/app-backend";
import { parseAppBackendCapability } from "@dohc/security-contract/app-backend";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { credentialScopedOperation } from "../workspaces/credentialScopedOperation";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import { CHANNELS } from "./channels";

export interface OwnerAppBackendTransport {
  request(publicationId: string, action: OwnerAppBackendRequest["action"], body: unknown | undefined, signal: AbortSignal): Promise<unknown>;
  assertCurrent(): void;
}

export function createRemoteAppBackendTransport(input: {
  workspaceId: string; credentials: CloudCredentials; credentialGeneration: number;
  currentCredentialGeneration(): number;
  relayJson(credentials: CloudCredentials, path: string, init: RequestInit): Promise<unknown>;
}): OwnerAppBackendTransport {
  const session = credentialScopedOperation({ capturedGeneration: input.credentialGeneration, currentGeneration: input.currentCredentialGeneration, assertCurrent() {} });
  return { assertCurrent: session.assertCurrent, request: (publicationId, action, body, signal) => session.run(() => input.relayJson(input.credentials,
    `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${publicationId}/backend/${action}`,
    { method: "POST", signal, body: JSON.stringify(action === "describe" || action === "export" ? {} : body ?? {}) })) };
}

export function createOwnerAppBackendHandler<Caller, Workspace extends { workspaceId: string; shareView?: unknown }, Operation extends { workspace: Workspace; signal: AbortSignal; assertCurrent(): void }>(deps: {
  withWorkspaceOperation<T>(caller: Caller, workspaceId: string, work: (operation: Operation) => Promise<T>): Promise<T>;
  transportForWorkspace(workspace: Workspace, publicationId: string, signal: AbortSignal): Promise<OwnerAppBackendTransport>;
  saveExport(workspace: Workspace, publicationId: string, bundle: unknown, signal: AbortSignal, destination?: { path: string; overwrite: boolean }): Promise<string | null>;
  readRecovery?(path: string, signal: AbortSignal): Promise<unknown>;
}) {
  return async (caller: Caller, raw: unknown) => {
    const input = OwnerAppBackendRequest.parse(raw);
    return deps.withWorkspaceOperation(caller, input.workspaceId, async operation => {
      const current = () => { operation.signal.throwIfAborted(); operation.assertCurrent(); };
      current();
      if (shareViewIsPresent(operation.workspace.shareView)) throw new Error("Open the original workspace to manage this app.");
      const transport = await deps.transportForWorkspace(operation.workspace, input.publicationId, operation.signal);
      const request = async (action: OwnerAppBackendRequest["action"], body?: unknown) => {
        current(); transport.assertCurrent();
        const result = await transport.request(input.publicationId, action, body, operation.signal);
        current(); transport.assertCurrent();
        return result;
      };
      const rawDescription = await request("describe");
      if (!rawDescription || typeof rawDescription !== "object" || Array.isArray(rawDescription)) throw new Error("dohc could not read this app. Refresh and try again.");
      const description = rawDescription as Record<string, unknown>;
      if (description.publicationId !== input.publicationId || typeof description.active !== "boolean" ||
          !Number.isSafeInteger(description.authorityRevision) || (description.authorityRevision as number) < 1 ||
          !Number.isSafeInteger(description.revision) || (description.revision as number) < 0) throw new Error("This app is unavailable. Refresh its publications.");
      const capability = parseAppBackendCapability(description.capability);
      if (input.action === "describe") return OwnerAppBackendDescribe.parse({ capability, revision: description.revision, online: description.active });
      if (input.action === "restore") {
        if (!deps.readRecovery) throw new Error("Use the owner CLI to restore app recovery data.");
        if (description.active) throw new Error("This app already has data. Restore into an uninitialized app.");
        const bundle = await deps.readRecovery(input.sourcePath, operation.signal);
        const restored = OwnerAppBackendRestore.parse(await request("restore", { authorityRevision: description.authorityRevision, bundle }));
        if (restored.publicationId !== input.publicationId || restored.authorityRevision !== description.authorityRevision) throw new Error("dohc could not confirm app recovery. Refresh and try again.");
        return restored;
      }
      if (!description.active) throw new Error("This app has no initialized data. Initialize or restore it first.");
      if (input.action === "invoke") {
        if (!capability.operations.some(operation => operation.name === input.operation)) throw new Error("This app operation is unavailable. Refresh and try again.");
        return OwnerAppBackendInvoke.parse(await request("invoke", { authorityRevision: description.authorityRevision,
          operation: input.operation, idempotencyKey: input.idempotencyKey, input: input.input }));
      }
      if (input.action === "helper") {
        const result = OwnerAppBackendHelper.parse(await request("helper", { authorityRevision: description.authorityRevision, grantId: input.grantId, enabled: input.enabled }));
        if (result.grantId !== input.grantId || result.enabled !== input.enabled) throw new Error("dohc could not confirm organizer access. Refresh and try again.");
        return result;
      }
      const bundle = await request("export", { authorityRevision: description.authorityRevision });
      current(); transport.assertCurrent();
      const savedPath = await deps.saveExport(operation.workspace, input.publicationId, bundle, operation.signal,
        input.savePath === undefined ? undefined : { path: input.savePath, overwrite: input.overwrite === true });
      current(); transport.assertCurrent();
      return OwnerAppBackendExport.parse({ savedPath });
    });
  };
}

export function registerOwnerAppBackendIpc<Sender, Workspace extends { workspaceId: string; shareView?: unknown }, Operation extends { workspace: Workspace; signal: AbortSignal; assertCurrent(): void }>(deps: Omit<Parameters<typeof createOwnerAppBackendHandler<Sender, Workspace, Operation>>[0], "withWorkspaceOperation"> & {
  registerHandler(channel: string, handler: (event: { sender: Sender }, raw: unknown) => unknown): void;
  assertTrustedSender(event: { sender: Sender }): void;
  withRendererWorkspaceOperation<T>(sender: Sender, workspaceId: string, message: string, work: (operation: Operation) => Promise<T>): Promise<T>;
}) {
  const handler = createOwnerAppBackendHandler<Sender, Workspace, Operation>({ ...deps,
    withWorkspaceOperation: (sender, workspaceId, work) => deps.withRendererWorkspaceOperation(sender, workspaceId, "App changes stopped because this window changed workspaces.", work) });
  deps.registerHandler(CHANNELS.appBackend, (event, raw) => {
    deps.assertTrustedSender(event);
    const input = OwnerAppBackendRequest.parse(raw);
    if (input.action === "restore") throw new Error("Use the owner CLI to restore app recovery data.");
    if (input.action === "export" && (input.savePath !== undefined || input.overwrite !== undefined)) throw new Error("Choose the export location in the save dialog.");
    return handler(event.sender, input);
  });
}
