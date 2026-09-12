import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { createHash, randomUUID } from "node:crypto";
import { CHANNELS } from "./channels";
import { RelayShareLinkListResponse } from "./bridgeContract";
import { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "./ownerAppPublicationContract";
import { prepareOwnerAppPublication } from "../workspaces/ownerAppPublication";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { credentialScopedOperation } from "../workspaces/credentialScopedOperation";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "../workspaces/closedAppCompiler";

export function registerOwnerAppPublicationIpc<Sender extends { id: number }, Workspace extends { workspaceId: string; shareView?: unknown }, Operation extends {
  workspace: Workspace; signal: AbortSignal; session: { generation: number }; assertCurrent(): void;
}>(dependencies: {
  registerHandler(channel: string, handler: (event: { sender: Sender }, payload: unknown) => unknown): void;
  assertTrustedSender(event: { sender: Sender }): void;
  withRendererWorkspaceOperation<Result>(sender: Sender, workspaceId: string, message: string, work: (operation: Operation) => Promise<Result>): Promise<Result>;
  remoteForWorkspace(workspace: Workspace): Promise<{ credentials: CloudCredentials; credentialGeneration: number }>;
  currentCredentialGeneration(): number;
  flushCapture(workspace: Workspace): Promise<void>;
  withAdapter<Result>(workspace: Workspace, work: (adapter: VersionedLiveAdapter) => Promise<Result>): Promise<Result | null>;
  compile(request: ClosedAppBuildRequest, signal: AbortSignal): Promise<ClosedAppBuild>;
  relayJson(credentials: CloudCredentials, path: string, init?: RequestInit): Promise<unknown>;
  upload(credentials: CloudCredentials, workspaceId: string, sha256: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}) {
  type Prepared = Awaited<ReturnType<typeof prepareOwnerAppPublication>>;
  const pending = new Map<string, { prepared: Prepared; input: Extract<OwnerAppPublicationRequest, { action: "prepare" }>;
    senderId: number; rendererGeneration: number; signal: AbortSignal; generation: number; candidateDigest: string; createdAt: number; clear(): void }>();
  const preparing = new Map<number, symbol>();
  const clearExpired = () => {
    for (const entry of pending.values()) if (entry.signal.aborted || Date.now() - entry.createdAt > 10 * 60_000) entry.clear();
  };
  dependencies.registerHandler(CHANNELS.publishOwnerApp, async (event, raw) => {
    dependencies.assertTrustedSender(event);
    const input = OwnerAppPublicationRequest.parse(raw);
    return dependencies.withRendererWorkspaceOperation(event.sender, input.workspaceId, "Publishing stopped because this window changed workspaces.", async operation => {
      operation.assertCurrent();
      if (shareViewIsPresent(operation.workspace.shareView)) throw new Error("Only the original workspace can publish this app.");
      const remote = await dependencies.remoteForWorkspace(operation.workspace);
      const session = credentialScopedOperation({ assertCurrent: () => operation.assertCurrent(), capturedGeneration: remote.credentialGeneration, currentGeneration: dependencies.currentCredentialGeneration });
      session.assertCurrent();
      clearExpired();
      if (input.action === "withdraw") {
        const raw = await session.run(() => dependencies.relayJson(remote.credentials,
          `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${input.publicationId}/withdraw`,
          { method: "POST", signal: operation.signal, body: JSON.stringify({ expectedAuthorityRevision: input.expectedAuthorityRevision }) }));
        const row = raw as { publicationId?: string; active?: boolean; authorityRevision?: number; owner?: { workspaceId?: string } } | null;
        if (!row || row.publicationId !== input.publicationId || row.owner?.workspaceId !== input.workspaceId || row.active !== false) throw new Error("dohc could not confirm that this publication ended.");
        return OwnerAppPublicationResult.parse({ kind: "withdrawn", publicationId: row.publicationId, authorityRevision: row.authorityRevision });
      }
      if (input.action !== "prepare") {
        const entry = pending.get(input.approvalId);
        if (!entry || entry.senderId !== event.sender.id || entry.rendererGeneration !== operation.session.generation || entry.signal !== operation.signal || entry.input.workspaceId !== input.workspaceId || entry.generation !== remote.credentialGeneration) throw new Error("This app preparation expired. Prepare the app again.");
        if (input.action === "cancel") {
          entry.clear();
          return OwnerAppPublicationResult.parse({ kind: "cancelled" });
        }
        if (input.candidateDigest !== entry.candidateDigest) throw new Error("The app candidate changed. Review it again.");
        // Consume before the first upload so duplicate approvals cannot race.
        entry.clear();
        const { prepared } = entry, { candidate } = prepared;
        for (const file of prepared.files) {
          await session.run(() => dependencies.upload(remote.credentials, input.workspaceId, file.sha256, file.bytes, operation.signal));
        }
        const rawResult = await session.run(() => dependencies.relayJson(remote.credentials,
          `/sync/${encodeURIComponent(input.workspaceId)}/app-publications`, { method: "POST", signal: operation.signal,
            body: JSON.stringify({ shareId: entry.input.shareId, grantId: entry.input.grantId, expectedGrantGeneration: prepared.generation, candidate }) }));
        if (!rawResult || typeof rawResult !== "object") throw new Error("dohc could not read the publication result.");
        const row = rawResult as Record<string, unknown>;
        const owner = row.owner as Record<string, unknown> | undefined;
        if (!owner || owner.workspaceId !== input.workspaceId || owner.shareId !== entry.input.shareId || owner.grantId !== entry.input.grantId || owner.generation !== prepared.generation ||
            JSON.stringify(row.candidate) !== JSON.stringify(candidate) || row.active !== true) throw new Error("The app publication changed. Review it again.");
        return OwnerAppPublicationResult.parse({ kind: "published", publicationId: row.publicationId, authorityRevision: row.authorityRevision });
      }
      // A window holds one prepared bundle. Replacement releases its old bytes.
      for (const entry of pending.values()) if (entry.senderId === event.sender.id) entry.clear();
      if (pending.size + preparing.size >= 8) throw new Error("Too many apps await publication. Cancel another preparation and try again.");
      const preparation = Symbol("app preparation");
      preparing.set(event.sender.id, preparation);
      const assertPreparing = () => {
        session.assertCurrent();
        if (preparing.get(event.sender.id) !== preparation) throw new Error("A newer app preparation replaced this one.");
      };
      try {
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
        adapter, signal: operation.signal, assertCurrent: assertPreparing, compile: dependencies.compile,
      })));
      if (!prepared) throw new Error("dohc could not capture this app. Restart dohc and try again.");
      const { candidate } = prepared;
      assertPreparing();
      const approvalId = randomUUID(), candidateDigest = createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
      const clear = () => { pending.delete(approvalId); operation.signal.removeEventListener("abort", clear); clearTimeout(expiry); };
      const expiry = setTimeout(clear, 10 * 60_000);
      expiry.unref();
      pending.set(approvalId, { prepared, input, candidateDigest, senderId: event.sender.id, signal: operation.signal,
        rendererGeneration: operation.session.generation, generation: remote.credentialGeneration, createdAt: Date.now(), clear });
      operation.signal.addEventListener("abort", clear, { once: true });
      return OwnerAppPublicationResult.parse({ kind: "prepared", approvalId, candidateDigest, appRoot: candidate.appRoot,
        versionId: candidate.versionId, sourceRevision: candidate.sourceRevision, sourcePaths: candidate.inputs.map(file => file.path), capabilities: [], externalNetwork: true });
      } finally {
        if (preparing.get(event.sender.id) === preparation) preparing.delete(event.sender.id);
      }
    });
  });
}
