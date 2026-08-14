import { T3_PINNED_VERSION } from "./t3Entry";

// The readiness contract from the 2026-08-13 t3 spike: poll the environment
// descriptor every 100 ms with a 1 s per-request timeout and a 60 s overall
// deadline, abort the moment the child exits, and accept only HTTP 200 with
// a decodable descriptor whose serverVersion is exactly the pinned release.
// Stdout is never the readiness signal; this endpoint is.
export const READINESS_INTERVAL_MS = 100;
export const READINESS_REQUEST_TIMEOUT_MS = 1_000;
export const READINESS_OVERALL_TIMEOUT_MS = 60_000;

export interface T3EnvironmentDescriptor {
  serverVersion: string;
}

export class T3VersionMismatchError extends Error {
  constructor(readonly observedVersion: string) {
    super(
      `The t3 server reports version ${observedVersion}; this plugin requires ` +
        `exactly ${T3_PINNED_VERSION}. The installed package does not match ` +
        "the plugin. Reinstall the t3-code plugin.",
    );
  }
}

export class T3ChildExitError extends Error {
  constructor() {
    super("The t3 server process exited before it became ready.");
  }
}

export class T3ReadinessTimeoutError extends Error {
  constructor(overallTimeoutMs: number) {
    super(
      `The t3 server did not become ready within the ${overallTimeoutMs} ms ` +
        "readiness deadline.",
    );
  }
}

export interface PollT3ReadinessInput {
  environmentUrl: string;
  /** Resolves when the child exits; readiness fails immediately then. */
  childExited: Promise<unknown>;
  fetchFn?: typeof fetch;
  intervalMs?: number;
  requestTimeoutMs?: number;
  overallTimeoutMs?: number;
  now?: () => number;
}

function decodeDescriptor(value: unknown): T3EnvironmentDescriptor | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "serverVersion" in value &&
    typeof value.serverVersion === "string"
  ) {
    return { serverVersion: value.serverVersion };
  }
  return null;
}

export async function pollT3Readiness(
  input: PollT3ReadinessInput,
): Promise<T3EnvironmentDescriptor> {
  const fetchFn = input.fetchFn ?? fetch;
  const intervalMs = input.intervalMs ?? READINESS_INTERVAL_MS;
  const requestTimeoutMs = input.requestTimeoutMs ?? READINESS_REQUEST_TIMEOUT_MS;
  const overallTimeoutMs = input.overallTimeoutMs ?? READINESS_OVERALL_TIMEOUT_MS;
  const now = input.now ?? Date.now;
  const deadline = now() + overallTimeoutMs;

  let exited = false;
  void Promise.resolve(input.childExited).then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );

  while (true) {
    if (exited) throw new T3ChildExitError();
    if (now() >= deadline) throw new T3ReadinessTimeoutError(overallTimeoutMs);
    try {
      const response = await fetchFn(input.environmentUrl, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.status === 200) {
        const descriptor = decodeDescriptor(await response.json());
        if (descriptor) {
          if (descriptor.serverVersion !== T3_PINNED_VERSION) {
            throw new T3VersionMismatchError(descriptor.serverVersion);
          }
          return descriptor;
        }
      }
    } catch (error) {
      if (error instanceof T3VersionMismatchError) throw error;
      // Not listening yet, request timeout, or an undecodable body: poll on.
    }
    if (exited) throw new T3ChildExitError();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
