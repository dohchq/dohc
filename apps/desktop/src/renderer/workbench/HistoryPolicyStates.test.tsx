// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineMomentDetailRecord, HistoryPolicyUnreadableResult } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { EngineMomentDiffPage } from "./EngineMomentDiffPage";
import * as unifiedDiff from "./unifiedDiff";
import { HistoryHiddenState, historyHiddenWords, restoreRulesUnreadableWords } from "./HistoryPolicyStates";
import { momentDiffTabPath } from "./workbenchState";

const noop = () => {};
const PARSER = "visibility.toml: TOML parse error at line 3, column 9";
const hidden: HistoryPolicyUnreadableResult = {
  status: "policy-unreadable",
  unreadable: [".dohc/visibility.toml"],
  policyErrors: [PARSER],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("History hidden by its rules", () => {
  it("names what dohc can't read and what to do", () => {
    expect(historyHiddenWords([".dohc/visibility.toml"])).toBe(
      "dohc can't read .dohc/visibility.toml, so History is hidden. Fix the file, then try again.",
    );
    expect(historyHiddenWords([".dohc/files.toml", ".dohc/visibility.toml"])).toBe(
      "dohc can't read .dohc/files.toml and .dohc/visibility.toml, so History is hidden. Fix the files, then try again.",
    );
    expect(historyHiddenWords([".dohc"])).toBe(
      "dohc can't read this workspace's .dohc folder, so History is hidden. Fix the folder, then try again.",
    );
    // A Stop and restore row already names its file.
    expect(restoreRulesUnreadableWords([".dohc/visibility.toml"])).toBe(
      "dohc could not restore this file because it can't read .dohc/visibility.toml. Fix the file, then try again.",
    );
    expect(restoreRulesUnreadableWords([".dohc"])).toBe(
      "dohc could not restore this file because it can't read this workspace's .dohc folder. Fix the folder, then try again.",
    );
  });

  it("keeps the parser's text out of sight and in Copy details", async () => {
    const writeText = vi.fn(async () => undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onRetry = vi.fn();
    render(<HistoryHiddenState testId="history-policy-hidden" result={hidden} onRetry={onRetry} />);
    const state = screen.getByTestId("history-policy-hidden");
    expect(state.textContent).toContain("dohc can't read .dohc/visibility.toml, so History is hidden.");
    expect(state.textContent).not.toContain("TOML parse error");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Copy details" }));
    expect(writeText).toHaveBeenCalledWith(
      `Error: dohc can't read .dohc/visibility.toml, so History is hidden. Fix the file, then try again.\nCause: ${PARSER}`,
    );
  });
});

function moment(): EngineMomentDetailRecord {
  return {
    id: "m-1",
    versionId: "main",
    path: "notes/plan.md",
    recordedAtMs: 100,
    operation: "write",
    origin: "local-file",
    beforeText: "one\n",
    afterText: "two\n",
  };
}

type PageProps = Parameters<typeof EngineMomentDiffPage>[0];
type Mock = ReturnType<typeof vi.fn>;

// The page as the shell mounts it. `update` renders it again with new props,
// such as a newer History answer or the shell's restore request.
function renderPage(readEngineMoment: Mock, restoreEngineMomentFile: Mock = vi.fn()) {
  vi.stubGlobal("dohcDesktop", { readEngineMoment, restoreEngineMomentFile });
  const calls = {
    onPathResolved: vi.fn(),
    onError: vi.fn(),
    onSettled: vi.fn(),
    onReopenRestore: vi.fn(),
    onRestoreRequestTaken: vi.fn(),
    onOpenSharedRestore: vi.fn(),
  };
  let props: PageProps = {
    workspaceId: "ws-1",
    tabPath: momentDiffTabPath("m-1"),
    onBeforeRestore: async () => noop,
    onOpenFile: noop,
    registerActiveUndo: noop,
    onRestored: noop,
    onStopAndRestore: noop,
    historyAnswer: { answer: 1 },
    restoreRequested: false,
    ...calls,
  };
  const view = render(<EngineMomentDiffPage {...props} />);
  const update = (next: Partial<PageProps>) => {
    props = { ...props, ...next };
    view.rerender(<EngineMomentDiffPage {...props} />);
  };
  return { ...calls, update };
}

describe("a History diff the rules hide", () => {
  it("shows the hidden state and reads again on Try again", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ ...hidden, moment: null })
      .mockResolvedValue({ moment: moment() });
    renderPage(read);
    const state = await screen.findByTestId("engine-diff-hidden");
    expect(state.textContent).not.toContain("TOML parse error");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("engine-diff-lines")).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("says the change is hidden because History no longer tracks its file, and drops the path from the tab", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ status: "untracked", moment: null })
      .mockResolvedValue({ moment: moment() });
    const page = renderPage(read);
    const state = await screen.findByTestId("engine-diff-untracked");
    expect(state.textContent).toBe(
      "History no longer tracks this file, so this change is hidden. To show it, track the file in .dohc/files.toml.Try again",
    );
    expect(page.onPathResolved).toHaveBeenCalledWith("m-1", null);
    expect(screen.queryByText("This change is no longer in the history record.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("engine-diff-lines")).toBeTruthy();
    expect(page.onPathResolved).toHaveBeenLastCalledWith("m-1", "notes/plan.md");
  });

  it.each([
    ["hidden", { ...hidden, moment: null }, "engine-diff-hidden"],
    ["untracked", { status: "untracked", moment: null }, "engine-diff-untracked"],
  ] as const)("hides an open diff once a newer History answer finds it %s", async (_case, answer, testId) => {
    const read = vi.fn().mockResolvedValueOnce({ moment: moment() }).mockResolvedValueOnce(answer);
    const page = renderPage(read);
    await screen.findByTestId("engine-diff-lines");
    fireEvent.click(screen.getByTestId("engine-diff-more"));
    expect(screen.getByRole("menu")).toBeTruthy();

    page.update({ historyAnswer: { answer: 2 } });
    expect(await screen.findByTestId(testId)).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("engine-diff-lines")).toBeNull();
    expect(screen.queryByTestId("engine-diff-restore-file")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByText("notes/plan.md")).toBeNull();
    expect(page.onPathResolved).toHaveBeenLastCalledWith("m-1", null);
  });

  it("keeps the diff it built when a newer History answer still shows the change", async () => {
    const read = vi.fn().mockResolvedValue({ moment: moment() });
    const page = renderPage(read);
    const lines = await screen.findByTestId("engine-diff-lines");
    page.update({ historyAnswer: { answer: 2 } });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getByTestId("engine-diff-lines")).toBe(lines);
  });

  it("lets only the newest read set the page", async () => {
    const older = deferred<{ moment: EngineMomentDetailRecord }>();
    const read = vi.fn()
      .mockResolvedValueOnce({ moment: moment() })
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce({ status: "untracked", moment: null });
    const page = renderPage(read);
    await screen.findByTestId("engine-diff-lines");
    page.update({ historyAnswer: { answer: 2 } });
    page.update({ historyAnswer: { answer: 3 } });
    expect(await screen.findByTestId("engine-diff-untracked")).toBeTruthy();
    await act(async () => {
      older.resolve({ moment: moment() });
      await older.promise;
    });
    expect(screen.getByTestId("engine-diff-untracked")).toBeTruthy();
    expect(screen.queryByTestId("engine-diff-lines")).toBeNull();
  });

  it("restores again on Try again after a fresh read, and offers Undo restore after it", async () => {
    const refused = new Error(
      `Error invoking remote method 'desktop:restore-engine-moment-file': RestorePolicyRefusalError [policy-unreadable]: .dohc/visibility.toml: ${PARSER}`,
    );
    const restore = vi.fn()
      .mockRejectedValueOnce(refused)
      .mockResolvedValue({ restored: "text", restoredMomentId: "restore-1" });
    const read = vi.fn().mockResolvedValue({ moment: moment() });
    const page = renderPage(read, restore);
    await screen.findByTestId("engine-diff-lines");
    await act(async () => { fireEvent.click(screen.getByTestId("engine-diff-restore-file")); });
    expect(page.onError).toHaveBeenCalledWith(
      "dohc could not restore notes/plan.md.", refused, expect.any(Function), "history-restore:notes/plan.md", "notes/plan.md",
    );
    expect(screen.queryByTestId("engine-diff-restore-status")).toBeNull();
    expect(screen.getByTestId("engine-moment-diff-page").textContent).not.toContain("TOML parse error");

    // Try again asks the shell to open this change again; it restores nothing itself.
    (page.onError.mock.calls[0]![2] as () => void)();
    expect(page.onReopenRestore).toHaveBeenCalledWith("m-1", "notes/plan.md");
    expect(restore).toHaveBeenCalledOnce();

    // The shell's request reads the change again, then restores it, and the
    // page takes it once.
    page.update({ restoreRequested: true });
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
    expect(read).toHaveBeenCalledTimes(2);
    expect(page.onRestoreRequestTaken).toHaveBeenCalledOnce();
    page.update({ restoreRequested: false });
    await screen.findByTestId("engine-diff-restore-status");
    expect(restore).toHaveBeenCalledTimes(2);
    expect(page.onSettled).toHaveBeenCalledWith("history-restore:notes/plan.md");
    expect(screen.getByTestId("engine-diff-restore-status").textContent).toBe(
      "Restored the earlier state. Undo restore is available here.",
    );
    expect(screen.getByTestId("engine-diff-undo-restore")).toBeTruthy();
  });

  it("settles a restore request on a fresh read, which can find the change hidden", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ moment: moment() })
      .mockResolvedValue({ status: "untracked", moment: null });
    const restore = vi.fn();
    const page = renderPage(read, restore);
    await screen.findByTestId("engine-diff-lines");

    // The page still shows the diff from its last read when the request comes.
    page.update({ restoreRequested: true });
    expect(await screen.findByTestId("engine-diff-untracked")).toBeTruthy();
    await waitFor(() => expect(page.onRestoreRequestTaken).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledTimes(2);
    expect(restore).not.toHaveBeenCalled();
    expect(page.onPathResolved).toHaveBeenLastCalledWith("m-1", null);
  });

  it("drops a restore request whose fresh read fails, instead of restoring on an old answer", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ moment: moment() })
      .mockRejectedValue(new Error("dohc is busy."));
    const restore = vi.fn();
    const page = renderPage(read, restore);
    await screen.findByTestId("engine-diff-lines");
    page.update({ restoreRequested: true });
    await waitFor(() => expect(page.onRestoreRequestTaken).toHaveBeenCalledOnce());
    expect(screen.getByTestId("engine-diff-lines")).toBeTruthy();
    expect(restore).not.toHaveBeenCalled();
  });

  // Under act, React renders the fresh read in the same flush as the request,
  // so nothing can land between them. In the app the fresh read waits for
  // the next task. This test sets the request outside act, and a sibling
  // rejects the earlier read in the same commit, after the page's effects.
  it("leaves the request to the fresh read when an earlier read fails after Try again", async () => {
    const earlier = deferred<{ moment: EngineMomentDetailRecord }>();
    const read = vi.fn()
      .mockResolvedValueOnce({ moment: moment() })
      .mockReturnValueOnce(earlier.promise)
      .mockResolvedValue({ moment: moment() });
    const restore = vi.fn().mockResolvedValue({ restored: "text", restoredMomentId: "restore-1" });
    vi.stubGlobal("dohcDesktop", { readEngineMoment: read, restoreEngineMomentFile: restore });
    const taken = vi.fn();
    const onPathResolved = vi.fn();
    const rejectEarlier = () => earlier.reject(new Error("dohc is busy."));
    let setRequested: (requested: boolean) => void = noop;
    function RejectInSameCommit(props: { when: boolean }) {
      useEffect(() => {
        if (props.when) rejectEarlier();
      }, [props.when]);
      return null;
    }
    function Harness(props: { answer: number }) {
      const [requested, setRequestedState] = useState(false);
      setRequested = setRequestedState;
      const historyAnswer = useMemo(() => ({ answer: props.answer }), [props.answer]);
      const takeRequest = useCallback(() => {
        taken();
        setRequestedState(false);
      }, []);
      return (
        <>
          <EngineMomentDiffPage
            workspaceId="ws-1"
            tabPath={momentDiffTabPath("m-1")}
            onBeforeRestore={async () => noop}
            onOpenFile={noop}
            onPathResolved={onPathResolved}
            registerActiveUndo={noop}
            onRestored={noop}
            onStopAndRestore={noop}
            onError={noop}
            onSettled={noop}
            historyAnswer={historyAnswer}
            onReopenRestore={noop}
            restoreRequested={requested}
            onRestoreRequestTaken={takeRequest}
            onOpenSharedRestore={noop}
          />
          <RejectInSameCommit when={requested} />
        </>
      );
    }
    const view = render(<Harness answer={1} />);
    await screen.findByTestId("engine-diff-lines");
    // A History refresh starts a read, which is still out when Try again comes.
    view.rerender(<Harness answer={2} />);
    expect(read).toHaveBeenCalledTimes(2);

    const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
    try {
      setRequested(true);
      await waitFor(() => expect(screen.getByTestId("engine-diff-restore-status")).toBeTruthy());
    } finally {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    }
    expect(read).toHaveBeenCalledTimes(3);
    expect(restore).toHaveBeenCalledOnce();
    expect(taken).toHaveBeenCalledOnce();
  });

  it("holds a restore request until its own change has an answer", async () => {
    const other = { ...moment(), id: "m-0", path: "notes/other.md" };
    const target = deferred<{ moment: EngineMomentDetailRecord }>();
    const read = vi.fn(({ momentId }: { momentId: string }) =>
      momentId === "m-0" ? Promise.resolve({ moment: other }) : target.promise);
    const restore = vi.fn().mockResolvedValue({ restored: "text", restoredMomentId: "restore-1" });
    const page = renderPage(read, restore);
    page.update({ tabPath: momentDiffTabPath("m-0") });
    await waitFor(() => expect(screen.getByTestId("engine-diff-title-open-file").textContent).toBe("notes/other.md"));

    // The tab switches to the change the shell asked about, and the page
    // still holds the other change's answer.
    page.update({ tabPath: momentDiffTabPath("m-1"), restoreRequested: true });
    await act(async () => {});
    expect(page.onRestoreRequestTaken).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    await act(async () => {
      target.resolve({ moment: moment() });
      await target.promise;
    });
    expect(await screen.findByTestId("engine-diff-restore-status")).toBeTruthy();
    expect(restore).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1", momentId: "m-1" });
    expect(page.onRestoreRequestTaken).toHaveBeenCalledOnce();
  });

  it("runs a retried Undo again directly", async () => {
    const restore = vi.fn()
      .mockResolvedValueOnce({ restored: "text", restoredMomentId: "restore-1" })
      .mockRejectedValueOnce(new Error("dohc is busy."))
      .mockResolvedValue({ restored: "text", restoredMomentId: "undo-1" });
    const page = renderPage(vi.fn().mockResolvedValue({ moment: moment() }), restore);
    await screen.findByTestId("engine-diff-lines");
    await act(async () => { fireEvent.click(screen.getByTestId("engine-diff-restore-file")); });
    await act(async () => { fireEvent.click(screen.getByTestId("engine-diff-undo-restore")); });
    expect(page.onError).toHaveBeenCalledWith(
      "dohc could not undo the restore of notes/plan.md.", expect.any(Error), expect.any(Function), "history-restore:notes/plan.md", "notes/plan.md",
    );
    await act(async () => { (page.onError.mock.calls[0]![2] as () => void)(); });
    expect(restore).toHaveBeenCalledTimes(3);
    expect(restore).toHaveBeenLastCalledWith({ workspaceId: "ws-1", momentId: "restore-1" });
    expect(page.onReopenRestore).not.toHaveBeenCalled();
    expect(screen.getByTestId("engine-diff-restore-status").textContent).toBe("Undid the restore. This was recorded in history.");
  });
});


it("refreshes a diff's account name without waiting on the server", async () => {
  let notify!: (event: { workspaceId: string }) => void;
  let named = false;
  const read = vi.fn(async () => ({ moment: { ...moment(), namedAuthor: { userId: "ben", label: named ? "ben@test.example (via share link)" : "Someone you shared with" } } }));
  const page = renderPage(read);
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  // Subscribe on the new workspace, under the same read token used by the diff.
  page.update({ workspaceId: "ws-names" });
  await screen.findByText(/Someone you shared with/);
  named = true;
  act(() => notify({ workspaceId: "ws-names" }));
  await screen.findByText(/ben@test.example/);
});

it("keeps the prepared diff across name events and unrelated History answers", async () => {
  const compute = vi.spyOn(unifiedDiff, "computeTextDiff");
  const lines = vi.spyOn(unifiedDiff, "buildUnifiedDiffLines");
  let notify!: (event: { workspaceId: string }) => void;
  let label = "Someone you shared with";
  const read = vi.fn(async () => ({ moment: { ...moment(), namedAuthor: { userId: "ben", label } } }));
  const page = renderPage(read);
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  page.update({ workspaceId: "ws-names" });
  await screen.findByText(/Someone you shared with/);
  expect(compute).toHaveBeenCalledOnce();
  expect(lines).toHaveBeenCalledOnce();

  label = "ben@test.example (via share link)";
  act(() => notify({ workspaceId: "ws-names" }));
  await screen.findByText(/ben@test.example/);
  expect.soft(compute).toHaveBeenCalledOnce();
  expect.soft(lines).toHaveBeenCalledOnce();

  await act(async () => { page.update({ historyAnswer: { answer: "unrelated" } }); });
  expect(read).toHaveBeenCalledTimes(4);
  expect(compute).toHaveBeenCalledOnce();
  expect(lines).toHaveBeenCalledOnce();
});

it("refreshes every author's name on a change several people wrote, keeping its diff", async () => {
  const compute = vi.spyOn(unifiedDiff, "computeTextDiff");
  let notify!: (event: { workspaceId: string }) => void;
  let authorLabels = ["ann@test.example", "Someone you shared with"];
  const read = vi.fn(async (): Promise<{ moment: EngineMomentDetailRecord }> => ({ moment: { ...moment(), authorLabels } }));
  const page = renderPage(read);
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  page.update({ workspaceId: "ws-names" });
  expect((await screen.findAllByText(/Someone you shared with/)).length).toBeGreaterThan(0);
  const diffLines = screen.getByTestId("engine-diff-lines");
  expect(compute).toHaveBeenCalledOnce();

  authorLabels = ["ann@test.example", "ben@test.example (via share link)"];
  act(() => notify({ workspaceId: "ws-names" }));
  await waitFor(() => expect(screen.queryAllByText(/Someone you shared with/)).toHaveLength(0));
  expect(screen.getAllByText(/ben@test\.example/).length).toBeGreaterThan(0);
  expect(read).toHaveBeenCalledTimes(3);
  expect(compute).toHaveBeenCalledOnce();
  expect(screen.getByTestId("engine-diff-lines")).toBe(diffLines);
});
