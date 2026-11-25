import { DATASET_CAPABILITIES } from "@dohc/cli/dataset";
import { rateLimitMs as serviceRateLimitMs } from "@dohc/service-http/telemetry";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicReplaceFileSync } from "../atomicReplaceFile";
import type { CodeLocation, CrashEvent } from "../crashReports/crashReport";
import {
  sharedViewAccessOperations,
  type ReadCrashReportResult,
  type ReportKinds,
} from "../ipc/bridgeContract";
import { CHANNELS } from "../ipc/channels";
import { chatOperations } from "../ipc/chatOperations";
import { datasetOperations } from "../ipc/datasetOperations";
import { relayShareOperations, shareMountOperations } from "../ipc/shareOperations";
import { workspaceFileOperations } from "../ipc/workspaceFileOperations";
import type { PrivacySettings } from "../settings/userSettings";
import type { PublicUpdateState } from "../updates/electronUpdater";
import { isDatasetWriteAction } from "../usage/cliUsage";
import { errorReport, type ErrorFacts, type ErrorReport, type ReportedError } from "./errorReport";
import type { ErrorSender } from "./posthogErrors";
import type { Reporting } from "./reportingConfig";

export const CURRENT_USAGE_NOTICE_VERSION = 2;

const DRIVE_SERVER_ORIGIN = "https://drive.dohc.computer";
const CRASH_SIGNAL_REASON_PATTERN = /^[a-z-]{1,40}$/;

export type CountBucket = "0" | "1" | "2-5" | "6+";
export type ServerKind = "none" | "drive" | "self_hosted";
export type WorkspaceAddMethod =
  | "create_local"
  | "attach_folder"
  | "join_cloud"
  | "open_shared_view"
  | "mount_share";
export type WorkspaceOpenTrigger = "user" | "auto_restore" | "deep_link";
export type WorkspaceKind = "local" | "synced" | "received_share";

export interface WorkspaceOpenTriggers<Sender extends object> {
  markStartupRestore(sender: Sender): void;
  clearStartupRestore(sender: Sender): void;
  noteActivation(sender: Sender, workspaceId: string, trigger: WorkspaceOpenTrigger): void;
  consume(sender: Sender, workspaceId: string): WorkspaceOpenTrigger;
}

export function createWorkspaceOpenTriggers<
  Sender extends object,
>(): WorkspaceOpenTriggers<Sender> {
  const startupRestore = new WeakSet<Sender>();
  const pending = new WeakMap<Sender, { workspaceId: string; trigger: WorkspaceOpenTrigger }>();
  return {
    markStartupRestore(sender) {
      startupRestore.add(sender);
    },
    clearStartupRestore(sender) {
      startupRestore.delete(sender);
    },
    noteActivation(sender, workspaceId, trigger) {
      pending.set(sender, { workspaceId, trigger });
    },
    consume(sender, workspaceId) {
      const queued = pending.get(sender);
      if (queued?.workspaceId === workspaceId) {
        pending.delete(sender);
        startupRestore.delete(sender);
        return queued.trigger;
      }
      if (startupRestore.delete(sender)) return "auto_restore";
      pending.delete(sender);
      return "user";
    },
  };
}
export type UpdateEventStage =
  | "available"
  | "download_started"
  | "downloaded"
  | "install_started"
  | "failed";
export type CrashSignalSource = "main" | "window" | "gpu" | "utility" | "engine";

export type UsageEvent =
  | {
      name: "app_launched";
      workspace_count_bucket?: CountBucket;
      synced_workspace_count_bucket?: CountBucket;
      has_agents_configured?: boolean;
    }
  | { name: "app_active_heartbeat" }
  | {
      name: "app_update_event";
      stage: UpdateEventStage;
      failure_step?: "check" | "download" | "install";
    }
  | { name: "workspace_added"; method: WorkspaceAddMethod }
  | { name: "workspace_opened"; trigger?: WorkspaceOpenTrigger; workspace_kind?: WorkspaceKind }
  | {
      name: "feature_used";
      capability_id: string;
      door: "renderer" | "automation";
    }
  | {
      name: "tool_invoked";
      door: "cli" | "mcp";
      capability_id: string;
      outcome: "ok" | "error" | "refused";
      duration_ms: number;
    }
  | { name: "share_created"; method: "people" | "link" }
  | { name: "app_published"; local: boolean }
  | { name: "chat_message_sent" }
  | {
      name: "crash_signal";
      source: CrashSignalSource;
      reason: string;
    };

export interface UsageEventContext {
  workspaceKind?(workspaceId: string): WorkspaceKind | undefined;
  workspaceOpenTrigger?(workspaceId: string): WorkspaceOpenTrigger | undefined;
}

export function countBucket(count: number): CountBucket {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2-5";
  return "6+";
}

export function classifyServerKind(serverUrl: string | null | undefined): ServerKind {
  const trimmed = serverUrl?.trim();
  if (!trimmed) return "none";
  try {
    const parsed = new URL(trimmed);
    if (parsed.origin === DRIVE_SERVER_ORIGIN) return "drive";
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return "self_hosted";
    return "none";
  } catch {
    return "none";
  }
}

export function updateEventFromTransition(
  previous: PublicUpdateState | null,
  next: PublicUpdateState,
): Extract<UsageEvent, { name: "app_update_event" }> | null {
  if (next.failure && next.failure.id !== previous?.failure?.id) {
    return { name: "app_update_event", stage: "failed", failure_step: next.failure.step };
  }
  if (next.status === previous?.status) return null;
  switch (next.status) {
    case "available":
      return { name: "app_update_event", stage: "available" };
    case "downloading":
      return { name: "app_update_event", stage: "download_started" };
    case "ready":
      return { name: "app_update_event", stage: "downloaded" };
    default:
      return null;
  }
}

export function crashSignalFromEvent(
  event: CrashEvent,
): Extract<UsageEvent, { name: "crash_signal" }> | null {
  if (event.kind === "main-exception") return null;
  if (event.kind === "engine") {
    return { name: "crash_signal", source: "engine", reason: event.stage };
  }
  const reason = CRASH_SIGNAL_REASON_PATTERN.test(event.reason) ? event.reason : "unknown";
  return { name: "crash_signal", source: event.source, reason };
}

function datasetFeatureEvent(input: unknown, result: unknown): UsageEvent | null {
  const action =
    input && typeof input === "object" && "action" in input
      ? (input as { action?: unknown }).action
      : undefined;
  if (typeof action !== "string" || !Object.hasOwn(DATASET_CAPABILITIES, action)) return null;
  if (!isDatasetWriteAction(action)) return null;
  const capabilityId = DATASET_CAPABILITIES[action as keyof typeof DATASET_CAPABILITIES];
  if (!result || typeof result !== "object") return null;
  const answer = result as { ok?: unknown; replayed?: unknown; kind?: unknown };
  if (answer.ok === false || answer.replayed === true) return null;
  if (
    answer.kind === "refused" ||
    answer.kind === "collections-refused" ||
    answer.kind === "partial"
  ) {
    return null;
  }
  return { name: "feature_used", capability_id: capabilityId, door: "renderer" };
}

const USAGE_EVENTS: Readonly<
  Record<
    string,
    (result: unknown, input?: unknown, context?: UsageEventContext) => UsageEvent | null
  >
> = {
  [CHANNELS.createLocalWorkspace]: () => ({ name: "workspace_added", method: "create_local" }),
  [CHANNELS.attachWorkspaceFolder]: () => ({ name: "workspace_added", method: "attach_folder" }),
  [CHANNELS.cloudJoinWorkspace]: () => ({ name: "workspace_added", method: "join_cloud" }),
  [sharedViewAccessOperations.openSharedView.channel]: () => ({
    name: "workspace_added",
    method: "open_shared_view",
  }),
  [shareMountOperations.mountShare.channel]: (result) =>
    (result as { alreadyAdded?: unknown } | null)?.alreadyAdded === true
      ? null
      : { name: "workspace_added", method: "mount_share" },
  [CHANNELS.openWorkspace]: (_result, input, context) => {
    const workspaceId =
      input && typeof input === "object" && "workspaceId" in input
        ? (input as { workspaceId?: unknown }).workspaceId
        : undefined;
    const workspace_kind =
      typeof workspaceId === "string" ? context?.workspaceKind?.(workspaceId) : undefined;
    const trigger =
      typeof workspaceId === "string" ? context?.workspaceOpenTrigger?.(workspaceId) : undefined;
    return {
      name: "workspace_opened",
      ...(trigger ? { trigger } : {}),
      ...(workspace_kind ? { workspace_kind } : {}),
    };
  },
  [workspaceFileOperations.createWorkspaceFile.channel]: () => ({
    name: "feature_used",
    capability_id: "file.create",
    door: "renderer",
  }),
  [workspaceFileOperations.createWorkspaceFolder.channel]: () => ({
    name: "feature_used",
    capability_id: "folder.create",
    door: "renderer",
  }),
  [CHANNELS.createCollectionRecord]: () => ({
    name: "feature_used",
    capability_id: "dataset.record.create",
    door: "renderer",
  }),
  [CHANNELS.applyDatabaseEdit]: () => ({
    name: "feature_used",
    capability_id: "database.edit",
    door: "renderer",
  }),
  [datasetOperations.dataset.channel]: (result, input) => datasetFeatureEvent(input, result),
  [relayShareOperations.createRelayShare.channel]: () => ({
    name: "share_created",
    method: "people",
  }),
  [relayShareOperations.createRelayShareLink.channel]: () => ({
    name: "share_created",
    method: "link",
  }),
  [CHANNELS.publishOwnerApp]: (result) => {
    const outcome = result as { kind?: unknown; local?: unknown } | null;
    return outcome?.kind === "published"
      ? { name: "app_published", local: outcome.local === true }
      : null;
  },
  [chatOperations.sendChatMessage.channel]: () => ({ name: "chat_message_sent" }),
};

/** The usage event a request that answered `result` counts, if any. */
export function usageEventFor(
  channel: string,
  result: unknown,
  input?: unknown,
  context?: UsageEventContext,
): UsageEvent | null {
  return Object.hasOwn(USAGE_EVENTS, channel)
    ? USAGE_EVENTS[channel]!(result, input, context)
    : null;
}

export const REPORT_LIMITS = {
  usageQueue: 200,
  usageBatch: 25,
  usagePerLaunch: 1_000,
  usageFlushMs: 15_000,
  usageRetryMaxAgeMs: 30 * 60_000,
  usageBaseBackoffMs: 1_000,
  usageMaxBackoffMs: 60_000,
  errorQueue: 10,
  errorsPerLaunch: 25,
  errorsPrepared: 100,
  errorKeys: 200,
  errorFlushMs: 1_000,
  requestTimeoutMs: 10_000,
  shutdownTimeoutMs: 3_000,
  defaultPauseMs: 60_000,
  maxPauseMs: 3_600_000,
} as const;

// Older nightlies parse reporting.json strictly and discard unknown keys, so
// keep this schema unchanged and store notice versioning in a sibling file.
const ReportingState = z
  .object({
    usage: z
      .object({
        installId: z.string().uuid(),
      })
      .strict()
      .optional(),
    errors: z.literal(true).optional(),
  })
  .strict();
type ReportingState = z.infer<typeof ReportingState>;

const NoticeMetaState = z
  .object({
    usage: z.number().int().positive().optional(),
    lastCrashSeq: z.number().int().nonnegative().optional(),
  })
  .strict();
type NoticeMetaState = z.infer<typeof NoticeMetaState>;

export interface Telemetry {
  track(event: UsageEvent): void;
  markActive(): void;
  observePreviousCrash(report: ReadCrashReportResult["report"]): void;
  reportError(reported: ReportedError): void;
  setPrivacy(privacy: PrivacySettings): void;
  noticeDue(privacy: PrivacySettings): ReportKinds;
  acknowledgeNotice(shown: ReportKinds): void;
  readonly available: ReportKinds;
  flush(): Promise<void>;
}

interface QueuedUsageEvent {
  event: string;
  uuid: string;
  properties: Record<string, unknown>;
  timestamp: string;
  queuedAtMs: number;
}

interface Lane<Item> {
  queue: Item[];
  sending: AbortController | null;
  draining: Promise<void> | null;
  pausedUntilMs: number;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Usage and error reports, sent from main only. No report leaves before a
 * notice on screen has named its kind and main has read the switches, and
 * each switch is read again just before every send.
 */
export function createTelemetry(deps: {
  reporting: Reporting | null;
  statePath: string;
  facts(): ErrorFacts;
  locate(frame: string): CodeLocation | null;
  readCode(path: string): Promise<string>;
  serverKind?: () => ServerKind;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
}): Telemetry {
  const { reporting } = deps;
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const noticeMetaPath = join(dirname(deps.statePath), "reporting-notice.json");
  let privacy: PrivacySettings | null = null;
  let named: ReportingState = reporting ? readState(deps.statePath) : {};
  let noticeMeta: NoticeMetaState = reporting ? readNoticeMeta(noticeMetaPath) : {};
  let pendingCrashSeq: number | null = null;
  let lastHeartbeatUtcDay: string | null = null;
  let quitting = false;
  let ended = false;
  let flushing: Promise<void> | null = null;
  let usageCount = 0;
  let errorCount = 0;
  let errorsPrepared = 0;
  const errorKeys = new Set<string>();
  const usage: Lane<QueuedUsageEvent> = lane();
  const errors: Lane<ErrorReport> = lane();
  let errorSender: Promise<ErrorSender> | null = null;

  const usageAcknowledged = () =>
    Boolean(named.usage) && (noticeMeta.usage ?? 0) >= CURRENT_USAGE_NOTICE_VERSION;
  const usageOn = () =>
    !ended && Boolean(reporting?.usage && usageAcknowledged() && privacy?.usageReports);
  const errorsOn = () =>
    !ended && Boolean(reporting?.errors && named.errors && privacy?.errorReports);
  const usageMayQueue = () =>
    !ended && Boolean(reporting?.usage) && (privacy === null || privacy.usageReports);
  const errorsMayQueue = () =>
    !ended && Boolean(reporting?.errors) && (privacy === null || privacy.errorReports);

  function clearTimer<Item>(target: Lane<Item>): void {
    if (target.timer) clearTimeout(target.timer);
    target.timer = null;
  }

  let usageGeneration = 0;

  function drop<Item>(target: Lane<Item>): void {
    if (target === (usage as Lane<unknown>)) usageGeneration += 1;
    target.queue.length = 0;
    target.sending?.abort();
    clearTimer(target);
    target.failures = 0;
    target.pausedUntilMs = 0;
  }

  function schedule<Item>(
    target: Lane<Item>,
    on: () => boolean,
    delayMs: number,
    run: () => Promise<void>,
  ): void {
    if (quitting || !on() || target.timer || target.queue.length === 0) return;
    target.timer = setTimeout(
      () => {
        target.timer = null;
        void run();
      },
      Math.max(0, delayMs),
    );
    target.timer.unref?.();
  }

  function scheduleUsage(delayMs: number = REPORT_LIMITS.usageFlushMs): void {
    schedule(usage, usageOn, Math.max(delayMs, usage.pausedUntilMs - now()), () => sendUsage());
  }

  function dropExpiredUsage(atMs = now()): void {
    const cutoff = atMs - REPORT_LIMITS.usageRetryMaxAgeMs;
    let keep = 0;
    for (let i = 0; i < usage.queue.length; i += 1) {
      if (usage.queue[i]!.queuedAtMs >= cutoff) usage.queue[keep++] = usage.queue[i]!;
    }
    usage.queue.length = keep;
  }

  function pauseUsageBackoff(): void {
    usage.failures += 1;
    const backoff = Math.min(
      REPORT_LIMITS.usageMaxBackoffMs,
      REPORT_LIMITS.usageBaseBackoffMs * 2 ** (usage.failures - 1),
    );
    usage.pausedUntilMs = now() + Math.round(backoff * (0.75 + 0.5 * random()));
  }

  async function postUsageBatch(
    batch: QueuedUsageEvent[],
    generation: number,
  ): Promise<"ok" | "retry" | "drop"> {
    const service = reporting?.usage;
    const distinctId = named.usage?.installId;
    if (!service || !distinctId) return "drop";
    const controller = new AbortController();
    usage.sending = controller;
    try {
      const response = await send(service.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: service.key,
          batch: batch.map(({ queuedAtMs: _queued, ...item }) => ({
            ...item,
            distinct_id: distinctId,
          })),
        }),
        redirect: "error",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(REPORT_LIMITS.requestTimeoutMs),
        ]),
      });
      await response.body?.cancel().catch(() => {});
      if (controller.signal.aborted || generation !== usageGeneration) return "drop";
      if (response.ok) {
        usage.failures = 0;
        return "ok";
      }
      if (response.status === 429) {
        usage.pausedUntilMs = now() + rateLimitMs(response);
        return "retry";
      }
      if (response.status === 408 || response.status >= 500) {
        pauseUsageBackoff();
        return "retry";
      }
      return "drop";
    } catch {
      if (controller.signal.aborted || generation !== usageGeneration) return "drop";
      if (usageOn()) pauseUsageBackoff();
      return "retry";
    } finally {
      if (usage.sending === controller) usage.sending = null;
    }
  }

  function sendUsage(ignorePause = false): Promise<void> {
    if (usage.draining) return usage.draining;
    const atMs = now();
    dropExpiredUsage(atMs);
    if (!usageOn() || usage.queue.length === 0) return Promise.resolve();
    if (!ignorePause && atMs < usage.pausedUntilMs) {
      scheduleUsage(usage.pausedUntilMs - atMs);
      return Promise.resolve();
    }
    clearTimer(usage);
    const run = (async () => {
      let first = true;
      while (usageOn()) {
        if (!first) {
          const stepMs = now();
          dropExpiredUsage(stepMs);
          if (usage.queue.length === 0 || (!ignorePause && stepMs < usage.pausedUntilMs)) break;
        }
        first = false;
        const generation = usageGeneration;
        const batch = usage.queue.splice(0, REPORT_LIMITS.usageBatch);
        if ((await postUsageBatch(batch, generation)) === "retry") {
          if (!quitting && usageOn() && generation === usageGeneration) {
            const kept = batch.filter(
              (item) => item.queuedAtMs >= now() - REPORT_LIMITS.usageRetryMaxAgeMs,
            );
            const room = Math.max(0, REPORT_LIMITS.usageQueue - usage.queue.length);
            if (room > 0 && kept.length > 0) usage.queue.unshift(...kept.slice(kept.length - room));
            clearTimer(usage);
            scheduleUsage(usage.pausedUntilMs - now());
          }
          break;
        }
      }
    })();
    const settled = run.finally(() => {
      if (usage.draining === settled) usage.draining = null;
      if (!quitting && usageOn() && usage.queue.length > 0) {
        if (usage.queue.length >= REPORT_LIMITS.usageBatch && now() >= usage.pausedUntilMs) {
          void sendUsage();
        } else {
          scheduleUsage();
        }
      }
    });
    usage.draining = settled;
    return settled;
  }

  function drainErrors(): Promise<void> {
    const ready = () => errorsOn() && errors.queue.length > 0 && now() >= errors.pausedUntilMs;
    const dropIfPaused = () => {
      if (now() < errors.pausedUntilMs) errors.queue.length = 0;
    };
    if (!errors.draining && ready()) {
      const run = (async () => {
        do {
          const service = reporting?.errors;
          const report = errors.queue.shift();
          if (!service || !report) return;
          const controller = new AbortController();
          errors.sending = controller;
          try {
            errorSender ??= import("./posthogErrors").then(({ createErrorSender }) =>
              createErrorSender({ service, fetch: send, readCode: deps.readCode }),
            );
            const response = await (
              await errorSender
            )(
              report,
              AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(REPORT_LIMITS.requestTimeoutMs),
              ]),
            );
            const pauseMs = response ? rateLimitMs(response) : 0;
            if (pauseMs > 0) errors.pausedUntilMs = now() + pauseMs;
          } catch {
            // Dropped: error reports never retry.
          } finally {
            if (errors.sending === controller) errors.sending = null;
          }
        } while (ready());
      })();
      const settled = run.finally(() => {
        if (errors.draining === settled) errors.draining = null;
        dropIfPaused();
      });
      errors.draining = settled;
    }
    if (!errors.draining) dropIfPaused();
    return errors.draining ?? Promise.resolve();
  }

  function enqueueUsage(event: UsageEvent, atMsOverride?: number): void {
    if (!usageMayQueue() || usageCount >= REPORT_LIMITS.usagePerLaunch) return;
    if (usage.queue.length >= REPORT_LIMITS.usageQueue) return;
    usageCount += 1;
    const facts = deps.facts();
    const { name, ...fields } = event;
    const rawAtMs = atMsOverride ?? facts.atMs;
    const timestampMs =
      name === "crash_signal" ? Math.floor(rawAtMs / 3_600_000) * 3_600_000 : rawAtMs;
    usage.queue.push({
      event: name,
      uuid: randomUUID(),
      properties: {
        ...fields,
        $process_person_profile: false,
        $geoip_disable: true,
        $lib: "dohc-desktop",
        schema_version: 2,
        app_version: facts.version,
        channel: facts.channel,
        dist: reporting?.dist ?? `${process.platform}-${process.arch}`,
        os: facts.os,
        os_version: facts.osVersion,
        arch: facts.arch,
        server_kind: safeServerKind(deps.serverKind),
      },
      timestamp: new Date(timestampMs).toISOString(),
      queuedAtMs: now(),
    });
    if (usage.queue.length >= REPORT_LIMITS.usageBatch) void sendUsage();
    else if (!usage.draining) scheduleUsage();
  }

  function persistNoticeMeta(next: NoticeMetaState): boolean {
    try {
      writeJsonFile(noticeMetaPath, next);
      noticeMeta = next;
      return true;
    } catch (error) {
      console.error("[reports] could not save the report notice state", error);
      return false;
    }
  }

  return {
    available: { usage: Boolean(reporting?.usage), errors: Boolean(reporting?.errors) },

    track(event) {
      enqueueUsage(event);
    },

    markActive() {
      if (!usageMayQueue()) return;
      const utcDay = new Date(now()).toISOString().slice(0, 10);
      if (utcDay === lastHeartbeatUtcDay) return;
      lastHeartbeatUtcDay = utcDay;
      enqueueUsage({ name: "app_active_heartbeat" });
    },

    observePreviousCrash(report) {
      if (!reporting?.usage || !usageMayQueue() || !report || report.source !== "main") return;
      const seenSeq = Math.max(noticeMeta.lastCrashSeq ?? 0, pendingCrashSeq ?? 0);
      if (report.through <= seenSeq) return;
      const reason = fatalMainCrashReason(report.text);
      if (!reason) return;
      pendingCrashSeq = report.through;
      enqueueUsage({ name: "crash_signal", source: "main", reason }, report.atMs);
      if (usageOn()) {
        persistNoticeMeta({ ...noticeMeta, lastCrashSeq: report.through });
      }
    },

    reportError(reported) {
      try {
        if (!reporting || !errorsMayQueue() || errorCount >= REPORT_LIMITS.errorsPerLaunch) return;
        if (
          errors.queue.length >= REPORT_LIMITS.errorQueue ||
          errorsPrepared >= REPORT_LIMITS.errorsPrepared
        )
          return;
        errorsPrepared += 1;
        const { report, key } = errorReport(reported, deps.facts(), reporting.dist, deps.locate);
        if (errorKeys.has(key)) return;
        if (errorKeys.size < REPORT_LIMITS.errorKeys) errorKeys.add(key);
        errorCount += 1;
        errors.queue.push(report);
        schedule(errors, errorsOn, REPORT_LIMITS.errorFlushMs, drainErrors);
      } catch (error) {
        console.error("[reports] could not prepare an error report", error);
      }
    },

    setPrivacy(next) {
      privacy = next;
      if (!next.usageReports) {
        drop(usage);
        pendingCrashSeq = null;
        lastHeartbeatUtcDay = null;
      }
      if (!next.errorReports) drop(errors);
      if (next.usageReports && pendingCrashSeq !== null && usageOn()) {
        if (pendingCrashSeq > (noticeMeta.lastCrashSeq ?? 0)) {
          persistNoticeMeta({ ...noticeMeta, lastCrashSeq: pendingCrashSeq });
        }
      }
      scheduleUsage();
      schedule(errors, errorsOn, REPORT_LIMITS.errorFlushMs, drainErrors);
    },

    noticeDue(next) {
      return {
        usage: Boolean(reporting?.usage) && next.usageReports && !usageAcknowledged(),
        errors: Boolean(reporting?.errors) && next.errorReports && !named.errors,
      };
    },

    acknowledgeNotice(shown) {
      const usageNeedsState = shown.usage && Boolean(reporting?.usage) && !named.usage;
      const errorsNeedsState = shown.errors && Boolean(reporting?.errors) && !named.errors;
      const usageNeedsNotice =
        shown.usage &&
        Boolean(reporting?.usage) &&
        (noticeMeta.usage ?? 0) < CURRENT_USAGE_NOTICE_VERSION;
      if (!usageNeedsState && !errorsNeedsState && !usageNeedsNotice) return;
      if (usageNeedsState || errorsNeedsState) {
        const next: ReportingState = {
          ...named,
          ...(usageNeedsState ? { usage: { installId: randomUUID() } } : {}),
          ...(errorsNeedsState ? { errors: true as const } : {}),
        };
        try {
          writeJsonFile(deps.statePath, next);
        } catch (error) {
          console.error("[reports] could not save the report state", error);
          return;
        }
        named = next;
      }
      if (usageNeedsNotice) {
        const nextMeta: NoticeMetaState = {
          ...noticeMeta,
          usage: CURRENT_USAGE_NOTICE_VERSION,
          ...(pendingCrashSeq !== null
            ? { lastCrashSeq: Math.max(noticeMeta.lastCrashSeq ?? 0, pendingCrashSeq) }
            : {}),
        };
        if (!persistNoticeMeta(nextMeta)) {
          schedule(errors, errorsOn, REPORT_LIMITS.errorFlushMs, drainErrors);
          return;
        }
      }
      scheduleUsage();
      schedule(errors, errorsOn, REPORT_LIMITS.errorFlushMs, drainErrors);
    },

    flush() {
      if (flushing) return flushing;
      quitting = true;
      clearTimer(usage);
      clearTimer(errors);
      flushing = (async () => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const finishUsage = async () => {
          while (usage.draining) await usage.draining;
          await sendUsage(true);
        };
        await Promise.race([
          Promise.allSettled([finishUsage(), drainErrors()]),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, REPORT_LIMITS.shutdownTimeoutMs);
          }),
        ]);
        clearTimeout(deadline);
        ended = true;
        drop(usage);
        drop(errors);
      })();
      return flushing;
    },
  };
}

function safeServerKind(read?: () => ServerKind): ServerKind {
  try {
    return read?.() ?? "none";
  } catch {
    return "none";
  }
}

function fatalMainCrashReason(text: string): "uncaughtException" | "module-load" | null {
  const sections = text.split(/\n\n+/u);
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const section = sections[i]!;
    if (section.includes("Uncaught exception")) return "uncaughtException";
    if (section.includes("The main module failed to load")) return "module-load";
    if (section.includes("Unhandled promise rejection")) return null;
  }
  return null;
}

function lane<Item>(): Lane<Item> {
  return { queue: [], sending: null, draining: null, pausedUntilMs: 0, failures: 0, timer: null };
}

function readState(path: string): ReportingState {
  try {
    return ReportingState.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

function readNoticeMeta(path: string): NoticeMetaState {
  try {
    return NoticeMetaState.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

function writeJsonFile(path: string, state: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicReplaceFileSync(path, (temporary) =>
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 }),
  );
}

/**
 * How long PostHog asked dohc to wait: a 429's Retry-After in seconds, or a
 * minute without one.
 */
export function rateLimitMs(response: Pick<Response, "status" | "headers">): number {
  return serviceRateLimitMs(response, {
    defaultPauseMs: REPORT_LIMITS.defaultPauseMs,
    maxPauseMs: REPORT_LIMITS.maxPauseMs,
  });
}

/**
 * The switches as the settings file sets them. A file dohc cannot use, or a
 * switch it cannot read, turns that report off rather than on.
 */
export function privacyInEffect(result: {
  settings: { privacy: PrivacySettings };
  source: string;
  ignored?: ReadonlyArray<{ key: string }>;
}): PrivacySettings {
  if (result.source === "recovered") return { usageReports: false, errorReports: false };
  const ignored = new Set(result.ignored?.map((setting) => setting.key));
  const readable = (key: keyof PrivacySettings) =>
    !ignored.has("privacy") && !ignored.has(`privacy.${key}`) && result.settings.privacy[key];
  return { usageReports: readable("usageReports"), errorReports: readable("errorReports") };
}
