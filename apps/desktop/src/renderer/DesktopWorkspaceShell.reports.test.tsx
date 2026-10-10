// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListKeptCopiesResult, ReportKinds } from "../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS, type PrivacySettings } from "../settings/userSettings";
import { settingsSectionPin } from "../testPins";
import { deferred, type Deferred } from "../testing/deferred";
import { keptCopyMessage } from "./shell/useKeptCopyNotices";
import { reportsNoticeText } from "./shell/useReportsNotice";
import type { Workspace } from "./DesktopWorkspaceShell";
import { DesktopWorkspaceShell, OTHER_WORKSPACE, WORKSPACE, makeBridge, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";

const BOTH = { usage: true, errors: true };
const ON = { usageReports: true, errorReports: true };
const OFF = { usageReports: false, errorReports: false };

// The shell as DesktopRoot mounts it, with the switches it has read so far.
function shell(bridge: ReturnType<typeof makeBridge>, privacy: PrivacySettings | null, workspace: Workspace = WORKSPACE) {
  vi.stubGlobal("dohcDesktop", bridge);
  return (
    <DesktopWorkspaceShell
      workspace={workspace}
      workspaces={[WORKSPACE, OTHER_WORKSPACE]}
      {...shellBootstrapProps(bridge)}
      userSettings={privacy ? { settings: { ...DEFAULT_USER_SETTINGS, privacy }, source: "stored" } : null}
      onSwitchWorkspace={() => {}}
    />
  );
}

// Each ask waits until the test answers it.
function heldAnswers(bridge: ReturnType<typeof makeBridge>): Deferred<ReportKinds>[] {
  const answers: Deferred<ReportKinds>[] = [];
  bridge.readReportsNotice = vi.fn(() => {
    const answer = deferred<ReportKinds>();
    answers.push(answer);
    return answer.promise;
  });
  return answers;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the notice about reports", () => {
  it("tells main once the notice is on screen, stays until closed, and opens Privacy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const bridge = makeBridge(Promise.resolve(null));
    const answers = heldAnswers(bridge);
    render(shell(bridge, ON));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(bridge.acknowledgeReportsNotice).not.toHaveBeenCalled();

    await act(async () => answers[0]!.resolve(BOTH));
    const toast = await screen.findByTestId("workspace-shell-notice");
    expect(toast.textContent).toContain(reportsNoticeText(BOTH));
    expect(toast.textContent).toContain("random ID for this installation");
    expect(bridge.acknowledgeReportsNotice).toHaveBeenCalledExactlyOnceWith(BOTH);

    // A success toast fades after a few seconds; this one waits to be closed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId("workspace-shell-notice").textContent).toContain(reportsNoticeText(BOTH));

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Privacy settings" }));
    expect(await screen.findByTestId(settingsSectionPin("privacy"))).toBeTruthy();
    expect(bridge.acknowledgeReportsNotice).toHaveBeenCalledOnce();
  });

  it("tells main nothing while a newer toast covers the notice, and tells it once the notice shows", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const answers = heldAnswers(bridge);
    const kept = deferred<ListKeptCopiesResult>();
    bridge.listKeptCopies = vi.fn(() => kept.promise);
    render(shell(bridge, ON));
    await waitFor(() => expect(answers).toHaveLength(1));
    await waitFor(() => expect(bridge.listKeptCopies).toHaveBeenCalled());

    // The kept copy arrives in the same update, after the notice, so its toast wins.
    await act(async () => {
      answers[0]!.resolve(BOTH);
      await answers[0]!.promise;
      kept.resolve({ keptCopies: [{ id: 1, path: "notes.md", keptAtMs: 1 }], more: false });
      await kept.promise;
    });
    const covering = await screen.findByTestId("workspace-shell-error");
    expect(covering.textContent).toContain(keptCopyMessage("notes.md"));
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
    expect(bridge.acknowledgeReportsNotice).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss workspace error" }));
    expect((await screen.findByTestId("workspace-shell-notice")).textContent).toContain(reportsNoticeText(BOTH));
    expect(bridge.acknowledgeReportsNotice).toHaveBeenCalledExactlyOnceWith(BOTH);
  });

  it("shows nothing and tells main nothing when the window closes before main answers", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const answers = heldAnswers(bridge);
    const view = render(shell(bridge, ON));
    await waitFor(() => expect(answers).toHaveLength(1));
    view.unmount();
    await act(async () => answers[0]!.resolve(BOTH));
    expect(bridge.acknowledgeReportsNotice).not.toHaveBeenCalled();
  });

  it("drops an answer for the workspace the window left, and asks again for the new one", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const answers = heldAnswers(bridge);
    const view = render(shell(bridge, ON));
    await waitFor(() => expect(answers).toHaveLength(1));
    view.rerender(shell(bridge, ON, OTHER_WORKSPACE));
    await waitFor(() => expect(answers).toHaveLength(2));

    await act(async () => answers[0]!.resolve(BOTH));
    expect(screen.queryByText(reportsNoticeText(BOTH))).toBeNull();
    expect(bridge.acknowledgeReportsNotice).not.toHaveBeenCalled();

    await act(async () => answers[1]!.resolve({ usage: false, errors: true }));
    expect(await screen.findByText(reportsNoticeText({ usage: false, errors: true }))).toBeTruthy();
    expect(bridge.acknowledgeReportsNotice).toHaveBeenCalledExactlyOnceWith({ usage: false, errors: true });
  });

  it("waits for the saved switches, asks nothing while both are off, and asks once one turns on", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readReportsNotice = vi.fn(async () => ({ usage: true, errors: false }));
    const view = render(shell(bridge, null));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    view.rerender(shell(bridge, OFF));
    await act(async () => undefined);
    expect(bridge.readReportsNotice).not.toHaveBeenCalled();

    view.rerender(shell(bridge, { usageReports: true, errorReports: false }));
    expect(await screen.findByText(reportsNoticeText({ usage: true, errors: false }))).toBeTruthy();
    expect(bridge.readReportsNotice).toHaveBeenCalledOnce();
    expect(bridge.acknowledgeReportsNotice).toHaveBeenCalledExactlyOnceWith({ usage: true, errors: false });
  });

  it("names usage reports in a new notice when they turn on after a notice that named only error reports", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const answers = heldAnswers(bridge);
    const view = render(shell(bridge, { usageReports: false, errorReports: true }));
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => answers[0]!.resolve({ usage: false, errors: true }));
    expect(await screen.findByText(reportsNoticeText({ usage: false, errors: true }))).toBeTruthy();
    expect(bridge.acknowledgeReportsNotice).toHaveBeenLastCalledWith({ usage: false, errors: true });

    view.rerender(shell(bridge, ON));
    await waitFor(() => expect(answers).toHaveLength(2));
    await act(async () => answers[1]!.resolve({ usage: true, errors: false }));
    expect(await screen.findByText(reportsNoticeText({ usage: true, errors: false }))).toBeTruthy();
    expect(bridge.acknowledgeReportsNotice).toHaveBeenLastCalledWith({ usage: true, errors: false });
    expect(bridge.acknowledgeReportsNotice).not.toHaveBeenCalledWith(BOTH);
  });

  it("shows nothing when main says no notice is due", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    render(shell(bridge, ON));
    await waitFor(() => expect(bridge.readReportsNotice).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
    expect(bridge.acknowledgeReportsNotice).not.toHaveBeenCalled();
  });
});
