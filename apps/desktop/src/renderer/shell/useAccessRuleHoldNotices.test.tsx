// @vitest-environment jsdom
import { act, cleanup, configure, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessRuleHold } from "../../ipc/bridgeContract";
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
  canAccept: true,
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
  canAccept: true,
  unreadable: null,
  fallsBackTo: "team",
};
const ROOT_REMOVED: AccessRuleHold = {
  ...REMOVED,
  folder: "",
  changes: [{ who: "members", before: "view", after: "workspace" }],
  fallsBackTo: null,
};

type Decided = { heldAccessRules: AccessRuleHold[]; kept: string[] };

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
    decideAccessRule: vi.fn(async (_input: object): Promise<Decided> => ({
      heldAccessRules: [],
      kept: [],
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
    // The decision's answer lists no holds, so the rows go as it lands.
    await waitFor(() => expect([h.row("team"), h.row("")]).toEqual([undefined, undefined]));
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

  // Neither choice can read a rule another program holds, or one dohc could
  // not read, so there is no change to allow; Restore rule says why it
  // failed. The row leads with what the owner does, in the engine's words.
  it("says why the rule on disk cannot be read, what to do first, and offers no change to allow", async () => {
    const until = "Until you choose, dohc doesn't record or share changes in team.";
    // A locked rule names its file as spelled on disk, and its row reveals
    // the folder rather than opening a file dohc can't read.
    for (const [unreadable, rulePath, lead, target] of [
      [
        "locked",
        "team/ACCESS.yaml",
        "Close team/ACCESS.yaml in the program that has it open, so dohc can read it.",
        { to: "folder", path: "team" },
      ],
      [
        "on-disk",
        "team/access.yaml",
        "Check that you can open team/access.yaml.",
        { to: "file", path: "team/access.yaml" },
      ],
    ] as const) {
      cleanup();
      const h = harness([{ ...WIDENED, rulePath, changes: [], unreadable }]);
      await waitFor(() => expect(h.row("team")).toBeDefined());
      // Unread, the rule may widen access or not, so the title doesn't say.
      expect(h.row("team")!.title).toBe("dohc could not read the access rule for team");
      expect(h.row("team")!.message).toBe(`${lead} ${until}`);
      expect(h.row("team")!.rows).toBeUndefined();
      expect(h.row("team")!.target).toEqual(target);
      expect(h.row("team")!.action).toMatchObject({ label: "Restore rule", additional: [] });
    }
  });

  // Two readable spellings record as one rule members can't read, so
  // keeping them hides the folder. The row says what's wrong, and that
  // Restore keeps the files from outside dohc.
  it("offers to hide the folder when the rule on disk is several files", async () => {
    const several: AccessRuleHold = {
      ...WIDENED,
      observedSha256: null,
      changes: [],
      unreadable: "several-files",
    };
    const h = harness([several, { ...several, folder: "" }]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    expect(h.row("team")).toMatchObject({
      title: "More than one access rule file in team",
      message:
        "Until you choose, dohc doesn't record or share changes in team. Restoring puts back the rule dohc recorded and keeps the files from outside dohc as copies.",
    });
    expect(h.row("")!.title).toBe("This workspace has more than one access rule file");
    expect(h.row("team")!.action).toMatchObject({
      label: "Restore rule",
      additional: [{ label: "Hide from members" }],
    });
    act(() => h.errors().runShellErrorAction(h.row("team")!.id, 1));
    await waitFor(() =>
      expect(h.bridge.decideAccessRule).toHaveBeenCalledWith(
        expect.objectContaining({ decision: "accept", expectedSha256: null }),
      ),
    );
    const done = () => h.errors().shellErrors.find((error) => error.tone === "success");
    await waitFor(() =>
      expect(done()).toMatchObject({
        message: "Hid team from members.",
        action: { label: "Open History" },
      }),
    );
  });

  it("keeps Restore and withholds choices the engine cannot publish safely", async () => {
    for (const hold of [
      {
        ...WIDENED,
        canAccept: false,
        recordedRule: null,
        observedSha256: null,
        changes: [],
        unreadable: "several-files" as const,
      },
      { ...REMOVED, canAccept: false },
    ]) {
      cleanup();
      const h = harness([hold]);
      await waitFor(() => expect(h.row(hold.folder)).toBeDefined());
      expect(h.row(hold.folder)!.action).toMatchObject({ label: "Restore rule", additional: [] });
      if (hold.unreadable === "several-files") {
        expect(h.row(hold.folder)!.message).toContain(
          "dohc can't record these files without briefly giving members more access. Restore, then put the rule in one file.",
        );
      } else {
        expect(h.row(hold.folder)!.message).toContain(
          "dohc can't remove these files one at a time without briefly giving members more access. To remove the rule, restore it. Edit one file so it gives members View and names no one else. Delete all the files at once. Then choose Remove rule.",
        );
      }
    }
  });

  it("names the inherited rule when removing an unreadable recorded rule", async () => {
    const h = harness([
      {
        ...REMOVED,
        unreadable: "recorded",
        canAccept: false,
        recordedRule: null,
        changes: [{ who: "members", before: "none", after: "view" }],
      },
    ]);
    await waitFor(() => expect(h.row("team/sub")).toBeDefined());
    expect(h.row("team/sub")!.message).toContain(
      "Without it, team/sub follows the access rule for team.",
    );
    expect(h.row("team/sub")!.message).toContain(
      "To remove the rule, restore it. Edit one file so it gives members View and names no one else. Delete all the files at once. Then choose Remove rule.",
    );
    expect(h.row("team/sub")!.rows).toEqual(["Members: No access \u2192 View"]);
  });

  it("reads as working while a decision runs, then says what took effect with Open History", async () => {
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
    await act(async () => finish({ heldAccessRules: [], kept: [] }));
    h.list([]);
    const done = () => h.errors().shellErrors.find((error) => error.tone === "success");
    await waitFor(() =>
      expect(done()).toMatchObject({
        message: "team now follows the new access rule.",
        action: { label: "Open History", ends: true },
      }),
    );
    act(() => h.errors().runShellErrorAction(done()!.id));
    expect(h.openHistory).toHaveBeenCalledOnce();
  });

  it("names one entry's new reach, and where Restore kept the rule from outside dohc", async () => {
    const h = harness([{ ...WIDENED, changes: [WIDENED.changes[0]!] }, REMOVED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(2));
    const success = () => h.errors().shellErrors.filter((error) => error.tone === "success");
    act(() => h.errors().runShellErrorAction(h.row("team")!.id, 1));
    await waitFor(() =>
      expect(success()[0]).toMatchObject({
        message: "Members can now edit team.",
        action: { label: "Open History" },
      }),
    );

    h.bridge.decideAccessRule.mockResolvedValueOnce({
      heldAccessRules: [],
      kept: ["team/sub/access.yaml"],
    });
    act(() => h.errors().runShellErrorAction(h.row("team/sub")!.id));
    await waitFor(() =>
      expect(success().at(-1)).toMatchObject({
        message:
          "Restored the access rule for team/sub. Members can view team/sub. dohc kept the rule from outside dohc in Notices, where Save copy puts it beside team/sub/access.yaml.",
      }),
    );
    expect(success().at(-1)!.action).toBeUndefined();
  });

  it("says Restore removed new rule files and kept every copy in Notices", async () => {
    const hold: AccessRuleHold = {
      ...WIDENED,
      recordedRule: null,
      canAccept: false,
      observedSha256: null,
      changes: [],
      unreadable: "several-files",
    };
    const h = harness([hold]);
    h.bridge.decideAccessRule.mockResolvedValueOnce({
      heldAccessRules: [],
      kept: ["team/access.yaml", "team/\uFF41ccess.yaml"],
    });
    await waitFor(() => expect(h.row("team")).toBeDefined());
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    await waitFor(() =>
      expect(h.errors().shellErrors.find((error) => error.tone === "success")).toMatchObject({
        message:
          "Removed the new access rule files from team. dohc kept them as copies in Notices.",
      }),
    );
  });

  it("names every saved copy when Restore puts back a recorded rule", async () => {
    const h = harness([
      { ...WIDENED, observedSha256: null, changes: [], unreadable: "several-files" },
    ]);
    h.bridge.decideAccessRule.mockResolvedValueOnce({
      heldAccessRules: [],
      kept: ["team/access.yaml", "team/\uFF41ccess.yaml"],
    });
    await waitFor(() => expect(h.row("team")).toBeDefined());
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    await waitFor(() =>
      expect(h.errors().shellErrors.find((error) => error.tone === "success")).toMatchObject({
        message:
          "Restored the access rule for team. dohc kept the files from outside dohc as copies in Notices. Save copy puts each beside its original: team/access.yaml, team/\uFF41ccess.yaml.",
      }),
    );
  });

  it("offers History after Remove rule", async () => {
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
      h.errors().shellErrors.find((error) => error.identity === "waits-access-rule:main:team/sub");
    await waitFor(() =>
      expect(waits()).toMatchObject({
        tone: "warning",
        title: "Decide on the access rule for team first",
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

  // A folder may be named like another row's "waits" row.
  it("keeps the row of a folder named like another folder's waiting choice", async () => {
    const h = harness([
      WIDENED,
      REMOVED,
      { ...WIDENED, folder: "team/sub:waits", rulePath: "team/sub:waits/access.yaml" },
    ]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(3));
    h.bridge.decideAccessRule.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:decide-access-rule': DaemonRefusalError [CONFLICT]: access-rule-held: widened team",
      ),
    );
    act(() => h.errors().runShellErrorAction(h.row("team/sub")!.id));
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(4));
    expect(h.row("team/sub:waits")!.title).toBe(
      "Access to team/sub:waits was widened outside dohc",
    );
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
      h.errors().shellErrors.find((error) => error.identity === "waits-access-rule:main:team");
    await waitFor(() =>
      expect(waits()).toMatchObject({
        title: "Decide on the workspace's access rule first",
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

  it("says why nothing ran when the hold was decided already, with Open History, and its row goes with the list", async () => {
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(1));
    h.bridge.decideAccessRule.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:decide-access-rule': DaemonRefusalError [INVALID_PARAMS]: access-rule-not-held",
      ),
    );
    act(() => h.errors().runShellErrorAction(h.row("team")!.id, 1));
    const said = () =>
      h.errors().shellErrors.find((error) => error.identity === "decided-access-rule:main:team");
    await waitFor(() =>
      expect(said()).toMatchObject({
        tone: "warning",
        message:
          "dohc didn't apply your choice because the access rule for team no longer waits for it in the version you have open.",
        retry: null,
        action: { label: "Open History", ends: true },
      }),
    );
    expect(h.row("team")!.action?.busy).toBeUndefined();
    h.list([]);
    await waitFor(() => expect(h.row("team")).toBeUndefined());
    expect(said()).toBeDefined();
    // History shows what dohc recorded.
    act(() => h.errors().runShellErrorAction(said()!.id));
    expect(h.openHistory).toHaveBeenCalledOnce();
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
    await waitFor(() => expect(h.row("team")?.id).not.toBe(first.id));
    expect(h.row("team")).toMatchObject({
      title: "Access to team was widened outside dohc",
      seen: false,
    });
    // Beside it, the press says why nothing ran.
    expect(h.errors().shellErrors.map((error) => error.identity)).toEqual(
      expect.arrayContaining(["decided-access-rule:main:team"]),
    );
    expect(h.errors().shellErrors).toHaveLength(2);
    act(() => h.errors().runShellErrorAction(h.row("team")!.id, 1));
    await waitFor(() =>
      expect(h.bridge.decideAccessRule).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedSha256: "b".repeat(64) }),
      ),
    );
  });

  // Judging the changed rule again can clear its hold, as when the rule on
  // disk went back to the recorded one. The row goes, and the press still says
  // why nothing ran, whichever reaches the renderer first.
  it("says why nothing ran when the rule changed again and its hold cleared, in either order", async () => {
    const changed = () =>
      new Error(
        "Error invoking remote method 'desktop:decide-access-rule': DaemonRefusalError [CONFLICT]: access-rule-changed: team",
      );
    for (const order of ["refusal first", "list first"]) {
      cleanup();
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
      await waitFor(() => expect(h.bridge.decideAccessRule).toHaveBeenCalledOnce());
      if (order === "refusal first") await act(async () => refuse(changed()));
      h.list([]);
      if (order === "list first") await act(async () => refuse(changed()));
      await waitFor(() => expect(h.row("team")).toBeUndefined());
      const said = () =>
        h.errors().shellErrors.find((error) => error.identity === "decided-access-rule:main:team");
      await waitFor(() =>
        expect(said(), order).toMatchObject({
          tone: "warning",
          message:
            "dohc didn't apply your choice because the access rule for team changed again outside dohc.",
          retry: null,
          action: { label: "Open History", ends: true },
        }),
      );
      act(() => h.errors().runShellErrorAction(said()!.id));
      expect(h.openHistory).toHaveBeenCalledOnce();
    }
  });

  // The engine names the workspace's own rule with an empty folder.
  it("says why nothing ran when the workspace's own rule changed again", async () => {
    const h = harness([{ ...WIDENED, folder: "", rulePath: "access.yaml" }]);
    await waitFor(() => expect(h.row("")).toBeDefined());
    h.bridge.decideAccessRule.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:decide-access-rule': DaemonRefusalError [CONFLICT]: access-rule-changed: ",
      ),
    );
    act(() => h.errors().runShellErrorAction(h.row("")!.id));
    const said = () =>
      h.errors().shellErrors.find((error) => error.identity === "decided-access-rule:main:");
    await waitFor(() =>
      expect(said()).toMatchObject({
        tone: "warning",
        message:
          "dohc didn't apply your choice because the workspace's access rule changed again outside dohc.",
        retry: null,
      }),
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
      // Try again keeps Notices open, as Restore rule does.
      retryStays: true,
    });
    expect(h.row("team")!.action?.busy).toBeUndefined();
  });

  it("says another program has the rule open, with Try again", async () => {
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    h.bridge.decideAccessRule.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:decide-access-rule': DaemonRefusalError [OVERLOADED]: file-locked",
      ),
    );
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    const failed = () =>
      h
        .errors()
        .shellErrors.find(
          (error) => error.title === "dohc could not restore the access rule for team",
        );
    await waitFor(() =>
      expect(failed()).toMatchObject({
        message: "Another program has this file open. Close it there, then try again.",
        retry: expect.any(Function),
      }),
    );

    // A later press on the row that works takes the failure's place, so no
    // stale Try again stays beside the result.
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    await waitFor(() =>
      expect(h.errors().shellErrors.find((error) => error.tone === "success")).toBeDefined(),
    );
    expect(failed()).toBeUndefined();
  });

  // The shell's status can trail the decision, so the row stops reading as
  // working when the decision lands, also after Try again.
  it("stops reading as working when the decision lands, before the list follows", async () => {
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    await waitFor(() =>
      expect(h.errors().shellErrors.find((error) => error.tone === "success")).toBeDefined(),
    );
    expect(h.row("team")).toBeUndefined();

    h.list([{ ...WIDENED, recordedAtMs: 2 }]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    h.bridge.decideAccessRule.mockRejectedValueOnce(new Error("engine stopped"));
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    const failed = () =>
      h
        .errors()
        .shellErrors.find(
          (error) => error.title === "dohc could not restore the access rule for team",
        );
    await waitFor(() => expect(failed()).toBeDefined());
    act(() => h.errors().retryShellError(failed()!.id));
    await waitFor(() => expect(h.bridge.decideAccessRule).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(h.row("team")).toBeUndefined());

    // A choice the engine still lists afterwards goes back to its choices.
    h.list([{ ...WIDENED, recordedAtMs: 3 }]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    h.bridge.decideAccessRule.mockResolvedValueOnce({
      heldAccessRules: [{ ...WIDENED, recordedAtMs: 3 }],
      kept: [],
    });
    act(() => h.errors().runShellErrorAction(h.row("team")!.id));
    await waitFor(() => expect(h.bridge.decideAccessRule).toHaveBeenCalledTimes(4));
    await waitFor(() =>
      expect(h.row("team")!.action).toMatchObject({
        label: "Restore rule",
        additional: [{ label: "Allow new access" }],
      }),
    );
    expect(h.row("team")!.action?.busy).toBeUndefined();
  });

  it("says to open the workspace again when its folder moved, with no Try again", async () => {
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
