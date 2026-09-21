import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { parseAppPublicationCandidate, parseAppCollectionCapability, APP_PUBLICATION_MAX_BLOB_BYTES, APP_PUBLICATION_MAX_REQUEST_BYTES, type AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { createHash, randomUUID } from "node:crypto";
import { CHANNELS } from "./channels";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { RelayShareLinkListResponse } from "./bridgeContract";
import { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "./ownerAppPublicationContract";
import { prepareOwnerAppPublication, APP_PUBLICATION_LIMITS } from "../workspaces/ownerAppPublication";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { credentialScopedOperation } from "../workspaces/credentialScopedOperation";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "../workspaces/closedAppCompiler";

export function createOwnerAppPublicationHandler<Caller, Workspace extends { workspaceId: string; shareView?: unknown }, Operation extends {
  workspace: Workspace; signal: AbortSignal; scope?: string; assertCurrent(): void;
}>(dependencies: {
  callerKey(caller: Caller): string;
  withWorkspaceOperation<Result>(caller: Caller, workspaceId: string, work: (operation: Operation) => Promise<Result>): Promise<Result>;
  remoteForWorkspace(workspace: Workspace): Promise<{ credentials: CloudCredentials; credentialGeneration: number }>;
  currentCredentialGeneration(): number;
  flushCapture(workspace: Workspace): Promise<void>;
  withAdapter<Result>(workspace: Workspace, work: (adapter: VersionedLiveAdapter) => Promise<Result>): Promise<Result | null>;
  compile(request: ClosedAppBuildRequest, signal: AbortSignal): Promise<ClosedAppBuild>;
  relayJson(credentials: CloudCredentials, path: string, init?: RequestInit): Promise<unknown>;
  upload(credentials: CloudCredentials, workspaceId: string, sha256: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  localPublication?(input: OwnerAppPublicationRequest, callerKey: string, operation: Operation): Promise<OwnerAppPublicationResult | null>;
  beforeSharedPublish?(workspace: Workspace, candidate: AppPublicationCandidate, signal: AbortSignal): Promise<void>;
  activateBackend?(workspace: Workspace, input: { publicationId: string; authorityRevision: number; candidate: AppPublicationCandidate; initialize: boolean },
    request: (action: "activate" | "restore" | "describe", body: unknown) => Promise<unknown>, signal: AbortSignal): Promise<void>;
}) {
  type Prepared = Awaited<ReturnType<typeof prepareOwnerAppPublication>>;
  const pending = new Map<string, { prepared: Prepared; input: Extract<OwnerAppPublicationRequest, { action: "prepare" }>;
    callerKey: string; scope: string; signal: AbortSignal; generation: number; candidateDigest: string; createdAt: number; clear(): void;
    reactivation?: { publicationId: string; authorityRevision: number } }>();
  const preparing = new Map<string, symbol>();
  const clearExpired = () => {
    for (const entry of pending.values()) if (entry.signal.aborted || Date.now() - entry.createdAt > 10 * 60_000) entry.clear();
  };
  return async (caller: Caller, raw: unknown) => {
    const input = OwnerAppPublicationRequest.parse(raw);
    const callerKey = dependencies.callerKey(caller);
    return dependencies.withWorkspaceOperation(caller, input.workspaceId, async operation => {
      operation.assertCurrent();
      if (shareViewIsPresent(operation.workspace.shareView)) throw new Error("Only the original workspace can publish this app.");
      const local = await dependencies.localPublication?.(input, callerKey, operation);
      operation.assertCurrent(); operation.signal.throwIfAborted();
      if (local) return local;
      if (input.action === "prepareLocal" || input.action === "listLocal") throw new Error("Local apps are unavailable. Restart dohc and try again.");
      const remote = await dependencies.remoteForWorkspace(operation.workspace);
      const session = credentialScopedOperation({ assertCurrent: () => operation.assertCurrent(), capturedGeneration: remote.credentialGeneration, currentGeneration: dependencies.currentCredentialGeneration });
      session.assertCurrent();
      clearExpired();
      const remember = (prepared: Prepared, selection: Extract<OwnerAppPublicationRequest, { action: "prepare" }>, reactivation?: { publicationId: string; authorityRevision: number }) => {
        session.assertCurrent(); operation.signal.throwIfAborted();
        for (const entry of pending.values()) if (entry.callerKey === callerKey) entry.clear();
        if (pending.size >= 8) throw new Error("Too many apps await publication. Cancel another preparation and try again.");
        const candidate = prepared.candidate;
        const approvalId = randomUUID(), candidateDigest = createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
        const clear = () => { pending.delete(approvalId); operation.signal.removeEventListener("abort", clear); clearTimeout(expiry); };
        const expiry = setTimeout(clear, 10 * 60_000); expiry.unref();
        pending.set(approvalId, { prepared, input: selection, candidateDigest, callerKey, signal: operation.signal,
          scope: operation.scope ?? callerKey, generation: remote.credentialGeneration, createdAt: Date.now(), clear, reactivation });
        operation.signal.addEventListener("abort", clear, { once: true });
        return OwnerAppPublicationResult.parse({ kind: "prepared", approvalId, candidateDigest, appRoot: candidate.appRoot,
          versionId: candidate.versionId, sourceRevision: candidate.sourceRevision, sourcePaths: candidate.inputs.map(file => file.path), capabilities: candidate.capabilities, externalNetwork: true });
      };
      if (input.action === "reviewReactivation") {
        if (preparing.has(callerKey)) throw new Error("This caller is already preparing an app. Wait for it to finish.");
        const raw = await session.run(() => dependencies.relayJson(remote.credentials,
          `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${input.publicationId}`, { signal: operation.signal }));
        const row = raw as { publicationId?: string; candidate?: unknown; active?: boolean; authorityRevision?: number;
          owner?: { workspaceId?: string; ownerUserId?: string; shareId?: string; grantId?: string; generation?: number } } | null;
        if (!row || row.publicationId !== input.publicationId || row.active !== false || row.owner?.workspaceId !== input.workspaceId || row.owner.ownerUserId !== remote.credentials.userId ||
            !Number.isSafeInteger(row.authorityRevision) || row.authorityRevision! < 1 || !Number.isSafeInteger(row.owner.generation) || row.owner.generation! < 1) throw new Error("This app publication cannot be republished. Refresh the publication list.");
        const candidate = parseAppPublicationCandidate(row.candidate, APP_PUBLICATION_LIMITS);
        const selection = OwnerAppPublicationRequest.parse({ action: "prepare", workspaceId: input.workspaceId, appRoot: candidate.appRoot, shareId: row.owner.shareId, grantId: row.owner.grantId });
        if (selection.action !== "prepare") throw new Error("Invalid publication selection.");
        return remember({ candidate, files: [], generation: row.owner.generation! }, selection, { publicationId: input.publicationId, authorityRevision: row.authorityRevision! });
      }
      if (input.action === "list") {
        if (!isShareablePath(input.appRoot) || isSharedWithMePath(input.appRoot)) throw new Error("Choose an app in your workspace.");
        const query = new URLSearchParams({ appRoot: input.appRoot });
        if (input.cursor) query.set("cursor", input.cursor);
        const raw = await session.run(() => dependencies.relayJson(remote.credentials,
          `/sync/${encodeURIComponent(input.workspaceId)}/app-publications?${query}`, { signal: operation.signal }));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("dohc could not read app publications.");
        const result = OwnerAppPublicationResult.parse({ ...raw, kind: "listed" });
        if (result.kind !== "listed" || result.publications.some(row => !row.manifestUnavailable && row.appRoot !== input.appRoot)) throw new Error("The publication list belongs to another app.");
        return result;
      }
      if (input.action === "withdraw") {
        const raw = await session.run(() => dependencies.relayJson(remote.credentials,
          `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${input.publicationId}/withdraw`,
          { method: "POST", signal: operation.signal, body: JSON.stringify({ expectedAuthorityRevision: input.expectedAuthorityRevision }) }));
        const row = raw as { publicationId?: string; active?: boolean; authorityRevision?: number; owner?: { workspaceId?: string } } | null;
        if (!row || row.publicationId !== input.publicationId || row.owner?.workspaceId !== input.workspaceId || row.active !== false) throw new Error("dohc could not confirm that this publication ended.");
        return OwnerAppPublicationResult.parse({ kind: "withdrawn", publicationId: row.publicationId, authorityRevision: row.authorityRevision });
      }
      if (input.action === "revokeCollection") {
        const raw = await session.run(() => dependencies.relayJson(remote.credentials,
          `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${input.publicationId}/collection-approval`,
          { method: "POST", signal: operation.signal, body: JSON.stringify({ expectedAuthorityRevision: input.expectedAuthorityRevision, capability: null }) }));
        const row = raw as { publicationId?: unknown; authorityRevision?: unknown; capability?: unknown } | null;
        if (!row || row.publicationId !== input.publicationId || row.capability !== null || row.authorityRevision !== input.expectedAuthorityRevision + 1) throw new Error("dohc could not confirm collection access was revoked.");
        operation.signal.throwIfAborted();
        return OwnerAppPublicationResult.parse({ kind: "collectionRevoked", publicationId: row.publicationId, authorityRevision: row.authorityRevision });
      }
      if (input.action !== "prepare") {
        const entry = pending.get(input.approvalId);
        if (!entry || entry.callerKey !== callerKey || entry.scope !== (operation.scope ?? callerKey) || entry.signal !== operation.signal || entry.input.workspaceId !== input.workspaceId || entry.generation !== remote.credentialGeneration) throw new Error("This app preparation expired. Prepare the app again.");
        if (input.action === "cancel") {
          entry.clear();
          return OwnerAppPublicationResult.parse({ kind: "cancelled" });
        }
        if (input.candidateDigest !== entry.candidateDigest) throw new Error("The app candidate changed. Review it again.");
        // Consume before the first upload so duplicate approvals cannot race.
        entry.clear();
        const { prepared } = entry, { candidate } = prepared;
        await dependencies.beforeSharedPublish?.(operation.workspace, candidate, operation.signal);
        session.assertCurrent(); operation.signal.throwIfAborted();
        const finishPublication = async (publicationId: unknown, authorityRevision: unknown) => {
          const published = OwnerAppPublicationResult.parse({ kind: "published", publicationId, authorityRevision });
          if (published.kind !== "published") throw new Error("Invalid publication result.");
          const capability = candidate.capabilities[0];
          if (!capability) return published;
          if (capability.kind === "app-backend") {
            if (dependencies.activateBackend) {
              await dependencies.activateBackend(operation.workspace, { publicationId: published.publicationId,
                authorityRevision: published.authorityRevision, candidate, initialize: input.initialize !== false },
                (action, body) => session.run(() => dependencies.relayJson(remote.credentials,
                  `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${published.publicationId}/backend/${action}`,
                  { method: "POST", signal: operation.signal, body: JSON.stringify(body) })), operation.signal);
              session.assertCurrent(); operation.signal.throwIfAborted();
              return published;
            }
            if (input.initialize === false) return published;
            await session.run(() => dependencies.relayJson(remote.credentials,
              `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${published.publicationId}/backend/activate`,
              { method: "POST", signal: operation.signal, body: JSON.stringify({ authorityRevision: published.authorityRevision }) }));
            return published;
          }
          try {
          const raw = await session.run(() => dependencies.relayJson(remote.credentials,
            `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${published.publicationId}/collection-approval`,
            { method: "POST", signal: operation.signal, body: JSON.stringify({ expectedAuthorityRevision: published.authorityRevision, capability }) }));
          const approval = raw as { publicationId?: unknown; authorityRevision?: unknown; capability?: unknown } | null;
          if (!approval || approval.publicationId !== published.publicationId || approval.authorityRevision !== published.authorityRevision + 1 ||
              JSON.stringify(parseAppCollectionCapability(approval.capability)) !== JSON.stringify(capability)) throw new Error("Collection approval changed.");
          return OwnerAppPublicationResult.parse({ kind: "published", publicationId: published.publicationId, authorityRevision: approval.authorityRevision });
          } catch (error) {
            operation.signal.throwIfAborted();
            session.assertCurrent();
            if (error instanceof Error && error.name === "AbortError") throw error;
            const detail = error instanceof Error ? error.message : "Collection access could not be confirmed.";
            throw new Error(`The app is published. ${detail} Reload the publications before trying again.`);
          }
        };
        if (entry.reactivation) {
          const raw = await session.run(() => dependencies.relayJson(remote.credentials,
            `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${entry.reactivation!.publicationId}/reactivate`, { method: "POST", signal: operation.signal,
              body: JSON.stringify({ expectedAuthorityRevision: entry.reactivation!.authorityRevision }) }));
          const row = raw as { publicationId?: string; active?: boolean; authorityRevision?: number; owner?: { workspaceId?: string; shareId?: string; grantId?: string; generation?: number } } | null;
          if (!row || row.publicationId !== entry.reactivation.publicationId || row.active !== true || row.owner?.workspaceId !== input.workspaceId || row.owner.shareId !== entry.input.shareId || row.owner.grantId !== entry.input.grantId || row.owner.generation !== prepared.generation) throw new Error("dohc could not confirm that this app was republished. Refresh the publication list.");
          return finishPublication(row.publicationId, row.authorityRevision);
        }
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
            JSON.stringify(row.candidate) !== JSON.stringify(candidate)) throw new Error("The app publication changed. Review it again.");
        if (row.active !== true) throw new Error("This app is already unpublished. Review it from the publication list to republish it.");
        return finishPublication(row.publicationId, row.authorityRevision);
      }
      // A window holds one prepared bundle. Replacement releases its old bytes.
      if (preparing.has(callerKey)) throw new Error("This caller is already preparing an app. Wait for it to finish.");
      for (const entry of pending.values()) if (entry.callerKey === callerKey) entry.clear();
      if (pending.size + preparing.size >= 8) throw new Error("Too many apps await publication. Cancel another preparation and try again.");
      const preparation = Symbol("app preparation");
      preparing.set(callerKey, preparation);
      const assertPreparing = () => {
        session.assertCurrent();
        if (preparing.get(callerKey) !== preparation) throw new Error("A newer app preparation replaced this one.");
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
      const publishEnvelopeBytes = Buffer.byteLength(JSON.stringify({ shareId: input.shareId, grantId: input.grantId, expectedGrantGeneration: prepared.generation, candidate }), "utf8");
      if (publishEnvelopeBytes > APP_PUBLICATION_MAX_REQUEST_BYTES || prepared.files.some(file => file.byteLength > APP_PUBLICATION_MAX_BLOB_BYTES)) {
        throw new Error("This app exceeds the supported publication size. Choose a smaller build.");
      }
      return remember(prepared, input);
      } finally {
        if (preparing.get(callerKey) === preparation) preparing.delete(callerKey);
      }
    });
  };
}

/** Electron renderer adapter. Agents call createOwnerAppPublicationHandler directly. */
export function registerOwnerAppPublicationIpc<Sender extends { id: number }, Workspace extends { workspaceId: string; shareView?: unknown }, Operation extends {
  workspace: Workspace; signal: AbortSignal; session: { generation: number }; assertCurrent(): void;
}>(dependencies: Omit<Parameters<typeof createOwnerAppPublicationHandler<Sender, Workspace, Operation>>[0], "callerKey" | "withWorkspaceOperation"> & {
  registerHandler(channel: string, handler: (event: { sender: Sender }, payload: unknown) => unknown): void;
  assertTrustedSender(event: { sender: Sender }): void;
  withRendererWorkspaceOperation<Result>(sender: Sender, workspaceId: string, message: string, work: (operation: Operation) => Promise<Result>): Promise<Result>;
}): void {
  const handler = createOwnerAppPublicationHandler<Sender, Workspace, Operation & { scope: string }>({
    callerKey: (sender: Sender) => String(sender.id),
    withWorkspaceOperation: (sender, workspaceId, work) => dependencies.withRendererWorkspaceOperation(sender, workspaceId, "Publishing stopped because this window changed workspaces.", async operation => work({ ...operation, scope: `${operation.session.generation}` })),
    ...dependencies,
  });
  dependencies.registerHandler(CHANNELS.publishOwnerApp, async (event: { sender: Sender }, raw: unknown) => {
    dependencies.assertTrustedSender(event);
    return handler(event.sender, raw);
  });
}
