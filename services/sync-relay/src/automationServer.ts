import { createHash } from "node:crypto";
import { posix } from "node:path";
import { AutomationScheduler, type SchedulerClock, type ScheduleRecord } from "@dohc/automation-executor/automation-scheduler";
import { createAutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { cutText } from "@dohc/automation-executor/automation-chat";
import { automationFailedNotice, automationFailedNoticeId, type ReportedRun } from "@dohc/automation-executor/automation-failed-notice";
import { createAutomationRunStore, type MetadataDirResolver } from "@dohc/automation-executor/automation-run-store";
import {
  CollectionAutomations,
  type CollectionAutomationsOptions,
  type RunAdmission,
} from "@dohc/automation-executor/collection-automations";
import { claimPerson } from "@dohc/automation-executor/collection-automation-run";
import { collectionRecordWrites } from "@dohc/automation-executor/collection-record-edits";
import { groupMessagesNotice } from "@dohc/automation-executor/group-messages-notice";
import { parseReachHandover } from "@dohc/automation-executor/reach-verdicts";
import {
  createRelayedPressHost,
  relayedPressFailureNotice,
  type PressHostSeam,
  type PressTransport,
  type RelayedPressHost,
} from "@dohc/automation-executor/relayed-presses";
import { listRosterGrants, ownerRoster } from "@dohc/automation-executor/roster-listing";
import { skippedRunsNotice } from "@dohc/automation-executor/skipped-runs-notice";
import type { TokenBucketLimiter } from "@dohc/service-http";
import {
  AUTOMATION_COMPUTER_LABEL_MAX_CHARS,
  AUTOMATION_SERVER_INSTALL_ID,
  type RelayAutomationHost,
} from "@dohc/workspace-contracts/relay";
import {
  AUTOMATION_CLAIMED_EVENT,
  decodeAutomationGroupHandover,
  type Event,
  type JsonValue,
} from "@dohc/workspace-engine-client";
import { replicaAutomationChat, replicaChatStore, replicaNoticePoster, WAKE_ON_SERVER } from "./automationChatWrites";
import { ServerClaimEngine, type LiveClaimLedger } from "./automationLiveClaims";
import { replicaRecordEditContext, replicaRecordEngine } from "./automationRecordEdits";
import { startAutomationReplicas, type AutomationReplica } from "./automationReplicas";
import { RelayError } from "./errors";
import { observeRelayWrites } from "./relayWriteChanges";
import type { SyncRelayStorage } from "./storage";
import type { AutomationServer, AutomationServerSchedules } from "./storage/automationHosts";

// This server runs the automations of every workspace whose host record
// names it (ADR 0012, docs/plans relay host design item 5). Each workspace
// runs in the server's replica of it, through the same executor the owner's
// computers run, with the owner's authority from the relay's own records:
// its owner, its editors, and its host. The server follows the host record
// in process. When the record names it, it runs the workspace's schedules,
// Group triggers, and presses from shared views; when the owner moves them
// to a computer, it stops its Group triggers, steps its schedules one last
// time, and releases with its Group coverage and reach verdicts. A write to
// the relay wakes it; nothing polls.
//
// One tenant must not starve another: runs are bounded per workspace by a
// token bucket and across the server by a count of runs at once. A claim
// past either stays pending in its replica's engine.

/** At most this many runs at once across the server. */
export const SERVER_CONCURRENT_RUNS = 4;
/** Each workspace may start this many runs at once... */
export const SERVER_RUN_BURST = 120;
/** ...then one every this long: 360 an hour. */
export const SERVER_RUN_REFILL_MS = 10_000;

// A handover the server could not finish tries again after this long,
// doubling to the cap, if no relay write wakes it first.
const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 60_000;
// A failed sync of a copy tries again after this long, doubling to the cap,
// and is reported once it has failed this many times in a row.
const SYNC_RETRY_FIRST_MS = 1_000;
const SYNC_RETRY_MAX_MS = 60_000;
const SYNC_FAILURES_REPORTED = 3;
// An in-process press list waits this long for a press, as the route's
// long poll does.
const PRESS_WAIT_MS = 25_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the server drives in each workspace's executor. CollectionAutomations satisfies it. */
export type ServerExecutor = Pick<
  CollectionAutomations,
  | "open" | "dispose" | "notifyClaimed" | "handlePulledPaths" | "relayAnswered" | "groupMessagesArrived" | "hostChanged"
  | "releaseGroupSubscriptions" | "reachHandover" | "relayedClaim" | "pressRelayed" | "automationName"
  | "schedules" | "scheduleMarks" | "claimSchedule" | "failuresChanged"
>;

export interface AutomationServerOptions {
  storage: SyncRelayStorage;
  /** This server, as the owner's settings name it. */
  server: AutomationServer;
  replicas: Omit<Parameters<typeof startAutomationReplicas>[0], "storage" | "wanted" | "onChanged" | "onEngineEvent" | "onPulled" | "onReconciled" | "onError">;
  /** A GET of the owner's share listings, answered in process (createSyncRelayHandler's readOwnerShares). */
  readOwnerShares(ownerUserId: string, path: string): Promise<{ status: number; body: unknown }>;
  lookupUserDisplayName(userId: string): Promise<string | null> | string | null;
  /** The notice route's limiter, so the server and the owner's computers share one limit per person. */
  noticeLimiter: TokenBucketLimiter;
  /**
   * The live host, which claims the field changes of the live-shared records
   * it holds. Absent where this server holds no live documents.
   */
  live?: {
    ledger(workspaceId: string): LiveClaimLedger | null;
    /** Workspaces with a live-shared record in a folder that has automations. */
    workspaces(): readonly string[];
    onEvent(handler: (event: Event) => void): () => void;
  };
  onError(context: string, error: unknown): void;
  nowMs?(): number;
  clock?: SchedulerClock;
  /** Tests replace the replicas and the executor. */
  startReplicas?: typeof startAutomationReplicas;
  createExecutor?(options: CollectionAutomationsOptions): ServerExecutor;
}

/** One workspace this server runs, before its executor and press loop exist. */
interface WorkspaceState {
  readonly replica: AutomationReplica;
  /** The copy's engine, with the live host's claims beside its own. */
  readonly adapter: ServerClaimEngine;
  /** The host record as the server last acted on it. */
  host: RelayAutomationHost | null;
  /** The host record the schedules started from, kept once the scheduler has its marks. */
  pendingStart: { generation: number; releasedThroughMs: number | null } | null;
  handingOver: boolean;
  /** No handover try before this, after one failed. */
  retryAtMs: number;
  retryMs: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Work admitted as host that a handover waits for. */
  readonly held: Set<Promise<void>>;
  closed: boolean;
  syncing: Promise<void> | null;
  syncAgain: boolean;
  /** Syncs that failed in a row, and the timer that tries again. */
  syncFailures: number;
  syncTimer: ReturnType<typeof setTimeout> | undefined;
  reporting: Promise<void>;
  readonly names: Map<string, string>;
}

interface Hosted extends WorkspaceState {
  readonly executor: ServerExecutor;
  readonly presses: RelayedPressHost;
}

const runsOn = (host: RelayAutomationHost | null): host is RelayAutomationHost =>
  host?.installId === AUTOMATION_SERVER_INSTALL_ID && host.handoverFrom === null;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A metadata folder that is always this one: the replica made it beside its workspace. */
function metadataDirOf(dir: string): MetadataDirResolver {
  function resolve(rootPath: string): Promise<string>;
  function resolve(rootPath: string, options: { create: false }): Promise<string | null>;
  async function resolve(): Promise<string | null> {
    return dir;
  }
  return resolve;
}

export async function startAutomationServer(options: AutomationServerOptions) {
  const { storage, server } = options;
  const nowMs = options.nowMs ?? Date.now;
  const hosted = new Map<string, Hosted>();
  const evaluator = createAutomationFormulaEvaluator();
  const gate = createRunGate({ nowMs, onWaiting: (workspaceId) => overBudget(workspaceId) });
  let unavailable = false;
  let closed = false;

  // Waiters for the next relay write, as a press list waits for a press.
  const waiters = new Set<() => void>();
  function nextWrite(signal: AbortSignal, timeoutMs: number, until: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(check);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const check = () => { if (until()) done(); };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      signal.addEventListener("abort", done, { once: true });
      waiters.add(check);
    });
  }

  const scheduler = new AutomationScheduler({
    clock: options.clock ?? {
      now: Date.now,
      monotonic: () => performance.now(),
      setTimer: (wake, delayMs) => setTimeout(wake, delayMs).unref(),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    },
    onError: (context, error) => options.onError(`schedules: ${context}`, error),
    // How far the server's schedules ran, kept so that turning automations
    // off never lets a computer run again what the server ran.
    onRecord: (workspaceId, record) => {
      const throughMs = latestMark(record);
      if (throughMs !== null) storage.recordAutomationServerProgress({ workspaceId, throughMs });
      // The marks this start set are in the engine now, so a restart need not start again.
      const ws = hosted.get(workspaceId);
      if (record !== null && ws?.pendingStart) {
        storage.recordAutomationServerStart({ workspaceId, incarnation: ws.replica.incarnation, ...ws.pendingStart });
        ws.pendingStart = null;
      }
    },
    onSkipped: async (workspaceId, schedule, skipped) => {
      const ws = hosted.get(workspaceId);
      if (!ws) throw new Error("This server no longer runs this workspace's automations.");
      const { workspaceId: _workspace, ...notice } = skippedRunsNotice({ workspaceId, schedule, skipped });
      await posterOf(ws)({ ...notice, recipientUserId: ws.replica.ownerUserId }, ws.replica.signal);
    },
    onSkipWithdrawn: async (workspaceId, schedule, skipped) => {
      const ws = hosted.get(workspaceId);
      if (!ws) return;
      storage.markNotices({
        recipientUserId: ws.replica.ownerUserId,
        marks: [{ noticeId: skippedRunsNotice({ workspaceId, schedule, skipped }).noticeId, mark: "dismissed" }],
        nowMs: nowMs(),
      });
    },
  });

  // --- The host record, followed in process. ---

  const hostOf = (ws: WorkspaceState) => storage.automationHostRecord(ws.replica.workspaceId);
  /** The host generation the server runs the workspace at now, or null: nothing awaited. */
  const runningGeneration = (ws: WorkspaceState): number | null => {
    const host = hostOf(ws);
    return !ws.closed && !ws.handingOver && runsOn(host) ? host.generation : null;
  };
  const stillRuns = (ws: WorkspaceState) => runningGeneration(ws) !== null;

  /** Where the workspace's schedules and presses run, as its scheduler and press loop ask. */
  function hostSeam(ws: WorkspaceState, self: () => Hosted): PressHostSeam {
    return {
      runsHere: async () => {
        follow(self());
        return stillRuns(ws);
      },
      stillRuns: () => stillRuns(ws),
      generation: () => runningGeneration(ws),
      hold: () => hold(ws),
    };
  }

  /** Acts on the host record as it is now: start, hand over, or tell the executor. */
  function follow(ws: Hosted): void {
    if (ws.closed) return;
    const { workspaceId } = ws.replica;
    const host = hostOf(ws);
    const before = ws.host;
    ws.host = host;
    if (runsOn(host) && !runsOn(before)) {
      // A restart that finds the record it started from starts nothing again.
      const kept = storage.readAutomationServerSchedules(workspaceId);
      if (kept?.hostGeneration !== host.generation) {
        const released = host.releasedThroughMs;
        if (kept !== null && kept.throughMs !== null && kept.hostGeneration === null) {
          // An earlier copy ran this workspace's schedules, and this one has
          // not started yet: it lost that copy's marks, whatever the host
          // record did since. Its schedules resume at the latest progress on
          // record, and the times missed since are reported.
          const progress = [kept?.throughMs ?? null, released].filter((ms): ms is number => ms !== null);
          if (progress.length > 0) scheduler.resumedHere(workspaceId, Math.max(...progress));
          else scheduler.startedHere(workspaceId, null, null);
        } else {
          // A release since the server last started says where the last host stopped.
          scheduler.startedHere(workspaceId, released !== (kept?.hostReleasedMs ?? null) ? released : null, released);
        }
        ws.pendingStart = { generation: host.generation, releasedThroughMs: released };
      }
    }
    if (runsOn(host)) ws.presses.start();
    if (host?.handoverFrom === AUTOMATION_SERVER_INSTALL_ID && nowMs() >= ws.retryAtMs) void handOver(ws, host);
    if (JSON.stringify(before) !== JSON.stringify(host)) {
      ws.executor.hostChanged();
      scheduler.wake();
    }
  }

  /**
   * The owner moved the workspace's automations to a computer. The server
   * finishes what it admitted, stops its Group triggers, steps its schedules
   * one last time, and releases with its Group coverage and reach verdicts,
   * as a computer does over HTTP.
   */
  async function handOver(ws: Hosted, host: RelayAutomationHost): Promise<void> {
    if (ws.handingOver) return;
    ws.handingOver = true;
    const { workspaceId, ownerUserId } = ws.replica;
    const stillHandingOver = () => {
      const current = hostOf(ws);
      return !ws.closed && current?.generation === host.generation && current.handoverFrom === AUTOMATION_SERVER_INSTALL_ID;
    };
    let finished = false;
    try {
      while (ws.held.size > 0 && !ws.closed) await Promise.all([...ws.held]);
      if (!stillHandingOver()) return;
      const released = await ws.executor.releaseGroupSubscriptions(stillHandingOver);
      if (released === null || !stillHandingOver()) return;
      const throughMs = await scheduler.finishHere(workspaceId);
      if (throughMs === null || !stillHandingOver()) return;
      const reach = await ws.executor.reachHandover();
      if (!stillHandingOver()) return;
      storage.recordAutomationServerProgress({ workspaceId, throughMs });
      storage.releaseAutomationHost({
        workspaceId, ownerUserId, server, nowMs: nowMs(),
        installId: AUTOMATION_SERVER_INSTALL_ID,
        generation: host.generation,
        releasedThroughMs: throughMs,
        groups: JSON.stringify(released.handover),
        reach: reach === null ? null : JSON.stringify(reach),
        groupsWatched: released.watchedGeneration,
      });
      finished = true;
    } catch (error) {
      // The owner changed the host again first: the next read acts on it.
      if (!(error instanceof RelayError && error.code === "conflict")) {
        options.onError(`hand over the automations of workspace "${workspaceId}"`, error);
      }
    } finally {
      ws.handingOver = false;
      if (finished || !stillHandingOver()) {
        ws.retryMs = RETRY_FIRST_MS;
        ws.retryAtMs = 0;
      } else {
        retryLater(ws);
      }
      ws.executor.hostChanged();
      follow(ws);
    }
  }

  function retryLater(ws: Hosted): void {
    ws.retryAtMs = nowMs() + ws.retryMs;
    clearTimeout(ws.retryTimer);
    ws.retryTimer = setTimeout(() => follow(ws), ws.retryMs);
    ws.retryTimer.unref?.();
    ws.retryMs = Math.min(ws.retryMs * 2, RETRY_MAX_MS);
  }

  /** Holds off a handover while admitted work runs; null when the server does not run the workspace now. */
  function hold(ws: WorkspaceState): (() => void) | null {
    if (!stillRuns(ws)) return null;
    let release: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { release = resolve; });
    ws.held.add(done);
    return () => {
      ws.held.delete(done);
      release();
    };
  }

  // --- Notices, posted in process as the owner. ---

  function posterOf(ws: WorkspaceState) {
    return replicaNoticePoster({
      replica: ws.replica, storage, noticeLimiter: options.noticeLimiter, ownerName: () => ownerName(ws), nowMs,
    });
  }

  async function ownerName(ws: WorkspaceState): Promise<string> {
    const name = await nameOf(ws, ws.replica.ownerUserId);
    return name ?? "Unnamed";
  }

  async function nameOf(ws: WorkspaceState, userId: string): Promise<string | null> {
    const known = ws.names.get(userId);
    if (known !== undefined) return known;
    const name = (await options.lookupUserDisplayName(userId))?.trim() || null;
    if (name !== null) ws.names.set(userId, cutText(name, 40));
    return ws.names.get(userId) ?? null;
  }

  function withdrawFailure(ws: WorkspaceState, failure: ReportedRun): void {
    storage.markNotices({
      recipientUserId: ws.replica.ownerUserId,
      marks: [{
        noticeId: automationFailedNoticeId({ workspaceId: ws.replica.workspaceId, installId: AUTOMATION_SERVER_INSTALL_ID, failure }),
        mark: "dismissed",
      }],
      installId: AUTOMATION_SERVER_INSTALL_ID,
      nowMs: nowMs(),
    });
  }

  // The owner hears once a day that a workspace's runs wait for its budget.
  const toldOverBudget = new Map<string, string>();
  function overBudget(workspaceId: string): void {
    const ws = hosted.get(workspaceId);
    const day = new Date(nowMs()).toISOString().slice(0, 10);
    if (!ws || toldOverBudget.get(workspaceId) === day) return;
    toldOverBudget.set(workspaceId, day);
    void posterOf(ws)({
      noticeId: `automations-waiting:${sha256(workspaceId)}:${day}`,
      kind: "automation-failed",
      title: "Automations are waiting to run",
      body: `Your server runs up to ${Math.round(3_600_000 / SERVER_RUN_REFILL_MS)} automations an hour in each workspace. The waiting ones run in order as the limit allows.`,
      target: {},
      recipientUserId: ws.replica.ownerUserId,
    }, ws.replica.signal).catch((error: unknown) => {
      toldOverBudget.delete(workspaceId);
      options.onError(`tell the owner of workspace "${workspaceId}" that its automations wait`, error);
    });
  }

  // --- Each workspace's executor, over its replica. ---

  /** Pushes the replica's own writes soon, once at a time. */
  /**
   * Pushes the copy's writes, and pulls, once at a time. The engine refuses
   * a sync for a while at times, as while it reconciles the copy's
   * Collections, so a sync that fails tries again after a delay that
   * doubles to a minute. Only a failure that keeps repeating is reported.
   */
  function syncSoon(ws: WorkspaceState): void {
    if (ws.closed) return;
    if (ws.syncing) {
      ws.syncAgain = true;
      return;
    }
    clearTimeout(ws.syncTimer);
    ws.syncTimer = undefined;
    let failed = false;
    ws.syncing = ws.replica.sync().then(() => { ws.syncFailures = 0; }, (error: unknown) => {
      if (ws.replica.signal.aborted) return;
      failed = true;
      ws.syncFailures += 1;
      if (ws.syncFailures >= SYNC_FAILURES_REPORTED) {
        options.onError(`sync the server's copy of workspace "${ws.replica.workspaceId}"`, error);
      }
    }).finally(() => {
      ws.syncing = null;
      if (ws.syncAgain) {
        ws.syncAgain = false;
        syncSoon(ws);
      } else if (failed && !ws.closed) {
        const delayMs = Math.min(SYNC_RETRY_FIRST_MS * 2 ** (ws.syncFailures - 1), SYNC_RETRY_MAX_MS);
        ws.syncTimer = setTimeout(() => syncSoon(ws), delayMs);
        ws.syncTimer.unref?.();
      }
    });
  }

  async function readText(ws: WorkspaceState, path: string) {
    const version = await ws.adapter.getActiveVersion({ workspaceId: ws.replica.workspaceId });
    if (version === null) throw new Error("This server's copy of the workspace has no active version.");
    const read = await ws.adapter.readTextFile({ workspaceId: ws.replica.workspaceId, versionId: version.id, path });
    if (read === null) return null;
    // A binary file does not read as automations or a schema.
    if (read.contentKind !== "text" || read.text === null) return { text: "", truncated: true as const, contentHash: null };
    return { text: read.text, truncated: false as const, contentHash: sha256(read.text), versionId: version.id };
  }

  function executorOptions(ws: WorkspaceState, self: () => Hosted): CollectionAutomationsOptions {
    const { replica, adapter } = ws;
    const { workspaceId, ownerUserId } = replica;
    const chat = replicaAutomationChat({ replica, store: replicaChatStore(replica), ownerName: () => ownerName(ws) });
    return {
      withEngine: async (work) => replica.signal.aborted ? null : await work(adapter),
      withRecordWrites: async (signal, work) => {
        try {
          return await work(collectionRecordWrites(replicaRecordEditContext(replica, replicaRecordEngine(replica), signal)));
        } finally {
          syncSoon(ws);
        }
      },
      readText: async (path) => {
        const read = await readText(ws, path);
        return read === null ? null : read.truncated ? read : { text: read.text, truncated: false, contentHash: read.contentHash };
      },
      writeText: async (path, text, expectedContentHash) => {
        const read = await readText(ws, path);
        if (read === null || read.truncated || read.contentHash !== expectedContentHash) return { status: "conflict" };
        await adapter.writeTextFile({
          workspaceId, versionId: read.versionId, path, text, publish: true, expectedSha256: expectedContentHash, metadata: { origin: "api", summary: `Updated ${posix.basename(path)}` },
        });
        syncSoon(ws);
        return { status: "written" };
      },
      pathExists: async (path) => (await readText(ws, path)) !== null,
      // The relay's own records, read at each check: never a stale copy.
      roster: () => roster(ws),
      cachedRoster: () => roster(ws),
      evaluator: evaluator.forWorkspace(workspaceId),
      store: createAutomationRunStore(replica.root, metadataDirOf(replica.metadataDir)),
      chat: {
        directory: chat.directory,
        write: async (signal, message) => {
          try {
            return await chat.write(signal, message);
          } finally {
            syncSoon(ws);
          }
        },
      },
      groupHost: async () => runningGeneration(ws),
      // A handover an earlier copy already took reads as a take over: this
      // copy starts its Group triggers from now and holds what it cannot prove.
      groupRelayRecord: async (generation) => {
        const kept = handoverFor(ws, generation);
        return {
          generation: kept.generation ?? 0,
          handover: kept.groups === null ? null : decodeAutomationGroupHandover(kept.groups as JsonValue),
        };
      },
      reachRelayRecord: async (generation) => {
        const kept = handoverFor(ws, generation);
        return {
          generation: kept.generation ?? 0,
          reach: kept.reach === null ? null : parseReachHandover(kept.reach),
          everShared: kept.everShared,
        };
      },
      // The server is the host only while the record names it; it never claims one.
      requestHost: async () => undefined,
      groupMessagesSkipped: async (reason, atMs) => {
        const { workspaceId: _workspace, ...notice } = groupMessagesNotice({ workspaceId, reason, atMs, host: "server" });
        await posterOf(ws)({ ...notice, recipientUserId: ownerUserId }, replica.signal);
      },
      readMessageBody: async (messageId) => (await replicaChatStore(replica).getMessage({ workspaceId, messageId })).body,
      postNotice: posterOf(ws),
      onRunsChanged: () => undefined,
      reportFailure: (report) => ws.reporting = (async () => {
        const { workspaceId: _workspace, ...notice } = automationFailedNotice({
          workspaceId,
          computer: { installId: AUTOMATION_SERVER_INSTALL_ID, label: server.label },
          failure: report.failure,
          name: report.name,
          collectionPath: report.collectionPath,
        });
        await posterOf(ws)({ ...notice, recipientUserId: ownerUserId }, replica.signal);
        if (report.replaces !== null) withdrawFailure(ws, report.replaces);
      })(),
      withdrawFailure: async (failure) => withdrawFailure(ws, failure),
      // The owner's desktop reads author history and sends switch-off notices.
      onSwitchedOff: () => undefined,
      // Nobody opens the server's panel: its holds and marks show through the owner's computers later.
      onHoldsChanged: () => undefined,
      onAutomationsChanged: () => undefined,
      onSchedulesChanged: () => scheduler.wake(),
      hostCanRun: async () => true,
      personName: (userId) => ws.names.get(userId) ?? userId,
      wakeUnavailable: WAKE_ON_SERVER,
      // Try again on a server run arrives through the owner's routes, not a person here.
      mayRetryPress: async () => false,
      onPressSettled: (event) => self().presses.runSettled(event),
      onPressWaiting: () => undefined,
      holdForHost: () => hold(ws),
      admitRun: (signal) => gate.admit(workspaceId, signal),
      onError: (context, error) => options.onError(`automations in workspace "${workspaceId}": ${context}`, error),
      // The server's dataset host joins its executor in a later change.
      withDatasetHost: async () => null,
      nowMs,
    };
  }

  /** The relay's last release or take over at this generation, as this copy may take it. */
  function handoverFor(ws: WorkspaceState, generation: number) {
    const { workspaceId, ownerUserId } = ws.replica;
    const kept = storage.readAutomationGroupHandover({ workspaceId, ownerUserId, generation });
    if (kept.generation === null) return kept;
    if (fenced(storage.readAutomationServerSchedules(workspaceId), kept.generation)) return { ...kept, groups: null, reach: null };
    // Kept before this copy takes it, so a later copy knows it was taken.
    storage.recordAutomationServerTaken({ workspaceId, generation: kept.generation });
    return kept;
  }

  async function roster(ws: WorkspaceState) {
    const { workspaceId, ownerUserId } = ws.replica;
    const answer = await listRosterGrants(workspaceId, (path) => options.readOwnerShares(ownerUserId, path));
    return answer.kind === "answered"
      ? ownerRoster(ownerUserId, answer.listing, "")
      : ownerRoster(ownerUserId, undefined, answer.next);
  }

  function pressTransport(ws: WorkspaceState): PressTransport {
    const scope = { workspaceId: ws.replica.workspaceId, ownerUserId: ws.replica.ownerUserId, installId: AUTOMATION_SERVER_INSTALL_ID };
    const empty = () => storage.automationPressWait({ ...scope, nowMs: nowMs() }) === "empty";
    return {
      async list(signal) {
        if (empty()) await nextWrite(signal, PRESS_WAIT_MS, () => !empty());
        return storage.listAutomationPresses({ ...scope, nowMs: nowMs() });
      },
      accept: async (generation, hostPressIds) =>
        storage.acceptAutomationPresses({ ...scope, generation, hostPressIds, nowMs: nowMs() }),
      settle: async (input) => {
        storage.settleAutomationPress({ workspaceId: scope.workspaceId, ownerUserId: scope.ownerUserId, ...input, nowMs: nowMs() });
      },
    };
  }

  function open(replica: AutomationReplica): void {
    const state: WorkspaceState = {
      replica,
      adapter: new class extends ServerClaimEngine {
        override async claimNextAutomation(input: Parameters<ServerClaimEngine["claimNextAutomation"]>[0]) {
          const claim = await super.claimNextAutomation(input);
          const person = claim === null ? null : claimPerson(claim);
          if (person !== null) await nameOf(state, person).catch(() => null);
          return claim;
        }
      }([replica.client, replica.workspace, { workspaceId: replica.workspaceId }], {
        ledger: () => options.live?.ledger(replica.workspaceId) ?? null,
        storage,
        sync: () => replica.sync(),
        onFailuresChanged: () => ws.executor.failuresChanged(),
        onError: (context, error) => options.onError(`live claims in workspace "${replica.workspaceId}": ${context}`, error),
      }),
      host: null,
      pendingStart: null,
      handingOver: false,
      retryAtMs: 0,
      retryMs: RETRY_FIRST_MS,
      retryTimer: undefined,
      held: new Set(),
      closed: false,
      syncing: null,
      syncAgain: false,
      syncFailures: 0,
      syncTimer: undefined,
      reporting: Promise.resolve(),
      names: new Map(),
    };
    storage.beginAutomationServerCopy({ workspaceId: replica.workspaceId, incarnation: replica.incarnation });
    const create = options.createExecutor ?? ((executorOptions) => new CollectionAutomations(executorOptions));
    const ws: Hosted = Object.assign(state, {
      executor: create(executorOptions(state, () => ws)),
      presses: pressHost(state, () => ws),
    });
    hosted.set(replica.workspaceId, ws);
    // A write to the host record wakes the scheduler; it never asks on a timer.
    scheduler.add(replica.workspaceId, ws.executor, { ...hostSeam(state, () => ws), asksAgain: () => false });
    void ws.executor.open().then(() => follow(ws), (error: unknown) =>
      options.onError(`open the automations of workspace "${replica.workspaceId}"`, error));
  }

  /** The relayed press loop of one workspace, run while the server is its host. */
  function pressHost(ws: WorkspaceState, self: () => Hosted): RelayedPressHost {
    const { replica } = ws;
    return createRelayedPressHost({
      workspaceId: replica.workspaceId,
      host: hostSeam(ws, self),
      transport: async () => (ws.closed ? null : pressTransport(ws)),
      heldClaim: (press) => self().executor.relayedClaim({ automationId: press.automationId, collectionPath: press.collectionPath, definitionHash: press.definitionHash, pressId: press.hostPressId }),
      press: async (input, watch) => {
        // A formula's `person` shows the name of whoever pressed.
        await nameOf(ws, input.pressedBy).catch(() => null);
        return await self().executor.pressRelayed(input, watch);
      },
      notifyFailure: (failure) => posterOf(ws)(relayedPressFailureNotice(failure), replica.signal),
      onError: (context, error) => options.onError(`presses in workspace "${replica.workspaceId}": ${context}`, error),
    });
  }

  async function close(ws: Hosted): Promise<void> {
    if (ws.closed) return;
    ws.closed = true;
    if (hosted.get(ws.replica.workspaceId) === ws) hosted.delete(ws.replica.workspaceId);
    clearTimeout(ws.retryTimer);
    clearTimeout(ws.syncTimer);
    scheduler.remove(ws.replica.workspaceId);
    ws.presses.stop();
    await ws.executor.dispose();
    await ws.adapter.close();
    await ws.reporting.catch(() => undefined);
  }

  // A replica opened, closed, or was replaced: its executor follows it.
  function replicaChanged(workspaceId: string): void {
    const replica = replicas.replica(workspaceId);
    const current = hosted.get(workspaceId);
    if (current && current.replica === replica) return;
    const opening = current ? close(current) : Promise.resolve();
    void opening.then(() => {
      if (!closed && replica && replicas.replica(workspaceId) === replica && !hosted.has(workspaceId)) open(replica);
    }).catch((error: unknown) => options.onError(`close the automations of workspace "${workspaceId}"`, error));
  }

  function engineEvent(event: Event): void {
    if (event.name !== AUTOMATION_CLAIMED_EVENT) return;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) return;
    const { workspaceId, state, run } = payload as { workspaceId?: unknown; state?: unknown; run?: unknown };
    const ws = typeof workspaceId === "string" ? hosted.get(workspaceId) : undefined;
    if (!ws) return;
    // A claim inserted failed, as a chain stop, or a retry of a failed one.
    if (state === "failed" || (typeof run === "number" && run > 1)) ws.executor.failuresChanged();
    if (state !== "failed") ws.executor.notifyClaimed();
  }

  const replicas = await (options.startReplicas ?? startAutomationReplicas)({
    ...options.replicas,
    storage,
    nowMs,
    // The workspaces the server hosts, and those whose live-shared records it claims.
    wanted: () => [...new Set([...storage.serverHostedWorkspaces(), ...(options.live?.workspaces() ?? [])])],
    onChanged: replicaChanged,
    onEngineEvent: engineEvent,
    onPulled: (workspaceId, paths) => {
      const ws = hosted.get(workspaceId);
      if (!ws) return;
      ws.executor.handlePulledPaths(paths);
      ws.executor.relayAnswered();
      void ws.executor.groupMessagesArrived();
    },
    onReconciled: () => { unavailable = false; },
    onError: (error, workspaceId) => {
      // One workspace's copy failing is that workspace's; the server stays available to the others.
      if (workspaceId === undefined) unavailable = true;
      options.onError(workspaceId === undefined
        ? "keep this server's copies of workspaces"
        : `keep this server's copy of workspace "${workspaceId}"`, error);
    },
  });

  // Every relay write may change a host record or bring a press.
  let following = false;
  const stopWatching = observeRelayWrites(storage, () => {
    if (following) return;
    following = true;
    setImmediate(() => {
      following = false;
      if (closed) return;
      for (const ws of hosted.values()) {
        follow(ws);
        // A live claim whose change may have reached the relay now.
        if (ws.adapter.waiting()) ws.executor.notifyClaimed();
      }
      for (const check of [...waiters]) check();
    });
  });

  // The live host claims a live-shared record's change when it accepts its frame.
  const stopLiveEvents = options.live?.onEvent(engineEvent) ?? (() => undefined);

  return {
    /** Whether this server's copies of workspaces keep failing to open or sync. */
    get unavailable(): boolean {
      return unavailable;
    },
    async close(): Promise<void> {
      closed = true;
      stopWatching();
      stopLiveEvents();
      scheduler.dispose();
      for (const ws of [...hosted.values()]) await close(ws);
      await replicas.close();
      await evaluator.close();
    },
  };
}

/** Whether an earlier copy of the workspace was given the release at this generation, so took it. */
function fenced(kept: AutomationServerSchedules | null, generation: number): boolean {
  return kept !== null && kept.fenceGeneration !== null && generation <= kept.fenceGeneration;
}

/** The latest mark in a scheduler record, or null. */
function latestMark(record: ScheduleRecord | null): number | null {
  let latest: number | null = null;
  for (const schedule of record?.schedules ?? []) {
    if (schedule.throughMs !== null) latest = Math.max(latest ?? schedule.throughMs, schedule.throughMs);
  }
  return latest;
}

/**
 * The server's bound on runs: per workspace, a bucket of SERVER_RUN_BURST
 * that refills one every SERVER_RUN_REFILL_MS; across the server, at most
 * SERVER_CONCURRENT_RUNS at once, in arrival order. A turn that ends without
 * a run gives its token back.
 */
export function createRunGate(input: {
  nowMs(): number;
  onWaiting(workspaceId: string): void;
  concurrentRuns?: number;
  burst?: number;
  refillMs?: number;
}) {
  const concurrentRuns = input.concurrentRuns ?? SERVER_CONCURRENT_RUNS;
  const burst = input.burst ?? SERVER_RUN_BURST;
  const refillMs = input.refillMs ?? SERVER_RUN_REFILL_MS;
  const buckets = new Map<string, { tokens: number; atMs: number }>();
  const queue: Array<() => void> = [];
  let running = 0;

  const bucketOf = (workspaceId: string) => {
    const now = input.nowMs();
    const bucket = buckets.get(workspaceId) ?? { tokens: burst, atMs: now };
    // A clock that stepped back refills nothing until it passes the last reading.
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.atMs) / refillMs);
    bucket.atMs = Math.max(bucket.atMs, now);
    buckets.set(workspaceId, bucket);
    return bucket;
  };

  const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

  // Waits for a free run in arrival order; false when `signal` aborted first.
  const slot = (signal: AbortSignal) => new Promise<boolean>((resolve) => {
    if (running < concurrentRuns) {
      running += 1;
      resolve(true);
      return;
    }
    const turn = () => {
      signal.removeEventListener("abort", abort);
      running += 1;
      resolve(true);
    };
    const abort = () => {
      const index = queue.indexOf(turn);
      if (index >= 0) queue.splice(index, 1);
      resolve(false);
    };
    queue.push(turn);
    signal.addEventListener("abort", abort, { once: true });
  });

  return {
    async admit(workspaceId: string, signal: AbortSignal): Promise<RunAdmission | null> {
      for (;;) {
        if (signal.aborted) return null;
        const bucket = bucketOf(workspaceId);
        if (bucket.tokens >= 1) {
          bucket.tokens -= 1;
          break;
        }
        input.onWaiting(workspaceId);
        await sleep(Math.ceil((1 - bucket.tokens) * refillMs), signal);
      }
      if (!(await slot(signal))) {
        bucketOf(workspaceId).tokens += 1;
        return null;
      }
      let released = false;
      return {
        release(ran) {
          if (released) return;
          released = true;
          if (!ran) {
            const bucket = bucketOf(workspaceId);
            bucket.tokens = Math.min(burst, bucket.tokens + 1);
          }
          running -= 1;
          queue.shift()?.();
        },
      };
    },
  };
}

/** The server's name as the owner's settings show it: DOHC_SERVER_NAME, printable and bounded, or "This server". */
export function automationServerLabel(name: string | undefined): string {
  const printable = (name ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  const label = [...printable].slice(0, AUTOMATION_COMPUTER_LABEL_MAX_CHARS).join("").trim();
  return label.length > 0 ? label : "This server";
}
