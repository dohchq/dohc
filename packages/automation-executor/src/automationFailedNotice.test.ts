import { describe, expect, it } from "vitest";
import { isNoticeBody, isNoticeLine, NOTICE_BODY_MAX_CHARS, NOTICE_TITLE_MAX_CHARS } from "@dohc/workspace-contracts/relay";
import { automationFailedElsewhereBody, automationFailedNotice, FAILED_ELSEWHERE_BODY, type AutomationFailure } from "./automationFailedNotice";

const failure = (overrides: Partial<AutomationFailure> = {}): AutomationFailure => ({
  automationId: "collection:Projects/Tasks#stamp",
  claimId: "atc_1",
  neverStarted: false,
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
    const stopped = failure({ neverStarted: true, chainStopped: true, error: "chain-stopped", generation: 2 });
    const notice = automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: stopped, name: null });
    const why = '"stamp" did not run. dohc stops a chain after automations and agents start each other 4 times in a row. Check which automations start each other.';
    expect(notice.title).toBe("An automation chain stopped");
    expect(notice.body).toBe(`2 failures so far. ${why} This happened on Ice's laptop.`);
    expect(notice.target).toEqual({ automation: "collection:Projects/Tasks#stamp", path: "Projects/Tasks/automations.yaml" });
    // Everyone else reads why, without the computer, and no promise that someone can try it again.
    expect(automationFailedElsewhereBody(stopped, null)).toBe(why);
  });

  it("keeps the reason of a run too large to claim, and offers no run, since none can start it", () => {
    const reason = "This change was too large for dohc to start automations for every record. Change fewer records at a time.";
    const unclaimed = failure({ neverStarted: true, error: reason });
    const notice = automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: unclaimed, name: "Stamp the finish date" });
    expect(notice.title).toBe('Automation "Stamp the finish date" failed');
    expect(notice.body).toBe(`${reason} This happened on Ice's laptop.`);
    expect(notice.target.run).toBeUndefined();
    expect(automationFailedElsewhereBody(unclaimed, null)).toBe("It could not start on another person's computer, so no one can try it again.");
    // A run that started and failed can run again only where it ran.
    expect(automationFailedElsewhereBody(failure(), null)).toBe(FAILED_ELSEWHERE_BODY);
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
