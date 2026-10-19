import { relayShareOperations } from "../ipc/shareOperations";
import { chatOperations } from "../ipc/chatOperations";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicReplaceFileSync } from "../atomicReplaceFile";
import type { CodeLocation } from "../crashReports/crashReport";
import type { ReportKinds } from "../ipc/bridgeContract";
import { CHANNELS } from "../ipc/channels";
import type { PrivacySettings } from "../settings/userSettings";
import { errorReport, type ErrorFacts, type ErrorReport, type ReportedError } from "./errorReport";
import type { ErrorSender } from "./posthogErrors";
import type { Reporting } from "./reportingConfig";

// Every usage event dohc counts. Each counts one finished action and
// carries nothing about what it acted on.
export type UsageEvent =
  | { name: "app_launched" }
  | { name: "workspace_created" }
  | { name: "workspace_opened" }
  | { name: "share_created"; method: "people" | "link" }
  | { name: "app_published"; local: boolean }
  | { name: "chat_message_sent" };

// The finished actions a usage report counts, by the renderer request that
// does them. A request that failed did not finish, so it counts nothing.
const USAGE_EVENTS: Readonly<Record<string, (result: unknown) => UsageEvent | null>> = {
  [CHANNELS.createLocalWorkspace]: () => ({ name: "workspace_created" }),
  [CHANNELS.openWorkspace]: () => ({ name: "workspace_opened" }),
  [relayShareOperations.createRelayShare.channel]: () => ({ name: "share_created", method: "people" }),
  [relayShareOperations.createRelayShareLink.channel]: () => ({ name: "share_created", method: "link" }),
  // Publishing asks first: only an approved publication counts.
  [CHANNELS.publishOwnerApp]: (result) => {
    const outcome = result as { kind?: unknown; local?: unknown } | null;
    return outcome?.kind === "published" ? { name: "app_published", local: outcome.local === true } : null;
  },
  [chatOperations.sendChatMessage.channel]: () => ({ name: "chat_message_sent" }),
};

/** The usage event a request that answered `result` counts, if any. */
export function usageEventFor(channel: string, result: unknown): UsageEvent | null {
  return Object.hasOwn(USAGE_EVENTS, channel) ? USAGE_EVENTS[channel]!(result) : null;
}

// Limits that keep reports small and a loop that fails from flooding them.
export const REPORT_LIMITS = {
  usageQueue: 100,
  usageBatch: 50,
  usagePerLaunch: 1_000,
  usageFlushMs: 60_000,
  errorQueue: 10,
  errorsPerLaunch: 25,
  // Errors prepared per launch, repeats included, so a loop that keeps
  // failing stops costing work.
  errorsPrepared: 100,
  // Distinct problems remembered, so a repeat is not sent again.
  errorKeys: 200,
  errorFlushMs: 1_000,
  requestTimeoutMs: 10_000,
  shutdownTimeoutMs: 3_000,
  // A rate limit with no time stops a service for this long; none for longer than an hour.
  defaultPauseMs: 60_000,
  maxPauseMs: 3_600_000,
} as const;

// The kinds of report a notice on screen has named, each on its own. A file
// main cannot read names none, so the notice shows again.
const ReportingState = z.object({
  usage: z.object({
    // A random number for this installation, made when a notice first names
    // usage reports. Usage reports carry it so a count of people is
    // possible; nothing else does.
    installId: z.string().uuid(),
  }).strict().optional(),
  errors: z.literal(true).optional(),
}).strict();
type ReportingState = z.infer<typeof ReportingState>;

export interface Telemetry {
  track(event: UsageEvent): void;
  // Never throws: it runs inside crash handlers.
  reportError(reported: ReportedError): void;
  // The person's switches. Until main first reads them, reports wait. A
  // switch that turns off drops what waits and stops a send under way.
  setPrivacy(privacy: PrivacySettings): void;
  // The reports the notice must name: those this launch can send and
  // `privacy` allows that no notice on screen has named yet. None means no
  // notice is due. Asking changes nothing.
  noticeDue(privacy: PrivacySettings): ReportKinds;
  // A window shows a notice that names `shown`. Main saves those kinds, and
  // reports of those kinds may leave from now on.
  acknowledgeNotice(shown: ReportKinds): void;
  // The services this launch can send to.
  readonly available: ReportKinds;
  // At quit: sends what waits, a send under way included, within one
  // shutdown deadline, then drops the rest. Nothing leaves after it.
  flush(): Promise<void>;
}

interface Lane<Item> {
  queue: Item[];
  sending: AbortController | null;
  // The loop that sends what waits, while one runs.
  draining: Promise<void> | null;
  pausedUntilMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Usage and error reports, sent from main only. No report leaves before a
 * notice on screen has named its kind and main has read the switches, and
 * each switch is read again just before every send. A failed send is
 * dropped, never retried.
 */
export function createTelemetry(deps: {
  reporting: Reporting | null;
  // Holds the kinds a notice on screen has named, and the install ID.
  statePath: string;
  facts(): ErrorFacts;
  locate(frame: string): CodeLocation | null;
  // A file under dohc's folder, by the path `locate` gives it.
  readCode(path: string): Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
}): Telemetry {
  const { reporting } = deps;
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let privacy: PrivacySettings | null = null;
  let named: ReportingState = reporting ? readState(deps.statePath) : {};
  // Quit began, so no timer starts; then quit's flush ended, so nothing leaves.
  let quitting = false;
  let ended = false;
  let usageCount = 0;
  let errorCount = 0;
  let errorsPrepared = 0;
  const errorKeys = new Set<string>();
  const usage: Lane<{ event: string; properties: Record<string, unknown>; timestamp: string }> = lane();
  const errors: Lane<ErrorReport> = lane();
  // PostHog's SDK, loaded when the first error report leaves.
  let errorSender: Promise<ErrorSender> | null = null;

  const usageOn = () => !ended && Boolean(reporting?.usage && named.usage && privacy?.usageReports);
  const errorsOn = () => !ended && Boolean(reporting?.errors && named.errors && privacy?.errorReports);
  // Before the switches are known, reports wait; afterwards, a switch that
  // is off takes nothing in.
  const usageMayQueue = () => !ended && Boolean(reporting?.usage) && (privacy === null || privacy.usageReports);
  const errorsMayQueue = () => !ended && Boolean(reporting?.errors) && (privacy === null || privacy.errorReports);

  function drop<Item>(target: Lane<Item>): void {
    target.queue.length = 0;
    target.sending?.abort();
    if (target.timer) clearTimeout(target.timer);
    target.timer = null;
  }

  function schedule<Item>(target: Lane<Item>, on: () => boolean, delayMs: number, run: () => Promise<void>): void {
    if (quitting || !on() || target.timer || target.queue.length === 0) return;
    target.timer = setTimeout(() => {
      target.timer = null;
      void run();
    }, delayMs);
    target.timer.unref?.();
  }

  // One loop sends a lane's reports while it may, and a second caller joins
  // it. The loop clears itself in the step that ends it, so nobody joins a
  // loop that has stopped. A rate limit drops what waits.
  function drain<Item>(target: Lane<Item>, on: () => boolean, sendNext: () => Promise<void>): Promise<void> {
    const ready = () => on() && target.queue.length > 0 && now() >= target.pausedUntilMs;
    const dropIfPaused = () => {
      if (now() < target.pausedUntilMs) target.queue.length = 0;
    };
    if (!target.draining && ready()) {
      target.draining = (async () => {
        try {
          do await sendNext(); while (ready());
        } finally {
          target.draining = null;
          dropIfPaused();
        }
      })();
    }
    if (!target.draining) dropIfPaused();
    return target.draining ?? Promise.resolve();
  }

  async function post(target: Lane<unknown>, request: (signal: AbortSignal) => Promise<Response | undefined>): Promise<void> {
    const controller = new AbortController();
    target.sending = controller;
    try {
      const response = await request(AbortSignal.any([controller.signal, AbortSignal.timeout(REPORT_LIMITS.requestTimeoutMs)]));
      const pauseMs = response ? rateLimitMs(response) : 0;
      if (pauseMs > 0) target.pausedUntilMs = now() + pauseMs;
    } catch {
      // Dropped: a send that failed once is likely to fail again.
    } finally {
      if (target.sending === controller) target.sending = null;
    }
  }

  const sendUsage = () => drain(usage, usageOn, async () => {
    const batch = usage.queue.splice(0, REPORT_LIMITS.usageBatch);
    const service = reporting?.usage;
    if (!service || !named.usage) return;
    const distinctId = named.usage.installId;
    await post(usage, (signal) => send(service.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: service.key,
        batch: batch.map((item) => ({ ...item, distinct_id: distinctId })),
      }),
      redirect: "error",
      signal,
    }));
  });

  const sendErrors = () => drain(errors, errorsOn, async () => {
    const service = reporting?.errors;
    const report = errors.queue.shift();
    if (!service || !report) return;
    await post(errors, async (signal) => {
      errorSender ??= import("./posthogErrors").then(({ createErrorSender }) =>
        createErrorSender({ service, fetch: send, readCode: deps.readCode }));
      return await (await errorSender)(report, signal);
    });
  });

  return {
    available: { usage: Boolean(reporting?.usage), errors: Boolean(reporting?.errors) },

    track(event) {
      if (!usageMayQueue() || usageCount >= REPORT_LIMITS.usagePerLaunch) return;
      if (usage.queue.length >= REPORT_LIMITS.usageQueue) return;
      usageCount += 1;
      const facts = deps.facts();
      const { name, ...fields } = event;
      usage.queue.push({
        event: name,
        properties: {
          // An anonymous count: no person profile and no location from the address.
          $process_person_profile: false,
          $geoip_disable: true,
          $lib: "dohc-desktop",
          app_version: facts.version,
          channel: facts.channel,
          os: facts.os,
          arch: facts.arch,
          ...fields,
        },
        timestamp: new Date(facts.atMs).toISOString(),
      });
      if (usage.queue.length >= REPORT_LIMITS.usageBatch) void sendUsage();
      else schedule(usage, usageOn, REPORT_LIMITS.usageFlushMs, sendUsage);
    },

    reportError(reported) {
      try {
        if (!reporting || !errorsMayQueue() || errorCount >= REPORT_LIMITS.errorsPerLaunch) return;
        if (errors.queue.length >= REPORT_LIMITS.errorQueue || errorsPrepared >= REPORT_LIMITS.errorsPrepared) return;
        errorsPrepared += 1;
        const { report, key } = errorReport(reported, deps.facts(), reporting.dist, deps.locate);
        if (errorKeys.has(key)) return;
        if (errorKeys.size < REPORT_LIMITS.errorKeys) errorKeys.add(key);
        errorCount += 1;
        errors.queue.push(report);
        schedule(errors, errorsOn, REPORT_LIMITS.errorFlushMs, sendErrors);
      } catch (error) {
        console.error("[reports] could not prepare an error report", error);
      }
    },

    setPrivacy(next) {
      privacy = next;
      if (!next.usageReports) drop(usage);
      if (!next.errorReports) drop(errors);
      schedule(usage, usageOn, REPORT_LIMITS.usageFlushMs, sendUsage);
      schedule(errors, errorsOn, REPORT_LIMITS.errorFlushMs, sendErrors);
    },

    noticeDue(next) {
      return {
        usage: Boolean(reporting?.usage) && next.usageReports && !named.usage,
        errors: Boolean(reporting?.errors) && next.errorReports && !named.errors,
      };
    },

    acknowledgeNotice(shown) {
      // What the notice named counts, whatever the switches say by now.
      const usageNamed = shown.usage && Boolean(reporting?.usage) && !named.usage;
      const errorsNamed = shown.errors && Boolean(reporting?.errors) && !named.errors;
      if (!usageNamed && !errorsNamed) return;
      const next: ReportingState = {
        ...named,
        ...(usageNamed ? { usage: { installId: randomUUID() } } : {}),
        ...(errorsNamed ? { errors: true as const } : {}),
      };
      try {
        writeState(deps.statePath, next);
      } catch (error) {
        // Without the file the notice shows again, and nothing is sent.
        console.error("[reports] could not save the report state", error);
        return;
      }
      named = next;
      schedule(usage, usageOn, REPORT_LIMITS.usageFlushMs, sendUsage);
      schedule(errors, errorsOn, REPORT_LIMITS.errorFlushMs, sendErrors);
    },

    async flush() {
      if (quitting) return;
      quitting = true;
      for (const target of [usage, errors]) {
        if (target.timer) clearTimeout(target.timer);
        target.timer = null;
      }
      // A send under way is joined, not repeated. A service that does not
      // answer in time costs the deadline, and what waits is dropped.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([sendUsage(), sendErrors()]),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, REPORT_LIMITS.shutdownTimeoutMs);
        }),
      ]);
      clearTimeout(deadline);
      ended = true;
      drop(usage);
      drop(errors);
    },
  };
}

function lane<Item>(): Lane<Item> {
  return { queue: [], sending: null, draining: null, pausedUntilMs: 0, timer: null };
}

function readState(path: string): ReportingState {
  try {
    return ReportingState.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

function writeState(path: string, state: ReportingState): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicReplaceFileSync(path, (temporary) => writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 }));
}

/**
 * How long PostHog asked dohc to wait: a 429's Retry-After in seconds, or a
 * minute without one.
 */
export function rateLimitMs(response: Pick<Response, "status" | "headers">): number {
  if (response.status !== 429) return 0;
  const retryAfter = Number(response.headers.get("retry-after"));
  const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : REPORT_LIMITS.defaultPauseMs / 1000;
  return Math.min(seconds * 1000, REPORT_LIMITS.maxPauseMs);
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
