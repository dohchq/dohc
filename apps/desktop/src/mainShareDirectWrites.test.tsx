// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { createShareDirectWriteDelivery } from "./ipc/shareDirectWriteDelivery";
import { shareDirectWriteDeliveryOperations, type DohcDesktopBridge, type ShareDirectWriteAnswerDelivery, type ShareDirectWriteDeliveryPayload, type ShareDirectWritesPushedEvent } from "./ipc/bridgeContract";
import { createShareDirectWriteQueue } from "./workspaces/shareDirectWriteQueue";
import { useShareDirectWrites, type DirectWriteNotice } from "./renderer/shell/useShareDirectWrites";
import { deferred } from "./testing/deferred";
import { useShellError } from "./renderer/shell/useShellError";
import { RendererWorkspaceSessionOwner } from "./window/rendererWorkspaceSessionOwner";

const REFUSED = { status: "pushed" as const, writes: [{ result: "refused" as const, paths: ["tasks/automations.yaml"], reason: "" }] };
type Input = ShareDirectWriteDeliveryPayload;
type Listen = Extract<Input, { action: "listen" }>;
type Callback = (event: ShareDirectWritesPushedEvent, delivery: ShareDirectWriteAnswerDelivery) => void;
type Navigation = (details: { isSameDocument: boolean; isMainFrame: boolean }) => void;
type Sender = { send(channel: string, event: ShareDirectWritesPushedEvent): void; once(event: "destroyed", callback: () => void): void; on(event: "did-start-navigation", callback: Navigation): void };

function harness(onAcknowledge?: () => void) {
  const order: string[] = [];
  const windows: ReturnType<typeof windowFor>[] = [];
  const sessions = new Map<Sender, { workspaceId: string; rendererDocumentId: string }>();
  const delivery = createShareDirectWriteDelivery<Sender>({
    targets: () => windows.map(window => window.sender), currentSession: sender => sessions.get(sender),
    isSharedView: workspaceId => workspaceId !== "owner",
  });
  const handlers = new Map<string, (event: { sender: Sender; trusted: boolean }, payload: unknown) => Promise<unknown>>();
  delivery.register<{ sender: Sender; trusted: boolean }, object>({
    handle: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender: event => { if (!event.trusted) throw new Error("untrusted"); },
    withActiveWorkspace: async () => { throw new Error("The handler owns admission"); },
  });
  const operation = (sender: Sender, input: Input, trusted = true) => handlers.get(shareDirectWriteDeliveryOperations.updateShareDirectWriteDelivery.channel)!({ sender, trusted }, input) as Promise<boolean>;
  const queue = createShareDirectWriteQueue({ push: async () => ({ status: "pushed", writes: [] }), report: delivery.report });
  function windowFor(workspaceId = "a") {
    const events: ShareDirectWritesPushedEvent[] = [];
    let callback: Callback | null = null, destroy!: () => void;
    let navigation: Navigation | undefined;
    let listening!: Listen;
    let deferUnsubscribe = false;
    const unsubscriptions: Array<() => Promise<boolean>> = [];
    const sender: Sender = {
      send: (_channel: string, event: ShareDirectWritesPushedEvent) => {
        events.push(event);
        void Promise.resolve().then(() => {
          if (!callback) return;
          const identity = listening;
          const update = (action: "claim" | "acknowledge" | "release") => operation(sender, { ...identity, action, answerId: event.answerId });
          callback(event, {
            claim: () => update("claim"), release: () => update("release"),
            acknowledge: async () => { order.push("acknowledge"); onAcknowledge?.(); return update("acknowledge"); },
          });
        });
      },
      once: (_event: "destroyed", listener: () => void) => { destroy = listener; },
      on: (_event: "did-start-navigation", listener: Navigation) => { navigation = listener; },
    };
    const rendererDocumentId = crypto.randomUUID();
    sessions.set(sender, { workspaceId, rendererDocumentId });
    const api = {
      pushShareDirectWrites: ({ workspaceId }: { workspaceId: string }) => queue.pushNow(workspaceId),
      onShareDirectWritesPushed: (listener: Callback, workspaceId: string) => {
        callback = listener;
        const identity: Listen = { workspaceId, rendererDocumentId, subscriptionId: crypto.randomUUID(), action: "listen", listening: true };
        listening = identity;
        void operation(sender, identity);
        return () => {
          callback = null;
          const unsubscribe = () => operation(sender, { ...identity, listening: false });
          if (deferUnsubscribe) unsubscriptions.push(unsubscribe);
          else void unsubscribe();
        };
      },
    } as unknown as DohcDesktopBridge;
    return { sender, api, events, identity: () => listening, destroy: () => { sessions.delete(sender); destroy(); },
      navigate: (isSameDocument = false, isMainFrame = true) => navigation?.({ isSameDocument, isMainFrame }),
      deferUnsubscribe: () => { deferUnsubscribe = true; }, flushUnsubscribe: () => Promise.all(unsubscriptions.splice(0).map(run => run())),
      move: (workspaceId: string, document: string = rendererDocumentId) => sessions.set(sender, { workspaceId, rendererDocumentId: document }) };
  }
  const addWindow = (workspaceId = "a") => { const window = windowFor(workspaceId); windows.push(window); return window; };
  return { delivery, operation, queue, addWindow, order };
}
function input(notices: DirectWriteNotice[], order: string[] = []) {
  return { workspaceId: "a", sharedView: true, enabled: true, ready: true, ownerName: "Owner",
    refreshShareView: async () => "current" as const, checkShareAccess: async () => "current" as const,
    sendShareChanges: async () => {}, showNotice: (notice: DirectWriteNotice) => { order.push("shown"); notices.push(notice); } };
}
afterEach(() => { cleanup(); delete window.dohcDesktop; });

it("acknowledges after the shell's toast and Notice state commits", async () => {
  let atAcknowledgment: string[] = [];
  const f = harness(() => { atAcknowledgment = [screen.getByTestId("toast").textContent!, screen.getByTestId("notices").textContent!]; });
  const target = f.addWindow();
  window.dohcDesktop = target.api;
  function Probe() {
    const shell = useShellError("a");
    useShareDirectWrites({ ...input([]), showNotice: shell.showDirectWriteNotice });
    return <><div data-testid="toast">{shell.shellErrors.at(-1)?.message}</div><div data-testid="notices">{shell.shellErrors.map(row => row.message).join("\n")}</div></>;
  }
  render(<Probe />);
  await act(async () => f.queue.report("a", REFUSED));
  expect(f.order).toEqual(["acknowledge"]);
  expect(atAcknowledgment).toEqual([
    "The sync relay did not accept your change to tasks/automations.yaml. Send it as a proposal.",
    "The sync relay did not accept your change to tasks/automations.yaml. Send it as a proposal.",
  ]);
});

it.each(["stale", "refused"] as const)("holds a %s answer until shown and acknowledged, then never replays it", async result => {
  const f = harness(), window = f.addWindow(), notices: DirectWriteNotice[] = [];
  f.queue.report("a", result === "refused" ? REFUSED : { status: "pushed", writes: [{ result, paths: ["tasks/One.md"], stalePath: "tasks/One.md", recoveredDraftPath: "tasks/Record draft.txt" }] });
  globalThis.window.dohcDesktop = window.api;
  const view = renderHook(() => useShareDirectWrites(input(notices, f.order)));
  await act(async () => {});
  expect(notices).toHaveLength(1);
  expect(f.order).toEqual(["shown", "acknowledge"]);
  expect(notices[0]!.send?.label).toBe("Send as proposal");
  if (result === "stale") expect(notices[0]!.message).toContain("Your text draft is kept");
  view.unmount();
  renderHook(() => useShareDirectWrites(input(notices)));
  await act(async () => { await f.queue.pushNow("a"); });
  expect(notices).toHaveLength(1);
});

it.each(["access check", "unsubscribe"] as const)("replays an answer dropped during %s", async race => {
  const f = harness(), target = f.addWindow(), notices: DirectWriteNotice[] = [];
  window.dohcDesktop = target.api;
  const check = deferred<"current">(), initial = input(notices);
  const view = renderHook(props => useShareDirectWrites(props), { initialProps: { ...initial, checkShareAccess: () => check.promise } });
  await act(async () => {});
  if (race === "access check") {
    await act(async () => f.queue.report("a", REFUSED));
    target.move("b");
    view.rerender({ ...initial, workspaceId: "b", checkShareAccess: () => check.promise });
  } else {
    target.deferUnsubscribe();
    view.unmount();
    await act(async () => f.queue.report("a", REFUSED));
  }
  await act(async () => check.resolve("current"));
  expect(notices).toHaveLength(0);
  target.move("a");
  if (race === "access check") view.rerender(initial);
  else renderHook(() => useShareDirectWrites(initial));
  await act(async () => { await target.flushUnsubscribe(); });
  expect(notices).toHaveLength(1);
  expect(notices[0]!.kind).toBe("direct-write-refused");
});

it("admits only the session workspace and document, and ignores older cleanup", async () => {
  const f = harness(), target = f.addWindow();
  const listener: Listen = { workspaceId: "a", rendererDocumentId: crypto.randomUUID(), subscriptionId: crypto.randomUUID(), action: "listen", listening: true };
  await expect(f.operation(target.sender, listener, false)).rejects.toThrow("untrusted");
  expect(await f.operation(target.sender, listener)).toBe(false);
  target.move("a", listener.rendererDocumentId);
  expect(await f.operation(target.sender, { ...listener, workspaceId: "b" })).toBe(false);
  expect(await f.operation(target.sender, listener)).toBe(true);
  const replacement = { ...listener, subscriptionId: crypto.randomUUID() };
  expect(await f.operation(target.sender, replacement)).toBe(true);
  expect(await f.operation(target.sender, { ...listener, listening: false })).toBe(false);
  f.delivery.report("a", REFUSED);
  const answerId = target.events[0]!.answerId;
  expect(await f.operation(target.sender, { ...replacement, action: "acknowledge", answerId })).toBe(false);
  target.move("b", listener.rendererDocumentId);
  expect(await f.operation(target.sender, { ...replacement, action: "claim", answerId })).toBe(false);
  target.move("owner", listener.rendererDocumentId);
  expect(await f.operation(target.sender, { ...replacement, workspaceId: "owner" })).toBe(false);
});

it("lets only the first claimant show and acknowledge an answer across two windows", async () => {
  const f = harness(), a = f.addWindow(), b = f.addWindow();
  a.api.onShareDirectWritesPushed(() => {}, "a"); b.api.onShareDirectWritesPushed(() => {}, "a");
  f.delivery.report("a", REFUSED);
  const answerId = a.events[0]!.answerId;
  const claims = await Promise.all([a, b].map(target => f.operation(target.sender, { ...target.identity(), action: "claim", answerId })));
  expect(claims).toEqual([true, false]);
  expect(await f.operation(b.sender, { ...b.identity(), action: "acknowledge", answerId })).toBe(false);
  expect(await f.operation(a.sender, { ...a.identity(), action: "acknowledge", answerId })).toBe(true);
  expect(await f.operation(a.sender, { ...a.identity(), action: "acknowledge", answerId })).toBe(false);
  const events = a.events.length + b.events.length;
  a.api.onShareDirectWritesPushed(() => {}, "a"); b.api.onShareDirectWritesPushed(() => {}, "a");
  expect(a.events.length + b.events.length).toBe(events);
});

it("releases an unshown claim on window destruction and retains at most eight answers", async () => {
  const f = harness(), a = f.addWindow(), b = f.addWindow();
  for (let row = 0; row < 10; row++) f.delivery.report("a", REFUSED);
  a.api.onShareDirectWritesPushed(() => {}, "a");
  expect(a.events).toHaveLength(8);
  const answerId = a.events[0]!.answerId;
  expect(await f.operation(a.sender, { ...a.identity(), action: "claim", answerId })).toBe(true);
  a.destroy();
  b.api.onShareDirectWritesPushed(() => {}, "a");
  expect(b.events).toHaveLength(8);
  expect(await f.operation(b.sender, { ...b.identity(), action: "claim", answerId })).toBe(true);
});

it("replays an unacknowledged answer to a replacement renderer document", async () => {
  const f = harness(), target = f.addWindow();
  target.api.onShareDirectWritesPushed(() => {}, "a");
  f.delivery.report("a", REFUSED);
  const old = target.identity(), answerId = target.events[0]!.answerId;
  target.move("a", crypto.randomUUID());
  const replacement = { ...old, rendererDocumentId: crypto.randomUUID(), subscriptionId: crypto.randomUUID() };
  target.move("a", replacement.rendererDocumentId);
  expect(await f.operation(target.sender, { ...old, action: "claim", answerId })).toBe(false);
  expect(await f.operation(target.sender, replacement)).toBe(true);
  expect(target.events).toHaveLength(2);
  expect(target.events[1]!.answerId).toBe(answerId);
});

it("replays the previous workspace when a listener replaces a claimed answer's workspace", async () => {
  const f = harness(), a = f.addWindow(), b = f.addWindow();
  a.api.onShareDirectWritesPushed(() => {}, "a"); b.api.onShareDirectWritesPushed(() => {}, "a");
  f.delivery.report("a", REFUSED);
  const answerId = a.events[0]!.answerId;
  expect(await f.operation(a.sender, { ...a.identity(), action: "claim", answerId })).toBe(true);
  a.move("b");
  a.api.onShareDirectWritesPushed(() => {}, "b");
  expect(b.events.map(event => event.answerId)).toEqual([answerId, answerId]);
  expect(await f.operation(b.sender, { ...b.identity(), action: "claim", answerId })).toBe(true);
});

it("replays an unshown claim when its renderer reloads without a new subscription", async () => {
  const f = harness(), a = f.addWindow(), b = f.addWindow();
  a.api.onShareDirectWritesPushed(() => {}, "a"); b.api.onShareDirectWritesPushed(() => {}, "a");
  f.delivery.report("a", REFUSED);
  const answerId = a.events[0]!.answerId;
  expect(await f.operation(a.sender, { ...a.identity(), action: "claim", answerId })).toBe(true);
  a.navigate(true); a.navigate(false, false);
  expect(b.events).toHaveLength(1);
  a.navigate();
  expect(b.events.map(event => event.answerId)).toEqual([answerId, answerId]);
  expect(await f.operation(a.sender, { ...a.identity(), action: "claim", answerId })).toBe(false);
  expect(await f.operation(b.sender, { ...b.identity(), action: "claim", answerId })).toBe(true);
});

it("replays an unshown claim on session retirement into an owner workspace", async () => {
  const events: ShareDirectWritesPushedEvent[][] = [[], []];
  const senders = events.map((rows, id) => ({ id, isDestroyed: () => false,
    send: (_channel: string, event: ShareDirectWritesPushedEvent) => rows.push(event), once: () => {}, on: () => {} }));
  const sessions = new RendererWorkspaceSessionOwner<typeof senders[number]>({ retirement: {
    retireSender: session => {
      delivery.retireSender(session.sender);
      return { requiredForAdmission: Promise.resolve(), detachedFromAdmission: Promise.resolve() };
    },
    retireWorkspace: async () => {},
  } });
  const delivery = createShareDirectWriteDelivery({ targets: () => senders, currentSession: sender => sessions.current(sender), isSharedView: workspaceId => workspaceId !== "owner" });
  const workspace = { workspaceId: "a", attachmentId: Symbol("a") };
  const listeners = senders.map((): Listen => ({ action: "listen", listening: true, workspaceId: "a", rendererDocumentId: crypto.randomUUID(), subscriptionId: crypto.randomUUID() }));
  for (const [index, sender] of senders.entries()) {
    await sessions.open(sender, workspace, listeners[index]!.rendererDocumentId);
    expect(delivery.update(sender, listeners[index]!)).toBe(true);
  }
  delivery.report("a", REFUSED);
  const answerId = events[0]![0]!.answerId;
  expect(delivery.update(senders[0]!, { ...listeners[0]!, action: "claim", answerId })).toBe(true);
  await sessions.open(senders[0]!, { workspaceId: "owner", attachmentId: Symbol("owner") }, listeners[0]!.rendererDocumentId);
  expect(events[1]!.map(event => event.answerId)).toEqual([answerId, answerId]);
  expect(delivery.update(senders[0]!, { ...listeners[0]!, action: "acknowledge", answerId })).toBe(false);
  expect(delivery.update(senders[1]!, { ...listeners[1]!, action: "claim", answerId })).toBe(true);
});

it.each(["readiness", "workspace"] as const)("acknowledges a committed Notice before %s cleanup can replay it", async transition => {
  let atAcknowledgment: string[] = [];
  const f = harness(() => { atAcknowledgment = [screen.getByTestId("toast").textContent!, screen.getByTestId("notices").textContent!]; });
  const target = f.addWindow();
  window.dohcDesktop = target.api;
  function Probe() {
    const [changed, setChanged] = useState(false);
    const shell = useShellError("a");
    useShareDirectWrites({ ...input([]), ready: !(changed && transition === "readiness"),
      workspaceId: changed && transition === "workspace" ? "owner" : "a",
      sharedView: !(changed && transition === "workspace"),
      showNotice: notice => { shell.showDirectWriteNotice(notice); setChanged(true); } });
    return <><div data-testid="toast">{shell.shellErrors.at(-1)?.message}</div><div data-testid="notices">{shell.shellErrors.map(row => row.message).join("\n")}</div></>;
  }
  render(<Probe />);
  await act(async () => f.queue.report("a", REFUSED));
  expect(f.order).toEqual(["acknowledge"]);
  expect(atAcknowledgment).toEqual([screen.getByTestId("toast").textContent, screen.getByTestId("notices").textContent]);
  expect(atAcknowledgment[0]).toContain("Send it as a proposal.");
  const other = f.addWindow();
  other.api.onShareDirectWritesPushed(() => {}, "a");
  expect(other.events).toHaveLength(0);
});
