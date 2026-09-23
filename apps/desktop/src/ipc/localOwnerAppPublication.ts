import { createHash, randomUUID } from "node:crypto";
import { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "@dohc/cli/app-publication";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { prepareLocalAppPublication } from "../workspaces/ownerAppPublication";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "../workspaces/closedAppCompiler";
import type { LocalDatasetHost } from "../workspaces/localDatasetHost";

export function createLocalOwnerAppPublicationHandler<Workspace extends { workspaceId: string }, Operation extends { workspace: Workspace; signal: AbortSignal; session?: { generation: number }; scope?: string; assertCurrent(): void }>(deps: {
  datasetForWorkspace(workspace: Workspace, signal: AbortSignal): Promise<Pick<LocalDatasetHost, "approvedArtifacts" | "apps">>;
  flushCapture(workspace: Workspace): Promise<void>;
  withAdapter<T>(workspace: Workspace, work: (adapter: VersionedLiveAdapter) => Promise<T>): Promise<T | null>;
  compile(request: ClosedAppBuildRequest, signal: AbortSignal): Promise<ClosedAppBuild>;
  launchLocalDataset?(workspace: Workspace, publicationId: string, signal: AbortSignal): Promise<string>;
}) {
  type Prepared = Awaited<ReturnType<typeof prepareLocalAppPublication>>;
  const pending = new Map<string, { prepared: Prepared; workspaceId: string; callerKey: string; scope: string; signal: AbortSignal; digest: string; clear(): void }>();
  const preparing = new Set<string>();
  return async (input: OwnerAppPublicationRequest, callerKey: string, operation: Operation): Promise<OwnerAppPublicationResult | null> => {
    if (input.action !== "prepareLocal" && input.action !== "listLocal" && input.action !== "launchLocal" && input.action !== "approve" && input.action !== "cancel" && input.action !== "withdraw") return null;
    const current = () => { operation.signal.throwIfAborted(); operation.assertCurrent(); };
    current();
    if (input.action === "withdraw") {
      const local = await deps.datasetForWorkspace(operation.workspace, operation.signal); current();
      if (!local.apps.has(input.publicationId)) return null;
      const result = local.apps.withdraw(input.publicationId, input.expectedAuthorityRevision); current();
      return OwnerAppPublicationResult.parse({ kind: "withdrawn", ...result });
    }
    if (input.action === "launchLocal") {
      const dataset = await deps.datasetForWorkspace(operation.workspace, operation.signal);
      current();
      if (!dataset.apps.has(input.publicationId)) throw new Error("This app is not approved on this device. Prepare it again.");
      const launch = deps.launchLocalDataset;
      if (!launch) throw new Error("Local app launch is unavailable. Restart dohc and try again.");
      const url = await launch(operation.workspace, input.publicationId, operation.signal); current();
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.username || parsed.password) throw new Error("The local app launcher returned an invalid address.");
      return OwnerAppPublicationResult.parse({ kind: "localLaunched", publicationId: input.publicationId, url });
    }
    if (input.action === "approve" || input.action === "cancel") {
      const entry = pending.get(input.approvalId);
      if (!entry) return null;
      if (entry.workspaceId !== input.workspaceId || entry.callerKey !== callerKey || entry.scope !== (operation.scope ?? callerKey) || entry.signal !== operation.signal) throw new Error("This local app preparation expired. Prepare it again.");
      if (input.action === "cancel") { entry.clear(); return { kind: "cancelled" }; }
      if (input.candidateDigest !== entry.digest) throw new Error("The app candidate changed. Review it again.");
      entry.clear();
      const local = await deps.datasetForWorkspace(operation.workspace, operation.signal); current();
      const result = await local.apps.activate(entry.prepared, operation.signal);
      current();
      return OwnerAppPublicationResult.parse({ kind: "published", publicationId: result.publicationId, authorityRevision: result.authorityRevision, local: true });
    }
    if (!isShareablePath(input.appRoot) || isSharedWithMePath(input.appRoot)) throw new Error("Choose an app in your workspace.");
    if (input.action === "listLocal") {
      const local = await deps.datasetForWorkspace(operation.workspace, operation.signal); current();
      return OwnerAppPublicationResult.parse({ kind: "localListed", publications: local.apps.list(input.appRoot) });
    }
    if (preparing.has(callerKey)) throw new Error("This caller is already preparing an app. Wait for it to finish.");
    for (const entry of pending.values()) if (entry.callerKey === callerKey) entry.clear();
    if (pending.size + preparing.size >= 8) throw new Error("Too many apps await approval. Cancel another preparation and try again.");
    preparing.add(callerKey);
    try {
      await deps.flushCapture(operation.workspace); current();
      const prepared = await deps.withAdapter(operation.workspace, adapter => prepareLocalAppPublication(input, {
        adapter, signal: operation.signal, assertCurrent: current, compile: deps.compile,
        resolveDatasetRevision: async binding => {
          const local = await deps.datasetForWorkspace(operation.workspace, operation.signal); current();
          const approved = local.approvedArtifacts(binding.datasetId);
          if (!approved.active) throw new Error("This Collection is unavailable on this device.");
          return approved.revision;
        },
      }));
      current();
      if (!prepared) throw new Error("dohc could not capture this app. Restart dohc and try again.");
      const candidate = prepared.candidate;
      if (candidate.capabilities[0]?.kind !== "dataset") throw new Error("Connect this app to a Collection before preparing app data.");
      const approvalId = randomUUID(), digest = createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
      const clear = () => { pending.delete(approvalId); operation.signal.removeEventListener("abort", clear); clearTimeout(expiry); };
      const expiry = setTimeout(clear, 10 * 60_000); expiry.unref();
      pending.set(approvalId, { prepared, workspaceId: input.workspaceId, callerKey, scope: operation.scope ?? callerKey, signal: operation.signal, digest, clear });
      operation.signal.addEventListener("abort", clear, { once: true });
      return OwnerAppPublicationResult.parse({ kind: "prepared", approvalId, candidateDigest: digest, appRoot: candidate.appRoot,
        versionId: candidate.versionId, sourceRevision: candidate.sourceRevision, sourcePaths: candidate.inputs.map(file => file.path),
        capabilities: candidate.capabilities, externalNetwork: true, local: true });
    } finally { preparing.delete(callerKey); }
  };
}
