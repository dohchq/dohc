// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CheckSharedViewAccessResult, DohcDesktopBridge } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import {
  createAutomationButtons,
  resetAutomationButtonsForTests,
} from "../collections/useAutomationButtons";
import { type SharedViewPulled, useSharedViewAccess } from "./useSharedViewAccess";

const check = vi.fn<DohcDesktopBridge["checkSharedViewAccess"]>();
let visible = true;
const verified = vi.fn();
const pull = vi.fn<() => Promise<SharedViewPulled>>();
const follow = vi.fn<() => Promise<unknown>>();
const persistent = vi.fn();
let credentialsChanged: Parameters<DohcDesktopBridge["onCloudSessionChanged"]>[0];
beforeEach(() => {
  vi.useFakeTimers();
  visible = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    visible ? "visible" : "hidden",
  );
  check.mockReset().mockResolvedValue({ status: "current", access: "edit" });
  verified.mockReset();
  pull.mockReset().mockResolvedValue("other");
  follow.mockReset().mockResolvedValue("current");
  persistent.mockReset();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  window.dohcDesktop = {
    checkSharedViewAccess: check,
    onCloudSessionChanged: (listener: typeof credentialsChanged) => {
      credentialsChanged = listener;
      return () => undefined;
    },
  } as unknown as DohcDesktopBridge;
});
afterEach(() => {
  cleanup();
  resetAutomationButtonsForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.dohcDesktop;
});
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });
function setup() {
  return renderHook(
    ({ workspaceId, admission }) =>
      useSharedViewAccess({
        workspaceId,
        admission,
        enabled: true,
        onVerified: verified,
        pull,
        followStatedLevel: follow,
        onPersistentFailure: persistent,
      }),
    { initialProps: { workspaceId: "A", admission: { superseded: false } } },
  );
}

function relayedButtons() {
  window.dohcDesktop = {
    ...window.dohcDesktop,
    onAutomationRunSettled: () => () => undefined,
    onAutomationRunWaiting: () => () => undefined,
    onCollectionAutomationsChanged: () => () => undefined,
    pressAutomationButton: async () => ({ busy: false, relayed: true }),
  } as unknown as DohcDesktopBridge;
  return createAutomationButtons({ workspaceId: "A", of: { collectionPath: "tasks" } });
}
async function relayPress(buttons = relayedButtons()) {
  await act(async () => buttons.press("Finish", { id: "row", label: "task" }));
  return buttons;
}

it("pulls every thirty seconds without a second access request", async () => {
  setup();
  await flush();
  pull.mockClear();
  await act(() => vi.advanceTimersByTimeAsync(29_999));
  expect(check).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(pull).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledTimes(1);
});

it("starts the next pull as soon as a held pull answers, and checks access when the level changed", async () => {
  pull.mockResolvedValue("held");
  setup();
  await flush();
  expect(pull).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(pull).toHaveBeenCalledTimes(2);
  expect(check).toHaveBeenCalledTimes(1);
  pull.mockResolvedValueOnce("level-changed");
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(pull).toHaveBeenCalledTimes(3);
  expect(check).toHaveBeenCalledTimes(2);
  expect(verified).toHaveBeenCalledTimes(2);
});

it("checks access again when a pull that ran beside an access check reports a level change", async () => {
  // The first access check reads the level before the change.
  check
    .mockResolvedValueOnce({ status: "current", access: "comment" })
    .mockResolvedValueOnce({ status: "current", access: "edit" });
  pull.mockResolvedValueOnce("level-changed");
  setup();
  await flush();
  await flush();
  expect(check).toHaveBeenCalledTimes(2);
  expect(verified).toHaveBeenLastCalledWith({ status: "current", access: "edit" });
});

it("never overlaps deferred requests and rechecks a focus event after that request", async () => {
  const response = deferred<CheckSharedViewAccessResult>();
  check.mockReturnValueOnce(response.promise);
  setup();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  act(() => window.dispatchEvent(new Event("focus")));
  expect(check).toHaveBeenCalledTimes(1);
  await act(async () => {
    response.resolve({ status: "current", access: "edit" });
  });
  expect(check).toHaveBeenCalledTimes(2);
});

it("checks again after an in-flight request when a push caller requests a recheck", async () => {
  const response = deferred<CheckSharedViewAccessResult>();
  check.mockReturnValueOnce(response.promise);
  const hook = setup();
  let requested: Promise<CheckSharedViewAccessResult>;
  act(() => {
    requested = hook.result.current();
  });
  check.mockResolvedValue({ status: "ended" });
  await act(async () => {
    response.resolve({ status: "current", access: "edit" });
    expect(await requested!).toEqual({ status: "ended" });
  });
  expect(check).toHaveBeenCalledTimes(2);
});

it("pauses hidden checks and coalesces visibility with immediate focus", async () => {
  visible = false;
  setup();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  act(() => window.dispatchEvent(new Event("focus")));
  expect(check).not.toHaveBeenCalled();
  visible = true;
  for (const event of ["visibilitychange", "focus"]) {
    act(() => (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event)));
    await flush();
  }
  expect(check).toHaveBeenCalledTimes(1);
});

it("keeps offline separate from ended and discards answers on close", async () => {
  check.mockResolvedValue({ status: "unverified" });
  const hook = setup();
  await flush();
  expect(verified).not.toHaveBeenCalled();
  const response = deferred<CheckSharedViewAccessResult>();
  check.mockReturnValueOnce(response.promise);
  act(() => window.dispatchEvent(new Event("focus")));
  hook.unmount();
  await act(async () => {
    response.resolve({ status: "ended" });
  });
  expect(verified).not.toHaveBeenCalled();
});

it("discards an answer after workspace admission is superseded", async () => {
  const response = deferred<CheckSharedViewAccessResult>();
  check.mockReturnValueOnce(response.promise);
  const hook = setup();
  hook.rerender({ workspaceId: "B", admission: { superseded: false } });
  await flush();
  verified.mockClear();
  await act(async () => {
    response.resolve({ status: "ended" });
  });
  expect(verified).not.toHaveBeenCalled();
});

it("rechecks immediately when workspace relay sync recovers", async () => {
  const admission = { superseded: false };
  const hook = renderHook(
    ({ relayFailed }) =>
      useSharedViewAccess({
        workspaceId: "A",
        admission,
        enabled: true,
        relayFailed,
        onVerified: verified,
        pull,
        followStatedLevel: follow,
        onPersistentFailure: persistent,
      }),
    { initialProps: { relayFailed: false } },
  );
  await flush();
  hook.rerender({ relayFailed: true });
  await flush();
  expect(check).toHaveBeenCalledTimes(1);
  hook.rerender({ relayFailed: false });
  await flush();
  expect(check).toHaveBeenCalledTimes(2);
  hook.rerender({ relayFailed: false });
  await flush();
  expect(check).toHaveBeenCalledTimes(2);
  expect(pull).toHaveBeenCalledTimes(2);
});

it("does not interpret another workspace's healthy sync as recovery", async () => {
  const hook = renderHook(
    ({ workspaceId, admission, relayFailed }) =>
      useSharedViewAccess({
        workspaceId,
        admission,
        enabled: true,
        relayFailed,
        onVerified: verified,
        pull,
        followStatedLevel: follow,
        onPersistentFailure: persistent,
      }),
    { initialProps: { workspaceId: "A", admission: { superseded: false }, relayFailed: true } },
  );
  await flush();
  hook.rerender({ workspaceId: "B", admission: { superseded: false }, relayFailed: false });
  await flush();
  expect(check).toHaveBeenCalledTimes(2);
  expect(check).toHaveBeenLastCalledWith({ workspaceId: "B" });
});

it("backs off 30, 60, 120, 240, 480, 600 seconds and reports the third failure once", async () => {
  pull.mockRejectedValue(new Error("offline"));
  setup();
  await flush();
  for (const [index, delay] of [30, 60, 120, 240, 480, 600, 600].entries()) {
    await act(() => vi.advanceTimersByTimeAsync(delay * 1000 - 1));
    expect(pull).toHaveBeenCalledTimes(index + 1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(pull).toHaveBeenCalledTimes(index + 2);
  }
  expect(persistent).toHaveBeenCalledTimes(1);
});

it.each(["focus", "online"])(
  "resets failure backoff on %s and resets it on success",
  async (event) => {
    pull.mockRejectedValue(new Error("offline"));
    setup();
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    act(() => window.dispatchEvent(new Event(event)));
    await flush();
    expect(pull).toHaveBeenCalledTimes(3);
    pull.mockResolvedValue("other");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(pull).toHaveBeenCalledTimes(4);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(pull).toHaveBeenCalledTimes(5);
  },
);

it.each([0, 1])("jitters a failure by twenty percent (random %s)", async (random) => {
  vi.mocked(Math.random).mockReturnValue(random);
  pull.mockRejectedValue(new Error("offline"));
  setup();
  await flush();
  const delay = random === 0 ? 24_000 : 36_000;
  await act(() => vi.advanceTimersByTimeAsync(delay - 1));
  expect(pull).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(pull).toHaveBeenCalledTimes(2);
});

it("pauses a 401 until credentials change, including focus, online and explicit requests", async () => {
  pull.mockRejectedValue(Object.assign(new Error("sign in"), { errorKind: "unauthorized" }));
  const hook = setup();
  await flush();
  await act(() => vi.advanceTimersByTimeAsync(3_600_000));
  for (const event of ["focus", "online"]) act(() => window.dispatchEvent(new Event(event)));
  await act(async () => {
    await hook.result.current();
    await hook.result.current.pull();
  });
  expect(pull).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledTimes(1);
  pull.mockResolvedValue("other");
  act(() => credentialsChanged({ phase: "changing", sessionKey: "account" }));
  await flush();
  expect(pull).toHaveBeenCalledTimes(1);
  act(() => credentialsChanged({ phase: "ready", sessionKey: "account" }));
  await flush();
  expect(pull).toHaveBeenCalledTimes(2);
});

it("has one queued pull while a pull is in flight and drops that queue while hidden", async () => {
  const pending = deferred<SharedViewPulled>();
  pull.mockReturnValueOnce(pending.promise);
  const hook = setup();
  await flush();
  act(() => {
    void hook.result.current.pull();
    void hook.result.current.pull();
    void hook.result.current.pull();
  });
  expect(pull).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve("other"));
  expect(pull).toHaveBeenCalledTimes(2);
  const next = deferred<SharedViewPulled>();
  pull.mockReturnValueOnce(next.promise);
  act(() => {
    void hook.result.current.pull();
    void hook.result.current.pull();
  });
  visible = false;
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => next.resolve("other"));
  await act(() => vi.advanceTimersByTimeAsync(3_600_000));
  expect(pull).toHaveBeenCalledTimes(3);
});

it("drops a stale pull failure after a workspace switch", async () => {
  const pending = deferred<SharedViewPulled>();
  pull.mockReturnValueOnce(pending.promise);
  const hook = setup();
  await flush();
  hook.rerender({ workspaceId: "B", admission: { superseded: false } });
  await flush();
  await act(async () =>
    pending.reject(Object.assign(new Error("old"), { errorKind: "unauthorized" })),
  );
  expect(persistent).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(pull).toHaveBeenCalledTimes(3);
});

it("makes 120 pull requests per idle visible hour, with no periodic access requests", async () => {
  setup();
  await flush();
  pull.mockClear();
  check.mockClear();
  await act(() => vi.advanceTimersByTimeAsync(3_600_000));
  expect(pull).toHaveBeenCalledTimes(120);
  expect(check).not.toHaveBeenCalled();
});

it.each(["relayed", "settled"])(
  "pulls only after a known Button settlement (%s), and ignores other workspaces",
  async (completion) => {
    window.dohcDesktop = {
      ...window.dohcDesktop,
      onAutomationRunSettled: () => () => undefined,
      onAutomationRunWaiting: () => () => undefined,
      onCollectionAutomationsChanged: () => () => undefined,
      pressAutomationButton: async () =>
        completion === "relayed"
          ? { busy: false, relayed: true }
          : {
              busy: false,
              claimId: "press",
              settled: { claimId: "press", outcome: "done", effects: [] },
            },
    } as unknown as DohcDesktopBridge;
    setup();
    await flush();
    const other = createAutomationButtons({ workspaceId: "B", of: { collectionPath: "tasks" } });
    await act(async () => other.press("Finish", { id: "row", label: "task" }));
    expect(pull).toHaveBeenCalledTimes(1);
    const buttons = createAutomationButtons({ workspaceId: "A", of: { collectionPath: "tasks" } });
    await act(async () => buttons.press("Finish", { id: "row", label: "task" }));
    expect(pull).toHaveBeenCalledTimes(completion === "settled" ? 2 : 1);
    buttons.close();
    other.close();
  },
);

it("starts the opening pull before a deferred access check resolves", async () => {
  const response = deferred<CheckSharedViewAccessResult>();
  check.mockReturnValueOnce(response.promise);
  setup();
  await flush();
  expect(pull).toHaveBeenCalledOnce();
  expect(verified).not.toHaveBeenCalled();
  await act(async () => response.resolve({ status: "current", access: "edit" }));
});

it("returns unverified to a write caller when credentials change during access verification", async () => {
  const hook = setup();
  await flush();
  verified.mockClear();
  const response = deferred<CheckSharedViewAccessResult>();
  check.mockReturnValueOnce(response.promise);
  let requested!: Promise<CheckSharedViewAccessResult>;
  act(() => {
    requested = hook.result.current();
  });
  act(() => credentialsChanged({ phase: "changing", sessionKey: "Y" }));
  await act(async () => {
    response.resolve({ status: "ended" });
    expect(await requested).toEqual({ status: "unverified" });
  });
  expect(verified).not.toHaveBeenCalled();
});

it("keeps a needs-reopen answer from posting a sign-in failure while opening", async () => {
  check.mockResolvedValue({ status: "needs-reopen" });
  pull.mockRejectedValue(Object.assign(new Error("Sign in"), { errorKind: "unauthorized" }));
  setup();
  await flush();
  expect(verified).toHaveBeenCalledWith({ status: "needs-reopen" });
  expect(persistent).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(pull).toHaveBeenCalledOnce();
});

it("adds four probes per relayed press at 2, 5, 10 and 20 seconds without access requests", async () => {
  setup();
  await flush();
  pull.mockClear();
  check.mockClear();
  await relayPress();
  let elapsed = 0;
  for (const at of [2_000, 5_000, 10_000, 20_000]) {
    await act(() => vi.advanceTimersByTimeAsync(at - elapsed - 1));
    expect(pull).toHaveBeenCalledTimes([2_000, 5_000, 10_000, 20_000].indexOf(at));
    await act(() => vi.advanceTimersByTimeAsync(1));
    elapsed = at;
  }
  expect(pull).toHaveBeenCalledTimes(4);
  expect(check).not.toHaveBeenCalled();
  expect(pull.mock.calls).toEqual([[true], [true], [true], [true]]);
  expect(vi.getTimerCount()).toBe(1);
  console.info("relayed Button: 4 added unchanged probes, 0 access requests, 1 timer");
});

it("measures 123 requests in an idle visible hour with one unchanged relayed press", async () => {
  setup();
  await flush();
  pull.mockClear();
  check.mockClear();
  await relayPress();
  await act(() => vi.advanceTimersByTimeAsync(3_600_000));
  expect(pull).toHaveBeenCalledTimes(123);
  expect(check).not.toHaveBeenCalled();
  console.info(
    "one relayed Button in an idle hour: 123 requests vs 120 without a press; 4 burst probes, net +3",
  );
});

it.each([1, 2, 3, 4])(
  "keeps all relayed Button probes when probe %s brings changes",
  async (changedAt) => {
    setup();
    await flush();
    pull.mockClear();
    check.mockClear();
    for (let count = 1; count < changedAt; count++) pull.mockResolvedValueOnce("other");
    pull.mockResolvedValueOnce("other");
    await relayPress();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(pull).toHaveBeenCalledTimes(4);
    expect(check).not.toHaveBeenCalled();
    expect(pull.mock.calls).toEqual([[true], [true], [true], [true]]);
  },
);

it("coalesces overdue Button probes behind a slow pull without overlap", async () => {
  setup();
  await flush();
  pull.mockClear();
  const response = deferred<SharedViewPulled>();
  pull.mockReturnValueOnce(response.promise);
  await relayPress();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(pull).toHaveBeenCalledOnce();
  await act(async () => response.resolve("other"));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(pull).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(pull).toHaveBeenCalledTimes(3);
  expect(pull.mock.calls).toEqual([[true], [true], [true]]);
});

it.each(["hidden", "credentials", "workspace", "failure"])(
  "cancels a Button burst on %s",
  async (reason) => {
    const hook = setup();
    await flush();
    pull.mockClear();
    await relayPress();
    if (reason === "hidden") {
      visible = false;
      act(() => document.dispatchEvent(new Event("visibilitychange")));
    }
    if (reason === "credentials")
      act(() => credentialsChanged({ phase: "changing", sessionKey: "Y" }));
    if (reason === "workspace") {
      hook.rerender({ workspaceId: "B", admission: { superseded: false } });
      await flush();
      pull.mockClear();
    }
    if (reason === "failure") pull.mockRejectedValueOnce(new Error("offline"));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(pull).toHaveBeenCalledTimes(reason === "failure" ? 1 : 0);
  },
);

it("limits focus requests to one per five seconds", async () => {
  setup();
  await flush();
  for (let second = 1; second <= 10; second++) {
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();
  }
  expect(pull).toHaveBeenCalledTimes(3);
  expect(check).toHaveBeenCalledTimes(3);
});

it("measures an idle visible hour including twelve focus returns with rapid alt-tab bursts", async () => {
  setup();
  await flush();
  pull.mockClear();
  check.mockClear();
  for (let focus = 0; focus < 12; focus++) {
    await act(() => vi.advanceTimersByTimeAsync(focus === 0 ? 175_000 : 305_000));
    for (let burst = 0; burst < 4; burst++) {
      act(() => window.dispatchEvent(new Event("focus")));
      await flush();
    }
  }
  await act(() => vi.advanceTimersByTimeAsync(70_000));
  console.info(
    `idle hour with focus: ${pull.mock.calls.length} pulls, ${check.mock.calls.length} access requests`,
  );
  expect(pull).toHaveBeenCalledTimes(129);
  expect(check).toHaveBeenCalledTimes(12);
});

it("does not postpone background pulls when a write requests an access check", async () => {
  const hook = setup();
  await flush();
  pull.mockClear();
  for (let index = 0; index < 3; index++) {
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    await act(async () => {
      await hook.result.current();
    });
  }
  expect(pull).toHaveBeenCalledTimes(2);
});

const more: CheckSharedViewAccessResult = {
  status: "current",
  access: "view",
  relayStatesMore: true,
};
const returnToWindow = async (afterMs = 5_000) => {
  await act(() => vi.advanceTimersByTimeAsync(afterMs));
  act(() => window.dispatchEvent(new Event("focus")));
  await flush();
};

it("follows the stated level once when a return finds the relay states more", async () => {
  setup();
  await flush();
  expect(follow).not.toHaveBeenCalled();
  check.mockResolvedValueOnce(more);
  await returnToWindow();
  expect(follow).toHaveBeenCalledOnce();
  expect(verified).toHaveBeenLastCalledWith(more);
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  await returnToWindow();
  expect(follow).toHaveBeenCalledOnce();
});

it("follows the stated level when the window opens on a share the relay states more for", async () => {
  check.mockResolvedValueOnce(more);
  const pulled = deferred<SharedViewPulled>();
  pull.mockReturnValueOnce(pulled.promise);
  setup();
  await flush();
  expect(follow).not.toHaveBeenCalled();
  await act(async () => pulled.resolve("other"));
  expect(follow).toHaveBeenCalledOnce();
});

it("asks for nothing more on returns while the levels agree", async () => {
  setup();
  await flush();
  for (let index = 0; index < 4; index++) await returnToWindow(6_000);
  expect(check).toHaveBeenCalledTimes(5);
  expect(pull).toHaveBeenCalledTimes(5);
  expect(follow).not.toHaveBeenCalled();
});

it("asks for one follow when two returns come in a row", async () => {
  setup();
  await flush();
  check.mockResolvedValue(more);
  follow.mockReturnValue(new Promise(() => undefined));
  await returnToWindow();
  await returnToWindow(1_000);
  expect(follow).toHaveBeenCalledOnce();
  expect(check).toHaveBeenCalledTimes(2);
});

it("keeps checking access while a follow has not finished", async () => {
  setup();
  await flush();
  check.mockResolvedValueOnce(more);
  follow.mockReturnValue(new Promise(() => undefined));
  await returnToWindow();
  expect(follow).toHaveBeenCalledOnce();
  check.mockResolvedValue({ status: "ended" });
  await returnToWindow(10_000);
  expect(check).toHaveBeenCalledTimes(3);
  expect(verified).toHaveBeenLastCalledWith({ status: "ended" });
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(pull).toHaveBeenCalledTimes(4);
});

it("does not follow again until the next return when the pin could not follow", async () => {
  setup();
  await flush();
  check.mockResolvedValue(more);
  await returnToWindow();
  expect(follow).toHaveBeenCalledOnce();
  await act(() => vi.advanceTimersByTimeAsync(600_000));
  expect(follow).toHaveBeenCalledOnce();
  await returnToWindow();
  expect(follow).toHaveBeenCalledTimes(2);
});

it("does not follow for a write caller's check or a pull alone", async () => {
  const hook = setup();
  await flush();
  check.mockResolvedValue(more);
  await act(async () => {
    expect(await hook.result.current()).toEqual(more);
    await hook.result.current.pull();
  });
  expect(follow).not.toHaveBeenCalled();
});

it("follows a verified upgrade when the pull beside the check failed, and still backs the pull off", async () => {
  setup();
  await flush();
  check.mockResolvedValueOnce(more);
  pull.mockRejectedValueOnce(new Error("offline"));
  await returnToWindow();
  expect(follow).toHaveBeenCalledOnce();
  expect(pull).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(29_999));
  expect(pull).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(pull).toHaveBeenCalledTimes(3);
  expect(follow).toHaveBeenCalledOnce();
});

it("does not follow when the check itself failed or could not verify", async () => {
  setup();
  await flush();
  check.mockRejectedValueOnce(new Error("offline"));
  await returnToWindow();
  check.mockResolvedValueOnce({ status: "unverified" });
  await returnToWindow(600_000);
  expect(follow).not.toHaveBeenCalled();
});

it("starts no follow for a workspace the window has left", async () => {
  const answer = deferred<CheckSharedViewAccessResult>();
  check.mockReturnValueOnce(answer.promise);
  const hook = setup();
  await flush();
  hook.rerender({ workspaceId: "B", admission: { superseded: false } });
  await flush();
  await act(async () => answer.resolve(more));
  expect(follow).not.toHaveBeenCalled();
});

it("keeps a follow that fails out of the pull's failure count", async () => {
  setup();
  await flush();
  check.mockResolvedValue(more);
  follow.mockRejectedValue(new Error("refresh failed"));
  for (let index = 0; index < 4; index++) await returnToWindow(6_000);
  expect(follow).toHaveBeenCalledTimes(4);
  expect(persistent).not.toHaveBeenCalled();
});

it("checks on a return within five seconds of a background pull", async () => {
  setup();
  await flush();
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(pull).toHaveBeenCalledTimes(2);
  expect(check).toHaveBeenCalledTimes(1);
  await returnToWindow(2_000);
  expect(check).toHaveBeenCalledTimes(2);
});
