import { expect, vi } from "vitest";
import { resolve } from "node:path";
import type { WatcherStatusResult } from "@dohc/workspace-engine-client";
import { CHANNELS } from "../ipc/channels";
import { registerSharedViewsIpcHandlers } from "../ipc/sharedViewsIpc";
import { createWorkspaceRootApproval } from "../ipc/workspaceRegistryIpc";
import { CredentialSessionCache } from "../workspaces/credentialSessionCache";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { EngineRelayWorkspaceClient } from "../workspaces/engineRelayClient";
import { createWorkspaceAuthorityOwner, type PhysicalWorkspace, type WorkspaceAuthorityLease } from "../workspaces/workspaceAuthorityOwner";
import { createRendererWorkspaceOperationRunner, type ExactRendererWorkspaceOperation } from "../window/rendererWorkspaceOperation";
import { createJoinedWorkspaceRunner } from "../workspaces/createJoinedWorkspace";
import type { CreatedWorkspace } from "../workspaces/createWorkspaceFolder";
import { type ShareViewInfo } from "../workspaces/shareViewInfo";
import { withStaleSensitiveWorkspaceOperation } from "../workspaces/workspaceAssets";
import { buildShareCode } from "../workspaces/syncCode";

export const credentials: CloudCredentials = {
  serverUrl: "https://account.example.test", relayUrl: "https://relay.example.test",
  token: "token", userId: "recipient", email: "recipient@example.test",
};
export const info: ShareViewInfo = {
  shareId: "share", granterUserId: "granter", granterEmail: "granter@example.test", genericChatWritable: true,
  selector: { paths: ["docs"], versionId: null, access: "edit" }, createdAtMs: 1,
};
export const outcome = { ok: true as const, status: "updated" as const, changedPaths: 2, excludedPaths: [], unjournalablePaths: [], collisionRecordQuarantined: false, refusedOps: 1, refusedDetail: "refused path" };
export const ready: WatcherStatusResult = {
  phase: "ready",
  terminal: false,
  running: true,
  degraded: false,
  noAtomicPlacement: false, recoveryUnavailable: false, deferredWrites: [], keptFiles: [], captureRecoveries: [], heldFiles: [], retainedCopies: { count: 0, bytes: 0 },
};

export async function createSharedViewsIpcHarness(options: {
  rootPath?: string;
  syncNotices?: (isCurrent: () => boolean) => Promise<void>;
  // How the authority and the open flow resolve roots. Real folders use canonicalWorkspaceRoot.
  canonicalizeRoot?: (root: string) => string;
} = {}) {
  const canonicalizeRoot = options.canonicalizeRoot ?? ((root: string) => root);
  const steps: string[] = [];
  const home = resolve("/shared-views-ipc-home").replace(/\\/g, "/");
  const rootPath = `${home}/received`;
  const roots = createWorkspaceRootApproval(() => home); roots.approveRoot(rootPath);
  const workspace: RegistryEntry = {
    workspaceId: "existing", rootPath: options.rootPath ?? `${home}/existing`, kind: "personal", mode: "local-first",
    shareView: { shareId: "share", granterEmail: info.granterEmail, genericChatWritable: false, grantedSelector: { ...info.selector!, paths: [...info.selector!.paths] }, relayUrl: credentials.relayUrl, recipientUserId: credentials.userId },
  };
  const registry = new Map([[workspace.workspaceId, workspace]]);
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id: string) => registry.get(id) ?? null, canonicalizeRoot, createState: () => ({}),
  });
  const attachmentId = await authorities.withOperation("existing", operation => operation.workspace.attachmentId);
  let rendererCurrent = true;
  let rendererClosed = false;
  const session = { workspaceId: "existing", attachmentId, generation: 1, isCurrent: () => rendererCurrent && !rendererClosed };
  type Event = { sender: string; trusted: boolean };
  type Workspace = PhysicalWorkspace<RegistryEntry>;
  type Operation = ExactRendererWorkspaceOperation<Workspace, object, typeof session>;
  type Lease = WorkspaceAuthorityLease<RegistryEntry, object>;
  type Dependencies = Parameters<typeof registerSharedViewsIpcHandlers<string, Event, Operation, Lease>>[0];
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<string, Workspace, object, typeof session>({
    currentSession: () => session, withPhysicalOperation: (id, work) => authorities.withOperation(id, work),
  });
  const cache = new CredentialSessionCache<CloudCredentials>(); cache.set(credentials);
  const load = vi.fn<() => Promise<CloudCredentials | null>>(async () => cache.snapshot().credentials);
  const warm = vi.fn<() => Promise<void>>(async () => undefined);
  const startup = vi.fn<() => Promise<void>>(async () => undefined);
  const fetchInfo = vi.fn<Dependencies["fetchShareViewInfo"]>(async () => { steps.push("preflight"); return info; });
  const probeLog = vi.fn<Dependencies["probeShareViewLog"]>(async () => ({ unchanged: true }));
  const registryRead = vi.fn((id: string) => registry.get(id)!);
  const workspaceOperation = vi.fn(withRendererWorkspaceOperation);
  const fetchAccess = vi.fn<Dependencies["fetchShareViewAccess"]>(async () => "edit");
  const readDir = vi.fn(async (_root: string) => [] as string[]);
  const mkdir = vi.fn(async () => { steps.push("mkdir"); });
  const createFolder = vi.fn(async (input: { workspaceId?: string; rootPath: string }): Promise<CreatedWorkspace> => {
    steps.push("create");
    return { workspaceId: input.workspaceId!, rootPath: input.rootPath, kind: "personal" as const, mode: "local-first" as const };
  });
  const cleanup = vi.fn(async () => { steps.push("cleanup"); });
  const notify = vi.fn<Dependencies["notifyRenderer"]>(() => { steps.push("notify"); });
  const syncNotices = vi.fn(options.syncNotices ?? (async (_isCurrent: () => boolean) => undefined));
  const surfaces = vi.fn(() => { steps.push("surfaces"); });
  const createJoinedWorkspace = createJoinedWorkspaceRunner({
    canonicalizeRoot, reserve: input => authorities.reserveBinding(input), createFolder,
    register: (reservation, entry) => authorities.registerReservedBinding(reservation, entry, {
      persist: () => { steps.push("register"); registry.set(entry.workspaceId, entry); },
      rollback: () => { registry.delete(entry.workspaceId); },
    }),
    remove: (binding, finalize) => authorities.retireBinding(binding, {
      finalize, removeBinding: () => { steps.push("remove"); registry.delete(binding.workspaceId); },
    }),
    release: (reservation, finalize) => authorities.releaseReservation(reservation, finalize),
    closeRelay: cleanup, rollbackComplete: () => { surfaces(); notify(); }, logError: vi.fn(),
  });
  const setView = vi.fn<Dependencies["setWorkspaceShareView"]>(async (id, shareView) => { steps.push("pin"); registry.get(id)!.shareView = shareView; });
  const recordIdentity = vi.fn<EngineRelayWorkspaceClient["recordShareViewIdentity"]>(async () => { steps.push("identity"); return { identity: "recorded" }; });
  const relayFor = vi.fn<Dependencies["receivedShareEngine"]["relayFor"]>(() => ({ recordShareViewIdentity: recordIdentity } as unknown as EngineRelayWorkspaceClient));
  const status = vi.fn<() => Promise<WatcherStatusResult>>(async () => { steps.push("capture-ready"); return ready; });
  const storeFor = vi.fn<Dependencies["receivedShareEngine"]["storeFor"]>(() => ({ watcherStatus: status } as unknown as ReturnType<Dependencies["receivedShareEngine"]["storeFor"]>));
  const reconcile = vi.fn<Dependencies["shareViewFiles"]["reconcile"]>(async (_lease, _target, _request, onCursorCommitted) => {
    steps.push("reconcile"); onCursorCommitted?.(42); return { kind: "refresh", outcome };
  });
  const end = vi.fn<Dependencies["shareViewFiles"]["end"]>(async (_lease, target, assertCurrent) => {
    assertCurrent();
    registry.get(target.workspaceId)!.shareView!.ended = true;
  });
  const narrow = vi.fn<Dependencies["shareViewFiles"]["narrow"]>(async (_lease, _target, assertCurrent, commit) => { assertCurrent(); await commit([], { paths: [], unchecked: false, checked: 0 }); });
  const closed = new Set<() => void>();
  const open = vi.fn<Dependencies["openWorkspaceActivity"]>(async () => { steps.push("open"); });
  const recordRefusal = vi.fn<Dependencies["recordShareViewStoreRefusal"]>();
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  registerSharedViewsIpcHandlers<string, Event, Operation, Lease>({
    registerHandler: (channel, handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    assertTrustedSender: event => { if (!event.trusted) throw new Error("untrusted"); },
    withRendererWorkspaceOperation: workspaceOperation as Dependencies["withRendererWorkspaceOperation"], loadAndCacheCurrentCredentials: load, warmCredentialCache: warm,
    currentCredentials: () => cache.snapshot().credentials, engineDaemonStartup: startup,
    currentRendererSession: () => session,
    probeShareViewLog: probeLog,
    currentCredentialGeneration: () => cache.snapshot().generation,
    onSenderClosed: (_sender, close) => { closed.add(close); return () => { closed.delete(close); }; },
    fetchShareViewInfo: fetchInfo, fetchShareViewAccess: fetchAccess, usableRoot: roots.usableRoot, readdir: readDir, mkdir, createJoinedWorkspace,
    setWorkspaceShareView: setView, refreshNativeWorkspaceSurfaces: surfaces, workspaceAuthorities: authorities,
    canonicalWorkspaceFor: lease => {
      lease.assertCurrent();
      return { ...registry.get(lease.binding.workspaceId)!, rootPath: lease.binding.canonicalRootPath, attachmentId: lease.binding.attachmentId };
    },
    withStaleSensitiveWorkspaceOperation, shareViewFiles: { reconcile, end, narrow }, receivedShareEngine: { relayFor, storeFor },
    openWorkspaceActivity: open, requireWorkspace: registryRead, notifyRenderer: notify,
    recordShareViewStoreRefusal: recordRefusal,
    syncNotices,
  });
  const invoke = (channel: string, payload: unknown, trusted = true) =>
    Promise.resolve().then(() => handlers.get(channel)!({ sender: "window", trusted }, payload));
  const openPayload = { rootPath, shareCode: buildShareCode({ relayUrl: credentials.relayUrl!, shareId: "share" }) };
  return { workspace, registry, authorities, attachmentId, roots, cache, load, warm, startup, fetchInfo, readDir,
    mkdir, createFolder, cleanup, notify, surfaces, setView, recordIdentity, relayFor, status, storeFor, reconcile,
    syncNotices, probeLog, registryRead, workspaceOperation, open, end, narrow, fetchAccess, closed, recordRefusal, handlers, invoke, openPayload, steps,
    closeRenderer: () => { rendererClosed = true; for (const close of [...closed]) close(); },
    retireRenderer: () => { rendererCurrent = false; } };
}
