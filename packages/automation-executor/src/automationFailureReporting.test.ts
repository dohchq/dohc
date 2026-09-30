import { describe, expect, it } from "vitest";
import { NoticeNotSentError } from "./automationChat";
import { AUTOMATION_SWITCHED_OFF_BODY, type AutomationFailedNotice } from "./automationFailedNotice";
import { reportAutomationFailure } from "./automationFailureReporting";
import type { AutomationFailureReport } from "./collectionAutomations";
import type { NoticeRecipient } from "@dohc/workspace-contracts/relay";

const report: AutomationFailureReport = {
  failure: { automationId: "collection:Tasks#slow", claimId: "third-timeout", neverStarted: false, chainStopped: false,
    error: "private-token", updatedAtMs: 3, generation: 3, datasetInstance: null,
    switchedOff: { reason: "consecutive-timeouts", collectionPath: "Tasks" } },
  name: "Slow", collectionPath: "Tasks", startedBy: "starter", replaces: null,
};

describe("shared automation failure reporting", () => {
  it("still notifies the owner and starter when the last editor's History is unreadable", async () => {
    const received: string[] = [];
    const errors: unknown[] = [];
    await reportAutomationFailure({ computer: { installId: "server", label: "Server" }, primary: { recipientUserId: "owner" }, throughShare: false,
      post: async (notice) => { received.push(notice.recipientUserId ?? "local"); }, withdraw: async () => undefined,
      lastChangedBy: async () => { throw new Error("History unreadable"); }, onError: (_context, error) => { errors.push(error); },
    }, "ws", report);
    expect(received).toEqual(["owner", "starter"]);
    expect(errors).toHaveLength(1);
  });
  it("deduplicates owner, last editor and starter, retaining private detail only for the host's person", async () => {
    const sent: Array<AutomationFailedNotice & Partial<NoticeRecipient>> = [];
    const deps = { computer: { installId: "server", label: "Server" }, primary: { recipientUserId: "owner" }, throughShare: false,
      post: async (notice: AutomationFailedNotice & Partial<NoticeRecipient>) => { sent.push(notice); },
      withdraw: async () => undefined, lastChangedBy: async () => "editor", onError: () => undefined };
    await reportAutomationFailure(deps, "ws", report);
    expect(sent.map((notice) => notice.recipientUserId)).toEqual(["owner", "starter", "editor"]);
    expect(sent[0]!.body).toContain("private-token");
    for (const notice of sent.slice(1)) {
      expect(notice.body).toBe(AUTOMATION_SWITCHED_OFF_BODY);
      expect(notice.target).toMatchObject({ recovery: "automation-controls", path: "Tasks/automations.yaml", automation: report.failure.automationId });
      expect(notice.target.run).toBeUndefined();
    }
    sent.length = 0;
    await reportAutomationFailure({ ...deps, lastChangedBy: async () => "owner" }, "ws", { ...report, startedBy: "owner" });
    expect(sent).toHaveLength(1);
    sent.length = 0;
    await reportAutomationFailure({ ...deps, primary: undefined, primaryUserId: "starter", lastChangedBy: async () => "starter" }, "ws", report);
    expect(sent).toHaveLength(1);
  });

  it("skips a recipient denied at the post boundary without blocking other eligible people", async () => {
    const received: string[] = [];
    const denied: string[] = [];
    await reportAutomationFailure({ computer: { installId: "server", label: "Server" }, primary: { recipientUserId: "owner" }, throughShare: false,
      post: async (notice) => {
        if (notice.recipientUserId === "starter") throw new NoticeNotSentError("Access revoked");
        received.push(notice.recipientUserId ?? "local");
      }, withdraw: async () => undefined, lastChangedBy: async () => "editor", onError: (context) => { denied.push(context); },
    }, "ws", report);
    expect(received).toEqual(["owner", "editor"]);
    expect(denied).toHaveLength(1);
  });
});
