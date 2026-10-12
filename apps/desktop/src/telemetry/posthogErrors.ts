import {
  createStackParser,
  ErrorCoercer,
  ErrorPropertiesBuilder,
  nodeStackLineParser,
  type ExceptionList,
} from "@posthog/core/error-tracking";
import { PostHog, type EventMessage } from "posthog-node";
import type { ErrorReport } from "./errorReport";
import type { ErrorService } from "./reportingConfig";

// The trailer `posthog-cli sourcemap inject` appends to each file it
// injects. PostHog finds the file's uploaded source map by this ID.
const CHUNK_ID = /\n\/\/# chunkId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Carries a report's time to before_send, which moves it to the event.
const OCCURRED_AT = "dohc_occurred_at_ms";

// The SDK's client, reading only the error a report hands it. By default
// the SDK also opens each frame's file to quote lines around it.
class ErrorReportClient extends PostHog {
  protected override createErrorPropertiesBuilder(): ErrorPropertiesBuilder {
    return new ErrorPropertiesBuilder([new ErrorCoercer()], createStackParser("node:javascript", nodeStackLineParser));
  }
}

export type ErrorSender = (report: ErrorReport, signal: AbortSignal) => Promise<Response | undefined>;

/**
 * Sends each report as one PostHog exception through the SDK's
 * captureException path, as one request that `signal` can stop. It answers
 * the service's response, or nothing when no request left.
 */
export function createErrorSender(input: {
  service: ErrorService;
  fetch: typeof fetch;
  // A file under dohc's folder, by its path there.
  readCode(path: string): Promise<string>;
}): ErrorSender {
  // Each dohc file's chunk ID, by the name reports give the file.
  const chunkIds = new Map<string, string | null>();
  let sending: { signal: AbortSignal; response?: Response } | null = null;

  const client = new ErrorReportClient(input.service.key, {
    host: input.service.host,
    // The lane drops a report whose request failed.
    fetchRetryCount: 0,
    // A report is a few kilobytes; compressing it would wait on a worker thread.
    disableCompression: true,
    fetch: async (url, init) => {
      const current = sending;
      if (!current || current.signal.aborted) throw new Error("No error report is being sent.");
      const response = await input.fetch(url, {
        ...init,
        redirect: "error",
        signal: init.signal ? AbortSignal.any([init.signal, current.signal]) : current.signal,
      });
      current.response = response;
      return response;
    },
    before_send: (event) => event && finish(event),
  });

  function finish(event: EventMessage): EventMessage {
    const { [OCCURRED_AT]: atMs, ...properties } = event.properties ?? {};
    for (const exception of properties.$exception_list as ExceptionList) {
      const frames = exception.stacktrace?.frames ?? [];
      if (frames.length === 0) delete exception.stacktrace;
      for (const frame of frames) {
        // dohc's own code is the app; a dependency bundled into it is not.
        frame.in_app = Boolean(frame.filename?.startsWith("app:///") && !frame.filename.includes("/node_modules/"));
        const chunkId = frame.filename ? chunkIds.get(frame.filename) : undefined;
        if (chunkId) frame.chunk_id = chunkId;
      }
    }
    // The release the build's injected files name. The SDK also reads an
    // environment variable, which can hold anything.
    if (typeof properties.$release_id !== "string" || !UUID.test(properties.$release_id)) delete properties.$release_id;
    return { ...event, properties, timestamp: new Date(atMs as number) };
  }

  async function chunkIdIn(path: string): Promise<string | null> {
    if (!/\.[cm]?js$/.test(path)) return null;
    try {
      return CHUNK_ID.exec(await input.readCode(path))?.[1] ?? null;
    } catch {
      return null;
    }
  }

  return async (report, signal) => {
    for (const [file, path] of report.files) {
      if (!chunkIds.has(file)) chunkIds.set(file, await chunkIdIn(path));
    }
    if (signal.aborted) return undefined;
    const current: { signal: AbortSignal; response?: Response } = { signal };
    sending = current;
    try {
      await client.captureExceptionImmediate(report.error, undefined, { ...report.properties, [OCCURRED_AT]: report.atMs });
      return current.response;
    } finally {
      sending = null;
    }
  };
}
