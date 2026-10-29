import { expect, it, vi } from "vitest";
import { CHAT_DISPATCH_NOTICES_MAX, ChatDispatchNoticesEvent } from "../ipc/bridgeContract";
import { createChatDispatchNotices } from "./chatDispatchNotices";

it("retains the latest notice per workspace and reason until that row is dismissed", () => {
  const publish = vi.fn();
  const notices = createChatDispatchNotices(publish);
  notices.report("a", { reason: "no-runner", threadId: "t1", message: "No runner." });
  const first = notices.register("a").notices[0]!;
  notices.report("a", { reason: "no-runner", threadId: "t2", message: "Dispatch is off." });
  notices.report("a", { reason: "budget-paused", threadId: "t4", message: "Budget paused." });
  notices.report("b", { reason: "no-runner", threadId: "other", message: "Other workspace." });

  // Registration after a period with no windows replays both reasons.
  const replay = notices.register("a");
  expect(replay.notices.map(({ threadId }) => threadId)).toEqual(["t2", "t4"]);
  expect(notices.register("a")).toEqual(replay);
  expect(notices.register("b").notices.map(({ threadId }) => threadId)).toEqual(["other"]);
  expect(notices.register("c").notices).toEqual([]);

  notices.dismiss("a", first.id);
  notices.dismiss("b", replay.notices[0]!.id);
  expect(notices.register("a")).toEqual(replay);
  notices.dismiss("a", replay.notices[0]!.id);
  expect(notices.register("a").notices.map(({ reason }) => reason)).toEqual(["budget-paused"]);
  expect(publish).toHaveBeenLastCalledWith(notices.register("a"));
  expect(notices.register("a").revision).toBeGreaterThan(replay.revision);
  for (const notice of notices.register("a").notices) notices.dismiss("a", notice.id);
  expect(notices.register("a").notices).toEqual([]);
  expect(notices.register("b").notices).toHaveLength(1);
});

it("clears a forgotten workspace without clearing another workspace", () => {
  const publish = vi.fn();
  const notices = createChatDispatchNotices(publish);
  for (const workspace of ["a", "b"]) notices.report(workspace, { reason: "no-runner", threadId: "thread", message: "No runner." });
  const before = notices.register("a");
  notices.clearWorkspace("a");
  expect(notices.register("a").notices).toEqual([]);
  expect(notices.register("a").revision).toBeGreaterThan(before.revision);
  expect(publish).toHaveBeenLastCalledWith(notices.register("a"));
  expect(notices.register("b").notices).toHaveLength(1);
});

it("keeps a pause per thread, and takes back only the thread that resumed", () => {
  const publish = vi.fn();
  const notices = createChatDispatchNotices(publish);
  notices.report("a", { reason: "budget-paused", threadId: "t1", message: "Paused in #launch." });
  notices.report("a", { reason: "budget-paused", threadId: "t2", message: "Paused in #general." });
  notices.report("a", { reason: "budget-paused", threadId: "t1", message: "Paused in #launch again." });
  expect(notices.register("a").notices.map(({ threadId, message }) => [threadId, message])).toEqual([
    ["t1", "Paused in #launch again."], ["t2", "Paused in #general."],
  ]);
  notices.clear("a", "budget-paused", "t1");
  expect(notices.register("a").notices.map(({ threadId }) => threadId)).toEqual(["t2"]);
  expect(publish).toHaveBeenLastCalledWith(notices.register("a"));
});

it("keeps every snapshot within the IPC contract, however many chats pause", () => {
  const notices = createChatDispatchNotices(vi.fn());
  notices.report("a", { reason: "restricted", threadId: "r", message: "Restricted." });
  notices.report("a", { reason: "no-runner", threadId: "n", message: "No runner." });
  for (let index = 0; index <= CHAT_DISPATCH_NOTICES_MAX; index += 1) {
    notices.report("a", { reason: "budget-paused", threadId: `t${index}`, message: `Paused in t${index}.` });
    expect(ChatDispatchNoticesEvent.safeParse(notices.register("a")).success).toBe(true);
  }
  const threads = notices.register("a").notices.map(({ threadId }) => threadId);
  expect(threads).toHaveLength(CHAT_DISPATCH_NOTICES_MAX);
  expect(threads.slice(0, 2)).toEqual(["r", "n"]);
  // The oldest pauses gave way to the newest.
  expect(threads).not.toContain("t0");
  expect(threads.at(-1)).toBe(`t${CHAT_DISPATCH_NOTICES_MAX}`);
});

it("takes back one reason's notice and leaves the others", () => {
  const publish = vi.fn();
  const notices = createChatDispatchNotices(publish);
  notices.report("a", { reason: "restricted", threadId: "t1", message: "Restricted." });
  notices.report("a", { reason: "no-runner", threadId: "t2", message: "No runner." });
  const before = notices.register("a");
  notices.clear("a", "restricted");
  expect(notices.register("a").notices.map(({ reason }) => reason)).toEqual(["no-runner"]);
  expect(notices.register("a").revision).toBeGreaterThan(before.revision);
  publish.mockClear();
  notices.clear("a", "restricted");
  notices.clear("b", "restricted");
  expect(publish).not.toHaveBeenCalled();
});
