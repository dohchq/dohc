// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionMenu } from "./WorkspaceVersions";

const bridgeMock = {
  listWorkspaceVersions: vi.fn(),
  switchWorkspaceVersion: vi.fn(),
  createWorkspaceVersion: vi.fn(),
};

const MAIN = { id: "main", name: "Main", kind: "main" as const, createdAtMs: 0, canMergeIntoMain: false };
const DRAFT = { id: "draft", name: "Draft", kind: "named" as const, createdAtMs: 1, canMergeIntoMain: true };

beforeEach(() => {
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT], activeVersionId: "draft" });
  bridgeMock.switchWorkspaceVersion.mockResolvedValue({ activeVersionId: "main", changedFileCount: 1 });
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("VersionMenu refreshKey (regression: external version switches)", () => {
  it.each([false, true])("changes lineage after a failed preflight only for an observed version change (%s)", async (recoveredChange) => {
    const onWorkspaceStateChanged = vi.fn();
    const onError = vi.fn();
    const user = userEvent.setup();
    render(
      <VersionMenu
        workspaceId="ws-1"
        activeTabDirty={false}
        beginLineageOperation={async () => { throw new Error("Retained collection input"); }}
        onOpenCompare={() => {}}
        onWorkspaceStateChanged={onWorkspaceStateChanged}
        onError={onError}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("version-menu-active").textContent).toBe("Draft"));
    if (recoveredChange) {
      bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN], activeVersionId: "main" });
    } else {
      bridgeMock.listWorkspaceVersions.mockRejectedValue(new Error("Recovery read failed"));
    }
    await user.click(screen.getByTestId("version-menu-button"));
    await user.click(screen.getByRole("menuitemradio", { name: "Main" }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(bridgeMock.switchWorkspaceVersion).not.toHaveBeenCalled();
    expect(onWorkspaceStateChanged).toHaveBeenCalledWith(recoveredChange ? "main" : undefined, recoveredChange);
  });

  it("keeps waiting while a large workspace is still importing", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    bridgeMock.listWorkspaceVersions.mockImplementation(async () => {
      attempts += 1;
      if (attempts <= 7) {
        throw new Error(
          "Error invoking remote method 'desktop:list-workspace-versions': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
        );
      }
      return { versions: [MAIN], activeVersionId: "main" };
    });
    const onError = vi.fn();
    render(
      <VersionMenu
        workspaceId="ws-importing"
        activeTabDirty={false}
        beginLineageOperation={async () => () => {}}
        onOpenCompare={() => {}}
        onWorkspaceStateChanged={() => {}}
        onError={onError}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });

    expect(attempts).toBe(8);
    expect(screen.getByTestId("version-menu-active").textContent).toBe("Main");
    expect(onError).not.toHaveBeenCalled();
  });

  it("re-reads the active version when the shell bumps refreshKey", async () => {
    function menu(refreshKey: number) {
      return (
        <VersionMenu
          workspaceId="ws-1"
          activeTabDirty={false}
          beginLineageOperation={async () => () => {}}
          onOpenCompare={() => {}}
          onWorkspaceStateChanged={() => {}}
          onError={() => {}}
          refreshKey={refreshKey}
        />
      );
    }
    const view = render(menu(0));
    await waitFor(() => expect(screen.getByTestId("version-menu-active").textContent).toBe("Draft"));

    // A version switch made outside this menu bumps the shell's versionEpoch,
    // which reaches the menu as refreshKey. Without the re-read the selector
    // kept showing the version it last saw.
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT], activeVersionId: "main" });
    view.rerender(menu(1));
    await waitFor(() => expect(screen.getByTestId("version-menu-active").textContent).toBe("Main"));
  });
});
