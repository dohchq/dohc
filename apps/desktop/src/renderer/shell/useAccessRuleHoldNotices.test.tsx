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

function harness(holds: readonly AccessRuleHold[]) {
  const bridge = {
    decideAccessRule: vi.fn(async (_input: object): Promise<Decided> => ({
      heldAccessRules: [],
      kept: [],
      undo: null,
    })),
    writeWorkspaceText: vi.fn(async (_input: object) => ({})),
    createWorkspaceFile: vi.fn(async (_input: object) => ({ path: "" })),
    deleteWorkspacePath: vi.fn(async (_input: object) => ({})),
  };
  vi.stubGlobal("dohcDesktop", bridge);
  const showNotice = vi.fn((_identity: string) => undefined);
  const openHistory = vi.fn();
  let errors!: ReturnType<typeof useShellError>;
  function Shell(props: { holds: readonly AccessRuleHold[] }) {
    errors = useShellError("ws-a");
    useAccessRuleHoldNotices({
      workspaceId: "ws-a",
      holds: props.holds,
      showNotice,
      openHistory,
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
    row,
    errors: () => errors,
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
        "Until you choose, dohc doesn't record or share changes in team, and members keep their earlier access. Allowing the new rule gives:",
      action: { label: "Restore rule", additional: [{ label: "Allow new access" }] },
    });
    expect(h.row("team/sub")).toMatchObject({
      title: "The access rule for team/sub was removed outside dohc",
      message:
        "Until you choose, dohc doesn't record or share changes in team/sub, and members keep their earlier access. Without it, team/sub follows the access rule for team.",
      action: { label: "Restore rule", additional: [{ label: "Remove rule" }] },
    });
    expect(h.row("")).toMatchObject({
      title: "The workspace's access rule was removed outside dohc",
      message:
        "Until you choose, dohc doesn't record or share changes in this workspace, and members keep their earlier access. Without it, this workspace follows each member's workspace access.",
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
      expect(h.errors().shellErrors.filter((error) => error.identity)).toEqual([]),
    );
  });

  it("lists who reaches the folder differently, and opens the rule or reveals the folder", async () => {
    const h = harness([WIDENED, REMOVED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(2));
    expect(h.row("team")).toMatchObject({
      rows: ["members: View → Edit", "sam@example.com: none → Edit"],
      target: { to: "file", path: "team/access.yaml" },
    });
    expect(h.row("team")!.details).toEqual([
      ["Folder", "team"],
      ["Recorded rule", "members: view\n"],
      ["Noticed", new Date(1).toISOString()],
    ]);
    expect(h.row("team/sub")).toMatchObject({
      rows: ["members: View → Edit"],
      target: { to: "folder", path: "team/sub" },
    });
  });

  it("says when a rule cannot be read", async () => {
    const h = harness([{ ...WIDENED, changes: [], unreadable: "on-disk" }]);
    await waitFor(() => expect(h.row("team")).toBeDefined());
    expect(h.row("team")!.message).toBe(
      "Until you choose, dohc doesn't record or share changes in team, and members keep their earlier access. dohc can't read the access rule now on disk. Allowing it hides team from members.",
    );
    expect(h.row("team")!.rows).toBeUndefined();
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
      expect(h.bridge.writeWorkspaceText).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "ws-a",
        relativePath: "team/access.yaml",
        text: "members: view\n",
        expectedContentHash: "b".repeat(64),
      }),
    );
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
      expect(success()[0]).toMatchObject({ message: "Members now reach team at Edit." }),
    );
    act(() => h.errors().runShellErrorAction(success()[0]!.id));
    await waitFor(() =>
      expect(h.bridge.deleteWorkspacePath).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "ws-a",
        relativePath: "team/access.yaml",
      }),
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
          "Restored the access rule for team/sub. dohc kept the rule from outside dohc as a kept copy of team/sub/access.yaml.",
      }),
    );
    act(() => h.errors().runShellErrorAction(success().at(-1)!.id));
    await waitFor(() =>
      expect(h.bridge.createWorkspaceFile).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "ws-a",
        relativePath: "team/sub/access.yaml",
        initialText: "members: view\n",
        exclusive: true,
      }),
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
    act(() => h.errors().runShellErrorAction(h.row("team/sub")!.id));
    const waits = () =>
      h.errors().shellErrors.find((error) => error.identity === "access-rule:main:team/sub:waits");
    await waitFor(() =>
      expect(waits()).toMatchObject({
        tone: "warning",
        title: "Decide team first",
        message: "The access rule for team also changed outside dohc.",
        retry: null,
        action: { label: "Show team" },
      }),
    );
    // The inner row is back to its choices.
    expect(h.row("team/sub")!.action).toMatchObject({
      label: "Restore rule",
      additional: [{ label: "Remove rule" }],
    });
    expect(h.row("team/sub")!.action?.busy).toBeUndefined();
    act(() => h.errors().runShellErrorAction(waits()!.id));
    expect(h.showNotice).toHaveBeenCalledExactlyOnceWith("access-rule:main:team");
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
        "dohc still doesn't record or share changes in team, and members keep their earlier access.",
      retry: expect.any(Function),
    });
    expect(h.row("team")!.action?.busy).toBeUndefined();
  });
});
