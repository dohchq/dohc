// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineMomentDetailRecord, HistoryPolicyUnreadableResult } from "../../ipc/bridgeContract";
import { EngineMomentDiffPage } from "./EngineMomentDiffPage";
import { HistoryHiddenState, historyHiddenWords } from "./HistoryPolicyStates";
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

function renderPage(readEngineMoment: ReturnType<typeof vi.fn>, restoreEngineMomentFile = vi.fn()) {
  vi.stubGlobal("dohcDesktop", { readEngineMoment, restoreEngineMomentFile });
  const onError = vi.fn();
  const onSettled = vi.fn();
  const onRestored = vi.fn();
  render(
    <EngineMomentDiffPage
      workspaceId="ws-1"
      tabPath={momentDiffTabPath("m-1")}
      onBeforeRestore={async () => noop}
      onOpenFile={noop}
      onPathResolved={noop}
      registerActiveUndo={noop}
      onRestored={onRestored}
      onStopAndRestore={noop}
      onError={onError}
      onSettled={onSettled}
    />,
  );
  return { onError, onSettled, onRestored };
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

  it("says the change is hidden because History no longer tracks its file", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ status: "untracked", moment: null })
      .mockResolvedValue({ moment: moment() });
    renderPage(read);
    const state = await screen.findByTestId("engine-diff-untracked");
    expect(state.textContent).toBe(
      "History no longer tracks this file, so this change is hidden. To show it, track the file in .dohc/files.toml.Try again",
    );
    expect(screen.queryByText("This change is no longer in the history record.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("engine-diff-lines")).toBeTruthy();
  });

  it("reports a failed restore to the shell, and its Try again repeats the restore and clears the row", async () => {
    const refused = new Error(
      "Error invoking remote method 'desktop:restore-engine-moment-file': RestorePolicyRefusalError [policy-unreadable]: " + PARSER,
    );
    const restore = vi.fn()
      .mockRejectedValueOnce(refused)
      .mockResolvedValue({ restored: "text", restoredMomentId: "restore-1" });
    const { onError, onSettled, onRestored } = renderPage(vi.fn().mockResolvedValue({ moment: moment() }), restore);
    await screen.findByTestId("engine-diff-lines");
    fireEvent.click(screen.getByTestId("engine-diff-restore-file"));
    await act(async () => { fireEvent.click(screen.getByTestId("engine-diff-confirm-restore")); });
    expect(onError).toHaveBeenCalledWith("dohc could not restore notes/plan.md.", refused, expect.any(Function), "history-restore:notes/plan.md");
    expect(screen.queryByTestId("engine-diff-restore-status")).toBeNull();
    expect(screen.getByTestId("engine-moment-diff-page").textContent).not.toContain("TOML parse error");
    expect(onRestored).not.toHaveBeenCalled();

    const retry = onError.mock.calls[0]![2] as () => void;
    await act(async () => { retry(); });
    expect(restore).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledWith("history-restore:notes/plan.md");
    expect(screen.getByTestId("engine-diff-restore-status").textContent).toBe(
      "Restored the earlier state. Undo restore is available here.",
    );
  });
});
