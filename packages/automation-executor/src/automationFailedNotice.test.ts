import { describe, expect, it } from "vitest";
import { isNoticeBody, isNoticeLine, NOTICE_BODY_MAX_CHARS, NOTICE_TITLE_MAX_CHARS } from "@dohc/workspace-contracts/relay";
import { automationFailedNotice, type AutomationFailure } from "./automationFailedNotice";

const failure = (overrides: Partial<AutomationFailure> = {}): AutomationFailure => ({
  automationId: "collection:Projects/Tasks#stamp",
  claimId: "atc_1",
  chainStopped: false,
  error: "ana@dohc.test cannot edit Budget.",
  updatedAtMs: 5_000,
  generation: 1,
  datasetInstance: null,
  ...overrides,
});
const laptop = { installId: "install-a", label: "Ice's laptop" };

describe("a failed run's notice", () => {
  it("names the automation, the error, and the computer, and offers its run", () => {
    expect(automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: failure(), name: "Stamp the finish date" })).toEqual({
      workspaceId: "ws",
      noticeId: expect.stringMatching(/^automation-failed:[0-9a-f]{40}$/u),
      kind: "automation-failed",
      title: 'Automation "Stamp the finish date" failed',
      body: "ana@dohc.test cannot edit Budget. It ran on Ice's laptop.",
      target: { automation: "collection:Projects/Tasks#stamp", path: "Projects/Tasks/automations.yaml", run: "atc_1" },
    });
  });

  it("offers no run for a chain stop, which never ran, and says so", () => {
    const notice = automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: failure({ chainStopped: true, error: "chain-stopped", generation: 2 }), name: null });
    expect(notice.title).toBe("An automation chain stopped");
    expect(notice.body).toBe('2 failures so far. dohc stops a chain of automations after 4 steps, so "stamp" did not run. It ran on Ice\'s laptop.');
    expect(notice.target.run).toBeUndefined();
  });

  it("keeps a long error and name within what the relay takes", () => {
    const notice = automationFailedNotice({
      workspaceId: "ws", computer: laptop, failure: failure({ error: `Bad\u0001${"x".repeat(2_000)}` }), name: "n".repeat(300),
    });
    expect(isNoticeLine(notice.title, NOTICE_TITLE_MAX_CHARS)).toBe(true);
    expect(isNoticeBody(notice.body)).toBe(true);
    expect([...notice.body].length).toBeLessThanOrEqual(NOTICE_BODY_MAX_CHARS);
    expect(notice.body.endsWith("It ran on Ice's laptop.")).toBe(true);
  });

  it("differs for each computer and each failure, so none hides another", () => {
    const ids = [
      automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: failure(), name: null }).noticeId,
      automationFailedNotice({ workspaceId: "ws", computer: { ...laptop, installId: "install-b" }, failure: failure(), name: null }).noticeId,
      automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: failure({ generation: 2 }), name: null }).noticeId,
    ];
    expect(new Set(ids).size).toBe(3);
  });
});
