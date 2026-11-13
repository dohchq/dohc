// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportKinds } from "../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS, type PrivacySettings } from "../settings/userSettings";
import { deferred, type Deferred } from "../testing/deferred";
import { reportsNoticeText } from "./shell/useReportsNotice";
import type { Workspace } from "./DesktopWorkspaceShell";
import { DesktopWorkspaceShell, OTHER_WORKSPACE, WORKSPACE, makeBridge, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";

const BOTH = { usage: true, errors: true };
const ON = { usageReports: true, errorReports: true };

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
    await waitFor(() => expect(bridge.acknowledgeReportsNotice).toHaveBeenCalledExactlyOnceWith({ usage: false, errors: true }));
  });



});
