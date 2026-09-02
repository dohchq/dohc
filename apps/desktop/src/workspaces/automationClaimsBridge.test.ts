import type { Event } from "@dohc/workspace-engine-client";
import { describe, expect, it } from "vitest";
import { bridgeAutomationClaimsToExecutors } from "./automationClaimsBridge";

function daemonStub(): {
  daemon: { onEvent(handler: (event: Event) => void): () => void };
  emit(event: Event): void;
} {
  const handlers: Array<(event: Event) => void> = [];
  return {
    daemon: {
      onEvent(handler) {
        handlers.push(handler);
        return () => undefined;
      },
    },
    emit(event) {
      for (const handler of handlers) handler(event);
    },
  };
}

function claimed(payload: Event["payload"]): Event {
  return { seq: 1, sessionGeneration: 1, name: "automation.claimed", payload };
}

describe("bridgeAutomationClaimsToExecutors", () => {
  it("wakes exactly the workspace the claim names and drops everything else", () => {
    const stub = daemonStub();
    const woken: string[] = [];
    bridgeAutomationClaimsToExecutors(stub.daemon, (workspaceId) =>
      workspaceId === "ws-a"
        ? { notifyClaimed: () => woken.push(workspaceId) }
        : undefined,
    );

    stub.emit(claimed({ workspaceId: "ws-a", claimId: "claim-1" }));
    // A closed workspace, a foreign event name, and a malformed payload are
    // all dropped: the claim table drains on the workspace's next open.
    stub.emit(claimed({ workspaceId: "ws-closed" }));
    stub.emit({ ...claimed({ workspaceId: "ws-a" }), name: "record.updated" });
    stub.emit(claimed(null));
    stub.emit(claimed({ workspaceId: "" }));

    expect(woken).toEqual(["ws-a"]);
  });
});
