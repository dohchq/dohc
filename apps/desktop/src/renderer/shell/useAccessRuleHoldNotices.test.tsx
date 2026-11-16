// @vitest-environment jsdom
import { act, cleanup, configure, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessRuleHold, AccessRuleUndo } from "../../ipc/bridgeContract";
import { useAccessRuleHoldNotices } from "./useAccessRuleHoldNotices";
import { useShellError } from "./useShellError";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WIDENED: AccessRuleHold = {
  versionId: "main",
  folder: "team",
  reason: "widened",
  observedSha256: "a".repeat(64),
  recordedAtMs: 1,
  recordedRule: "members: view\n",
  rulePath: "team/access.yaml",
  changes: [
    { who: "members", before: "view", after: "edit" },
    { who: "sam@example.com", before: "none", after: "edit" },
  ],
  unreadable: null,
  fallsBackTo: null,
};
const REMOVED: AccessRuleHold = {
  versionId: "main",
  folder: "team/sub",
  reason: "removed",
  observedSha256: null,
  recordedAtMs: 1,
  recordedRule: "members: view\n",
  rulePath: null,
  changes: [{ who: "members", before: "view", after: "edit" }],
  unreadable: null,
  fallsBackTo: "team",
};
const ROOT_REMOVED: AccessRuleHold = {
  ...REMOVED,
  folder: "",
  changes: [{ who: "members", before: "view", after: "workspace" }],
  fallsBackTo: null,
};

type Decided = { heldAccessRules: AccessRuleHold[]; kept: string[]; undo: AccessRuleUndo | null };

// The members' level from Members settings, or a failed read.
const membersAt = (memberLevel: "view" | "comment" | "edit") => async (_input: object) => ({
  status: "ready",
  view: { memberLevel },
});
const membersUnread = async (_input: object): Promise<never> => {
  throw new Error("Not signed in");
};

function harness(
  holds: readonly AccessRuleHold[],
  members: (input: object) => Promise<unknown> = membersAt("edit"),
) {
  const bridge = {
    // Undo goes through the engine too, so the bridge offers no file write.
    decideAccessRule: vi.fn(async (_input: object): Promise<Decided> => ({
      heldAccessRules: [],
      kept: [],
      undo: null,
    })),
    workspaceMembers: vi.fn(members),
  };
  vi.stubGlobal("dohcDesktop", bridge);
  const showNotice = vi.fn((_identity: string) => undefined);
  const openHistory = vi.fn();
  const openMembers = vi.fn();
  let errors!: ReturnType<typeof useShellError>;
  let notices!: ReturnType<typeof useAccessRuleHoldNotices>;
  function Shell(props: { holds: readonly AccessRuleHold[] }) {
    errors = useShellError("ws-a");
    notices = useAccessRuleHoldNotices({
      workspaceId: "ws-a",
      holds: props.holds,
      showNotice,
      openHistory,
      openMembers,
      reportShellFailure: errors.reportShellFailure,
      clearIdentity: errors.clearIdentity,
      dropNoticeStep: errors.dropNoticeStep,
      showSuccessNotice: errors.showSuccessNotice,
    });
    return null;
  }
  const view = render(<Shell holds={holds} />);
  const row = (folder: string) =>
    errors.shellErrors.find((error) => error.identity === `access-rule:main:${folder}`);
  return {
    bridge,
    showNotice,
    openHistory,
    openMembers,
    row,
    errors: () => errors,
    readMemberLevel: () => notices.readMemberLevel(),
    list: (next: readonly AccessRuleHold[]) => view.rerender(<Shell holds={next} />),
  };
}

describe("useAccessRuleHoldNotices", () => {
  it("offers Restore rule first, then the change, and says what the change leads to", async () => {
    const h = harness([WIDENED, REMOVED, ROOT_REMOVED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(3));
    expect(h.row("team")).toMatchObject({
      tone: "warning",
      noDismiss: true,
      title: "Access to team was widened outside dohc",
      message:
        "Until you choose, dohc doesn't record or share changes in team. Restoring keeps the rule from outside dohc as a copy.",
      action: { label: "Restore rule", additional: [{ label: "Allow new access" }] },
    });
    expect(h.row("team/sub")).toMatchObject({
      title: "The access rule for team/sub was removed outside dohc",
      message:
        "Until you choose, dohc doesn't record or share changes in team/sub. Without it, team/sub follows the access rule for team.",
      action: { label: "Restore rule", additional: [{ label: "Remove rule" }] },
    });
    expect(h.row("")).toMatchObject({
      title: "The workspace's access rule was removed outside dohc",
      message:
        "Until you choose, dohc doesn't record or share changes in this workspace. Without it, members get the level set in Members settings.",
      rows: ["Members: View → Edit"],
      action: { additional: [{ label: "Remove rule" }] },
    });

    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    act(() => h.errors().runShellErrorAction(h.row("")!.id, 1));
    await waitFor(() => expect(h.bridge.decideAccessRule).toHaveBeenCalledTimes(2));
    expect(h.bridge.decideAccessRule).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-a",
      versionId: "main",
      folder: "team",
      decision: "restore",
      expectedSha256: "a".repeat(64),
      expectedReason: "widened",
    });
    expect(h.bridge.decideAccessRule).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-a",
      versionId: "main",
      folder: "",
      decision: "accept",
      expectedSha256: null,
      expectedReason: "removed",
    });
    // The rows stay until the engine stops listing the holds.
    expect(h.row("team")).toBeDefined();
    h.list([]);
    await waitFor(() =>
      expect(h.errors().shellErrors.filter((error) => error.tone === "warning")).toEqual([]),
    );
  });

  it("lists who reaches the folder differently, and opens the rule or reveals the folder", async () => {
    const h = harness([WIDENED, REMOVED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(2));
    expect(h.row("team")).toMatchObject({
      rows: ["Members: View → Edit", "sam@example.com: No access → Edit"],
      target: { to: "file", path: "team/access.yaml" },
    });
    expect(h.row("team")!.details).toEqual([
      ["Recorded rule", "members: view\n"],
      ["Noticed", new Date(1).toLocaleString()],
      ["Until you choose", "Members keep their earlier access."],
    ]);
    expect(h.row("team/sub")).toMatchObject({
      rows: ["Members: View → Edit"],
      target: { to: "folder", path: "team/sub" },
    });
  });

  it("says when a rule cannot be read", async () => {
    const h = harness([{ ...WIDENED, changes: [], unreadable: "on-disk" }]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    expect(h.row("team")!.message).toBe(
      "Until you choose, dohc doesn't record or share changes in team. Restoring keeps the rule from outside dohc as a copy. dohc can't read the access rule now on disk. Allowing it hides team from members.",
    );
    expect(h.row("team")!.rows).toBeUndefined();
    expect(h.row("team")!.action).toMatchObject({ additional: [{ label: "Hide from members" }] });
  });

  it("reads as working while a decision runs, then says what took effect with Undo", async () => {
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    let finish!: (decided: Decided) => void;
    h.bridge.decideAccessRule.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => h.errors().runShellErrorAction(h.row("team")!.id, 1));
    await waitFor(() =>
      expect(h.row("team")!.action).toMatchObject({
        label: "Restore rule",
        busy: 1,
        additional: [{ label: "Allowing…" }],
      }),
    );
    // Neither step runs again while one does.
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    expect(h.bridge.decideAccessRule).toHaveBeenCalledOnce();
    const undo = {
      path: "team/access.yaml",
      text: "members: view\n",
      expectedSha256: "b".repeat(64),
    };
    await act(async () => finish({ heldAccessRules: [], kept: [], undo }));
    h.list([]);
    const done = () => h.errors().shellErrors.find((error) => error.tone === "success");
    await waitFor(() =>
      expect(done()).toMatchObject({
        message: "team now follows the new access rule.",
        action: { label: "Undo", ends: true },
      }),
    );
    act(() => h.errors().runShellErrorAction(done()!.id));
    await waitFor(() =>
      expect(h.bridge.decideAccessRule).toHaveBeenLastCalledWith({
        workspaceId: "ws-a",
        versionId: "main",
        folder: "team",
        decision: "undo",
        undo,
      }),
    );
    await waitFor(() =>
      expect(
        h
          .errors()
          .shellErrors.filter((error) => error.tone === "success")
          .at(-1),
      ).toMatchObject({ message: "The access rule for team is back as it was." }),
    );
  });

  it("reads the members' level again for Undo of a Restore, after the last hold went", async () => {
    const h = harness([ROOT_REMOVED], membersAt("view"));
    await waitFor(() => expect(h.row("")).toMatchObject({ rows: ["Members: View, no change"] }));
    const undo = { path: "access.yaml", text: "", expectedSha256: "b".repeat(64) };
    h.bridge.decideAccessRule.mockResolvedValueOnce({ heldAccessRules: [], kept: [], undo });
    act(() => h.errors().runShellErrorAction(h.row("")!.id));
    const done = () => h.errors().shellErrors.find((error) => error.tone === "success");
    await waitFor(() =>
      expect(done()).toMatchObject({
        message: "Restored the workspace's access rule. Members can view.",
        action: { label: "Undo" },
      }),
    );
    h.list([]);
    // The owner sets Edit in Members settings, then undoes the Restore.
    h.bridge.workspaceMembers.mockImplementation(membersAt("edit"));
    act(() => h.readMemberLevel());
    act(() => h.errors().runShellErrorAction(done()!.id));
    await waitFor(() =>
      expect(
        h
          .errors()
          .shellErrors.filter((error) => error.tone === "success")
          .at(-1),
      ).toMatchObject({ message: "Members can now edit." }),
    );
  });

  it("drops a decision's Undo once dohc holds the folder again, and keeps it for a list from before", async () => {
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    const undo = {
      path: "team/access.yaml",
      text: "members: view\n",
      expectedSha256: "b".repeat(64),
    };
    h.bridge.decideAccessRule.mockResolvedValueOnce({ heldAccessRules: [], kept: [], undo });
    act(() => h.errors().runShellErrorAction(h.row("team")!.id, 1));
    const done = () => h.errors().shellErrors.find((error) => error.tone === "success");
    await waitFor(() => expect(done()).toMatchObject({ action: { label: "Undo" } }));
    // A list read before the decision landed still names the same hold.
    h.list([{ ...WIDENED }]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    expect(done()!.action).toMatchObject({ label: "Undo" });
    h.list([]);
    await waitFor(() => expect(h.row("team")).toBeUndefined());
    h.list([{ ...WIDENED, observedSha256: "c".repeat(64), recordedAtMs: 2 }]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    await waitFor(() => expect(done()!.action).toBeUndefined());
    expect(done()!.message).toBe("team now follows the new access rule.");
  });

  it("says an Undo the engine refused points to History, with no Try again", async () => {
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    const undo = {
      path: "team/access.yaml",
      text: "members: view\n",
      expectedSha256: "b".repeat(64),
    };
    h.bridge.decideAccessRule.mockResolvedValueOnce({ heldAccessRules: [], kept: [], undo });
    act(() => h.errors().runShellErrorAction(h.row("team")!.id, 1));
    const done = () => h.errors().shellErrors.find((error) => error.tone === "success");
    await waitFor(() => expect(done()).toBeDefined());
    h.bridge.decideAccessRule.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:decide-access-rule': DaemonRefusalError [CONFLICT]: access-rule-changed: team",
      ),
    );
    act(() => h.errors().runShellErrorAction(done()!.id));
    const refused = () =>
      h
        .errors()
        .shellErrors.find((error) => error.title === "dohc could not undo your choice for team");
    await waitFor(() =>
      expect(refused()).toMatchObject({
        message:
          "The access rule for team changed since you chose. Its earlier versions are in History.",
        retry: null,
        action: { label: "Open History" },
      }),
    );
    act(() => h.errors().runShellErrorAction(refused()!.id));
    expect(h.openHistory).toHaveBeenCalledOnce();
  });

  it("names one entry's new reach, the kept copy after Restore, and undoes by creating or deleting the rule", async () => {
    const h = harness([{ ...WIDENED, changes: [WIDENED.changes[0]!] }, REMOVED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(2));
    const success = () => h.errors().shellErrors.filter((error) => error.tone === "success");
    h.bridge.decideAccessRule.mockResolvedValueOnce({
      heldAccessRules: [],
      kept: [],
      undo: { path: "team/access.yaml", text: null, expectedSha256: "c".repeat(64) },
    });
    act(() => h.errors().runShellErrorAction(h.row("team")!.id, 1));
    await waitFor(() =>
      expect(success()[0]).toMatchObject({ message: "Members can now edit team." }),
    );
    act(() => h.errors().runShellErrorAction(success()[0]!.id));
    await waitFor(() =>
      expect(h.bridge.decideAccessRule).toHaveBeenLastCalledWith(
        expect.objectContaining({
          decision: "undo",
          folder: "team",
          undo: { path: "team/access.yaml", text: null, expectedSha256: "c".repeat(64) },
        }),
      ),
    );

    h.bridge.decideAccessRule.mockResolvedValueOnce({
      heldAccessRules: [],
      kept: ["team/sub/access.yaml"],
      undo: { path: "team/sub/access.yaml", text: "members: view\n", expectedSha256: null },
    });
    act(() => h.errors().runShellErrorAction(h.row("team/sub")!.id));
    await waitFor(() =>
      expect(success().at(-1)).toMatchObject({
        message:
          "Restored the access rule for team/sub. Members can view team/sub. The rule from outside dohc is saved as a copy of team/sub/access.yaml.",
      }),
    );
    const restored = success().at(-1)!.id;
    act(() => h.errors().runShellErrorAction(restored));
    await waitFor(() =>
      expect(h.bridge.decideAccessRule).toHaveBeenLastCalledWith(
        expect.objectContaining({
          decision: "undo",
          folder: "team/sub",
          undo: { path: "team/sub/access.yaml", text: "members: view\n", expectedSha256: null },
        }),
      ),
    );
  });

  it("offers History where no file change undoes a decision", async () => {
    const h = harness([REMOVED]);
    await waitFor(() => expect(h.row("team/sub")).toBeDefined());
    act(() => h.errors().runShellErrorAction(h.row("team/sub")!.id, 1));
    const done = () => h.errors().shellErrors.find((error) => error.tone === "success");
    await waitFor(() =>
      expect(done()).toMatchObject({
        message:
          "Removed the access rule for team/sub. team/sub now follows the access rule for team.",
        action: { label: "Open History" },
      }),
    );
    act(() => h.errors().runShellErrorAction(done()!.id));
    expect(h.openHistory).toHaveBeenCalledOnce();
  });

  it("files the outer folder last, so it leads Notices, and sends an inner decision to it first", async () => {
    const h = harness([WIDENED, REMOVED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(2));
    expect(h.errors().shellErrors.map((error) => error.identity)).toEqual([
      "access-rule:main:team/sub",
      "access-rule:main:team",
    ]);
    h.bridge.decideAccessRule.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:decide-access-rule': DaemonRefusalError [CONFLICT]: access-rule-held: widened team",
      ),
    );
    const inner = h.row("team/sub")!.id;
    act(() => h.errors().runShellErrorAction(inner));
    const waits = () =>
      h.errors().shellErrors.find((error) => error.identity === "access-rule:main:team/sub:waits");
    await waitFor(() =>
      expect(waits()).toMatchObject({
        tone: "warning",
        title: "Choose for team's access rule first",
        message:
          "dohc didn't apply your choice for team/sub. The access rule for team also changed outside dohc.",
        retry: null,
        action: { label: "Show its notice" },
      }),
    );
    // The inner row is back to its choices where it stands, with no new toast.
    expect(h.row("team/sub")!.id).toBe(inner);
    expect(h.row("team/sub")!.action).toMatchObject({
      label: "Restore rule",
      additional: [{ label: "Remove rule" }],
    });
    expect(h.row("team/sub")!.action?.busy).toBeUndefined();
    act(() => h.errors().runShellErrorAction(waits()!.id));
    expect(h.showNotice).toHaveBeenCalledExactlyOnceWith("access-rule:main:team");
  });

  it("names the workspace's rule when the choice waits for it, and drops that row once the outer rule is decided", async () => {
    const h = harness([WIDENED, ROOT_REMOVED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(2));
    h.bridge.decideAccessRule.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:decide-access-rule': DaemonRefusalError [CONFLICT]: access-rule-held: removed ",
      ),
    );
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    const waits = () =>
      h.errors().shellErrors.find((error) => error.identity === "access-rule:main:team:waits");
    await waitFor(() =>
      expect(waits()).toMatchObject({
        title: "Choose for the workspace's access rule first",
        message:
          "dohc didn't apply your choice for team. The workspace's access rule also changed outside dohc.",
      }),
    );
    // The owner decides the workspace's rule from its own row, without Show.
    h.list([WIDENED]);
    await waitFor(() => expect(waits()).toBeUndefined());
    expect(h.row("team")).toBeDefined();
  });

  it("updates a row whose rows change under the same judgment where it stands, with no new toast", async () => {
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    const first = h.row("team")!;
    act(() => h.errors().hideShellError(first.id));
    h.list([{ ...WIDENED, changes: [{ who: "members", before: "comment", after: "edit" }] }]);
    await waitFor(() => expect(h.row("team")!.rows).toEqual(["Members: Comment → Edit"]));
    expect(h.row("team")!.id).toBe(first.id);
    expect(h.errors().shellErrors).toHaveLength(1);
    // The person hid its toast; the update brings none back.
    expect(h.row("team")).toMatchObject({ seen: true });
  });

  it("files nothing new when the hold was decided already", async () => {
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(1));
    h.bridge.decideAccessRule.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:decide-access-rule': DaemonRefusalError [INVALID_PARAMS]: access-rule-not-held",
      ),
    );
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    await waitFor(() => expect(h.row("team")!.action?.busy).toBeUndefined());
    expect(h.errors().shellErrors).toHaveLength(1);
  });

  it("shows the rule as it is now when it changed since the owner saw it", async () => {
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(1));
    const first = h.errors().shellErrors[0]!;
    act(() => h.errors().hideShellError(first.id));
    h.bridge.decideAccessRule.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:decide-access-rule': DaemonRefusalError [CONFLICT]: access-rule-changed: team",
      ),
    );
    act(() => h.errors().runShellErrorAction(first.id, 1));
    await waitFor(() => expect(h.bridge.decideAccessRule).toHaveBeenCalledOnce());
    // Main recorded the engine's new judgment, which arrives as the list.
    h.list([{ ...WIDENED, observedSha256: "b".repeat(64), recordedAtMs: 2 }]);
    await waitFor(() => expect(h.errors().shellErrors[0]?.id).not.toBe(first.id));
    expect(h.errors().shellErrors).toHaveLength(1);
    expect(h.errors().shellErrors[0]).toMatchObject({
      title: "Access to team was widened outside dohc",
      seen: false,
    });
    act(() => h.errors().runShellErrorAction(h.errors().shellErrors[0]!.id, 1));
    await waitFor(() =>
      expect(h.bridge.decideAccessRule).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedSha256: "b".repeat(64) }),
      ),
    );
  });

  it("says when a decision failed for another reason, with Try again", async () => {
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(1));
    h.bridge.decideAccessRule.mockRejectedValueOnce(new Error("engine stopped"));
    act(() => h.errors().runShellErrorAction(h.errors().shellErrors[0]!.id));
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(2));
    expect(h.errors().shellErrors[1]).toMatchObject({
      title: "dohc could not restore the access rule for team",
      message:
        "dohc still doesn't record or share changes in team. Members keep their earlier access.",
      retry: expect.any(Function),
    });
    expect(h.row("team")!.action?.busy).toBeUndefined();
  });

  it("says to open the workspace again when its folder moved, with no Try again, for a choice and its Undo", async () => {
    const moved = () =>
      new Error(
        "Error invoking remote method 'desktop:decide-access-rule': DaemonRefusalError [INVALID_PARAMS]: workspace-folder-moved",
      );
    const words =
      "This workspace's folder moved while dohc had it open. Open the workspace again from where it is now.";
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    h.bridge.decideAccessRule.mockRejectedValueOnce(moved());
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    const chose = () =>
      h
        .errors()
        .shellErrors.find(
          (error) => error.title === "dohc could not restore the access rule for team",
        );
    await waitFor(() => expect(chose()).toMatchObject({ message: words, retry: null }));

    const undo = {
      path: "team/access.yaml",
      text: "members: view\n",
      expectedSha256: "b".repeat(64),
    };
    h.bridge.decideAccessRule.mockResolvedValueOnce({ heldAccessRules: [], kept: [], undo });
    act(() => h.errors().runShellErrorAction(h.row("team")!.id, 1));
    const done = () => h.errors().shellErrors.find((error) => error.tone === "success");
    await waitFor(() => expect(done()).toBeDefined());
    h.bridge.decideAccessRule.mockRejectedValueOnce(moved());
    act(() => h.errors().runShellErrorAction(done()!.id));
    const undid = () =>
      h
        .errors()
        .shellErrors.find((error) => error.title === "dohc could not undo your choice for team");
    await waitFor(() => expect(undid()).toMatchObject({ message: words, retry: null }));
  });

  it("names the level members get from Members settings, in the rows and what Remove rule did", async () => {
    const h = harness([ROOT_REMOVED], membersAt("comment"));
    await waitFor(() => expect(h.row("")).toMatchObject({ rows: ["Members: View → Comment"] }));
    expect(h.bridge.workspaceMembers).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-a",
      request: { action: "list" },
    });
    // The level is known, so the row offers only the choices.
    expect(h.row("")!.action!.additional).toHaveLength(1);
    act(() => h.errors().runShellErrorAction(h.row("")!.id, 1));
    const done = () => h.errors().shellErrors.find((error) => error.tone === "success");
    await waitFor(() =>
      expect(done()).toMatchObject({
        message: "Removed the workspace's access rule. Members can now comment.",
      }),
    );
  });

  it("reads the level again when asked, and stops a choice made on a level that changed since", async () => {
    const h = harness([ROOT_REMOVED], membersAt("comment"));
    await waitFor(() => expect(h.row("")).toMatchObject({ rows: ["Members: View → Comment"] }));
    const first = h.row("")!.id;
    // Settings saved a new level, or the owner came back to Notices.
    h.bridge.workspaceMembers.mockImplementation(membersAt("edit"));
    act(() => h.readMemberLevel());
    await waitFor(() => expect(h.row("")).toMatchObject({ rows: ["Members: View → Edit"] }));
    expect(h.row("")!.id).toBe(first);
    // Another window changed it again before the owner chose.
    h.bridge.workspaceMembers.mockImplementation(membersAt("view"));
    act(() => h.errors().runShellErrorAction(h.row("")!.id, 1));
    await waitFor(() => expect(h.row("")).toMatchObject({ rows: ["Members: View, no change"] }));
    await waitFor(() => expect(h.row("")!.action?.busy).toBeUndefined());
    expect(h.bridge.decideAccessRule).not.toHaveBeenCalled();
    // The row says why, and comes back unread with a toast, so a second
    // press is made on what it shows now.
    expect(h.row("")).toMatchObject({
      seen: false,
      lead: "dohc didn't apply your choice because the members' level changed in Members settings.",
      message: expect.stringMatching(/^Until you choose/),
      action: { additional: [{ label: "Remove rule" }, { label: "Open Members" }] },
    });
    expect(h.row("")!.id).not.toBe(first);
    expect(h.errors().shellErrors.filter((error) => error.tone === "success")).toEqual([]);
    // Choosing on the level shown now runs, and says what it did at that level.
    act(() => h.errors().runShellErrorAction(h.row("")!.id, 1));
    await waitFor(() => expect(h.bridge.decideAccessRule).toHaveBeenCalledOnce());
    // The busy row no longer carries the earlier refusal.
    expect(h.row("")?.lead).toBeUndefined();
    const done = () => h.errors().shellErrors.find((error) => error.tone === "success");
    await waitFor(() =>
      expect(done()).toMatchObject({
        message: "Removed the workspace's access rule. Members can still view.",
      }),
    );
  });

  it("runs a choice only on the newest read of the level, not an older answer that arrives late", async () => {
    const h = harness([ROOT_REMOVED], membersAt("comment"));
    await waitFor(() => expect(h.row("")).toMatchObject({ rows: ["Members: View → Comment"] }));
    // The press's read is slow and still answers Comment.
    let answerLate: (value: unknown) => void = () => {};
    h.bridge.workspaceMembers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerLate = resolve;
        }),
    );
    act(() => h.errors().runShellErrorAction(h.row("")!.id, 1));
    // Settings saves Edit meanwhile, and that newer read answers first.
    h.bridge.workspaceMembers.mockImplementation(membersAt("edit"));
    act(() => h.readMemberLevel());
    await waitFor(() => expect(h.row("")).toMatchObject({ rows: ["Members: View → Edit"] }));
    await act(async () => answerLate({ status: "ready", view: { memberLevel: "comment" } }));
    await waitFor(() => expect(h.row("")!.lead).toMatch(/^dohc didn't apply your choice because/));
    expect(h.row("")).toMatchObject({ rows: ["Members: View → Edit"] });
    expect(h.row("")!.action?.busy).toBeUndefined();
    expect(h.bridge.decideAccessRule).not.toHaveBeenCalled();
  });

  it("says dohc can't read the level, not that it changed, when the press's read fails", async () => {
    const h = harness([ROOT_REMOVED], membersAt("comment"));
    await waitFor(() => expect(h.row("")).toMatchObject({ rows: ["Members: View → Comment"] }));
    h.bridge.workspaceMembers.mockImplementation(membersUnread);
    act(() => h.errors().runShellErrorAction(h.row("")!.id, 1));
    await waitFor(() =>
      expect(h.row("")).toMatchObject({
        rows: ["Members: View → set in Members settings"],
        lead: "dohc didn't apply your choice because it can't read the members' level now.",
      }),
    );
    expect(h.row("")!.action).toMatchObject({
      additional: [{ label: "Remove rule" }, { label: "Open Members" }],
    });
    expect(h.bridge.decideAccessRule).not.toHaveBeenCalled();
  });

  it("says what members can do once Undo puts the recorded rule back", async () => {
    const h = harness([{ ...WIDENED, changes: [WIDENED.changes[0]!] }]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    const undo = {
      path: "team/access.yaml",
      text: "members: view\n",
      expectedSha256: "b".repeat(64),
    };
    h.bridge.decideAccessRule.mockResolvedValueOnce({ heldAccessRules: [], kept: [], undo });
    act(() => h.errors().runShellErrorAction(h.row("team")!.id, 1));
    const done = () => h.errors().shellErrors.find((error) => error.tone === "success");
    await waitFor(() => expect(done()).toMatchObject({ message: "Members can now edit team." }));
    act(() => h.errors().runShellErrorAction(done()!.id));
    await waitFor(() =>
      expect(
        h
          .errors()
          .shellErrors.filter((error) => error.tone === "success")
          .at(-1),
      ).toMatchObject({
        message: "The access rule for team is back as it was. Members can view team.",
      }),
    );
  });

  it("says where the level is set, with Open Members, when dohc can't read it", async () => {
    const h = harness([ROOT_REMOVED], membersUnread);
    await waitFor(() => expect(h.row("")).toBeDefined());
    expect(h.row("")).toMatchObject({
      rows: ["Members: View → set in Members settings"],
      message:
        "Until you choose, dohc doesn't record or share changes in this workspace. Without it, members get the level set in Members settings. dohc can't read that level now.",
      action: { additional: [{ label: "Remove rule" }, { label: "Open Members" }] },
    });
    expect(JSON.stringify(h.row(""))).not.toContain("workspace access");
    act(() => h.errors().runShellErrorAction(h.row("")!.id, 2));
    expect(h.openMembers).toHaveBeenCalledOnce();
    expect(h.bridge.decideAccessRule).not.toHaveBeenCalled();
    act(() => h.errors().runShellErrorAction(h.row("")!.id, 1));
    const done = () => h.errors().shellErrors.find((error) => error.tone === "success");
    await waitFor(() =>
      expect(done()).toMatchObject({
        message:
          "Removed the workspace's access rule. Members now get the level set in Members settings.",
      }),
    );
  });

  it("says what members can now do after an Undo that puts a widening back", async () => {
    const h = harness([{ ...WIDENED, changes: [WIDENED.changes[0]!] }]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    const undo = {
      path: "team/access.yaml",
      text: "members: edit\n",
      expectedSha256: "b".repeat(64),
    };
    h.bridge.decideAccessRule.mockResolvedValueOnce({
      heldAccessRules: [],
      kept: ["team/access.yaml"],
      undo,
    });
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    const success = () => h.errors().shellErrors.filter((error) => error.tone === "success");
    await waitFor(() =>
      expect(success()[0]).toMatchObject({
        message:
          "Restored the access rule for team. Members can view team. The rule from outside dohc is saved as a copy of team/access.yaml.",
      }),
    );
    act(() => h.errors().runShellErrorAction(success()[0]!.id));
    await waitFor(() =>
      expect(success().at(-1)).toMatchObject({ message: "Members can now edit team." }),
    );
  });

  it("puts back the hold as the engine lists it now after a refused choice, or clears a hold it no longer lists", async () => {
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    let refuse!: (error: Error) => void;
    h.bridge.decideAccessRule.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    // The list refreshes while the choice runs.
    const newer = {
      ...WIDENED,
      changes: [{ who: "members", before: "comment", after: "edit" } as const],
    };
    h.list([newer]);
    await waitFor(() => expect(h.row("team")!.rows).toEqual(["Members: Comment → Edit"]));
    await act(async () => refuse(new Error("engine stopped")));
    await waitFor(() => expect(h.row("team")!.action?.busy).toBeUndefined());
    expect(h.row("team")!.rows).toEqual(["Members: Comment → Edit"]);
    // A choice whose hold left the list while it ran leaves no row behind.
    h.bridge.decideAccessRule.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    h.list([]);
    await act(async () =>
      refuse(
        new Error(
          "Error invoking remote method 'desktop:decide-access-rule': DaemonRefusalError [INVALID_PARAMS]: access-rule-not-held",
        ),
      ),
    );
    await waitFor(() => expect(h.row("team")).toBeUndefined());
    expect(h.errors().shellErrors.filter((error) => error.noDismiss)).toEqual([]);
  });
});
