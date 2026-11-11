// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ResolveWorkLinkPayload, WorkLinkPlace, WorkspaceActivatedMessage } from "../ipc/bridgeContract";
import { deferred, type Deferred } from "../testing/deferred";
import { CollectionFieldWriteHost } from "./collections/recordFieldWrites";
import type { Workspace } from "./DesktopWorkspaceShell";
import { DesktopWorkspaceShell, OTHER_WORKSPACE, WORKSPACE, makeBridge, renderShell, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";
import { CHAT_NOT_FOUND_NOTE, RUN_THREAD_LOOKUP_FAILED_NOTE, type NoticeTarget } from "../notices/noticeTarget";
import { openWorkLinkInDohc } from "./workLinkOpener";

const LINK = `https://dohc.example/l/${"a".repeat(43)}`;
const THIRD: Workspace = { ...WORKSPACE, workspaceId: "ws-shell-third", rootPath: "/home/sam/dohc/third" };
const placeIn = (workspace: Workspace): WorkLinkPlace =>
  ({ workspaceId: workspace.workspaceId, channelId: "group-1", threadId: "thread-1", messageId: "message-1" });
const AT_MESSAGE: NoticeTarget = { to: "chat", thread: "thread-1", channel: "group-1", message: "message-1" };

// Main's answers wait until the test settles them, in the order they were asked.
function renderShells() {
  const answers: Deferred<WorkLinkPlace | null>[] = [];
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    resolveWorkLink: vi.fn((_payload: ResolveWorkLinkPayload) => {
      const answer = deferred<WorkLinkPlace | null>();
      answers.push(answer);
      return answer.promise;
    }),
  });
  vi.stubGlobal("dohcDesktop", bridge);
  const onSwitchWorkspace = vi.fn((_workspace: Workspace, _open?: NoticeTarget) => {});
  const workspaces = [WORKSPACE, OTHER_WORKSPACE, THIRD];
  // Keyed on the workspace, as DesktopRoot mounts it, so a switch remounts the shell.
  const shown = (workspace: Workspace) => (
    <>
      <CollectionFieldWriteHost />
      <DesktopWorkspaceShell
        key={workspace.workspaceId}
        workspace={workspace}
        workspaces={workspaces}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={onSwitchWorkspace}
      />
    </>
  );
  const view = render(shown(WORKSPACE));
  return { bridge, answers, onSwitchWorkspace, show: (workspace: Workspace) => view.rerender(shown(workspace)) };
}

describe("a work link clicked in dohc", () => {
  it("opens nothing when main answers after the window switched workspaces", async () => {
    const { bridge, answers, onSwitchWorkspace, show } = renderShells();
    const stale = openWorkLinkInDohc(LINK);
    await waitFor(() => expect(bridge.resolveWorkLink).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE.workspaceId, url: LINK }));

    show(THIRD);
    await act(async () => answers[0]!.resolve(placeIn(OTHER_WORKSPACE)));
    await expect(stale).resolves.toBe(true);
    expect(onSwitchWorkspace).not.toHaveBeenCalled();

    // The remounted shell asks for its own workspace and opens its own answer.
    const fresh = openWorkLinkInDohc(LINK);
    await waitFor(() => expect(bridge.resolveWorkLink).toHaveBeenLastCalledWith({ workspaceId: THIRD.workspaceId, url: LINK }));
    await act(async () => answers[1]!.resolve(placeIn(OTHER_WORKSPACE)));
    await expect(fresh).resolves.toBe(true);
    expect(onSwitchWorkspace).toHaveBeenCalledExactlyOnceWith(OTHER_WORKSPACE, AT_MESSAGE);
  });

  it("opens only the newest link when an older one answers last", async () => {
    const { bridge, answers, onSwitchWorkspace } = renderShells();
    const older = openWorkLinkInDohc(LINK);
    const newer = openWorkLinkInDohc(LINK);
    await waitFor(() => expect(bridge.resolveWorkLink).toHaveBeenCalledTimes(2));

    await act(async () => answers[1]!.resolve(placeIn(OTHER_WORKSPACE)));
    await expect(newer).resolves.toBe(true);
    await act(async () => answers[0]!.resolve(placeIn(THIRD)));
    await expect(older).resolves.toBe(true);
    expect(onSwitchWorkspace).toHaveBeenCalledExactlyOnceWith(OTHER_WORKSPACE, AT_MESSAGE);
  });

  it("lets only the newest open act, so an older lookup answered later changes nothing", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const older = deferred<never>();
    bridge.listChatChannels
      .mockImplementationOnce(() => older.promise)
      .mockImplementation(async () => ({ channels: [], fileThreads: [] }));
    renderShell(bridge);
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    const activated = bridge.onWorkspaceActivated.mock.calls.at(-1)![0] as
      (workspace: Workspace, file?: string, message?: WorkspaceActivatedMessage) => void;
    const open = (thread: string) => act(() => activated(WORKSPACE, undefined, { channelId: null, threadId: thread, messageId: `${thread}-m` }));

    await open("thread-a");
    await waitFor(() => expect(bridge.listChatChannels).toHaveBeenCalledTimes(1));
    await open("thread-b");
    expect(await screen.findByText(CHAT_NOT_FOUND_NOTE, { exact: false })).toBeTruthy();

    await act(async () => older.reject(new Error("engine stopped")));
    expect(screen.queryByText(RUN_THREAD_LOOKUP_FAILED_NOTE, { exact: false })).toBeNull();
  });
});
