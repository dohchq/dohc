import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  CRASH_REPORT_MAX_CHARS,
  CrashReportSource,
  type ReadCrashReportResult,
} from "../ipc/bridgeContract";
import {
  CRASH_EVENT_MAX_CHARS,
  crashEventSource,
  crashReportText,
  formatCrashEvent,
  type CrashEvent,
  type CrashFacts,
} from "./crashReport";

// A report keeps the newest five problems and counts the rest.
export const CRASH_REPORT_MAX_PROBLEMS = 5;
const SEND_TIMEOUT_MS = 20_000;

const PendingReport = z.object({
  version: z.literal(1),
  // The last problem's number. A revision names every problem up to it.
  seq: z.number().int().nonnegative(),
  leftOut: z.number().int().nonnegative(),
  problems: z.array(z.object({
    seq: z.number().int().positive(),
    atMs: z.number().int().nonnegative(),
    source: CrashReportSource,
    text: z.string().min(1).max(CRASH_EVENT_MAX_CHARS),
  })).max(CRASH_REPORT_MAX_PROBLEMS),
});
type PendingReport = z.infer<typeof PendingReport>;

// The problems in the report changed after the person read it. Send refuses,
// so what leaves is always what they read.
export class CrashReportChangedError extends Error {
  constructor() {
    super("The crash report changed. Open it again to read it before you send it.");
    this.name = "CrashReportChangedError";
  }
}

export interface CrashReportStore {
  // Never throws: it runs inside crash handlers.
  record(event: CrashEvent): void;
  read(): ReadCrashReportResult;
  // Removes the problems up to `revision`; a newer one stays.
  dismiss(revision: number): void;
  // Posts the report the person read to the report server, then removes it.
  send(revision: number): Promise<void>;
}

/**
 * The report server address, or null. Only https, or http to this computer
 * for tests, and never with a user name or password in it.
 */
export function crashReportEndpoint(value: string | undefined): URL | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  return url.protocol === "http:" && loopback ? url : null;
}

/**
 * The crash report on this computer, in one file. Recording writes it
 * synchronously, so a report survives a main process that is about to end.
 * Nothing here sends on its own: `send` is the only network call, and only
 * the person's Send report reaches it.
 */
export function createCrashReportStore(deps: {
  path: string;
  // Null when this build has no report server.
  endpoint: URL | null;
  facts(): CrashFacts;
  scrub(text: string): string;
  onChanged(): void;
  fetch?: typeof fetch;
}): CrashReportStore {
  const fetchReport = deps.fetch ?? fetch;
  let cached: PendingReport | null = null;

  function load(): PendingReport {
    if (cached) return cached;
    const empty: PendingReport = { version: 1, seq: 0, leftOut: 0, problems: [] };
    let raw: string;
    try {
      raw = readFileSync(deps.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[crash-report] could not read the crash report", error);
      }
      cached = empty;
      return cached;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = PendingReport.safeParse(json);
    if (!parsed.success) console.error("[crash-report] the crash report file is damaged; starting a new one");
    cached = parsed.success ? parsed.data : empty;
    return cached;
  }

  function save(report: PendingReport): void {
    mkdirSync(dirname(deps.path), { recursive: true });
    writeFileSync(`${deps.path}.tmp`, JSON.stringify(report), { mode: 0o600 });
    renameSync(`${deps.path}.tmp`, deps.path);
    cached = report;
  }

  function text(report: PendingReport): string {
    return crashReportText(report.problems.map((problem) => problem.text), report.leftOut)
      .slice(0, CRASH_REPORT_MAX_CHARS);
  }

  // The problems left out are older than every kept one, so they go too.
  function removeThrough(revision: number): void {
    const report = load();
    const kept = report.problems.filter((problem) => problem.seq > revision);
    if (kept.length === report.problems.length) return;
    save({ ...report, problems: kept, leftOut: 0 });
    deps.onChanged();
  }

  return {
    record(event) {
      try {
        const facts = deps.facts();
        const report = load();
        const seq = report.seq + 1;
        const problems = [...report.problems, {
          seq,
          atMs: facts.atMs,
          source: crashEventSource(event),
          text: formatCrashEvent(event, facts, deps.scrub),
        }];
        const dropped = Math.max(0, problems.length - CRASH_REPORT_MAX_PROBLEMS);
        save({
          version: 1,
          seq,
          leftOut: report.leftOut + dropped,
          problems: problems.slice(dropped),
        });
        deps.onChanged();
      } catch (error) {
        console.error("[crash-report] could not record a crash", error);
      }
    },

    read() {
      const report = load();
      const newest = report.problems.at(-1);
      return {
        report: newest
          ? {
              revision: report.seq,
              source: newest.source,
              problems: report.problems.length + report.leftOut,
              atMs: newest.atMs,
              text: text(report),
            }
          : null,
        sendTo: deps.endpoint?.host ?? null,
      };
    },

    dismiss(revision) {
      removeThrough(revision);
    },

    async send(revision) {
      if (!deps.endpoint) throw new Error("This build of dohc has no report server.");
      const report = load();
      if (report.problems.length === 0 || report.seq !== revision) throw new CrashReportChangedError();
      let response: Response;
      try {
        response = await fetchReport(deps.endpoint, {
          method: "POST",
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: text(report),
          // A redirect would send the report somewhere the person was not told.
          redirect: "error",
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error("The connection to the report server failed.", { cause: error });
      }
      if (!response.ok) throw new Error(`The report server answered ${response.status}.`);
      removeThrough(revision);
    },
  };
}
