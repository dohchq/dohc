import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { CodeLocation } from "../crashReports/crashReport";
import type { ReportKinds } from "../ipc/bridgeContract";
import { CHANNELS } from "../ipc/channels";
import type { PrivacySettings } from "../settings/userSettings";
import { sentryEnvelope, sentryEvent, type ErrorFacts, type ReportedError, type SentryEvent } from "./errorReport";
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
  [CHANNELS.createRelayShare]: () => ({ name: "share_created", method: "people" }),
  [CHANNELS.createRelayShareLink]: () => ({ name: "share_created", method: "link" }),
  // Publishing asks first: only an approved publication counts.
  [CHANNELS.publishOwnerApp]: (result) => {
    const outcome = result as { kind?: unknown; local?: unknown } | null;
    return outcome?.kind === "published" ? { name: "app_published", local: outcome.local === true } : null;
  },
  [CHANNELS.sendChatMessage]: () => ({ name: "chat_message_sent" }),
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

const ReportingState = z.object({
  // A random number for this installation. Usage reports carry it so a
  // count of people is possible; nothing else does.
  installId: z.string().uuid(),
}).strict();

export interface Telemetry {
  track(event: UsageEvent): void;
  // Never throws: it runs inside crash handlers.
  reportError(reported: ReportedError): void;
  // The person's switches. Until main first reads them, reports wait. A
  // switch that turns off drops what waits and stops a send under way.
  setPrivacy(privacy: PrivacySettings): void;
  // The reports the notice must name: those this launch can send and
  // `privacy` allows, until a window has shown the notice. None means no
  // notice is due. Asking changes nothing.
  noticeDue(privacy: PrivacySettings): ReportKinds;
  // A window shows the notice. Main saves the install ID, and reports may
  // leave from now on.
  acknowledgeNotice(): void;
  // The services this launch can send to.
  readonly available: ReportKinds;
  // Sends what waits, within the shutdown budget.
  flush(): Promise<void>;
}

interface Lane<Item> {
  queue: Item[];
  sending: AbortController | null;
  pausedUntilMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Usage and error reports, sent from main only. Nothing leaves before the
 * person has seen the notice and main has read their switches, and each
 * switch is read again just before every send. A failed send is dropped,
 * never retried.
 */
export function createTelemetry(deps: {
  reporting: Reporting | null;
  // Holds the install ID. It exists once a window showed the notice.
  statePath: string;
  facts(): ErrorFacts & { channel: string };
  locate(frame: string): CodeLocation | null;
  fetch?: typeof fetch;
  now?: () => number;
}): Telemetry {
  const { reporting } = deps;
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let privacy: PrivacySettings | null = null;
  let installId = reporting ? readInstallId(deps.statePath) : null;
  let usageCount = 0;
  let errorCount = 0;
  let errorsPrepared = 0;
  const errorKeys = new Set<string>();
  const usage: Lane<{ event: string; properties: Record<string, unknown>; timestamp: string }> = lane();
  const errors: Lane<SentryEvent> = lane();

  const usageOn = () => Boolean(reporting?.usage && installId && privacy?.usageReports);
  const errorsOn = () => Boolean(reporting?.errors && installId && privacy?.errorReports);
  // Before the switches are known, reports wait; afterwards, a switch that
  // is off takes nothing in.
  const usageMayQueue = () => Boolean(reporting?.usage) && (privacy === null || privacy.usageReports);
  const errorsMayQueue = () => Boolean(reporting?.errors) && (privacy === null || privacy.errorReports);

  function drop<Item>(target: Lane<Item>): void {
    target.queue.length = 0;
    target.sending?.abort();
    if (target.timer) clearTimeout(target.timer);
    target.timer = null;
  }

  function schedule<Item>(target: Lane<Item>, on: () => boolean, delayMs: number, run: () => Promise<void>): void {
    if (!on() || target.timer || target.queue.length === 0) return;
    target.timer = setTimeout(() => {
      target.timer = null;
      void run();
    }, delayMs);
    target.timer.unref?.();
  }

  async function post(
    target: Lane<unknown>,
    request: (signal: AbortSignal) => Promise<Response>,
    timeoutMs: number,
  ): Promise<void> {
    const controller = new AbortController();
    target.sending = controller;
    try {
      const response = await request(AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]));
      const pauseMs = rateLimitMs(response);
      if (pauseMs > 0) target.pausedUntilMs = now() + pauseMs;
    } catch {
      // Dropped: a send that failed once is likely to fail again.
    } finally {
      if (target.sending === controller) target.sending = null;
    }
  }

  async function sendUsage(timeoutMs: number = REPORT_LIMITS.requestTimeoutMs): Promise<void> {
    const service = reporting?.usage;
    while (service && usageOn() && !usage.sending && usage.queue.length > 0 && now() >= usage.pausedUntilMs) {
      const batch = usage.queue.splice(0, REPORT_LIMITS.usageBatch);
      const distinctId = installId!;
      await post(usage, (signal) => send(service.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: service.key,
          batch: batch.map((item) => ({ ...item, distinct_id: distinctId })),
        }),
        redirect: "error",
        signal,
      }), timeoutMs);
    }
    if (now() < usage.pausedUntilMs) usage.queue.length = 0;
  }

  async function sendErrors(timeoutMs: number = REPORT_LIMITS.requestTimeoutMs): Promise<void> {
    const service = reporting?.errors;
    while (service && errorsOn() && !errors.sending && errors.queue.length > 0 && now() >= errors.pausedUntilMs) {
      const event = errors.queue.shift()!;
      await post(errors, (signal) => send(service.url, {
        method: "POST",
        headers: {
          "content-type": "application/x-sentry-envelope",
          "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${service.publicKey}, sentry_client=dohc-desktop/1`,
        },
        body: sentryEnvelope(event, now()),
        redirect: "error",
        signal,
      }), timeoutMs);
    }
    if (now() < errors.pausedUntilMs) errors.queue.length = 0;
  }

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
        const { event, key } = sentryEvent(reported, deps.facts(), reporting, deps.locate);
        if (errorKeys.has(key)) return;
        if (errorKeys.size < REPORT_LIMITS.errorKeys) errorKeys.add(key);
        errorCount += 1;
        errors.queue.push(event);
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
      if (installId) return { usage: false, errors: false };
      return {
        usage: Boolean(reporting?.usage) && next.usageReports,
        errors: Boolean(reporting?.errors) && next.errorReports,
      };
    },

    acknowledgeNotice() {
      if (!reporting || installId) return;
      try {
        installId = writeInstallId(deps.statePath);
      } catch (error) {
        // Without the file the notice shows again, and nothing is sent.
        console.error("[reports] could not save the report state", error);
        return;
      }
      schedule(usage, usageOn, REPORT_LIMITS.usageFlushMs, sendUsage);
      schedule(errors, errorsOn, REPORT_LIMITS.errorFlushMs, sendErrors);
    },

    async flush() {
      for (const target of [usage, errors]) {
        if (target.timer) clearTimeout(target.timer);
        target.timer = null;
      }
      await Promise.allSettled([
        sendUsage(REPORT_LIMITS.shutdownTimeoutMs),
        sendErrors(REPORT_LIMITS.shutdownTimeoutMs),
      ]);
    },
  };
}

function lane<Item>(): Lane<Item> {
  return { queue: [], sending: null, pausedUntilMs: 0, timer: null };
}

function readInstallId(path: string): string | null {
  try {
    return ReportingState.parse(JSON.parse(readFileSync(path, "utf8"))).installId;
  } catch {
    return null;
  }
}

function writeInstallId(path: string): string {
  const installId = randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify({ installId }), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return installId;
}

/**
 * How long a service asked dohc to wait. Sentry names limits per category
 * in X-Sentry-Rate-Limits; an error report honors one with no categories or
 * with "error". A 429 without either header waits a minute.
 */
export function rateLimitMs(response: Pick<Response, "status" | "headers">): number {
  let seconds = 0;
  const limits = response.headers.get("x-sentry-rate-limits");
  for (const entry of limits?.split(",") ?? []) {
    const [retryAfter, categories = ""] = entry.trim().split(":");
    const names = categories.split(";").filter(Boolean);
    if (names.length === 0 || names.includes("error")) seconds = Math.max(seconds, Number(retryAfter) || 0);
  }
  if (response.status === 429 && seconds === 0) {
    const retryAfter = Number(response.headers.get("retry-after"));
    seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : REPORT_LIMITS.defaultPauseMs / 1000;
  }
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
