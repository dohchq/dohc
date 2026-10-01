import type { RelayButtonAuthority, RelayButtonInspection, RelayButtonInspectionRequest, RelayButtonTarget } from "@dohc/workspace-contracts/relay";
import { SHARED_BUTTON_UNCHECKED, SHARED_BUTTON_DENIED } from "@dohc/automation-executor/button-presser";
import type { StorageContext } from "./storage/context";
import { buttonAuthority, isRunningHost, type HostScope } from "./storage/automationPresses";
import { notFound, relayError, RelayError } from "./errors";
import { notifyRelayWrite } from "./relayWriteChanges";

const brokers = new WeakMap<StorageContext, Map<string, Map<string, Pending>>>();
const polls = new WeakMap<StorageContext, Map<string, { scope: HostScope; at: number }>>();
export const BUTTON_INSPECTION_HOST_LIVE_MS = 75_000;
export function parkButtonInspectionHost(storage: StorageContext, scope: HostScope): () => void {
  if (!isRunningHost(storage, scope)) return () => {};
  let hosts = polls.get(storage);
  if (!hosts) { hosts = new Map(); polls.set(storage, hosts); }
  const poll = { scope, at: Date.now() };
  hosts.set(scope.workspaceId, poll);
  return () => { if (hosts.get(scope.workspaceId) === poll) poll.at = Date.now(); };
}
interface Pending {
  request: RelayButtonInspectionRequest;
  source: Parameters<typeof buttonAuthority>[1];
  generation: number;
  resolve(result: RelayButtonInspection): void;
}
export interface ButtonInspectionSource {
  workspaceId: string; shareId: string; grantId: string; grantGeneration: number; userId: string;
}
export interface ButtonInspectionInput {
  target: RelayButtonTarget;
  source: ButtonInspectionSource;
  id: string;
  signal: AbortSignal;
  wake(): void;
}
const pending = (storage: StorageContext, workspaceId: string) => {
  let workspaces = brokers.get(storage);
  if (!workspaces) { workspaces = new Map(); brokers.set(storage, workspaces); }
  let value = workspaces.get(workspaceId);
  if (!value) { value = new Map(); workspaces.set(workspaceId, value); }
  return value;
};

/** Bounded, short-lived requests. An unreachable host supplies no access verdict. */
export function inspectAutomationButton(storage: StorageContext, { target, source, id, signal, wake }: ButtonInspectionInput): Promise<RelayButtonInspection> {
  const row = storage.db.prepare("SELECT generation,handover_from FROM sync_relay_automation_hosts WHERE workspace_id=?").get(source.workspaceId);
  const poll = polls.get(storage)?.get(source.workspaceId);
  if (!poll || Date.now() - poll.at > BUTTON_INSPECTION_HOST_LIVE_MS || !isRunningHost(storage, poll.scope) || !row || row.handover_from !== null) return Promise.resolve({ kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED });
  const requests = pending(storage, source.workspaceId);
  if (requests.size >= 50) return Promise.resolve({ kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED });
  const host = { generation: Number(row.generation) };
  const scope = { ...source, ...target };
  buttonAuthority(storage, scope, host.generation);
  return new Promise(resolve => {
    const finish = (result: RelayButtonInspection) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort); requests.delete(id);
      if (requests.size === 0) brokers.get(storage)?.delete(source.workspaceId);
      resolve(result);
    };
    const abort = () => finish({ kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED });
    const timer = setTimeout(abort, 10_000);
    requests.set(id, { request: { ...target, inspectionId: id }, source: scope, generation: host.generation, resolve: finish });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else { wake(); notifyRelayWrite(storage); }
  });
}

export function listButtonInspections(storage: StorageContext, scope: HostScope): RelayButtonInspectionRequest[] {
  if (!isRunningHost(storage, scope)) return [];
  return [...(brokers.get(storage)?.get(scope.workspaceId)?.values() ?? [])].map(entry => entry.request);
}

export function resolveButtonInspection(storage: StorageContext, scope: HostScope & { generation: number; inspectionId: string }): RelayButtonAuthority {
  const held = brokers.get(storage)?.get(scope.workspaceId)?.get(scope.inspectionId);
  if (!held || held.source.workspaceId !== scope.workspaceId) throw notFound();
  if (held.generation !== scope.generation || !isRunningHost(storage, scope)) throw relayError("conflict");
  return buttonAuthority(storage, held.source, scope.generation);
}

export function answerButtonInspection(storage: StorageContext, scope: HostScope & { generation: number; inspectionId: string }, result: RelayButtonInspection): void {
  const held = brokers.get(storage)?.get(scope.workspaceId)?.get(scope.inspectionId);
  if (!held || held.source.workspaceId !== scope.workspaceId || !storage.workspaceIsOwnedBy(scope.workspaceId, scope.ownerUserId)) throw notFound();
  if (held.generation !== scope.generation || !isRunningHost(storage, scope)) {
    held.resolve({ kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED });
    throw notFound();
  }
  try { resolveButtonInspection(storage, scope); }
  catch (error) {
    held.resolve(error instanceof RelayError && (error.code === "not_found" || error.code === "share_read_only")
      ? { kind: "denied", reason: SHARED_BUTTON_DENIED } : { kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED });
    throw error;
  }
  if (result.kind === "ready" && (result.automationId !== held.request.automationId || result.definitionHash !== held.request.definitionHash)) {
    held.resolve({ kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED });
    throw notFound();
  }
  held.resolve(result);
}
