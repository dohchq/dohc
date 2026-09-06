// Shared by the viewer's React suites: fetch fakes and act-loop settling.
import { act } from "react";
import { vi } from "vitest";

const SETTLE_TURN_LIMIT = 300;

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

/** Runs act turns until `condition` holds; fails after a bounded number of turns. */
export async function settle(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURN_LIMIT; turn += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    if (condition()) return;
  }
  throw new Error(
    `Condition did not settle within ${String(SETTLE_TURN_LIMIT)} act turns`,
  );
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
