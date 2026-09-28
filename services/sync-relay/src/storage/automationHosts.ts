import {
  AUTOMATION_COMPUTERS_PER_WORKSPACE,
  AUTOMATION_SERVER_INSTALL_ID,
  AUTOMATION_SERVER_MAX_WORKSPACES,
  type RelayAutomationComputer,
  type RelayAutomationHost,
  type RelayAutomationHostState,
} from "@dohc/workspace-contracts/relay";
import { badRequest, notFound, relayError } from "../errors";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";

// The relay's last release or take over, at most one per workspace: the
// host generation it started, the computer it named, and the Group handover
// a release carried. A take over writes a mark with no handover. A reader
// compares the generation with the one it last watched at to tell whether
// another computer may have run since.
export function initializeAutomationGroupHandoverSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_automation_group_handovers (
      workspace_id TEXT NOT NULL PRIMARY KEY
        REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
      for_install_id TEXT NOT NULL CHECK (length(for_install_id) BETWEEN 1 AND 256),
      took_over INTEGER NOT NULL CHECK (took_over IN (0, 1)),
      groups_json TEXT NOT NULL CHECK (json_valid(groups_json) AND length(groups_json) <= 4194304)
    ) STRICT;
  `);
}

// A computer the relay made the host itself, from a claim that found none.
// The owner's choice and a take over delete it. While the server runs
// automations, only a host placed this way hands over to it.
export function initializeAutomationHostPlacementSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_automation_host_placements (
      workspace_id TEXT NOT NULL PRIMARY KEY
        REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      install_id TEXT NOT NULL CHECK (length(install_id) BETWEEN 1 AND 256)
    ) STRICT;
  `);
}

function keepGroupHandover(
  storage: StorageContext,
  workspaceId: string,
  row: { generation: number; forInstallId: string; tookOver: boolean; groups: string },
): void {
  storage.db.prepare(
    `INSERT INTO sync_relay_automation_group_handovers
       (workspace_id, generation, for_install_id, took_over, groups_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       generation = excluded.generation, for_install_id = excluded.for_install_id,
       took_over = excluded.took_over, groups_json = excluded.groups_json`,
  ).run(workspaceId, row.generation, row.forInstallId, row.tookOver ? 1 : 0, row.groups);
}

// Every input names the owner the route authenticated. Each call checks
// ownership again inside its transaction, because reading the request body
// can yield.
interface OwnerScope {
  workspaceId: string;
  ownerUserId: string;
}

// The dohc server while it runs automations, as its deployment configures
// it; null when it does not.
export interface AutomationServer {
  label: string;
}

export interface AutomationHostReadInput extends OwnerScope {
  server: AutomationServer | null;
  nowMs: number;
}

export interface AutomationHostCheckInInput extends AutomationHostReadInput {
  installId: string;
  label: string;
  claim: boolean;
}

export interface AutomationHostChooseInput extends AutomationHostReadInput {
  installId: string;
  generation: number;
}

export interface AutomationHostReleaseInput extends AutomationHostReadInput {
  installId: string;
  generation: number;
  releasedThroughMs: number;
  /** The Group handover, as JSON text. */
  groups: string;
  /** The host generation the releasing computer last watched its Group subscriptions at. */
  groupsWatched: number;
}

export interface AutomationGroupHandoverInput extends OwnerScope {
  generation: number;
}

export interface AutomationHostTakeOverInput extends AutomationHostReadInput {
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

function readState(storage: StorageContext, input: AutomationHostReadInput): RelayAutomationHostState {
  const computers: RelayAutomationComputer[] = storage.db.prepare(
    `SELECT install_id, label, last_seen_ms FROM sync_relay_automation_computers
     WHERE workspace_id = ? ORDER BY last_seen_ms DESC, install_id`,
  ).all(input.workspaceId).map((row) => ({
    installId: String(row.install_id),
    kind: "computer",
    label: String(row.label),
    lastSeenMs: Number(row.last_seen_ms),
  }));
  if (input.server) {
    computers.unshift({
      installId: AUTOMATION_SERVER_INSTALL_ID, kind: "server", label: input.server.label, lastSeenMs: input.nowMs,
    });
  }
  return { host: readHost(storage, input.workspaceId), computers };
}

// The computer the relay placed as the host itself, or null.
function placement(storage: StorageContext, workspaceId: string): string | null {
  const row = storage.db.prepare(
    "SELECT install_id FROM sync_relay_automation_host_placements WHERE workspace_id = ?",
  ).get(workspaceId);
  return row ? String(row.install_id) : null;
}

function place(storage: StorageContext, workspaceId: string, installId: string | null): void {
  if (installId === null) {
    storage.db.prepare("DELETE FROM sync_relay_automation_host_placements WHERE workspace_id = ?").run(workspaceId);
    return;
  }
  storage.db.prepare(
    `INSERT INTO sync_relay_automation_host_placements (workspace_id, install_id) VALUES (?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET install_id = excluded.install_id`,
  ).run(workspaceId, installId);
}

// Whether the server can run this workspace's automations: it already does,
// or it runs them for fewer workspaces than its limit.
function serverHasRoom(storage: StorageContext, workspaceId: string): boolean {
  const others = Number(storage.db.prepare(
    `SELECT COUNT(*) AS n FROM sync_relay_automation_hosts
     WHERE (install_id = ? OR handover_from = ?) AND workspace_id <> ?`,
  ).get(AUTOMATION_SERVER_INSTALL_ID, AUTOMATION_SERVER_INSTALL_ID, workspaceId)?.n);
  return others < AUTOMATION_SERVER_MAX_WORKSPACES;
}

// `installId` starts because the server stopped running automations
// without a release. The server ran in this process, so it ran nothing after
// this process's clock reads now: the relay records now as released, and
// the computer starts after it, as after a release. The progress never goes
// back, and a computer whose clock runs behind never runs again what the
// server ran.
function startWithoutHandover(
  storage: StorageContext,
  workspaceId: string,
  host: RelayAutomationHost,
  installId: string,
  nowMs: number,
): void {
  writeHost(storage, workspaceId, {
    installId, handoverFrom: null, releasedThroughMs: laterProgress(host.releasedThroughMs, nowMs),
  }, host);
  keepGroupHandover(storage, workspaceId, {
    generation: host.generation + 1, forInstallId: installId, tookOver: true, groups: "{}",
  });
}

// While the server runs no automations, a record that still counts on it is
// repaired. When the server was the one running, it cannot be now, since it
// is this process: the host becomes `claimant`, or the computer the server
// was handing over to, and starts after now. When a computer was handing over
// to the server, that computer never stopped: the handover is called off,
// as choosing that computer back does.
function repairWithoutServer(storage: StorageContext, workspaceId: string, claimant: string | null, nowMs: number): void {
  const host = readHost(storage, workspaceId);
  if (!host) return;
  const running = host.handoverFrom ?? host.installId;
  if (running === AUTOMATION_SERVER_INSTALL_ID) {
    if (host.installId !== AUTOMATION_SERVER_INSTALL_ID) {
      startWithoutHandover(storage, workspaceId, host, host.installId, nowMs);
    } else if (claimant !== null) {
      startWithoutHandover(storage, workspaceId, host, claimant, nowMs);
      place(storage, workspaceId, claimant);
    }
  } else if (host.installId === AUTOMATION_SERVER_INSTALL_ID) {
    writeHost(storage, workspaceId, {
      installId: running, handoverFrom: null, releasedThroughMs: host.releasedThroughMs,
    }, host);
  }
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

export function readAutomationHost(storage: StorageContext, input: AutomationHostReadInput): RelayAutomationHostState {
  return storage.readTx(() => {
    requireOwner(storage, input);
    return readState(storage, input);
  });
}

// Records the computer as seen now. A new computer past the bound makes room
// by forgetting the one seen longest ago that is neither the host nor
// handing over. With `claim`, a host is recorded if none is: the server
// while it runs automations and has room, or else this computer. While the
// server runs automations, a computer the relay placed as the host hands
// over to it now, since that computer is on to release. While it does not,
// a record that still counts on the server is repaired first.
export function checkInAutomationComputer(
  storage: StorageContext,
  input: AutomationHostCheckInInput,
): RelayAutomationHostState {
  return storage.tx(() => {
    requireOwner(storage, input);
    const { workspaceId, installId } = input;
    if (installId === AUTOMATION_SERVER_INSTALL_ID) throw badRequest("installId is reserved for the server");
    if (!input.server) repairWithoutServer(storage, workspaceId, input.claim ? installId : null, input.nowMs);
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
      const toServer = input.server !== null && serverHasRoom(storage, workspaceId);
      writeHost(storage, workspaceId, {
        installId: toServer ? AUTOMATION_SERVER_INSTALL_ID : installId, handoverFrom: null, releasedThroughMs: null,
      }, null);
      place(storage, workspaceId, toServer ? null : installId);
    } else if (
      input.server && host?.installId === installId && host.handoverFrom === null &&
      placement(storage, workspaceId) === installId && serverHasRoom(storage, workspaceId)
    ) {
      // The placement stays through the handover, so a handover called off
      // leaves the computer placed, not chosen.
      writeHost(storage, workspaceId, {
        installId: AUTOMATION_SERVER_INSTALL_ID, handoverFrom: installId, releasedThroughMs: host.releasedThroughMs,
      }, host);
    }
    return readState(storage, input);
  });
}

// The owner picks another checked-in computer, or the server while it runs
// automations and has room. The computer running now hands over to it; while
// a handover waits, the computer still running keeps handing over, and
// choosing it back cancels the handover. When the server was running and no
// longer runs automations, it cannot hand over, so the chosen computer
// starts after now. The progress earlier handovers reported stays. The choice
// is the owner's, so the relay's own placement ends.
export function chooseAutomationHost(
  storage: StorageContext,
  input: AutomationHostChooseInput,
): RelayAutomationHostState {
  return storage.tx(() => {
    requireOwner(storage, input);
    const { workspaceId, installId } = input;
    const host = readHost(storage, workspaceId);
    requireGeneration(host, input.generation);
    if (installId === AUTOMATION_SERVER_INSTALL_ID) {
      if (!input.server) throw badRequest("This server does not run automations.");
      if (!serverHasRoom(storage, workspaceId)) {
        throw badRequest("This server is running automations for as many workspaces as it can.");
      }
    } else {
      const known = storage.db.prepare(
        "SELECT 1 FROM sync_relay_automation_computers WHERE workspace_id = ? AND install_id = ?",
      ).get(workspaceId, installId);
      if (!known) throw badRequest("installId is not one of this workspace's computers");
    }
    place(storage, workspaceId, null);
    // The computer that is still running: the one handing over, or else the host.
    const running = host === null ? null : host.handoverFrom ?? host.installId;
    if (host !== null && running === AUTOMATION_SERVER_INSTALL_ID && !input.server) {
      startWithoutHandover(storage, workspaceId, host, installId, input.nowMs);
      return readState(storage, input);
    }
    if (host?.installId === installId) return readState(storage, input);
    writeHost(storage, workspaceId, {
      installId,
      handoverFrom: running === installId ? null : running,
      releasedThroughMs: host?.releasedThroughMs ?? null,
    }, host);
    return readState(storage, input);
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
    // A computer that has not watched since the relay's last record ran
    // nothing since, so its own handover is stale. The record goes on
    // instead: a handover that computer never took, or, after a take over
    // it never watched at, a mark, so the next computer starts from now.
    const held = storage.db.prepare(
      "SELECT generation, took_over, groups_json FROM sync_relay_automation_group_handovers WHERE workspace_id = ?",
    ).get(input.workspaceId);
    const stale = held !== undefined && input.groupsWatched < Number(held.generation);
    keepGroupHandover(storage, input.workspaceId, {
      generation: host.generation + 1,
      forInstallId: host.installId,
      tookOver: stale && held.took_over === 1,
      groups: stale ? String(held.groups_json) : input.groups,
    });
    return readState(storage, input);
  });
}

// The relay's last release or take over, read at the current host's
// generation: the generation it started, and the Group handover when a
// release left it for the current host. It stays across a handover the owner
// called off, until the next release or take over replaces it.
export function readAutomationGroupHandover(
  storage: StorageContext,
  input: AutomationGroupHandoverInput,
): { generation: number | null; groups: Record<string, unknown> | null } {
  return storage.readTx(() => {
    requireOwner(storage, input);
    const host = readHost(storage, input.workspaceId);
    if (!host || host.generation !== input.generation) throw relayError("conflict");
    const row = storage.db.prepare(
      "SELECT generation, for_install_id, took_over, groups_json FROM sync_relay_automation_group_handovers WHERE workspace_id = ?",
    ).get(input.workspaceId);
    if (!row) return { generation: null, groups: null };
    const mine = row.took_over === 0 && row.for_install_id === host.installId;
    return {
      generation: Number(row.generation),
      groups: mine ? JSON.parse(String(row.groups_json)) as Record<string, unknown> : null,
    };
  });
}

// The owner ends a handover without the old computer's release. The
// progress earlier handovers reported stays. The server takes over only
// while it runs automations.
export function takeOverAutomationHost(
  storage: StorageContext,
  input: AutomationHostTakeOverInput,
): RelayAutomationHostState {
  return storage.tx(() => {
    requireOwner(storage, input);
    const host = readHost(storage, input.workspaceId);
    requireGeneration(host, input.generation);
    if (!host?.handoverFrom) throw relayError("conflict");
    if (host.installId === AUTOMATION_SERVER_INSTALL_ID && !input.server) {
      throw badRequest("This server does not run automations.");
    }
    writeHost(storage, input.workspaceId, {
      installId: host.installId,
      handoverFrom: null,
      releasedThroughMs: host.releasedThroughMs,
    }, host);
    keepGroupHandover(storage, input.workspaceId, {
      generation: host.generation + 1,
      forInstallId: host.installId,
      tookOver: true,
      groups: "{}",
    });
    place(storage, input.workspaceId, null);
    return readState(storage, input);
  });
}
