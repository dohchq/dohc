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

// dohc's own report server. The owner chooses it together with the update
// host. Until then a packaged build has none, so it offers Copy report only.
const DOHC_REPORT_SERVER: URL | null = null;

const PendingReport = z.object({
  version: z.literal(2),
  // Counts every change to the report, so any change to its text is a new
  // revision.
  revision: z.number().int().nonnegative(),
  // The last problem's number. Dismiss removes the problems up to it.
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

// What main's own dialog shows before a report leaves: where it goes and
// the exact text. Only a confirm there sends it.
export interface CrashReportSendRequest {
  host: string;
  text: string;
}

export interface CrashReportStore {
  // Never throws: it runs inside crash handlers.
  record(event: CrashEvent): void;
  read(): ReadCrashReportResult;
  // Removes the problems up to `through`; a newer one stays.
  dismiss(through: number): void;
  // Asks the person through `confirm`, main's own dialog, then posts
  // exactly the text it showed and removes those problems. False when they
  // did not confirm, or when another send is already asking.
  send(confirm: (request: CrashReportSendRequest) => Promise<boolean>): Promise<boolean>;
}

/**
 * The report server. A packaged build uses dohc's own. A development or
 * test build may name one in DOHC_CRASH_REPORT_URL: https, or http to this
 * computer, and never with a user name or password in it.
 */
export function crashReportEndpoint(value: string | undefined, packaged: boolean): URL | null {
  if (packaged) return DOHC_REPORT_SERVER;
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
 * Nothing here sends on its own: `send` is the only network call, and it
 * posts only after the person confirms in main's own dialog.
 */
export function createCrashReportStore(deps: {
  path: string;
  // Null when this build has no report server.
  endpoint: URL | null;
  facts(): CrashFacts;
  codeFrame(frame: string): string;
  onChanged(): void;
  fetch?: typeof fetch;
}): CrashReportStore {
  const fetchReport = deps.fetch ?? fetch;
  let cached: PendingReport | null = null;
  let asking = false;

  function load(): PendingReport {
    if (cached) return cached;
    const empty: PendingReport = { version: 2, revision: 0, seq: 0, leftOut: 0, problems: [] };
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

  function save(report: Omit<PendingReport, "revision">): void {
    const next = { ...report, revision: load().revision + 1 };
    mkdirSync(dirname(deps.path), { recursive: true });
    writeFileSync(`${deps.path}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${deps.path}.tmp`, deps.path);
    cached = next;
  }

  function text(report: PendingReport): string {
    return crashReportText(report.problems.map((problem) => problem.text), report.leftOut)
      .slice(0, CRASH_REPORT_MAX_CHARS);
  }

  // The problems left out are older than every kept one, so they go too.
  function removeThrough(through: number): void {
    const report = load();
    const kept = report.problems.filter((problem) => problem.seq > through);
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
          text: formatCrashEvent(event, facts, deps.codeFrame),
        }];
        const dropped = Math.max(0, problems.length - CRASH_REPORT_MAX_PROBLEMS);
        save({
          version: 2,
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
              revision: report.revision,
              through: report.seq,
              source: newest.source,
              problems: report.problems.length + report.leftOut,
              atMs: newest.atMs,
              text: text(report),
            }
          : null,
        sendTo: deps.endpoint?.host ?? null,
      };
    },

    dismiss(through) {
      removeThrough(through);
    },

    async send(confirm) {
      if (!deps.endpoint) throw new Error("This build of dohc has no report server.");
      if (asking) return false;
      const report = load();
      if (report.problems.length === 0) throw new Error("There is no crash report to send.");
      // The snapshot the dialog shows is the text that is posted, whatever
      // is recorded while the dialog is open.
      const snapshot = text(report);
      const through = report.seq;
      asking = true;
      try {
        if (!(await confirm({ host: deps.endpoint.host, text: snapshot }))) return false;
        let response: Response;
        try {
          response = await fetchReport(deps.endpoint, {
            method: "POST",
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: snapshot,
            // A redirect would send the report somewhere the person was not told.
            redirect: "error",
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
        } catch (error) {
          throw new Error("The connection to the report server failed.", { cause: error });
        }
        if (!response.ok) throw new Error(`The report server answered ${response.status}.`);
        removeThrough(through);
        return true;
      } finally {
        asking = false;
      }
    },
  };
}
