// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CHANNELS } from "./ipc/channels";
import { ShareDirectWritesSubscription, type DohcDesktopBridge, type PushShareDirectWritesResult, type ShareDirectWritesPushedEvent } from "./ipc/bridgeContract";
import { createShareDirectWriteQueue, DIRECT_WRITE_PUSH_DELAY_MS } from "./workspaces/shareDirectWriteQueue";
import { useShareDirectWrites, type DirectWriteNotice } from "./renderer/shell/useShareDirectWrites";

// Exercise main's notifier without starting Electron or its workspace services.
const main = readFileSync(resolve("src/main.ts"), "utf8");
const start = main.indexOf("function notifyShareDirectWritesPushed(");
const code = stripTypeScriptTypes(main.slice(start, main.indexOf("\n}", start) + 2));

afterEach(() => { cleanup(); vi.useRealTimers(); delete window.dohcDesktop; });

it("validates subscription updates and ignores an older subscription's cleanup", () => {
  const registrationStart = main.indexOf("  handleIpc(CHANNELS.shareDirectWritesPushed", main.indexOf("function registerIpcHandlers()"));
  const registration = stripTypeScriptTypes(main.slice(registrationStart, main.indexOf("  registerOperations", registrationStart)));
  const subscriptions = new WeakMap<object, unknown>();
  let handler!: (event: { sender: object; trusted: boolean }, payload: unknown) => void;
  new Function("handleIpc", "assertTrustedSender", "CHANNELS", "ShareDirectWritesSubscription", "shareDirectWriteListeners", registration)(
    (_channel: string, callback: typeof handler) => { handler = callback; },
    (event: { trusted: boolean }) => { if (!event.trusted) throw new Error("untrusted"); },
    CHANNELS, ShareDirectWritesSubscription, subscriptions,
  );
  const sender = {}, event = { sender, trusted: true };
  const input = { workspaceId: "share", rendererDocumentId: crypto.randomUUID(), subscriptionId: crypto.randomUUID(), listening: true };
  expect(() => handler({ ...event, trusted: false }, input)).toThrow("untrusted");
  expect(() => handler(event, { ...input, workspaceId: "" })).toThrow();
  expect(subscriptions.has(sender)).toBe(false);
  handler(event, input);
  const replacement = { ...input, subscriptionId: crypto.randomUUID() };
  handler(event, replacement);
  handler(event, { ...input, listening: false });
  expect(subscriptions.get(sender)).toEqual(replacement);
  handler(event, { ...replacement, listening: false });
  expect(subscriptions.has(sender)).toBe(false);
});

it.each(["stale", "refused"] as const)("holds a %s answer while the session has no listener, then shows it once on open", async result => {
  vi.useFakeTimers();
  let listener: ((event: ShareDirectWritesPushedEvent) => void) | null = null;
  const session = { workspaceId: "share", rendererDocumentId: "doc" };
  const sender = { send: (_channel: string, event: ShareDirectWritesPushedEvent) => listener?.(event) };
  const subscriptions = new WeakMap<object, typeof session>();
  const notify = new Function("BrowserWindow", "rendererWorkspaceSessions", "CHANNELS", "shareDirectWriteListeners",
    `${code}; return notifyShareDirectWritesPushed;`)(
    { getAllWindows: () => [{ webContents: sender }] }, { current: () => session }, CHANNELS, subscriptions,
  ) as (workspaceId: string, result: PushShareDirectWritesResult) => boolean;
  const answer: PushShareDirectWritesResult = { status: "pushed", writes: [result === "refused"
    ? { result, paths: ["tasks/automations.yaml"], reason: "" }
    : { result, paths: ["tasks/One.md"], stalePath: "tasks/One.md", recoveredDraftPath: "tasks/Record draft.txt" }] };
  const push = vi.fn(async (): Promise<PushShareDirectWritesResult> => ({ status: "pushed", writes: [] }));
  push.mockResolvedValueOnce(answer);
  const queue = createShareDirectWriteQueue({ push, report: notify });
  queue.edited("share");
  await vi.advanceTimersByTimeAsync(DIRECT_WRITE_PUSH_DELAY_MS);
  const notices: DirectWriteNotice[] = [];
  window.dohcDesktop = {
    pushShareDirectWrites: () => queue.pushNow("share"),
    onShareDirectWritesPushed: (callback: typeof listener) => {
      listener = callback;
      subscriptions.set(sender, session);
      return () => { listener = null; subscriptions.delete(sender); };
    },
  } as unknown as DohcDesktopBridge;
  renderHook(() => useShareDirectWrites({ workspaceId: "share", enabled: true, ready: true, ownerName: "Owner",
    refreshShareView: async () => "current", checkShareAccess: async () => "current",
    sendShareChanges: async () => {}, showNotice: notice => notices.push(notice) }));
  await act(async () => {});
  expect(notices).toHaveLength(1);
  expect(notices[0]!.send?.label).toBe("Send as proposal");
  if (result === "stale") expect(notices[0]!.message).toContain("Your text draft is kept in tasks/Record draft.txt");
  await act(async () => { await queue.pushNow("share"); });
  expect(notices).toHaveLength(1);
  expect(notify("other", answer)).toBe(false);
  session.rendererDocumentId = "replacement-doc";
  subscriptions.set(sender, { ...session, rendererDocumentId: "doc" });
  expect(notify("share", answer)).toBe(false);
});
