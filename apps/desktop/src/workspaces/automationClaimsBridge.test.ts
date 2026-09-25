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

  it("routes a claim inserted failed to the failure surface, not the drain", () => {
    const stub = daemonStub();
    const woken: string[] = [];
    const failed: string[] = [];
    bridgeAutomationClaimsToExecutors(
      stub.daemon,
      (workspaceId) => ({ notifyClaimed: () => woken.push(workspaceId) }),
      (workspaceId) => failed.push(workspaceId),
    );

    // The depth cap's chain-stopped row: never drainable work, so waking
    // the executor would only spin claimNext for nothing.
    stub.emit(
      claimed({ workspaceId: "ws-a", claimId: "claim-1", state: "failed" }),
    );
    stub.emit(
      claimed({ workspaceId: "ws-a", claimId: "claim-2", state: "pending" }),
    );

    expect(failed).toEqual(["ws-a"]);
    expect(woken).toEqual(["ws-a"]);
  });

  it("routes a retried claim to both the drain and the failure surface", () => {
    const stub = daemonStub();
    const woken: string[] = [];
    const failed: string[] = [];
    bridgeAutomationClaimsToExecutors(
      stub.daemon,
      (workspaceId) => ({ notifyClaimed: () => woken.push(workspaceId) }),
      (workspaceId) => failed.push(workspaceId),
    );

    // automations.retry announces the requeued claim as run 2: it is work
    // to drain, and one fewer failure for the owner's notice.
    stub.emit(
      claimed({ workspaceId: "ws-a", claimId: "claim-1", state: "pending", run: 2 }),
    );

    expect(woken).toEqual(["ws-a"]);
    expect(failed).toEqual(["ws-a"]);
  });
});
