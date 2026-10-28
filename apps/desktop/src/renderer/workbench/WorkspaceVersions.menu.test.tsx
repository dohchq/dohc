// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionMenu } from "./WorkspaceVersions";

const bridgeMock = {
  listWorkspaceVersions: vi.fn(),
  switchWorkspaceVersion: vi.fn(),
  createWorkspaceVersion: vi.fn(),
  mergeWorkspaceVersion: vi.fn(),
};

const MAIN = { id: "main", name: "Main", kind: "main" as const, createdAtMs: 0, canMergeIntoMain: false };
const DRAFT = { id: "draft", name: "Draft", kind: "named" as const, createdAtMs: 1, canMergeIntoMain: true };
const NESTED = { id: "nested", name: "Draft two", kind: "named" as const, createdAtMs: 2, canMergeIntoMain: false };

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

function renderMenu(extra: Pick<ComponentProps<typeof VersionMenu>, "onShareVersion"> = {}) {
  const props = {
    onWorkspaceStateChanged: vi.fn(),
    onError: vi.fn<ComponentProps<typeof VersionMenu>["onError"]>(),
  };
  render(
    <VersionMenu
      workspaceId="ws-1"
      activeTabDirty={false}
      beginLineageOperation={async () => () => {}}
      onOpenCompare={() => {}}
      {...props}
      {...extra}
    />,
  );
  return props;
}

async function openOn(user: ReturnType<typeof userEvent.setup>, active: string) {
  await waitFor(() => expect(screen.getByTestId("version-menu-active").textContent).toBe(active));
  await user.click(screen.getByTestId("version-menu-button"));
}

// Each row by its version name or test id, and each line between groups.
function rows(): (string | null)[] {
  return [...screen.getByTestId("version-menu").querySelectorAll("[role=menuitem],[role=menuitemradio],[role=separator],input")]
    .map((row) => row.getAttribute("data-version-name") ?? row.getAttribute("data-testid") ?? row.getAttribute("role"));
}

function descriptionOf(element: HTMLElement): string | null | undefined {
  return document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent;
}

function acrossIpc(channel: string, error: string): Error {
  return new Error(`Error invoking remote method '${channel}': ${error}`);
}

describe("VersionMenu", () => {
  it.each([
    ["Main with sharing", "main", true, ["Main", "Draft", "version-new", "separator", "version-share"]],
    ["Main without sharing", "main", false, ["Main", "Draft", "version-new"]],
    ["a version", "draft", true, ["Main", "Draft", "version-new", "separator", "version-compare", "version-merge", "version-share"]],
  ] as const)("lists the versions, then New version, then what the active version can do, on %s", async (_case, activeVersionId, sharing, expected) => {
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT], activeVersionId });
    renderMenu(sharing ? { onShareVersion: () => {} } : {});
    await openOn(userEvent.setup(), activeVersionId === "main" ? "Main" : "Draft");
    expect(rows()).toEqual(expected);
  });

  it("says on the Merge row why a version made from another version cannot merge", async () => {
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT, NESTED], activeVersionId: "nested" });
    renderMenu();
    await openOn(userEvent.setup(), "Draft two");
    const merge = screen.getByTestId("version-merge");
    expect(merge.getAttribute("aria-disabled")).toBe("true");
    expect(descriptionOf(merge)).toBe("Only versions made from Main can merge into Main.");
    expect(merge.title).toBe("");
  });

  it.each([
    ["main", "Main", "Starts as a copy of Main"],
    ["draft", "Draft", "Starts as a copy of Draft. It can't merge into Main."],
  ] as const)("says what a new version starts from on %s, then that it is being created", async (activeVersionId, active, hint) => {
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT], activeVersionId });
    bridgeMock.createWorkspaceVersion.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderMenu();
    await openOn(user, active);
    await user.click(screen.getByTestId("version-new"));
    const field = screen.getByTestId("version-new-input");
    expect(descriptionOf(field)).toBe(hint);
    await user.type(field, "Ideas{Enter}");
    await waitFor(() => expect(descriptionOf(field)).toBe("Creating…"));
  });

  it.each([
    ["an empty name", "  ", null, "Give the new version a name."],
    ["a taken name", "Draft", "VersionedTextStoreError [version-name-conflict]: version-name-conflict", "Another version is called Draft. Choose another name."],
    ["a name the engine refuses", "Ideas", "VersionedTextStoreError [invalid-version-name]: invalid-version-name", "dohc can't use that name. Choose another name."],
  ] as const)("keeps %s in the field and says why there", async (_case, name, refusal, words) => {
    if (refusal !== null) bridgeMock.createWorkspaceVersion.mockRejectedValue(acrossIpc("desktop:create-workspace-version", refusal));
    const user = userEvent.setup();
    const props = renderMenu();
    await openOn(user, "Draft");
    await user.click(screen.getByTestId("version-new"));
    const field = screen.getByTestId<HTMLInputElement>("version-new-input");
    await user.type(field, `${name}{Enter}`);
    await waitFor(() => expect(screen.getByTestId("version-menu-error").textContent).toBe(words));
    expect(screen.getByTestId("version-menu-error").getAttribute("role")).toBe("alert");
    expect(descriptionOf(field)).toBe(words);
    expect(field.value).toBe(name);
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("reports any other create failure with a Try again that creates the same name", async () => {
    const failure = acrossIpc("desktop:create-workspace-version", "Error: The engine stopped.");
    bridgeMock.createWorkspaceVersion.mockRejectedValueOnce(failure);
    const user = userEvent.setup();
    const props = renderMenu();
    await openOn(user, "Draft");
    await user.click(screen.getByTestId("version-new"));
    await user.type(screen.getByTestId("version-new-input"), "Ideas{Enter}");
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith(expect.any(String), failure, expect.any(Function)));
    expect(screen.getByTestId<HTMLInputElement>("version-new-input").value).toBe("Ideas");
    expect(screen.queryByTestId("version-menu-error")).toBeNull();

    // A press on the notice closes the menu before Try again runs.
    await user.keyboard("{Escape}{Escape}");
    expect(screen.queryByTestId("version-menu")).toBeNull();
    const ideas = { id: "ideas", name: "Ideas", kind: "named" as const, createdAtMs: 3, canMergeIntoMain: false };
    bridgeMock.createWorkspaceVersion.mockResolvedValueOnce({ versions: [MAIN, DRAFT, ideas], activeVersionId: "ideas" });
    act(() => props.onError.mock.calls[0]![2]!());
    expect(screen.getByTestId<HTMLInputElement>("version-new-input").value).toBe("Ideas");
    await waitFor(() => expect(screen.getByTestId("version-menu-active").textContent).toBe("Ideas"));
    expect(bridgeMock.createWorkspaceVersion).toHaveBeenLastCalledWith({ workspaceId: "ws-1", name: "Ideas" });
    expect(props.onWorkspaceStateChanged).toHaveBeenCalledWith("ideas");
  });

  it("reports a failed merge with a Try again that reopens the dialog and merges", async () => {
    const failure = acrossIpc("desktop:merge-workspace-version", "Error: The engine stopped.");
    bridgeMock.mergeWorkspaceVersion.mockRejectedValueOnce(failure);
    const user = userEvent.setup();
    const props = renderMenu();
    await openOn(user, "Draft");
    await user.click(screen.getByTestId("version-merge"));
    await user.click(screen.getByTestId("version-merge-confirm"));
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith(expect.any(String), failure, expect.any(Function)));
    expect(screen.queryByTestId("version-merge-dialog")).toBeNull();

    bridgeMock.mergeWorkspaceVersion.mockResolvedValueOnce({
      mergedFileCount: 1, unchangedFileCount: 0, conflictCount: 0, conflicts: [], nextAfterConflictId: null,
    });
    act(() => props.onError.mock.calls[0]![2]!());
    await waitFor(() => expect(screen.getByTestId("version-merge-status").textContent).toBe("Merged 1 file into Main."));
    expect(bridgeMock.mergeWorkspaceVersion).toHaveBeenCalledTimes(2);
    expect(bridgeMock.mergeWorkspaceVersion).toHaveBeenLastCalledWith({ workspaceId: "ws-1", versionId: "draft" });
  });

  it("says so when Try again finds the version is gone", async () => {
    bridgeMock.mergeWorkspaceVersion.mockRejectedValueOnce(new Error("The engine stopped."));
    const user = userEvent.setup();
    const props = renderMenu();
    await openOn(user, "Draft");
    await user.click(screen.getByTestId("version-merge"));
    await user.click(screen.getByTestId("version-merge-confirm"));
    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));

    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN], activeVersionId: "main" });
    act(() => props.onError.mock.calls[0]![2]!());
    await waitFor(() => expect(props.onError).toHaveBeenLastCalledWith("Draft no longer exists, so it can't merge into Main.", null));
    expect(screen.queryByTestId("version-merge-dialog")).toBeNull();
    expect(bridgeMock.mergeWorkspaceVersion).toHaveBeenCalledTimes(1);
  });

  it("keeps Try again when Try again cannot read the versions", async () => {
    bridgeMock.mergeWorkspaceVersion.mockRejectedValueOnce(new Error("The engine stopped."));
    const user = userEvent.setup();
    const props = renderMenu();
    await openOn(user, "Draft");
    await user.click(screen.getByTestId("version-merge"));
    await user.click(screen.getByTestId("version-merge-confirm"));
    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));

    const unreadable = new Error("The engine stopped.");
    bridgeMock.listWorkspaceVersions.mockRejectedValueOnce(unreadable);
    act(() => props.onError.mock.calls[0]![2]!());
    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(2));
    expect(props.onError).toHaveBeenLastCalledWith(expect.any(String), unreadable, expect.any(Function));

    bridgeMock.mergeWorkspaceVersion.mockResolvedValueOnce({
      mergedFileCount: 1, unchangedFileCount: 0, conflictCount: 0, conflicts: [], nextAfterConflictId: null,
    });
    act(() => props.onError.mock.calls[1]![2]!());
    await waitFor(() => expect(screen.getByTestId("version-merge-status").textContent).toBe("Merged 1 file into Main."));
  });

  it("reports nothing when Try again's read fails after the menu is gone", async () => {
    bridgeMock.mergeWorkspaceVersion.mockRejectedValueOnce(new Error("The engine stopped."));
    const user = userEvent.setup();
    const props = renderMenu();
    await openOn(user, "Draft");
    await user.click(screen.getByTestId("version-merge"));
    await user.click(screen.getByTestId("version-merge-confirm"));
    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));

    let failRead!: (error: Error) => void;
    bridgeMock.listWorkspaceVersions.mockReturnValueOnce(new Promise((_resolve, reject) => { failRead = reject; }));
    act(() => props.onError.mock.calls[0]![2]!());
    cleanup();
    await act(async () => {
      failRead(new Error("The engine stopped."));
      await Promise.resolve();
    });
    expect(props.onError).toHaveBeenCalledTimes(1);
  });
});
