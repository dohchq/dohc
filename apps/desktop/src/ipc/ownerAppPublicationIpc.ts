import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { CHANNELS } from "./channels";
import { RelayShareLinkListResponse } from "./bridgeContract";
import { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "./ownerAppPublicationContract";
import { prepareOwnerAppPublication } from "../workspaces/ownerAppPublication";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { credentialScopedOperation } from "../workspaces/credentialScopedOperation";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "../workspaces/closedAppCompiler";

export function registerOwnerAppPublicationIpc<Sender, Workspace extends { workspaceId: string; shareView?: unknown }, Operation extends {
  workspace: Workspace; signal: AbortSignal; assertCurrent(): void;
}>(dependencies: {
  registerHandler(channel: string, handler: (event: { sender: Sender }, payload: unknown) => unknown): void;
  assertTrustedSender(event: { sender: Sender }): void;
  withRendererWorkspaceOperation<Result>(sender: Sender, workspaceId: string, message: string, work: (operation: Operation) => Promise<Result>): Promise<Result>;
  remoteForWorkspace(workspace: Workspace): Promise<{ credentials: CloudCredentials; credentialGeneration: number }>;
  currentCredentialGeneration(): number;
  flushCapture(workspace: Workspace): Promise<void>;
  withAdapter<Result>(workspace: Workspace, work: (adapter: VersionedLiveAdapter) => Promise<Result>): Promise<Result | null>;
  compile(request: ClosedAppBuildRequest, signal: AbortSignal): Promise<ClosedAppBuild>;
  confirm(sender: Sender, detail: string): Promise<boolean>;
  relayJson(credentials: CloudCredentials, path: string, init?: RequestInit): Promise<unknown>;
  upload(credentials: CloudCredentials, workspaceId: string, sha256: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}) {
  dependencies.registerHandler(CHANNELS.publishOwnerApp, async (event, raw) => {
    dependencies.assertTrustedSender(event);
    const input = OwnerAppPublicationRequest.parse(raw);
    return dependencies.withRendererWorkspaceOperation(event.sender, input.workspaceId, "Publishing stopped because this window changed workspaces.", async operation => {
      operation.assertCurrent();
      if (shareViewIsPresent(operation.workspace.shareView)) throw new Error("Only the original workspace can publish this app.");
      const remote = await dependencies.remoteForWorkspace(operation.workspace);
      const session = credentialScopedOperation({ assertCurrent: () => operation.assertCurrent(), capturedGeneration: remote.credentialGeneration, currentGeneration: dependencies.currentCredentialGeneration });
      session.assertCurrent();
      let grant;
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = RelayShareLinkListResponse.parse(await session.run(() => dependencies.relayJson(remote.credentials,
          `/sync/${encodeURIComponent(input.workspaceId)}/shares/links${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { signal: operation.signal })));
        grant = page.links.find(row => row.shareId === input.shareId && row.grantId === input.grantId);
        if (grant) break;
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("The app link listing changed. Try again.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (!grant) throw new Error("This app link is unavailable. Choose an active link.");
      await session.run(() => dependencies.flushCapture(operation.workspace));
      const prepared = await session.run(() => dependencies.withAdapter(operation.workspace, adapter => prepareOwnerAppPublication(input, grant!, {
        adapter, signal: operation.signal, assertCurrent: session.assertCurrent, compile: dependencies.compile,
      })));
      if (!prepared) throw new Error("dohc could not capture this app. Restart dohc and try again.");
      const { candidate } = prepared;
      const detail = [
        `App: ${candidate.appRoot}`,
        `Version: ${candidate.versionId}`,
        `Source revision: ${candidate.sourceRevision}`,
        "",
        "This publishes the captured app below. Later source edits need a new publication.",
        "The app can connect to external services and send them data it receives.",
        "Workspace data access: none. The bundle includes these source files and assets:",
        ...candidate.inputs.map(file => file.path),
      ].join("\n");
      if (!await session.run(() => dependencies.confirm(event.sender, detail))) return OwnerAppPublicationResult.parse({ kind: "cancelled" });
      for (const file of prepared.files) {
        await session.run(() => dependencies.upload(remote.credentials, input.workspaceId, file.sha256, file.bytes, operation.signal));
      }
      const rawResult = await session.run(() => dependencies.relayJson(remote.credentials,
        `/sync/${encodeURIComponent(input.workspaceId)}/app-publications`, { method: "POST", signal: operation.signal,
          body: JSON.stringify({ shareId: input.shareId, grantId: input.grantId, expectedGrantGeneration: prepared.generation, candidate }) }));
      if (!rawResult || typeof rawResult !== "object") throw new Error("dohc could not read the publication result.");
      const row = rawResult as Record<string, unknown>;
      const owner = row.owner as Record<string, unknown> | undefined;
      if (!owner || owner.workspaceId !== input.workspaceId || owner.shareId !== input.shareId || owner.grantId !== input.grantId || owner.generation !== prepared.generation ||
          JSON.stringify(row.candidate) !== JSON.stringify(candidate) || row.active !== true) throw new Error("The app publication changed. Review it again.");
      return OwnerAppPublicationResult.parse({ kind: "published", publicationId: row.publicationId, authorityRevision: row.authorityRevision });
    });
  });
}
