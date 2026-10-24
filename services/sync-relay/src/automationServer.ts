import { workspaceIsDeleted, accountIsFenced } from "./storage/accountDeletion";
import {isDeepStrictEqual} from "node:util";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { AutomationScheduler, type SchedulerClock, type ScheduleRecord } from "@dohc/automation-executor/automation-scheduler";
import { createAutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { cutText } from "@dohc/automation-executor/automation-chat";
import { automationFailedNoticeId, type ReportedRun } from "@dohc/automation-executor/automation-failed-notice";
import { reportAutomationFailure } from "@dohc/automation-executor/automation-failure-reporting";
import { whoChangedLast, type AutomationsFileHistory } from "@dohc/automation-executor/automation-history";
import { createAutomationRunStore, type AutomationRunStore, type AutomationStoreFolder, type StoredRun } from "@dohc/automation-executor/automation-run-store";
import {
  CollectionAutomations,
  type CollectionAutomationRun,
  type CollectionAutomationsOptions,
  type RunAdmission,
} from "@dohc/automation-executor/collection-automations";
import { claimPerson } from "@dohc/automation-executor/collection-automation-run";
import { AutomationRunWait, SHARED_BUTTON_UNCHECKED, SHARED_BUTTON_DENIED, SHARED_BUTTON_MOVED, SHARED_BUTTON_FIELD_CHANGED, SHARED_BUTTON_HELD } from "@dohc/automation-executor/button-presser";
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
  AUTOMATION_SERVER_MAX_WORKSPACES,
  NOTICE_BODY_MAX_CHARS,
  NOTICE_LIST_ROW_LIMIT,
  NOTICE_TITLE_MAX_CHARS,
  SERVER_HOLD_NOTICE_PREFIX,
  SERVER_RUN_FAILED_NOTICE_PREFIX,
  isNoticeTarget,
  type RelayAutomationHost,
} from "@dohc/workspace-contracts/relay";
import {
  AUTOMATION_CLAIMED_EVENT,
  DaemonRefusalError,
  decodeAutomationGroupHandover,
  type Event,
  type JsonValue,
} from "@dohc/workspace-engine-client";
import { replicaAutomationChat, replicaChatStore, replicaNoticePoster } from "./automationChatWrites";
import { ServerClaimEngine, type LiveClaimLedger } from "./automationLiveClaims";
import { replicaRecordEditContext, replicaRecordEngine } from "./automationRecordEdits";
import {automationRecordPresser} from "./automationRecordPresser";
import {automationRecordDelivery, AutomationRecordBindingChanged} from "./automationRecordDelivery";
import {createAutomationAcceptedRecords} from "./automationAcceptedRecords";
import type {NamedFrameHostSession} from "./namedLiveFrameSession";
import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import { startAutomationReplicas, type AutomationReplica } from "./automationReplicas";
import type { OwnerScope, ServerRuns } from "./automationServerRoutes";
import type { RelayDatasetHost } from "./datasetHost";
import type { DatasetServerPress } from "./datasetAutomations";
import type { AppBackendAuth } from "./appBackendAuthority";
import { notFound, RelayError } from "./errors";
import { observeRelayWrites } from "./relayWriteChanges";
import type { SyncRelayStorage } from "./storage";
import type { AutomationServer, AutomationServerSchedules, LostAutomationServerRun, LostAutomationServerRunCursor } from "./storage/automationHosts";

function checkedButtonAuthority<T>(read: () => T): T {
  try { return read(); }
  catch (error) {
    if (error instanceof RelayError && (error.code === "not_found" || error.code === "share_read_only")) throw error;
    throw new AutomationRunWait(SHARED_BUTTON_UNCHECKED, "roster");
  }
}

// This server runs the automations of every workspace whose host record
// names it (docs/engineering/security-boundaries.md). Each workspace
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
// An owner's action on a copy the server keeps closed waits this long for it to open.
const RETAINED_COPY_OPEN_MS = 30_000;
// The effects a run makes in its copy, which reach the relay only when the
// copy syncs. Notices and agent wakes go straight to the relay.
const COPY_EFFECTS: ReadonlySet<string> = new Set(["set", "add", "message"]);
// A page of run history lists this many of an automation's runs a lost copy may not have sent.
const LOST_RUNS_PAGE = 50;
// The `before` of a page of those runs, after the copy's own runs end: when
// the pass began reading them, then the last run listed.
const LOST_RUNS_CURSOR = /^lost:(\d{1,16}):(\d{1,16}):(.+)$/su;
const LOST_CHANGES_NOTICE_PREFIX = "server-lost-changes:";
const LOST_CHANGES_ERROR = "Your server lost its copy of this workspace and may not have sent this run's latest changes. Check the records it changed.";
const LOST_CHANGES_RETRY = "Your server lost this run's history with its copy of the workspace, so it will not run this again.";

/** What the server drives in each workspace's executor. CollectionAutomations satisfies it. */
export type ServerExecutor = Pick<
  CollectionAutomations,
  | "open" | "dispose" | "notifyClaimed" | "handlePulledPaths" | "relayAnswered" | "groupMessagesArrived" | "hostChanged"
  | "releaseGroupSubscriptions" | "reachHandover" | "relayedClaim" | "pressRelayed" | "automationName"
  | "schedules" | "scheduleMarks" | "claimSchedule" | "failuresChanged" | "datasetsChanged" | "pressDataset" | "holds"
  | "runs" | "listedRun" | "hasRun" | "retry" | "undo" | "undoRunsOf" | "removePendingRestore" | "confirmReach"
  | "inspectRelayedBatch"
>;

export interface AutomationServerOptions {
  storage: SyncRelayStorage;
  datasetHost?: RelayDatasetHost;
  recordDelivery?: {
    namespace: string;
    capture(input: {binding: LiveObjectBinding; shareId: string; ownerUserId: string}, signal: AbortSignal): Promise<NamedFrameHostSession>;
  };
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
  /** Delivers every record's queued updates. False when one had updates it found no outbox for. */
  flushRecordDelivery?(): Promise<boolean>;
  refreshRecord?(path: string): Promise<void>;
  refreshAcceptedRecords?(): Promise<void>;
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
  readonly holdNotices: Set<string>;
  /** Runs an earlier copy lost may still need a Notice. */
  lostToReport: boolean;
  readonly names: Map<string, string>;
  datasetMetadata?: string;
}

interface Hosted extends WorkspaceState {
  readonly executor: ServerExecutor;
  /** The executor's saved runs. Only this copy saved them: each copy starts with empty host data. */
  readonly runStore: AutomationRunStore;
  readonly presses: RelayedPressHost;
}

const runsOn = (host: RelayAutomationHost | null): host is RelayAutomationHost =>
  host?.installId === AUTOMATION_SERVER_INSTALL_ID && host.handoverFrom === null;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The run store's folder, always this one: the replica made it beside its workspace. */
function storeFolderOf(dir: string): AutomationStoreFolder {
  return { forWrite: async () => dir, read: (work) => work(dir) };
}

export async function startAutomationServer(options: AutomationServerOptions) {
  const { storage, server } = options;
  const nowMs = options.nowMs ?? Date.now;
  const hosted = new Map<string, Hosted>();
  // Copies owners' actions hold open, with how many actions still use each,
  // and when a copy nothing else needed stopped being needed and left.
  const visits = new Map<string, { actions: number; times: { incarnation: number; unwantedSinceMs: number; leftAtMs: number | null } | null }>();
  // Actions waiting for a copy to open.
  const copyWaiters = new Set<() => void>();
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
    if (accountIsFenced(storage, userId)) return null;
    const known = ws.names.get(userId);
    if (known !== undefined) return known;
    const name = (await options.lookupUserDisplayName(userId))?.trim() || null;
    if (name !== null && !accountIsFenced(storage, userId) && !ws.closed) ws.names.set(userId, cutText(name, 40));
    return ws.names.get(userId) ?? null;
  }

  function reportHolds(ws: Hosted): void {
    const holds = ws.executor.holds();
    ws.reporting = ws.reporting.then(async () => {
      if (ws.closed) return;
      const current = new Set<string>();
      for (const held of holds) {
        const noticeId = `${SERVER_HOLD_NOTICE_PREFIX}${sha256(ws.replica.workspaceId)}:${sha256(JSON.stringify([ws.replica.incarnation, held.automationId, held.definitionHash, held.step, held.recipient, held.seq]))}`;
        current.add(noticeId);
        if (ws.holdNotices.has(noticeId)) continue;
        const step = held.operationName ? `Step "${held.operationName}"`
          : /^\d+$/.test(held.step) ? `Step ${Number(held.step) + 1}` : "The step";
        await posterOf(ws)({
          noticeId, kind: "automation-failed",
          title: cutText(`Automation "${held.automationName}" is waiting`, NOTICE_TITLE_MAX_CHARS),
          // The owner's computers list the hold with Allow; this notice points there.
          body: cutText(`${step} to ${held.action} "${held.target}" waits for you. Allow it in Notices, where it shows as waiting on your server.`, NOTICE_BODY_MAX_CHARS),
          target: { path: held.collectionPath, automation: held.automationId }, recipientUserId: ws.replica.ownerUserId,
        }, ws.replica.signal);
        ws.holdNotices.add(noticeId);
      }
      const cleared = [...ws.holdNotices].filter(noticeId => !current.has(noticeId));
      if (cleared.length) storage.markNotices({ recipientUserId: ws.replica.ownerUserId,
        marks: cleared.map(noticeId => ({ noticeId, mark: "dismissed" as const })), nowMs: nowMs() });
      for (const noticeId of cleared) ws.holdNotices.delete(noticeId);
    }).catch((error: unknown) => options.onError(`tell the owner of workspace "${ws.replica.workspaceId}" which steps wait`, error));
  }

  function withdrawFailure(ws: WorkspaceState, failure: ReportedRun): void {
    storage.markNotices({
      recipientUserId: ws.replica.ownerUserId,
      marks: [{
        noticeId: automationFailedNoticeId({ workspaceId: ws.replica.workspaceId, installId: AUTOMATION_SERVER_INSTALL_ID, failure }).replace("automation-failed:", SERVER_RUN_FAILED_NOTICE_PREFIX),
        mark: "dismissed",
        withdraw: true,
      }],
      installId: AUTOMATION_SERVER_INSTALL_ID,
      nowMs: nowMs(),
    });
  }

  /** Tells the owner, once for each automation of a lost copy, how many of its runs' changes that copy may not have sent. */
  function reportLostRuns(ws: WorkspaceState): void {
    if (!ws.lostToReport) return;
    const { workspaceId, ownerUserId } = ws.replica;
    ws.reporting = ws.reporting.then(async () => {
      for (const lost of storage.unreportedLostAutomationServerRuns({ workspaceId, nowMs: nowMs() })) {
        if (ws.closed) return;
        const name = cutText(lost.automationName ?? lost.automationId.slice(lost.automationId.lastIndexOf("#") + 1), NOTICE_TITLE_MAX_CHARS - 40);
        const run = { automation: lost.automationId, run: lost.newestClaimId };
        const target = lost.collectionPath === null ? run : { ...run, path: `${lost.collectionPath}/automations.yaml` };
        await posterOf(ws)({
          noticeId: `${LOST_CHANGES_NOTICE_PREFIX}${sha256(workspaceId)}:${sha256(JSON.stringify([lost.incarnation, lost.automationId]))}`,
          kind: "automation-failed",
          title: cutText(`Automation "${name}" may have lost changes`, NOTICE_TITLE_MAX_CHARS),
          body: lost.runs === 1 ? LOST_CHANGES_ERROR
            : `Your server lost its copy of this workspace and may not have sent the latest changes of ${lost.runs} runs. Check the records they changed.`,
          target: isNoticeTarget(target) ? target : run, recipientUserId: ownerUserId,
        }, ws.replica.signal);
        storage.reportAutomationServerRunsLost({ workspaceId, incarnation: lost.incarnation, automationId: lost.automationId });
      }
      ws.lostToReport = false;
    }).catch((error: unknown) => options.onError(`tell the owner of workspace "${workspaceId}" which runs' changes its copy lost`, error));
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
    const { workspaceId, incarnation } = ws.replica;
    ws.syncing = (async () => {
      // The runs that ended before this sync began: it sends all their changes.
      const ended = storage.endedAutomationServerRuns({ workspaceId, incarnation });
      // Each lane finishes independently. A waiting draft never prevents sync.
      const [flushed, synced] = await Promise.allSettled([ws.flushRecordDelivery?.() ?? true, ws.replica.sync()]);
      if (flushed.status === "rejected") throw flushed.reason;
      if (synced.status === "rejected") throw synced.reason;
      // A record update the flush left may hold an ended run's changes.
      if (flushed.value) storage.confirmAutomationServerRunsSent({ workspaceId, incarnation, runs: ended });
      reportLostRuns(ws);
    })().then(() => { ws.syncFailures = 0; }, (error: unknown) => {
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
    const runStore = createAutomationRunStore(storeFolderOf(replica.metadataDir));
    const chat = replicaAutomationChat({ runStore, replica, store: replicaChatStore(replica), storage, nowMs, ownerName: () => ownerName(ws) });
    // A canonical sync changes the replica's draft revision. Keep it outside
    // another write's preparation and settlement, including background retries.
    const serializeRecords = <T>(work: () => Promise<T>) => replica.withRecordWork(work);
    const recordEngine = replicaRecordEngine(replica);
    recordEngine.onDeliveryError = (path, error) => options.onError(`deliver automation record "${path}" in workspace "${workspaceId}"`, error);
    recordEngine.checkWriteAuthority = async (path, declaration, signal) => {
      if (declaration.attribution.onBehalfOf === undefined || declaration.attribution.onBehalfOf === ownerUserId) return;
      const authority = await automationRecordPresser(replica, declaration, signal);
      if (!authority || !storage.automationRecordWriteAllowed({workspaceId, ownerUserId, currentPath: path, declaration, authority})) {
        throw new Error("This automation cannot change this record with the access of the person who started it.");
      }
    };
    const configured = options.recordDelivery;
    if (configured) {
      const delivery = automationRecordDelivery({replica, namespace: configured.namespace, ownerUserId,
        capture: async (binding, signal) => {
          let current;
          try {current = storage.automationRecordBinding(workspaceId, ownerUserId, binding.currentPath);}
          catch (error) {
            if (error instanceof Error && error.message === "The shared file is unavailable. Restore access, then try again.") throw new AutomationRecordBindingChanged("stale-binding");
            throw error;
          }
          if (!current || !isDeepStrictEqual(current.binding, binding)) throw new AutomationRecordBindingChanged(
            current && current.binding.restoreFenceGeneration !== binding.restoreFenceGeneration ? "restore-fenced" : "binding-changed", current?.binding);
          return configured.capture({...current, ownerUserId}, signal);
        }});
      const accepted = createAutomationAcceptedRecords({replica, namespace: configured.namespace, storage,
        // Fresh accepted state starts new work; quarantined writes remain terminal.
        synchronize: (binding, signal) => delivery.synchronize(binding, signal, true),
        onError: (path, error) => options.onError(`refresh automation record "${path}" in workspace "${workspaceId}"`, error)});
      ws.refreshAcceptedRecords = accepted.refreshChanged;
      ws.refreshRecord = async path => {
        try {await accepted.refresh(path);}
        catch (error) {
          options.onError(`refresh automation record "${path}" in workspace "${workspaceId}"`, error);
          throw error;
        }
      };
      recordEngine.prepareSharedRecord = async (path, signal) => {
        const current = storage.automationRecordBinding(workspaceId, ownerUserId, path);
        if (current) {
          try {await delivery.synchronize(current.binding, signal, true); await accepted.track(current.binding);}
          catch (error) {
            options.onError(`prepare automation record "${path}" in workspace "${workspaceId}"`, error);
            throw error;
          }
        }
      };
      recordEngine.deliverSharedRecord = async (path, signal) => {
        const current = storage.automationRecordBinding(workspaceId, ownerUserId, path);
        if (current) {await delivery.drain(current.binding, signal); await accepted.track(current.binding);}
      };
      let draining: Promise<boolean> | undefined;
      ws.flushRecordDelivery = () => draining ??= (async () => {
        let after = null, undelivered: string | null = null;
        const failures: unknown[] = [];
        do {
          const page = await replica.client.ownerYDocListDrafts({id: replica.nextRequestId(), workspace: replica.workspace, deadlineMs: 30_000}, {after, limit: 64, pendingOnly: true}, replica.signal);
          // A quarantined draft is listed only while its owner's Try again is pending; the drainer sends only that head.
          for (const draft of page.drafts) if (draft.pendingBytes > 0) {
            try {if (!await serializeRecords(() => delivery.drain(draft.binding, replica.signal, draft.outboxId ?? undefined))) undelivered ??= draft.binding.currentPath;}
            catch (error) {failures.push(error); options.onError(`deliver automation record "${draft.binding.currentPath}" in workspace "${workspaceId}"`, error);}
          }
          after = page.next;
        } while (after !== null);
        // Until it is delivered, no sync confirms that a run's changes were sent.
        if (undelivered !== null) options.onError(`deliver automation record "${undelivered}" in workspace "${workspaceId}"`,
          new Error("The record has updates waiting but no outbox to deliver them from, so the server confirms no run's changes as sent."));
        if (failures.length) throw failures[0];
        return undelivered === null;
      })().finally(() => {draining = undefined;});
    } else {
      recordEngine.prepareSharedRecord = async path => {
        if (storage.automationRecordBinding(workspaceId, ownerUserId, path)) throw new AutomationRunWait("Waiting for the shared file host");
      };
    }
    return {
      withEngine: async (work) => replica.signal.aborted ? null : await work(adapter),
      withRecordWrites: async (signal, work) => {
        try {
          return await serializeRecords(() => work(collectionRecordWrites(replicaRecordEditContext(replica, recordEngine, signal))));
        } finally {
          syncSoon(ws);
        }
      },
      // Only the owner's routes undo a run here, and Undo writes as that person.
      withUndoWrites: async (signal, work) => {
        try {
          return await serializeRecords(() => work(collectionRecordWrites(replicaRecordEditContext(replica, recordEngine, signal, true))));
        } finally {
          syncSoon(ws);
        }
      },
      readText: async (path) => {
        const read = await readText(ws, path);
        return read === null ? null : read.truncated ? read : { text: read.text, truncated: false, contentHash: read.contentHash };
      },
      writeText: async (path, text, expectedContentHash, automationId) => {
        const read = await readText(ws, path);
        if (read === null || read.truncated || read.contentHash !== expectedContentHash) return { status: "conflict" };
        try {
          await adapter.writeTextFile({
            workspaceId, versionId: read.versionId, path, text, publish: true, expectedSha256: expectedContentHash, metadata: { origin: "api", summary: `Updated ${posix.basename(path)}` },
            author: { kind: "automation", automationId, depth: 0 },
          });
        } catch (error) {
          if (error instanceof DaemonRefusalError && error.message === "write-precondition-failed") return { status: "conflict" };
          throw error;
        }
        syncSoon(ws);
        return { status: "written" };
      },
      pathExists: async (path) => (await readText(ws, path)) !== null,
      // The relay's own records, read at each check: never a stale copy.
      roster: () => roster(ws),
      cachedRoster: () => roster(ws),
      evaluator: evaluator.forWorkspace(workspaceId),
      store: runStore,
      chat: {
        hasMessage: chat.hasMessage,
        directory: chat.directory,
        write: async (signal, message, run) => {
          try {
            return await chat.write(signal, message, run);
          } finally {
            syncSoon(ws);
          }
        },
      },
      groupHost: async () => runningGeneration(ws),
      holdUnprovenWithoutHistory: async () => storage.automationWorkspaceInfo(workspaceId)?.everShared ?? true,
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
      ...unsentRunHooks(ws, self),
      reportFailure: (report) => ws.reporting = reportAutomationFailure({
          computer: { installId: AUTOMATION_SERVER_INSTALL_ID, label: server.label },
          primary: { recipientUserId: ownerUserId },
          throughShare: false,
          post: async ({ workspaceId: _workspace, ...notice }) => {
            if (notice.recipientUserId === undefined) throw new Error("A server Notice needs a recipient.");
            await posterOf(ws)({ ...notice, recipientUserId: notice.recipientUserId,
              noticeId: notice.noticeId.replace("automation-failed:", SERVER_RUN_FAILED_NOTICE_PREFIX) }, replica.signal);
          },
          withdraw: async () => { if (report.replaces !== null) withdrawFailure(ws, report.replaces); },
          lastChangedBy: async () => {
            if (report.collectionPath === null) return null;
            const id = report.failure.automationId.slice(report.failure.automationId.lastIndexOf("#") + 1);
            return whoChangedLast(automationHistory(ws), { path: `${report.collectionPath}/automations.yaml`, id, ownerUserId });
          },
          onError: options.onError,
        }, workspaceId, report),
      withdrawFailure: async (failure) => withdrawFailure(ws, failure),
      // The owner's desktop reads author history and sends switch-off notices.
      onSwitchedOff: () => undefined,
      onHoldsChanged: () => reportHolds(self()),
      onAutomationsChanged: () => undefined,
      onSchedulesChanged: () => scheduler.wake(),
      hostCanRun: async () => true,
      personName: (userId) => ws.names.get(userId) ?? userId,
      // Only the owner's routes ask for Try again here.
      mayRetryPress: async () => true,
      onPressSettled: (event) => self().presses.runSettled(event),
      onPressWaiting: () => undefined,
      holdForHost: () => hold(ws),
      resolveRelayedPress: async (hostPressId) => {
        const current = () => checkedButtonAuthority(() => storage.resolveAutomationPress({ workspaceId, ownerUserId, installId: AUTOMATION_SERVER_INSTALL_ID,
          generation: ws.host?.generation ?? 0, hostPressId, nowMs: nowMs() }));
        return { ...current(), current };
      },
      resolveButtonInspection: async (inspectionId) => checkedButtonAuthority(() => storage.resolveButtonInspection({ workspaceId, ownerUserId, installId: AUTOMATION_SERVER_INSTALL_ID,
        generation: ws.host?.generation ?? 0, inspectionId })),
      admitRun: (signal) => gate.admit(workspaceId, signal),
      onError: (context, error) => options.onError(`automations in workspace "${workspaceId}": ${context}`, error),
      withDatasetHost: async (work) => {
        if (!options.datasetHost) return null;
        return work(options.datasetHost.automations.workspace(workspaceId, ownerUserId, replica.signal));
      },
      nowMs,
    };
  }

  /**
   * Tells the relay before each attempt first changes the copy, and when it
   * ends, so a later copy can tell the owner which runs' changes this one
   * may not have sent.
   */
  function unsentRunHooks(ws: WorkspaceState, self: () => Hosted): Pick<CollectionAutomationsOptions, "beforeEffect" | "onRunEnded"> {
    const { workspaceId, incarnation } = ws.replica;
    const keyOf = (run: StoredRun) => JSON.stringify([run.automationId, run.claimId]);
    // Attempts already on record as changing, so each records once.
    const changing = new Set<string>();
    return {
      beforeEffect(run, effect) {
        if (!COPY_EFFECTS.has(effect.kind) || changing.has(keyOf(run))) return;
        const name = self().executor.automationName(run.automationId);
        storage.recordAutomationServerRunChanging({
          workspaceId, incarnation, automationId: run.automationId, claimId: run.claimId,
          automationName: name === null || name.trim() === "" ? null : cutText(name, 256),
          collectionPath: collectionPathOf(run), startedAtMs: run.startedAtMs, nowMs: nowMs(),
        });
        changing.add(keyOf(run));
      },
      onRunEnded(run) {
        changing.delete(keyOf(run));
        // A sync that begins now sends everything the run changed. A run
        // whose end is not on record counts as unsent, which is never wrong.
        try {
          if (storage.endAutomationServerRun({ workspaceId, incarnation, automationId: run.automationId, claimId: run.claimId })) syncSoon(ws);
        } catch (error) {
          options.onError(`record that a run ended in workspace "${workspaceId}"`, error);
        }
      },
    };
  }

  function automationHistory(ws: WorkspaceState): AutomationsFileHistory {
    const { adapter, replica: { workspaceId } } = ws;
    return {
      flush: async () => { await adapter.flushCapture(); },
      fileObjectIdForPath: async (path) => {
        const version = await adapter.getActiveVersion({ workspaceId });
        return version === null ? null : (await adapter.readTextFile({ workspaceId, versionId: version.id, path }))?.objectId ?? null;
      },
      listMoments: async (input) => {
        const page = await adapter.readHistoryPage({ workspaceId, ...input });
        return { moments: page.moments.map(({ momentId }) => ({ id: momentId, protected: false })), nextCursor: page.nextCursor };
      },
      readMoment: async (momentId) => {
        const moment = await adapter.getMoment({ workspaceId, momentId });
        if (moment === null) return null;
        const authors = moment.authors?.map((author) => {
          if ("corrupt" in author) throw new Error("This automation's History has unreadable authorship.");
          return author;
        });
        const text = async (side: "before" | "after") => {
          if (side === "before" && !moment.beforePresent) return undefined;
          const contentKind = side === "before" ? moment.beforeContentKind : moment.afterContentKind;
          if (contentKind !== "text") return "";
          const inline = side === "before" ? moment.beforeText : moment.afterText;
          if (inline !== null) return inline;
          const sha256 = side === "before" ? moment.beforeBlobSha256 : moment.afterBlobSha256;
          const body = sha256 === null ? null : await adapter.readTextBlob({ workspaceId, sha256 });
          if (body === null) throw new Error("This automation's History could not read its saved text.");
          return body;
        };
        const before = await text("before");
        const after = moment.operation === "delete" ? "" : await text("after");
        return { protected: false, moment: { operation: moment.operation,
          ...(authors === undefined ? {} : { authors }),
          payload: { ...(before === undefined ? {} : { before: { text: before } }), after: { text: after ?? "" } },
        } };
      },
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
    const empty = () => storage.automationPressWait({ ...scope, nowMs: nowMs() }) === "empty" && storage.listButtonInspections(scope).length === 0;
    return {
      async list(signal) {
        const release = storage.parkButtonInspectionHost(scope);
        try {
          if (empty()) await nextWrite(signal, PRESS_WAIT_MS, () => !empty());
          return storage.listAutomationPresses({ ...scope, nowMs: nowMs() });
        } finally { release(); }
      },
      accept: async (generation, hostPressIds) =>
        storage.acceptAutomationPresses({ ...scope, generation, hostPressIds, nowMs: nowMs() }),
      settle: async (input) => {
        storage.settleAutomationPress({ workspaceId: scope.workspaceId, ownerUserId: scope.ownerUserId, ...input, nowMs: nowMs() });
      },
      inspections: () => storage.listButtonInspections(scope),
      answerInspection: async (generation, inspectionId, result) => {
        if (result.kind !== "ready") {
          options.onError(`inspect shared Button "${inspectionId}" in workspace "${scope.workspaceId}"`, new Error(result.reason));
          result = {kind: result.kind, reason: result.kind === "unchecked" ? SHARED_BUTTON_UNCHECKED
            : [SHARED_BUTTON_MOVED, SHARED_BUTTON_FIELD_CHANGED, SHARED_BUTTON_HELD].includes(result.reason) ? result.reason : SHARED_BUTTON_DENIED};
        }
        storage.answerButtonInspection({ ...scope, generation, inspectionId }, result);
      },
    };
  }

  function open(replica: AutomationReplica): void {
    const state: WorkspaceState = {
      replica,
      adapter: new class extends ServerClaimEngine {
        override async getCollectionRecord(input: Parameters<ServerClaimEngine["getCollectionRecord"]>[0]) {
          const record = await super.getCollectionRecord(input);
          if (state.refreshRecord) {await state.refreshRecord(record.record.path); return super.getCollectionRecord(input);}
          return record;
        }
        override async queryCollectionRecords(input: Parameters<ServerClaimEngine["queryCollectionRecords"]>[0]) {
          await state.refreshAcceptedRecords?.();
          return super.queryCollectionRecords(input);
        }
        override async claimNextAutomation(input: Parameters<ServerClaimEngine["claimNextAutomation"]>[0]) {
          const claim = await super.claimNextAutomation(input);
          const person = claim === null ? null : claimPerson(claim);
          if (person !== null) await nameOf(state, person).catch(() => null);
          return claim;
        }
      }([replica.client, replica.workspace, { workspaceId: replica.workspaceId }], {
        ledger: () => options.live?.ledger(replica.workspaceId) ?? null,
        storage,
        sync: () => ws.replica.sync(),
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
      holdNotices: new Set(storage.readNoticeChanges({ recipientUserId: replica.ownerUserId, cursor: null, limit: NOTICE_LIST_ROW_LIMIT, nowMs: nowMs() })
        .notices.filter(notice => notice.noticeId.startsWith(`${SERVER_HOLD_NOTICE_PREFIX}${sha256(replica.workspaceId)}:`) && notice.dismissedAtMs === null)
        .map(notice => notice.noticeId)),
      lostToReport: true,
      names: new Map(),
    };
    storage.beginAutomationServerCopy({ workspaceId: replica.workspaceId, incarnation: replica.incarnation });
    // What an earlier copy had not sent went with its engine.
    storage.markAutomationServerRunsLost({ workspaceId: replica.workspaceId, incarnation: replica.incarnation, nowMs: nowMs() });
    const create = options.createExecutor ?? ((executorOptions) => new CollectionAutomations(executorOptions));
    const executorInput = executorOptions(state, () => ws);
    const ws: Hosted = Object.assign(state, {
      executor: create(executorInput),
      runStore: executorInput.store,
      presses: pressHost(state, () => ws),
    });
    hosted.set(replica.workspaceId, ws);
    reportLostRuns(ws);
    for (const check of [...copyWaiters]) check();
    // A write to the host record wakes the scheduler; it never asks on a timer.
    scheduler.add(replica.workspaceId, ws.executor, { ...hostSeam(state, () => ws), asksAgain: () => false });
    if (ws.flushRecordDelivery) syncSoon(ws);
    void ws.executor.open().then(() => { follow(ws); reportHolds(ws); if (options.datasetHost) ws.executor.failuresChanged(); }, (error: unknown) =>
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
      inspect: async (ids, signal) => await self().executor.inspectRelayedBatch(ids, signal),
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
    await ws.syncing?.catch(() => undefined);
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
      if (!closed && !workspaceIsDeleted(storage, workspaceId) && replica && replicas.replica(workspaceId) === replica && !hosted.has(workspaceId)) open(replica);
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

  let capacityReporting = Promise.resolve();
  const excluded = new Map<string, { ownerUserId: string; noticeId: string }>();
  const allWantedWorkspaces = () => [...new Set([...storage.serverHostedWorkspaces(), ...(options.live?.workspaces() ?? []), ...(options.datasetHost?.automations.wantedWorkspaces() ?? [])])].filter(id => !workspaceIsDeleted(storage, id));
  function wantedWorkspaces(): string[] {
    const running = runningWorkspaces();
    // A copy an owner's action reopened stays open while the action runs,
    // within the same cap as the copies the server runs. An admitted action
    // keeps its place: a workspace that needs the server since waits for it.
    const visiting = [...visits.keys()];
    return [...new Set([...visiting, ...running])].slice(0, AUTOMATION_SERVER_MAX_WORKSPACES);
  }
  function runningWorkspaces(): string[] {
    const all = allWantedWorkspaces();
    const waiting = new Set(all.slice(AUTOMATION_SERVER_MAX_WORKSPACES));
    capacityReporting = capacityReporting.then(async () => {
      if (closed) return;
      for (const workspaceId of waiting) {
        if (excluded.has(workspaceId)) continue;
        const info = storage.automationWorkspaceInfo(workspaceId);
        if (!info) continue;
        const { ownerUserId } = info;
        const noticeId = `automation-capacity:${sha256(workspaceId)}:${nowMs()}`;
        await replicaNoticePoster({ replica: { workspaceId, ownerUserId, signal: storage.unavailable }, storage,
          noticeLimiter: options.noticeLimiter, ownerName: async () => cutText((await options.lookupUserDisplayName(ownerUserId))?.trim() || "Unnamed", 40), nowMs })({
          noticeId, kind: "automation-failed",
          title: "This workspace's automations are waiting",
          body: `Your server can run automations in ${AUTOMATION_SERVER_MAX_WORKSPACES} workspaces. Free a place to run this workspace's automations.`,
          target: {}, recipientUserId: ownerUserId,
        }, storage.unavailable);
        excluded.set(workspaceId, { ownerUserId, noticeId });
      }
      for (const [workspaceId, { ownerUserId, noticeId }] of excluded) if (!waiting.has(workspaceId)) {
        storage.markNotices({ recipientUserId: ownerUserId,
          marks: [{ noticeId, mark: "dismissed" }], nowMs: nowMs() });
        excluded.delete(workspaceId);
      }
    }).catch((error: unknown) => options.onError("tell owners which workspaces wait for server capacity", error));
    return all.slice(0, AUTOMATION_SERVER_MAX_WORKSPACES);
  }

  const replicas = await (options.startReplicas ?? startAutomationReplicas)({
    ...options.replicas,
    storage,
    nowMs,
    wanted: wantedWorkspaces,
    onChanged: replicaChanged,
    onEngineEvent: engineEvent,
    onBeforeSync: workspaceId => hosted.get(workspaceId)?.refreshAcceptedRecords?.() ?? Promise.resolve(),
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
        const metadata = options.datasetHost?.automations.metadata(ws.replica.workspaceId);
        if (metadata !== ws.datasetMetadata) {
          ws.datasetMetadata = metadata;
          ws.executor.datasetsChanged();
        }
      }
      for (const check of [...waiters]) check();
    });
  });

  // The live host claims a live-shared record's change when it accepts its frame.
  const stopLiveEvents = options.live?.onEvent(engineEvent) ?? (() => undefined);

  /** The open copy of a workspace this owner owns, or notFound. The relay's records say who owns it now. */
  function ownedCopy({ workspaceId, ownerUserId }: OwnerScope): Hosted {
    const ws = hosted.get(workspaceId);
    if (!ws || ws.closed || ws.replica.ownerUserId !== ownerUserId || !storage.workspaceIsOwnedBy(workspaceId, ownerUserId)) {
      throw notFound();
    }
    return ws;
  }

  /** Undo's delete of a record a run added: the file goes from the copy, and its History keeps it. */
  function trashIn(ws: Hosted) {
    return async (path: string) => {
      const version = await ws.adapter.getActiveVersion({ workspaceId: ws.replica.workspaceId });
      if (version === null) throw new Error("This server's copy of the workspace has no active version.");
      await ws.adapter.deleteTextFile({
        workspaceId: ws.replica.workspaceId, versionId: version.id, path, metadata: { origin: "api", summary: `Removed ${posix.basename(path)}` },
      });
      syncSoon(ws);
    };
  }

  /**
   * Runs `work` on the owner's copy of a workspace. A copy the server keeps
   * after the workspace left it, for run history and Undo
   * (AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS), opens again for the
   * action. It runs no schedules, Group triggers or presses, since the host
   * record names another host, and leaves again a day after the action.
   */
  async function withCopy<T>(scope: OwnerScope, work: (ws: Hosted) => Promise<T>): Promise<T> {
    const { workspaceId, ownerUserId } = scope;
    const kept = storage.listAutomationWorkspaces().find((row) => row.workspaceId === workspaceId);
    if (kept?.ownerUserId !== ownerUserId || !storage.workspaceIsOwnedBy(workspaceId, ownerUserId)) throw notFound();
    const visit = visits.get(workspaceId);
    if (visit === undefined && !copyIsOpen(workspaceId) &&
      new Set([...allWantedWorkspaces().slice(0, AUTOMATION_SERVER_MAX_WORKSPACES), ...visits.keys()]).size >= AUTOMATION_SERVER_MAX_WORKSPACES) {
      throw new RelayError("conflict", "Your server has as many workspaces open as it can. Try again later.", 503);
    }
    // Every action holds the copy open, one waiting to leave included, until
    // it ends. Opening joins the copy again; its times go back afterwards.
    visits.set(workspaceId, {
      actions: (visit?.actions ?? 0) + 1,
      times: visit ? visit.times : kept.unwantedSinceMs === null ? null
        : { incarnation: kept.incarnation, unwantedSinceMs: kept.unwantedSinceMs, leftAtMs: kept.leftAtMs },
    });
    try {
      replicas.reconcile(workspaceId);
      await copyOpened(workspaceId);
      return await work(ownedCopy(scope));
    } finally {
      const current = visits.get(workspaceId)!;
      if (current.actions > 1) {
        visits.set(workspaceId, { ...current, actions: current.actions - 1 });
      } else {
        visits.delete(workspaceId);
        if (current.times !== null && !allWantedWorkspaces().includes(workspaceId)) {
          storage.restoreAutomationWorkspaceTimes({ workspaceId, ...current.times });
        }
      }
      replicas.reconcile();
    }
  }

  const copyIsOpen = (workspaceId: string) => {
    const ws = hosted.get(workspaceId);
    return ws !== undefined && !ws.closed;
  };

  /** Resolves once the replicas module opened this workspace's copy, or refuses after RETAINED_COPY_OPEN_MS. */
  function copyOpened(workspaceId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        copyWaiters.delete(check);
      };
      const check = () => {
        if (!copyIsOpen(workspaceId)) return;
        done();
        resolve();
      };
      const timer = setTimeout(() => {
        done();
        reject(new RelayError("conflict", "Your server is opening its copy of this workspace. Try again.", 503));
      }, RETAINED_COPY_OPEN_MS);
      timer.unref?.();
      copyWaiters.add(check);
      check();
    });
  }

  /**
   * The owner's copy, caught up with what the relay has, so an Undo keeps
   * every change someone made after the run, not only those the copy pulled.
   */
  async function currentCopy(scope: OwnerScope, ws: Hosted): Promise<Hosted> {
    await ws.replica.sync();
    return ownedCopy(scope);
  }

  /**
   * One page of the runs a lost copy of this workspace may not have sent,
   * newest first. A run this copy still lists, as a dataset claim the relay
   * keeps, shows on the copy's own pages instead. Every page of one pass
   * reads as of the time its first page did, so a claim whose older record
   * expires between pages keeps its place.
   */
  async function lostRunsPage(ws: Hosted, scope: OwnerScope, automationId: string, readAtMs: number, after?: LostAutomationServerRunCursor) {
    const lost = storage.lostAutomationServerRuns({
      workspaceId: scope.workspaceId, automationId, nowMs: readAtMs, limit: LOST_RUNS_PAGE + 1, ...(after === undefined ? {} : { after }),
    });
    const shown = lost.slice(0, LOST_RUNS_PAGE);
    const last = shown.at(-1);
    const runs: CollectionAutomationRun[] = [];
    for (const run of shown) if (!await ws.executor.hasRun(automationId, run.claimId)) runs.push(lostRunRow(run));
    return { runs, next: lost.length > LOST_RUNS_PAGE && last ? `lost:${readAtMs}:${last.startedAtMs}:${last.claimId}` : null };
  }
  const lostRun = (scope: OwnerScope, automationId: string, claimId: string) =>
    storage.lostAutomationServerRuns({ workspaceId: scope.workspaceId, automationId, claimId, nowMs: nowMs(), limit: 1 })[0];

  /**
   * The loss a run this copy lists still has. Only a run of the claim this
   * copy saved, which Try again continues from, ends it; a later change to
   * the claim alone does not.
   */
  async function lossOf(ws: Hosted, scope: OwnerScope, automationId: string, claimId: string) {
    const lost = lostRun(scope, automationId, claimId);
    if (lost === undefined) return undefined;
    const saved = await ws.runStore.runsOf(automationId, claimId);
    return saved.unreadable || saved.runs.length === 0 ? lost : undefined;
  }

  const runs: ServerRuns = {
    // They are older than any run of this copy, so they follow its last page.
    list: (scope, automationId, before) => withCopy(scope, async (ws) => {
      const lostAfter = before === undefined ? null : LOST_RUNS_CURSOR.exec(before);
      if (lostAfter) {
        return await lostRunsPage(ws, scope, automationId, Number(lostAfter[1]), { startedAtMs: Number(lostAfter[2]), claimId: lostAfter[3]! });
      }
      const page = await ws.executor.runs(automationId, before);
      const listed: CollectionAutomationRun[] = [];
      for (const run of page.runs) listed.push(withLoss(run, await lossOf(ws, scope, automationId, run.claimId)));
      if (page.next !== null) return { runs: listed, next: page.next };
      const lost = await lostRunsPage(ws, scope, automationId, nowMs());
      return { runs: [...listed, ...lost.runs], next: lost.next };
    }),
    get: (scope, automationId, claimId) => withCopy(scope, async (ws) => {
      const run = await ws.executor.listedRun(automationId, claimId);
      if (run !== null) return withLoss(run, await lossOf(ws, scope, automationId, claimId));
      const lost = lostRun(scope, automationId, claimId);
      return lost === undefined ? null : lostRunRow(lost);
    }),
    retry: (scope, input) => withCopy(scope, async (ws) => {
      // A copy kept after the workspace left runs nothing, so a run queued in it would never run.
      if (!allWantedWorkspaces().includes(scope.workspaceId)) {
        return { status: "refused", reason: "Your server no longer runs this workspace's automations, so it will not run this again." };
      }
      if (await lossOf(ws, scope, input.automationId, input.claimId) !== undefined) return { status: "refused", reason: LOST_CHANGES_RETRY };
      return await ws.executor.retry(input);
    }),
    undo: (scope, input) => withCopy(scope, async (copy) => {
      const ws = await currentCopy(scope, copy);
      const result = await ws.executor.undo(input, trashIn(ws));
      // What it put back reaches the relay while the action still holds the copy.
      await ws.replica.sync();
      return result;
    }),
    restore: (scope, definitions, again, retentionId) => withCopy(scope, async (copy) => {
      const ws = await currentCopy(scope, copy);
      const id = `desktop:${retentionId}`;
      if (definitions.length === 0) {
        await ws.executor.removePendingRestore(id);
        return {undone: 0, left: 0, reverted: 0, missing: 0, keptFields: [], otherKept: 0, errorMessage: null};
      }
      const result = await ws.executor.undoRunsOf(definitions, trashIn(ws), again, id);
      // What it put back reaches the relay before the owner's computer takes its turn.
      await ws.replica.sync();
      return result;
    }),
    // A closed copy runs nothing, so it holds nothing.
    holds: (scope) => ownedCopy(scope).executor.holds(),
    allow: (scope, input) => ownedCopy(scope).executor.confirmReach(input),
  };

  const stopDatasetClaims = options.datasetHost?.observeAutomationClaims((workspaceId, failed) => {
    const ws = hosted.get(workspaceId);
    if (ws) { ws.executor.notifyClaimed(); if (failed) ws.executor.failuresChanged(); }
  });

  return {
    deleteAccount(userId: string) {
      for (const ws of hosted.values()) ws.names.delete(userId);
    },
    async deleteWorkspaces(workspaceIds: readonly string[]) {
      for (const id of workspaceIds) {const ws = hosted.get(id); if (ws) await close(ws); visits.delete(id); excluded.delete(id); toldOverBudget.delete(id); gate.forgetWorkspace(id);}
      await replicas.deleteWorkspaces(workspaceIds);
    },
    async pressDataset(auth: Extract<AppBackendAuth, { kind: "named" }>, input: DatasetServerPress, signal: AbortSignal) {
      if (!options.datasetHost) throw notFound();
      return options.datasetHost.automations.press(auth, input.datasetId, signal, async describe => {
        const ws = hosted.get(auth.workspaceId);
        if (!ws || ws.closed) {
          if (allWantedWorkspaces().includes(auth.workspaceId)) throw new RelayError("conflict", "Your server is starting this workspace's automations. Try again.", 503);
          throw notFound();
        }
        if (ws.replica.pulledHead < storage.automationWorkspaceLogHead(auth.workspaceId)) await ws.replica.sync(signal);
        signal.throwIfAborted();
        if (ws.closed || ws.replica.signal.aborted) throw notFound();
        await nameOf(ws, auth.userId).catch(() => null);
        return ws.executor.pressDataset({ ...input, pressedBy: auth.userId }, describe, () => undefined);
      });
    },
    /** The owner's view of each workspace's runs here, for the owner routes. */
    runs,
    /** Whether this server's copies of workspaces keep failing to open or sync. */
    get unavailable(): boolean {
      return unavailable || replicas.unavailable;
    },
    async close(): Promise<void> {
      closed = true;
      stopWatching();
      stopLiveEvents();
      stopDatasetClaims?.();
      scheduler.dispose();
      for (const ws of [...hosted.values()]) await close(ws);
      await replicas.close();
      await capacityReporting;
      await evaluator.close();
    },
  };
}

/** Where the run's own Collection was when the run last named it, or null. */
function collectionPathOf(run: StoredRun): string | null {
  const collectionId = /^collection:(.+)#[^#]+$/u.exec(run.automationId)?.[1];
  return run.collections.find((collection) => collection.collectionId === collectionId)?.path ?? null;
}

/** A run a lost copy may not have sent, as run history lists it: failed, with nothing left to run or undo. */
function lostRunRow(lost: LostAutomationServerRun): CollectionAutomationRun {
  return withLoss({
    claimId: lost.claimId, state: "failed", error: null, createdAtMs: lost.startedAtMs, updatedAtMs: lost.unsentSinceMs,
    trigger: { kind: null, recordId: null, by: null, sharedAuthor: null, depth: 0 }, writes: [],
    definitionChanged: false, neverStarted: false, chainStopped: false, undone: false, undoUnfinished: false,
  }, lost);
}

/** A run as run history lists it, failed if a lost copy may not have sent its changes. */
function withLoss<Run extends CollectionAutomationRun>(run: Run, lost: LostAutomationServerRun | undefined): Run {
  return lost === undefined ? run : { ...run, state: "failed", error: LOST_CHANGES_ERROR, updatedAtMs: lost.unsentSinceMs, unsentChangesLost: true };
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
    forgetWorkspace(workspaceId: string) {buckets.delete(workspaceId);},
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
