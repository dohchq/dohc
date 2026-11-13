// Shared by the viewer's React suites: fetch fakes and act-loop settling.
import { act } from "react";
import { vi } from "vitest";

// Read before any test fakes timers, so settle's limit is real time.
const now = performance.now.bind(performance);
// Work off the main thread, such as a save's hash, can outlast hundreds of act
// turns on a loaded host, so settle waits by time. 10 s matches expect.poll's.
const SETTLE_TIME_LIMIT_MS = 10_000;

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A response whose JSON body resolves only when the test releases it. */
export function heldJsonResponse(status: number): {
  bodyStarted: () => boolean;
  release: (value: unknown) => void;
  response: Response;
} {
  let bodyStarted = false;
  let releaseBody: (value: unknown) => void = () => {
    throw new Error("held response body is not ready");
  };
  const body = new Promise<unknown>((resolve) => {
    releaseBody = resolve;
  });
  const response = new Response(null, { status });
  vi.spyOn(response, "json").mockImplementation(() => {
    bodyStarted = true;
    return body as ReturnType<Response["json"]>;
  });
  return {
    bodyStarted: () => bodyStarted,
    release: (value) => releaseBody(value),
    response,
  };
}

export function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return `${input.pathname}${input.search}`;
  const url = new URL(input.url);
  return `${url.pathname}${url.search}`;
}

/** Runs act turns until `condition` holds; fails after 10 s without it. */
export async function settle(condition: () => boolean): Promise<void> {
  const started = now();
  for (;;) {
    await act(async () => {
      await Promise.resolve();
    });
    if (condition()) return;
    if (now() - started >= SETTLE_TIME_LIMIT_MS) {
      throw new Error(
        `Condition did not settle within ${String(SETTLE_TIME_LIMIT_MS)} ms`,
      );
    }
  }
}

/** Sets a controlled input's value the way a user would, so React sees the change. */
export function setControlValue(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new Error("control value setter is missing");
  act(() => {
    setter.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
