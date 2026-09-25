import {
  AUTOMATION_COMPUTERS_PER_WORKSPACE,
  type RelayAutomationComputer,
  type RelayAutomationHost,
  type RelayAutomationHostState,
} from "@dohc/workspace-contracts/relay";
import { badRequest, notFound, relayError } from "../errors";
import type { StorageContext } from "./context";

// Every input names the owner the route authenticated. Each call checks
// ownership again inside its transaction, because reading the request body
// can yield.
interface OwnerScope {
  workspaceId: string;
  ownerUserId: string;
}

export interface AutomationHostCheckInInput extends OwnerScope {
  installId: string;
  label: string;
  claim: boolean;
  nowMs: number;
}

export interface AutomationHostChooseInput extends OwnerScope {
  installId: string;
  generation: number;
}

export interface AutomationHostReleaseInput extends OwnerScope {
  installId: string;
  generation: number;
  releasedThroughMs: number;
}

export interface AutomationHostTakeOverInput extends OwnerScope {
  generation: number;
}

function requireOwner(storage: StorageContext, scope: OwnerScope): void {
  if (!storage.workspaceIsOwnedBy(scope.workspaceId, scope.ownerUserId)) throw notFound();
}

function readHost(storage: StorageContext, workspaceId: string): RelayAutomationHost | null {
  const row = storage.db.prepare(
    `SELECT install_id, generation, handover_from, released_through_ms
     FROM sync_relay_automation_hosts WHERE workspace_id = ?`,
  ).get(workspaceId);
  if (!row) return null;
  return {
    installId: String(row.install_id),
    generation: Number(row.generation),
    handoverFrom: row.handover_from === null ? null : String(row.handover_from),
    releasedThroughMs: row.released_through_ms === null ? null : Number(row.released_through_ms),
  };
}

function readState(storage: StorageContext, workspaceId: string): RelayAutomationHostState {
  const computers: RelayAutomationComputer[] = storage.db.prepare(
    `SELECT install_id, label, last_seen_ms FROM sync_relay_automation_computers
     WHERE workspace_id = ? ORDER BY last_seen_ms DESC, install_id`,
  ).all(workspaceId).map((row) => ({
    installId: String(row.install_id),
    label: String(row.label),
    lastSeenMs: Number(row.last_seen_ms),
  }));
  return { host: readHost(storage, workspaceId), computers };
}

// A change names the generation it read: 0 when there was no host.
function requireGeneration(host: RelayAutomationHost | null, generation: number): void {
  if ((host?.generation ?? 0) !== generation) throw relayError("conflict");
}

function writeHost(
  storage: StorageContext,
  workspaceId: string,
  next: Omit<RelayAutomationHost, "generation">,
  previous: RelayAutomationHost | null,
): void {
  storage.db.prepare(
    `INSERT INTO sync_relay_automation_hosts
       (workspace_id, install_id, generation, handover_from, released_through_ms)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       install_id = excluded.install_id, generation = excluded.generation,
       handover_from = excluded.handover_from, released_through_ms = excluded.released_through_ms`,
  ).run(workspaceId, next.installId, (previous?.generation ?? 0) + 1, next.handoverFrom, next.releasedThroughMs);
}

// The latest progress any computer that handed over reported. A later
// release can only move it forward.
function laterProgress(previous: number | null, reported: number): number {
  return previous === null ? reported : Math.max(previous, reported);
}

export function readAutomationHost(storage: StorageContext, scope: OwnerScope): RelayAutomationHostState {
  return storage.readTx(() => {
    requireOwner(storage, scope);
    return readState(storage, scope.workspaceId);
  });
}

// Records the computer as seen now. A new computer past the bound makes room
// by forgetting the one seen longest ago that is neither the host nor
// handing over. With `claim`, the computer becomes the host if none is
// recorded.
export function checkInAutomationComputer(
  storage: StorageContext,
  input: AutomationHostCheckInInput,
): RelayAutomationHostState {
  return storage.tx(() => {
    requireOwner(storage, input);
    const { workspaceId, installId } = input;
    const host = readHost(storage, workspaceId);
    const known = storage.db.prepare(
      "SELECT 1 FROM sync_relay_automation_computers WHERE workspace_id = ? AND install_id = ?",
    ).get(workspaceId, installId);
    if (!known) {
      const count = Number(storage.db.prepare(
        "SELECT COUNT(*) AS n FROM sync_relay_automation_computers WHERE workspace_id = ?",
      ).get(workspaceId)?.n);
      if (count >= AUTOMATION_COMPUTERS_PER_WORKSPACE) {
        storage.db.prepare(
          `DELETE FROM sync_relay_automation_computers WHERE workspace_id = ? AND install_id = (
             SELECT install_id FROM sync_relay_automation_computers
             WHERE workspace_id = ? AND install_id IS NOT ? AND install_id IS NOT ?
             ORDER BY last_seen_ms, install_id LIMIT 1)`,
        ).run(workspaceId, workspaceId, host?.installId ?? null, host?.handoverFrom ?? null);
      }
    }
    storage.db.prepare(
      `INSERT INTO sync_relay_automation_computers (workspace_id, install_id, label, last_seen_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, install_id) DO UPDATE SET
         label = excluded.label, last_seen_ms = excluded.last_seen_ms`,
    ).run(workspaceId, installId, input.label, input.nowMs);
    if (input.claim && !host) {
      writeHost(storage, workspaceId, { installId, handoverFrom: null, releasedThroughMs: null }, null);
    }
    return readState(storage, workspaceId);
  });
}

// The owner picks another checked-in computer. The computer running now
// hands over to it; while a handover waits, the computer still running keeps
// handing over, and choosing it back cancels the handover. The progress
// earlier handovers reported stays.
export function chooseAutomationHost(
  storage: StorageContext,
  input: AutomationHostChooseInput,
): RelayAutomationHostState {
  return storage.tx(() => {
    requireOwner(storage, input);
    const { workspaceId, installId } = input;
    const host = readHost(storage, workspaceId);
    requireGeneration(host, input.generation);
    const known = storage.db.prepare(
      "SELECT 1 FROM sync_relay_automation_computers WHERE workspace_id = ? AND install_id = ?",
    ).get(workspaceId, installId);
    if (!known) throw badRequest("installId is not one of this workspace's computers");
    if (host?.installId === installId) return readState(storage, workspaceId);
    // The computer that is still running: the one handing over, or else the host.
    const running = host === null ? null : host.handoverFrom ?? host.installId;
    writeHost(storage, workspaceId, {
      installId,
      handoverFrom: running === installId ? null : running,
      releasedThroughMs: host?.releasedThroughMs ?? null,
    }, host);
    return readState(storage, workspaceId);
  });
}

// The computer handing over has stopped. The host starts after the latest
// progress any computer that handed over reported, so a computer that
// missed an earlier release cannot move it back.
export function releaseAutomationHost(
  storage: StorageContext,
  input: AutomationHostReleaseInput,
): RelayAutomationHostState {
  return storage.tx(() => {
    requireOwner(storage, input);
    const host = readHost(storage, input.workspaceId);
    requireGeneration(host, input.generation);
    if (!host || host.handoverFrom !== input.installId) throw relayError("conflict");
    writeHost(storage, input.workspaceId, {
      installId: host.installId,
      handoverFrom: null,
      releasedThroughMs: laterProgress(host.releasedThroughMs, input.releasedThroughMs),
    }, host);
    return readState(storage, input.workspaceId);
  });
}

// The owner ends a handover without the old computer's release. The
// progress earlier handovers reported stays.
export function takeOverAutomationHost(
  storage: StorageContext,
  input: AutomationHostTakeOverInput,
): RelayAutomationHostState {
  return storage.tx(() => {
    requireOwner(storage, input);
    const host = readHost(storage, input.workspaceId);
    requireGeneration(host, input.generation);
    if (!host?.handoverFrom) throw relayError("conflict");
    writeHost(storage, input.workspaceId, {
      installId: host.installId,
      handoverFrom: null,
      releasedThroughMs: host.releasedThroughMs,
    }, host);
    return readState(storage, input.workspaceId);
  });
}
