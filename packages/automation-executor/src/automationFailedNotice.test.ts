import { describe, expect, it } from "vitest";
import { isNoticeBody, isNoticeLine, isNoticeTarget, NOTICE_BODY_MAX_CHARS, NOTICE_TITLE_MAX_CHARS } from "@dohc/workspace-contracts/relay";
import { automationFailedElsewhereBody, automationFailedNotice, automationFailureBodyForPermission, AUTOMATION_SWITCHED_OFF_BODY, FAILED_ELSEWHERE_BODY, type AutomationFailure } from "./automationFailedNotice";

const failure = (overrides: Partial<AutomationFailure> = {}): AutomationFailure => ({
  automationId: "collection:object-tasks#stamp",
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
  it.each([
    [true, true, "Open the automation to turn it back on."],
    [true, false, "Open its automations file to turn it back on."],
    [false, false, "Ask someone who can edit the Collection to turn it back on."],
  ] as const)("gives the recipient a recovery they can use (edit %s, owner %s)", (canEdit, isOwner, next) => {
    const fact = "dohc switched this automation off after 3 runs in a row took too long. ";
    expect(automationFailureBodyForPermission(`${AUTOMATION_SWITCHED_OFF_BODY} Detail.`, canEdit, isOwner)).toBe(`${fact}${next} Detail.`);
    expect(isNoticeBody(automationFailureBodyForPermission(AUTOMATION_SWITCHED_OFF_BODY + "x".repeat(2_000), canEdit, isOwner))).toBe(true);
    expect(automationFailureBodyForPermission("Ordinary failure.", canEdit, isOwner)).toBe("Ordinary failure.");
  });

  it("puts the switch-off and recovery before a long private error, with a typed controls target", () => {
    const stopped = failure({ switchedOff: { reason: "consecutive-timeouts", collectionPath: "Projects/Tasks" }, error: "private-step-detail".repeat(2_000) });
    const notice = automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: stopped, name: "Slow", collectionPath: "Moved/Tasks" });
    expect(notice.title).toBe('Automation "Slow" switched off');
    expect(notice.body.startsWith(AUTOMATION_SWITCHED_OFF_BODY)).toBe(true);
    expect(isNoticeBody(notice.body)).toBe(true);
    expect(notice.target).toEqual({ recovery: "automation-controls", path: "Moved/Tasks/automations.yaml", automation: stopped.automationId, run: stopped.claimId });
    expect(isNoticeTarget(notice.target)).toBe(true);
    expect(automationFailedElsewhereBody(stopped, "Slow")).toBe(AUTOMATION_SWITCHED_OFF_BODY);
    expect(isNoticeTarget({ recovery: "automation-controls", automation: stopped.automationId })).toBe(false);
    expect(isNoticeTarget({ ...notice.target, recovery: "unknown" })).toBe(false);
    expect(automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: stopped, name: "Slow", collectionPath: null }).target.path)
      .toBe("Projects/Tasks/automations.yaml");
  });

  it.each(["x".repeat(1_000), "界".repeat(330)])("keeps controls when the path fits without duplication (%#)", (collectionPath) => {
    const stopped = failure({ switchedOff: { reason: "consecutive-timeouts", collectionPath } });
    const notice = automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: stopped, name: "Slow", collectionPath });
    expect(notice.target).toEqual({ recovery: "automation-controls", path: `${collectionPath}/automations.yaml`, automation: stopped.automationId, run: stopped.claimId });
    expect(isNoticeTarget(notice.target)).toBe(true);
  });

  it.each(["x".repeat(1_008), "x".repeat(2_000), "界".repeat(700)])("delivers a switch-off Notice without oversized controls (%#)", (collectionPath) => {
    const stopped = failure({ switchedOff: { reason: "consecutive-timeouts", collectionPath } });
    const notice = automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: stopped, name: "Slow", collectionPath });
    expect(notice.body.startsWith(AUTOMATION_SWITCHED_OFF_BODY)).toBe(true);
    expect(notice.target).toEqual({ automation: stopped.automationId, run: stopped.claimId });
    expect(isNoticeTarget(notice.target)).toBe(true);
  });

  it("never infers a switch-off from ordinary error text", () => {
    const ordinary = failure({ error: "The step says switched off, but dohc did not change the automation." });
    const notice = automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: ordinary, name: "Slow", collectionPath: "Tasks" });
    expect(notice.title).toBe('Automation "Slow" failed');
    expect(notice.target).not.toHaveProperty("recovery");
    expect(automationFailedElsewhereBody(ordinary, "Slow")).toBe(FAILED_ELSEWHERE_BODY);
  });

  it("names the automation, the error, and the computer, and offers its run", () => {
    expect(automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: failure(), name: "Stamp the finish date", collectionPath: "Projects/Tasks" })).toEqual({
      workspaceId: "ws",
      noticeId: expect.stringMatching(/^automation-failed:[0-9a-f]{40}$/u),
      kind: "automation-failed",
      title: 'Automation "Stamp the finish date" failed',
      body: "ana@dohc.test cannot edit Budget. It ran on Ice's laptop.",
      target: { automation: "collection:object-tasks#stamp", path: "Projects/Tasks/automations.yaml", run: "atc_1" },
    });
  });

  it("offers no run for a chain stop, which never ran, and says so", () => {
    const stopped = failure({ neverStarted: true, chainStopped: true, error: "chain-stopped", generation: 2 });
    const notice = automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: stopped, name: null, collectionPath: "Projects/Tasks" });
    const why = '"stamp" did not run. dohc stops a chain after automations and agents start each other 4 times in a row. Check which automations start each other.';
    expect(notice.title).toBe("An automation chain stopped");
    expect(notice.body).toBe(`2 failures so far. ${why} This happened on Ice's laptop.`);
    expect(notice.target).toEqual({ automation: "collection:object-tasks#stamp", path: "Projects/Tasks/automations.yaml" });
    // Everyone else reads why, without the computer, and no promise that someone can try it again.
    expect(automationFailedElsewhereBody(stopped, null)).toBe(why);
  });

  it("keeps the reason of a run too large to claim, and offers no run, since none can start it", () => {
    const reason = "This change was too large for dohc to start automations for every record. Change fewer records at a time.";
    const unclaimed = failure({ neverStarted: true, error: reason });
    const notice = automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: unclaimed, name: "Stamp the finish date", collectionPath: "Projects/Tasks" });
    expect(notice.title).toBe('Automation "Stamp the finish date" failed');
    expect(notice.body).toBe(`${reason} This happened on Ice's laptop.`);
    expect(notice.target.run).toBeUndefined();
    expect(automationFailedElsewhereBody(unclaimed, null)).toBe("It could not start on another person's computer, so no one can try it again.");
    // A run that started and failed can run again only where it ran.
    expect(automationFailedElsewhereBody(failure(), null)).toBe(FAILED_ELSEWHERE_BODY);
  });

  it("keeps a long error and name within what the relay takes", () => {
    const notice = automationFailedNotice({
      workspaceId: "ws", computer: laptop, failure: failure({ error: `Bad\u0001${"x".repeat(2_000)}` }), name: "n".repeat(300), collectionPath: "Projects/Tasks",
    });
    expect(isNoticeLine(notice.title, NOTICE_TITLE_MAX_CHARS)).toBe(true);
    expect(isNoticeBody(notice.body)).toBe(true);
    expect([...notice.body].length).toBeLessThanOrEqual(NOTICE_BODY_MAX_CHARS);
    expect(notice.body.endsWith("It ran on Ice's laptop.")).toBe(true);
  });

  it("differs for each computer and each failure, so none hides another", () => {
    const ids = [
      automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: failure(), name: null, collectionPath: null }).noticeId,
      automationFailedNotice({ workspaceId: "ws", computer: { ...laptop, installId: "install-b" }, failure: failure(), name: null, collectionPath: null }).noticeId,
      automationFailedNotice({ workspaceId: "ws", computer: laptop, failure: failure({ generation: 2 }), name: null, collectionPath: null }).noticeId,
    ];
    expect(new Set(ids).size).toBe(3);
  });
});
