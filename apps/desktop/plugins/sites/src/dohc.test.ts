// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from "vitest";

const SDK_PROTOCOL = "dohc:sdk:v1";
const postMessage = vi.fn();
const parentWindow = { postMessage } as unknown as Window;

function dispatchHostMessage(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", {
    data,
    origin: "https://host.dohc.test",
    source: parentWindow,
  }));
}

beforeAll(() => {
  window.history.replaceState(
    null,
    "",
    "/?dohcHostOrigin=https%3A%2F%2Fhost.dohc.test",
  );
  Object.defineProperty(window, "parent", {
    configurable: true,
    value: parentWindow,
  });
});

describe("sites panel dohc bridge", () => {
  it("collects an orphaned queue while another subscription stays active", async () => {
    const { subscribe } = await import("../ui/dohc.js");
    const activeEvents: unknown[] = [];
    const activeSubscription = subscribe(
      "files.watch",
      { path: "active" },
      (event) => activeEvents.push(event),
    );
    const activeRequest = postMessage.mock.calls.at(-1)?.[0] as {
      id: string;
    };
    dispatchHostMessage({
      protocol: SDK_PROTOCOL,
      id: activeRequest.id,
      ok: true,
      result: { subscriptionId: "sub_active" },
    });
    const unsubscribeActive = await activeSubscription;

    const failedSubscription = subscribe(
      "files.watch",
      { path: "failed" },
      () => undefined,
    );
    const failedRequest = postMessage.mock.calls.at(-1)?.[0] as {
      id: string;
    };
    dispatchHostMessage({
      protocol: SDK_PROTOCOL,
      type: "event",
      subscriptionId: "sub_reused",
      event: "change",
      data: { path: "failed/orphan.md" },
    });
    dispatchHostMessage({
      protocol: SDK_PROTOCOL,
      id: failedRequest.id,
      ok: false,
      error: { message: "no answer" },
    });
    await expect(failedSubscription).rejects.toThrow("no answer");

    dispatchHostMessage({
      protocol: SDK_PROTOCOL,
      type: "event",
      subscriptionId: "sub_active",
      event: "change",
      data: { path: "active/still-watched.md" },
    });
    expect(activeEvents).toEqual([{
      event: "change",
      data: { path: "active/still-watched.md" },
    }]);

    const reusedEvents: unknown[] = [];
    const reusedSubscription = subscribe(
      "files.watch",
      { path: "reused" },
      (event) => reusedEvents.push(event),
    );
    const reusedRequest = postMessage.mock.calls.at(-1)?.[0] as {
      id: string;
    };
    dispatchHostMessage({
      protocol: SDK_PROTOCOL,
      id: reusedRequest.id,
      ok: true,
      result: { subscriptionId: "sub_reused" },
    });
    const unsubscribeReused = await reusedSubscription;

    expect(reusedEvents).toEqual([]);

    unsubscribeActive();
    const activeUnsubscribeRequest = postMessage.mock.calls.at(-1)?.[0] as {
      id: string;
    };
    dispatchHostMessage({
      protocol: SDK_PROTOCOL,
      id: activeUnsubscribeRequest.id,
      ok: true,
      result: { ok: true },
    });

    unsubscribeReused();
    const reusedUnsubscribeRequest = postMessage.mock.calls.at(-1)?.[0] as {
      id: string;
    };
    dispatchHostMessage({
      protocol: SDK_PROTOCOL,
      id: reusedUnsubscribeRequest.id,
      ok: true,
      result: { ok: true },
    });
  });
});
