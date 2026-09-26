import { expect, it, vi } from "vitest";
import { createChatDispatchNotices } from "./chatDispatchNotices";

it("retains the latest notice per workspace and reason until that row is dismissed", () => {
  const publish = vi.fn();
  const notices = createChatDispatchNotices(publish);
  notices.report("a", { reason: "no-runner", threadId: "t1", message: "No runner." });
  const first = notices.register("a").notices[0]!;
  notices.report("a", { reason: "no-runner", threadId: "t2", message: "Dispatch is off." });
  notices.report("a", { reason: "run-failed", threadId: "t3", runId: "run", message: "Run failed." });
  notices.report("a", { reason: "budget-paused", threadId: "t4", message: "Budget paused." });
  notices.report("b", { reason: "no-runner", threadId: "other", message: "Other workspace." });

  // Registration after a period with no windows replays all three reasons.
  const replay = notices.register("a");
  expect(replay.notices.map(({ threadId }) => threadId)).toEqual(["t2", "t3", "t4"]);
  expect(notices.register("a")).toEqual(replay);
  expect(notices.register("b").notices.map(({ threadId }) => threadId)).toEqual(["other"]);
  expect(notices.register("c").notices).toEqual([]);

  notices.dismiss("a", first.id);
  notices.dismiss("b", replay.notices[0]!.id);
  expect(notices.register("a")).toEqual(replay);
  notices.dismiss("a", replay.notices[0]!.id);
  expect(notices.register("a").notices.map(({ reason }) => reason)).toEqual(["run-failed", "budget-paused"]);
  expect(publish).toHaveBeenLastCalledWith(notices.register("a"));
  expect(notices.register("a").revision).toBeGreaterThan(replay.revision);
  for (const notice of notices.register("a").notices) notices.dismiss("a", notice.id);
  expect(notices.register("a").notices).toEqual([]);
  expect(notices.register("b").notices).toHaveLength(1);
});
