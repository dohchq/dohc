import { AUTOMATION_SERVER_MAX_WORKSPACES } from "@dohc/workspace-contracts/relay";
import { startAutomationReplicas, type AutomationReplica } from "./automationReplicas";
import { notFound, RelayError } from "./errors";
import type { CopyReason } from "./storage/automationWorkspaces";

// Copies of workspaces this server keeps, for its automations and for its
// owners' accounts. Only an open visit holds one of the
// AUTOMATION_SERVER_MAX_WORKSPACES places, besides the workspaces whose
// automations run here. Account visits use at most ACCOUNT_VISIT_WORKSPACES
// of them, so automations always keep the rest. One account holds at most
// ACCOUNT_VISITS_PER_ACCOUNT visits at once, so it cannot take the accounts'
// share, and one caller at most ACCOUNT_VISITS_PER_CALLER, so one phone or
// agent cannot take its account's.

/** The workspaces account visits may hold open at once, of AUTOMATION_SERVER_MAX_WORKSPACES. */
export const ACCOUNT_VISIT_WORKSPACES = 48;
/** The account visits one account may hold at once, across its credentials. */
export const ACCOUNT_VISITS_PER_ACCOUNT = 4;
/** The account visits one credential may hold at once. */
export const ACCOUNT_VISITS_PER_CALLER = 4;
// A visit waits this long for its copy to open.
const COPY_OPEN_MS = 30_000;

/**
 * Who a visit is for. An account visit names its credential, such as a
 * session ID, and ends its wait when that request goes. A phone's visit
 * reaches only the workspaces that show on the phone; an agent's has its
 * own scope.
 */
export type CopyVisitor =
  | { reason: "automation" }
  | { reason: "account"; caller: string; signal: AbortSignal; phone: boolean };

/** What the automation server tells the copies, when this server runs automations. */
export interface CopyAutomations {
  /** Every workspace whose automations need a copy, in the order they get one. */
  wanted(): readonly string[];
  /** Those that have a place now. */
  running(): readonly string[];
  /** The copy is ready for an owner's action on its automations. */
  ready(workspaceId: string): boolean;
}

type ReplicaOptions = Parameters<typeof startAutomationReplicas>[0];

export interface ServerCopiesOptions extends Omit<ReplicaOptions, "wanted"> {
  automations?: CopyAutomations;
  /** Tests replace the replicas. */
  startReplicas?: typeof startAutomationReplicas;
}

export type ServerCopies = Awaited<ReturnType<typeof startServerCopies>>;

interface Visit {
  actions: number;
  accountActions: number;
  /** When a copy nothing else needed stopped being needed and left, to put back after an automation visit. */
  times: { incarnation: number; unwantedSinceMs: number; leftAtMs: number | null } | null;
}

export async function startServerCopies(options: ServerCopiesOptions) {
  const { storage, automations } = options;
  const visits = new Map<string, Visit>();
  // Account visits held now, by credential and by account.
  const callerVisits = new Map<string, number>();
  const ownerVisits = new Map<string, number>();
  const waiters = new Set<() => void>();
  const recheck = () => { for (const check of [...waiters]) check(); };

  function wanted(): Map<string, CopyReason[]> {
    const running = automations?.running() ?? [];
    const runs = new Set(running);
    // An admitted visit keeps its place: a workspace that needs the server since waits for it.
    const ids = [...new Set([...visits.keys(), ...running])].slice(0, AUTOMATION_SERVER_MAX_WORKSPACES);
    return new Map(ids.map((workspaceId) => {
      const visit = visits.get(workspaceId);
      const reasons: CopyReason[] = [];
      if (runs.has(workspaceId) || (visit !== undefined && visit.actions > visit.accountActions)) reasons.push("automation");
      if (visit !== undefined && visit.accountActions > 0) reasons.push("account");
      return [workspaceId, reasons];
    }));
  }

  const replicas = await (options.startReplicas ?? startAutomationReplicas)({
    ...options,
    wanted,
    onChanged: (workspaceId) => {
      options.onChanged?.(workspaceId);
      recheck();
    },
  });

  const isOpen = (workspaceId: string) => replicas.replica(workspaceId) !== undefined;
  const count = (counts: Map<string, number>, key: string, by: number) => {
    const next = (counts.get(key) ?? 0) + by;
    if (next > 0) counts.set(key, next);
    else counts.delete(key);
  };

  function busy(visitor: CopyVisitor, message: string): RelayError {
    return visitor.reason === "account" ? new RelayError("server_busy", message, 503) : new RelayError("conflict", message, 503);
  }

  /** Refuses a visit past the server's places, the accounts' share of them, or its account's or caller's limit. */
  function admit(ownerUserId: string, workspaceId: string, visitor: CopyVisitor): void {
    const visit = visits.get(workspaceId);
    const running = new Set(automations?.wanted().slice(0, AUTOMATION_SERVER_MAX_WORKSPACES) ?? []);
    // A workspace holds a place while its automations run here or a visit holds it, whether or not its copy is open yet.
    const occupied = new Set([...running, ...visits.keys()]);
    if (!occupied.has(workspaceId) && occupied.size >= AUTOMATION_SERVER_MAX_WORKSPACES) {
      throw busy(visitor, "Your server has as many workspaces open as it can. Try again later.");
    }
    if (visitor.reason !== "account") return;
    if ((ownerVisits.get(ownerUserId) ?? 0) >= ACCOUNT_VISITS_PER_ACCOUNT) {
      throw busy(visitor, "Your account is already reading as many workspaces as it can. Try again later.");
    }
    if ((callerVisits.get(visitor.caller) ?? 0) >= ACCOUNT_VISITS_PER_CALLER) {
      throw busy(visitor, "This sign-in is already reading as many workspaces as it can. Try again later.");
    }
    const accountHeld = [...visits].filter(([id, held]) => held.accountActions > 0 && !running.has(id)).length;
    if (!running.has(workspaceId) && (visit?.accountActions ?? 0) === 0 && accountHeld >= ACCOUNT_VISIT_WORKSPACES) {
      throw busy(visitor, "Your server has as many workspaces open as it can. Try again later.");
    }
  }

  /** Resolves once the copy is ready for the visitor, or refuses after COPY_OPEN_MS. */
  function opened(workspaceId: string, visitor: CopyVisitor): Promise<void> {
    const ready = () => visitor.reason === "automation" ? (automations?.ready(workspaceId) ?? false) : isOpen(workspaceId);
    const signal = visitor.reason === "account" ? visitor.signal : undefined;
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(check);
        signal?.removeEventListener("abort", abort);
      };
      const check = () => {
        if (!ready()) return;
        done();
        resolve();
      };
      const abort = () => {
        done();
        reject(signal!.reason);
      };
      const timer = setTimeout(() => {
        done();
        reject(busy(visitor, "Your server is opening its copy of this workspace. Try again."));
      }, COPY_OPEN_MS);
      timer.unref?.();
      waiters.add(check);
      if (signal?.aborted) abort();
      else {
        signal?.addEventListener("abort", abort, { once: true });
        check();
      }
    });
  }

  /**
   * Runs `work` on the owner's copy of a workspace, opening it for the
   * visit. An automation visit needs a copy the server already keeps, for
   * run history and Undo; one of a copy kept after the workspace left it
   * runs no schedules, Group triggers or presses, and leaves again a day
   * after the visit. An account visit can open any workspace the account
   * owns that has a sync identity, and a phone's visit only one that shows
   * on the phone. The copy's owner is checked again once it is open.
   */
  async function withServerCopy<T>(ownerUserId: string, workspaceId: string, visitor: CopyVisitor,
    work: (replica: AutomationReplica) => Promise<T>): Promise<T> {
    if (!storage.workspaceIsOwnedBy(workspaceId, ownerUserId)) throw notFound();
    const account = visitor.reason === "account";
    const kept = storage.listAutomationWorkspaces().find((row) => row.workspaceId === workspaceId);
    if (visitor.reason === "account" ? storage.getWorkspaceIdentity(workspaceId) === null || (visitor.phone && !storage.showsOnPhone(ownerUserId, workspaceId))
      : kept?.ownerUserId !== ownerUserId) throw notFound();
    admit(ownerUserId, workspaceId, visitor);
    // Every visit holds the copy open, one waiting to leave included, until
    // it ends. An automation visit puts the copy's times back afterwards.
    // An account visit keeps the copy for the account's own reason, so the
    // copy's wait to leave starts again when the visit ends.
    const visit = visits.get(workspaceId);
    visits.set(workspaceId, {
      actions: (visit?.actions ?? 0) + 1,
      accountActions: (visit?.accountActions ?? 0) + (account ? 1 : 0),
      times: account ? null : visit ? visit.times : kept === undefined || kept.unwantedSinceMs === null ? null
        : { incarnation: kept.incarnation, unwantedSinceMs: kept.unwantedSinceMs, leftAtMs: kept.leftAtMs },
    });
    if (visitor.reason === "account") {
      count(callerVisits, visitor.caller, 1);
      count(ownerVisits, ownerUserId, 1);
    }
    try {
      replicas.reconcile(workspaceId);
      await opened(workspaceId, visitor);
      const replica = replicas.replica(workspaceId);
      if (replica === undefined || replica.ownerUserId !== ownerUserId || !storage.workspaceIsOwnedBy(workspaceId, ownerUserId)) throw notFound();
      return await work(replica);
    } finally {
      if (visitor.reason === "account") {
        count(callerVisits, visitor.caller, -1);
        count(ownerVisits, ownerUserId, -1);
      }
      // Deleting the workspace forgets its visits while they run.
      const current = visits.get(workspaceId);
      if (current !== undefined) {
        const accountActions = current.accountActions - (account ? 1 : 0);
        // The pass this visit joined may have kept the reason "Show on phone" ended meanwhile.
        if (visitor.reason === "account" && visitor.phone && accountActions === 0 && !storage.showsOnPhone(ownerUserId, workspaceId)) {
          storage.endCopyReason(workspaceId, "account");
        }
        if (current.actions > 1) {
          visits.set(workspaceId, { ...current, actions: current.actions - 1, accountActions });
        } else {
          visits.delete(workspaceId);
          if (current.times !== null && !(automations?.wanted() ?? []).includes(workspaceId)) {
            storage.restoreAutomationWorkspaceTimes({ workspaceId, ...current.times });
          }
        }
      }
      replicas.reconcile();
    }
  }

  return {
    withServerCopy,
    /** The open copy of this workspace, or undefined. */
    replica: (workspaceId: string) => replicas.replica(workspaceId),
    /** Ask for a pass; a visit can retry its workspace immediately. */
    reconcile: (workspaceId?: string) => replicas.reconcile(workspaceId),
    /** A copy became ready for automation visits. */
    notifyReady: recheck,
    async deleteWorkspaces(workspaceIds: readonly string[]) {
      for (const id of workspaceIds) visits.delete(id);
      await replicas.deleteWorkspaces(workspaceIds);
    },
    /** Whether this server's copies of workspaces keep failing to open or sync. */
    get unavailable(): boolean {
      return replicas.unavailable;
    },
    close: () => replicas.close(),
  };
}
