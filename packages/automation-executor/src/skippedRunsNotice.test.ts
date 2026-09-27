import { describe, expect, it } from "vitest";
import { isNoticeBody, isNoticeLine, NOTICE_POSTED_ID_MAX_CHARS, NOTICE_TITLE_MAX_CHARS } from "@dohc/workspace-contracts/relay";
import type { ScheduledAutomation } from "./collectionAutomations";
import { skippedRunsNotice } from "./skippedRunsNotice";

const schedule: ScheduledAutomation = {
  automationId: "collection:Reports#weekday",
  name: "Weekday report",
  trigger: { kind: "schedule", every: "weekday", at: "09:00", timezone: "UTC" },
  scheduleHash: "hash",
  enabledSince: null,
};
const formatTime = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const NINE = Date.UTC(2026, 8, 21, 9);
const DAY = 24 * 60 * 60 * 1000;

describe("skipped-run notices", () => {
  it("names the automation and the count, and lists up to five times", () => {
    const notice = skippedRunsNotice({
      workspaceId: "ws-1",
      schedule,
      skipped: { first: [0, 1, 2, 3, 4].map((day) => NINE + day * DAY), count: 17 },
      formatTime,
    });
    expect(notice).toEqual({
      workspaceId: "ws-1",
      noticeId: `schedule-skipped:ws-1:collection:Reports#weekday:${NINE}`,
      kind: "schedule-skipped",
      title: "Weekday report skipped 17 times",
      body: [
        "2026-09-21T09:00", "2026-09-22T09:00", "2026-09-23T09:00", "2026-09-24T09:00", "2026-09-25T09:00",
        "and 12 more",
      ].join("\n"),
      target: { automation: "collection:Reports#weekday", path: "Reports/automations.yaml" },
    });
    const once = skippedRunsNotice({ workspaceId: "ws-1", schedule, skipped: { first: [NINE], count: 1 }, formatTime });
    expect([once.title, once.body]).toEqual(["Weekday report skipped once", "2026-09-21T09:00"]);
  });

  it("gives each time in the schedule's own zone, and names the zone", () => {
    const kolkata = { ...schedule, trigger: { ...schedule.trigger, timezone: "Asia/Kolkata" } };
    const notice = skippedRunsNotice({ workspaceId: "ws-1", schedule: kolkata, skipped: { first: [Date.UTC(2026, 8, 21, 3, 30)], count: 1 } });
    const expected = new Intl.DateTimeFormat(undefined, {
      timeZone: "Asia/Kolkata", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(Date.UTC(2026, 8, 21, 3, 30));
    expect(notice.body).toBe(expected);
    expect(notice.body).toMatch(/9:00/u);
    expect(notice.body).toMatch(/GMT\+5:30|IST/u);
  });

  it("stays within the relay's limits for a long name or path", () => {
    const long = { ...schedule, automationId: `collection:${"Deep/".repeat(80)}Reports#weekday`, name: "Report ".repeat(40).trim() };
    const notice = skippedRunsNotice({ workspaceId: "ws-1", schedule: long, skipped: { first: [NINE], count: 1_234 }, formatTime });
    expect(isNoticeLine(notice.noticeId, NOTICE_POSTED_ID_MAX_CHARS)).toBe(true);
    expect(isNoticeLine(notice.title, NOTICE_TITLE_MAX_CHARS)).toBe(true);
    expect(notice.title.endsWith("… skipped 1,234 times")).toBe(true);
    expect(isNoticeBody(notice.body)).toBe(true);
    expect(skippedRunsNotice({ workspaceId: "ws-1", schedule: long, skipped: { first: [NINE], count: 2 }, formatTime }).noticeId,
      "the same automation and first time give the same notice").toBe(notice.noticeId);
  });
});
