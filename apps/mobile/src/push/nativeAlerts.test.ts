import { describe, expect, it, vi } from "vitest";
import type { AccountState } from "../server/account";

const cleared: string[] = [];
vi.mock("expo-notifications", () => ({
  PermissionStatus: { GRANTED: "granted", DENIED: "denied" },
  dismissAllNotificationsAsync: async () => void cleared.push("dismiss"),
  unregisterForNotificationsAsync: async () => void cleared.push("unregister"),
}));

const { clearAlertsAtSignOut } = await import("./nativeAlerts");

const out = (pendingSignOut: "running" | "failed" | null): AccountState => ({
  status: "signed-out",
  origin: "https://dohc.example.com",
  ended: false,
  forgetFailed: false,
  pendingSignOut,
});

function account(initial: AccountState) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    move(next: AccountState) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("clearing alerts", () => {
  it("happens when a sign-in ends, and when a launch finds a Sign out pending, once each", () => {
    const launch = account({ status: "loading" });
    clearAlertsAtSignOut(launch);
    launch.move(out("running"));
    launch.move(out("failed"));
    launch.move(out(null));
    expect(cleared).toEqual(["dismiss", "unregister"]);

    cleared.length = 0;
    const plain = account({ status: "loading" });
    clearAlertsAtSignOut(plain);
    plain.move(out(null));
    expect(cleared).toEqual([]);
    plain.move({ status: "signed-in", signIn: {} as never });
    plain.move(out(null));
    expect(cleared).toEqual(["dismiss", "unregister"]);
  });

  it("happens when a launch can't read whether a Sign out is pending", () => {
    cleared.length = 0;
    const launch = account({ status: "loading" });
    clearAlertsAtSignOut(launch);
    launch.move({ status: "unreadable" });
    expect(cleared).toEqual(["dismiss", "unregister"]);
  });
});
