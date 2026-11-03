// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeFilesWait } from "./WorkspaceVersions";
import { VersionMenuHarness } from "./WorkspaceVersions.testHarness";

const bridgeMock = {
  listWorkspaceVersions: vi.fn(),
  switchWorkspaceVersion: vi.fn(),
  createWorkspaceVersion: vi.fn(),
  mergeWorkspaceVersion: vi.fn(),
  listWorkspaceVersionConflicts: vi.fn(),
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
      <VersionMenuHarness
        workspaceId="ws-1"
        activeTabDirty={false}
        beginLineageOperation={async () => { throw new Error("Retained collection input"); }}
        onOpenCompare={() => {}}
        onWorkspaceStateChanged={onWorkspaceStateChanged}
        onError={onError}
        clearError={() => {}}
        onMergeNotice={() => {}}
        onConflictError={() => {}}
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
      <VersionMenuHarness
        workspaceId="ws-importing"
        activeTabDirty={false}
        beginLineageOperation={async () => () => {}}
        onOpenCompare={() => {}}
        onWorkspaceStateChanged={() => {}}
        onError={onError}
        clearError={() => {}}
        onMergeNotice={() => {}}
        onConflictError={() => {}}
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
        <VersionMenuHarness
          workspaceId="ws-1"
          activeTabDirty={false}
          beginLineageOperation={async () => () => {}}
          onOpenCompare={() => {}}
          onWorkspaceStateChanged={() => {}}
          onError={() => {}}
          clearError={() => {}}
          onMergeNotice={() => {}}
          onConflictError={() => {}}
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

type MenuExtra = Pick<ComponentProps<typeof VersionMenuHarness>, "onShareVersion" | "onOpenAllVersions" | "onOpenHistory" | "onMergeOpenChange" | "enabled">;

function renderMenu(extra: MenuExtra = {}) {
  const props = {
    onWorkspaceStateChanged: vi.fn(),
    onError: vi.fn<ComponentProps<typeof VersionMenuHarness>["onError"]>(),
    clearError: vi.fn<ComponentProps<typeof VersionMenuHarness>["clearError"]>(),
    onMergeNotice: vi.fn<ComponentProps<typeof VersionMenuHarness>["onMergeNotice"]>(),
  };
  const menu = (more: MenuExtra) => (
    <VersionMenuHarness
      workspaceId="ws-1"
      activeTabDirty={false}
      beginLineageOperation={async () => () => {}}
      onConflictError={() => {}}
      onOpenCompare={() => {}}
      {...props}
      {...extra}
      {...more}
    />
  );
  const view = render(menu({}));
  return { ...props, rerender: (more: MenuExtra) => view.rerender(menu(more)) };
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

// A merge that failed after some of the version's files reached Main.
function stoppedPartway(): Error {
  return acrossIpc("desktop:merge-workspace-version", "MergeStoppedPartwayError: Error: disk full");
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

  it("ends with All versions, which closes the menu and opens the Versions page", async () => {
    const onOpenAllVersions = vi.fn();
    const user = userEvent.setup();
    renderMenu({ onOpenAllVersions });
    await openOn(user, "Draft");
    expect(rows().at(-1)).toBe("version-all");
    await user.click(screen.getByTestId("version-all"));
    expect(onOpenAllVersions).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("version-menu")).toBeNull();
  });

  it("says under Main what a version is for while only Main exists, and still ends with All versions", async () => {
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN], activeVersionId: "main" });
    renderMenu({ onShareVersion: () => {}, onOpenAllVersions: () => {} });
    await openOn(userEvent.setup(), "Main");
    expect(rows()).toEqual(["Main", "version-new", "separator", "version-share", "separator", "version-all"]);
    expect(descriptionOf(screen.getByRole("menuitemradio", { name: "Main" }))).toBe("Try changes without touching Main.");
    expect(screen.getByTestId("version-new").textContent).toBe("New version");
  });

  it("shows the chip's dot beside each version's name, and keeps its space on Main", async () => {
    renderMenu();
    await openOn(userEvent.setup(), "Draft");
    const chipDot = screen.getByTestId("version-menu-dot").className.split(" ").find((name) => name.startsWith("bg-hue-"));
    const [mainDot, draftDot] = screen.getAllByTestId("version-item-dot");
    expect(mainDot?.className).not.toContain("bg-hue-");
    expect(chipDot).toBeDefined();
    expect(draftDot?.className.split(" ")).toContain(chipDot);
    // The dot adds nothing to the row's name.
    expect(screen.getByRole("menuitemradio", { name: "Draft" })).toBeTruthy();
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
    ["main", "Main", "Starts from Main"],
    ["draft", "Draft", "Starts from Draft, so it can't merge into Main."],
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
    ["an empty name", "  ", null, "Enter a name for the version."],
    ["a taken name", "Draft", "VersionedTextStoreError [version-name-conflict]: version-name-conflict", "Another version is called Draft. Choose another name."],
    ["a name the engine refuses", "Ideas", "VersionedTextStoreError [invalid-version-name]: invalid-version-name", "dohc can't use that name. Choose another name."],
  ] as const)("keeps %s in the field and says why there until the name changes", async (_case, name, refusal, words) => {
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
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.value).toBe(name);
    expect(props.onError).not.toHaveBeenCalled();

    await user.type(field, "2");
    expect(screen.queryByTestId("version-menu-error")).toBeNull();
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(descriptionOf(field)).toBe("Starts from Draft, so it can't merge into Main.");
  });

  it("reports any other create failure with a Try again that creates the same name", async () => {
    const failure = acrossIpc("desktop:create-workspace-version", "Error: The engine stopped.");
    bridgeMock.createWorkspaceVersion.mockRejectedValueOnce(failure);
    const user = userEvent.setup();
    const props = renderMenu();
    await openOn(user, "Draft");
    await user.click(screen.getByTestId("version-new"));
    await user.type(screen.getByTestId("version-new-input"), "Ideas{Enter}");
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith(expect.any(String), failure, expect.any(Function), "version-create:ws-1:Ideas"));
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
    expect(props.clearError).toHaveBeenCalledWith("version-create:ws-1:Ideas");
  });

  it("takes back a create failure's notice when the name field creates it", async () => {
    bridgeMock.createWorkspaceVersion.mockRejectedValueOnce(acrossIpc("desktop:create-workspace-version", "Error: The engine stopped."));
    const user = userEvent.setup();
    const props = renderMenu();
    await openOn(user, "Draft");
    await user.click(screen.getByTestId("version-new"));
    await user.type(screen.getByTestId("version-new-input"), "Ideas{Enter}");
    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));
    expect(props.clearError).not.toHaveBeenCalled();

    const ideas = { id: "ideas", name: "Ideas", kind: "named" as const, createdAtMs: 3, canMergeIntoMain: false };
    bridgeMock.createWorkspaceVersion.mockResolvedValueOnce({ versions: [MAIN, DRAFT, ideas], activeVersionId: "ideas" });
    await user.type(screen.getByTestId("version-new-input"), "{Enter}");
    await waitFor(() => expect(props.clearError).toHaveBeenCalledWith(props.onError.mock.calls[0]![3]));
  });

  const merged = {
    mergedFileCount: 1, unchangedFileCount: 0, conflictCount: 0, replacedProtectedPaths: [], conflicts: [], nextAfterConflictId: null,
  };

  async function confirmMerge(user: ReturnType<typeof userEvent.setup>) {
    await openOn(user, "Draft");
    await user.click(screen.getByTestId("version-merge"));
    await user.click(screen.getByTestId("version-merge-confirm"));
  }

  it("shows a failed merge in the dialog, where Merge into Main merges again", async () => {
    bridgeMock.mergeWorkspaceVersion.mockRejectedValueOnce(acrossIpc("desktop:merge-workspace-version", "Error: The engine stopped."));
    const user = userEvent.setup();
    const props = renderMenu();
    await confirmMerge(user);
    const dialog = screen.getByTestId("version-merge-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("version-merge-failure-words").textContent).toBe("The engine stopped."));
    // The words say it all, so there is nothing more to copy.
    expect(within(dialog).queryByRole("button", { name: "Details" })).toBeNull();
    const confirm = screen.getByTestId<HTMLButtonElement>("version-merge-confirm");
    expect(confirm.textContent).toBe("Merge into Main");
    expect(confirm.disabled).toBe(false);
    expect(document.activeElement).toBe(confirm);
    // Focus reads the button and then the failure, once, with no alert on top.
    expect(confirm.getAttribute("aria-describedby")).toBe(within(dialog).getByTestId("version-merge-failure-words").id);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(props.onError).not.toHaveBeenCalled();

    bridgeMock.mergeWorkspaceVersion.mockResolvedValueOnce(merged);
    await user.click(confirm);
    await waitFor(() => expect(screen.getByTestId("version-merge-status").textContent).toBe("Merged 1 file into Main"));
    expect(screen.queryByTestId("version-merge-failure")).toBeNull();
    expect(bridgeMock.mergeWorkspaceVersion).toHaveBeenCalledTimes(2);
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("shows a merge that stopped partway with Open History at the left, then Cancel and Merge again", async () => {
    bridgeMock.mergeWorkspaceVersion.mockRejectedValueOnce(stoppedPartway());
    const onOpenHistory = vi.fn();
    const user = userEvent.setup();
    renderMenu({ onOpenHistory });
    await confirmMerge(user);
    const dialog = screen.getByTestId("version-merge-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("version-merge-failure-words").textContent)
      .toBe("dohc could not finish the merge. Some of Draft's changes are in Main, and History shows which."));
    await user.click(within(dialog).getByRole("button", { name: "Details" }));
    expect(within(dialog).getByTestId("version-merge-failure").textContent).toContain("Cause: Error: disk full");
    const footer = ["version-merge-open-history", "version-merge-cancel", "version-merge-confirm"];
    expect(within(dialog).getAllByRole("button").map((button) => button.dataset.testid ?? "").filter((id) => footer.includes(id)))
      .toEqual(footer);
    expect(screen.getByTestId("version-merge-confirm").textContent).toBe("Merge again");

    await user.click(screen.getByTestId("version-merge-open-history"));
    expect(onOpenHistory).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("version-merge-dialog")).toBeNull();
  });

  it("tells the shell while a merge dialog is open", async () => {
    const onMergeOpenChange = vi.fn<(open: boolean) => void>();
    const user = userEvent.setup();
    renderMenu({ onMergeOpenChange });
    await openOn(user, "Draft");
    expect(onMergeOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("version-merge"));
    expect(onMergeOpenChange.mock.calls).toEqual([[true]]);
    // Closing settles the rows that wait on decisions, so it says so once.
    await user.click(screen.getByTestId("version-merge-cancel"));
    expect(onMergeOpenChange.mock.calls).toEqual([[true], [false]]);
  });

  it("puts Details under a failure whose copy text holds more than it shows", async () => {
    bridgeMock.mergeWorkspaceVersion.mockRejectedValueOnce(new TypeError("result.conflicts is undefined"));
    const user = userEvent.setup();
    renderMenu();
    await confirmMerge(user);
    const dialog = screen.getByTestId("version-merge-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("version-merge-failure-words").textContent).toBe("dohc could not merge Draft into Main."));
    const toggle = within(dialog).getByRole("button", { name: "Details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")?.textContent)
      .toContain("Error: dohc could not merge Draft into Main.\nCause: TypeError: result.conflicts is undefined");
  });

  it.each([
    ["fails", new Error("The engine stopped."), { title: "dohc could not merge Draft into Main", message: "Fix the data store problem in Notices, then merge again." }],
    ["stops partway", stoppedPartway(), {
      title: "dohc could not finish merging Draft into Main", message: "Some of Draft's changes are in Main. Fix the data store problem in Notices, then merge again.",
    }],
  ])("reports a merge that %s after the menu is gone as a notice with no Try again", async (_name, failure, words) => {
    const answer = deferredMerge();
    const user = userEvent.setup();
    const props = renderMenu();
    await confirmMerge(user);
    await waitFor(() => expect(bridgeMock.mergeWorkspaceVersion).toHaveBeenCalledOnce());
    cleanup();
    await act(async () => {
      answer.reject(failure);
      await Promise.resolve();
    });
    expect(props.onMergeNotice).toHaveBeenCalledExactlyOnceWith({ identity: "version-merge:ws-1:draft", ...words, cause: failure });
    expect(props.onError).not.toHaveBeenCalled();
  });

  function deferredMerge() {
    let resolve!: (result: unknown) => void;
    let reject!: (error: unknown) => void;
    bridgeMock.mergeWorkspaceVersion.mockReturnValueOnce(new Promise((ok, fail) => { resolve = ok; reject = fail; }));
    return { resolve, reject };
  }

  // Starts a merge, then closes its dialog the way `close` says, while the merge runs.
  async function closeWhileMerging(user: ReturnType<typeof userEvent.setup>, close: "button" | "escape") {
    await confirmMerge(user);
    const button = screen.getByTestId<HTMLButtonElement>("version-merge-cancel");
    expect(button.textContent).toBe("Close");
    expect(document.activeElement).toBe(button);
    if (close === "button") await user.click(button);
    else await user.keyboard("{Escape}");
    expect(screen.queryByTestId("version-merge-dialog")).toBeNull();
  }

  const conflict = {
    conflictId: "c-1", path: "notes.md", sourceVersionId: "draft", targetVersionId: "main", origin: "merge" as const,
    contentKind: "text" as const, currentText: "a", incomingText: "b", baseText: "",
  };

  it.each([
    ["merged files", { ...merged, mergedFileCount: 4 }, { tone: "success", message: "Merged 4 files from Draft into Main" }],
    ["nothing to merge", { ...merged, mergedFileCount: 0 }, { tone: "success", message: "No files from Draft merged into Main" }],
    ["files all decided elsewhere", { ...merged, conflictCount: 2 }, { tone: "success", message: "Merged Draft into Main" }],
    ["protected files", { ...merged, replacedProtectedPaths: [".env"] }, {
      tone: "success", title: "Merged 1 file from Draft into Main", message: "One protected file took Draft's copy.", paths: [".env"],
    }],
    ["files to decide", { ...merged, conflictCount: 2, conflicts: [conflict], nextAfterConflictId: "c-1" }, {
      tone: "warning", title: "Merged Draft into Main", message: "2 files have two copies.", decideFrom: "draft",
    }],
  ])("keeps merging when the dialog closes, then reports %s as a notice", async (_name, result, notice) => {
    const answer = deferredMerge();
    const user = userEvent.setup();
    const props = renderMenu();
    await closeWhileMerging(user, "button");
    await act(async () => {
      answer.resolve(result);
      await Promise.resolve();
    });
    await waitFor(() => expect(props.onMergeNotice).toHaveBeenCalledExactlyOnceWith({ identity: "version-merge:ws-1:draft", ...notice }));
    expect(props.onWorkspaceStateChanged).toHaveBeenCalled();
    expect(props.clearError).toHaveBeenCalledWith("version-merge:ws-1:draft");
  });

  it("keeps merging when Escape closes the dialog, and its failure's Try again opens the dialog merging again", async () => {
    const answer = deferredMerge();
    const user = userEvent.setup();
    const props = renderMenu();
    await closeWhileMerging(user, "escape");
    const failure = acrossIpc("desktop:merge-workspace-version", "Error: The engine stopped.");
    await act(async () => {
      answer.reject(failure);
      await Promise.resolve();
    });
    await waitFor(() => expect(props.onMergeNotice).toHaveBeenCalledOnce());
    const notice = props.onMergeNotice.mock.calls[0]![0];
    expect(notice).toEqual({
      identity: "version-merge:ws-1:draft",
      title: "dohc could not merge Draft into Main",
      message: "The engine stopped.",
      cause: failure,
      retry: expect.any(Function),
    });

    const again = deferredMerge();
    act(() => void notice.retry!());
    expect(screen.getByTestId("version-merge-confirm").textContent).toBe("Merging…");
    await waitFor(() => expect(bridgeMock.mergeWorkspaceVersion).toHaveBeenCalledTimes(2));
    await act(async () => {
      again.resolve(merged);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("version-merge-status").textContent).toBe("Merged 1 file into Main"));
    // A Try again while a dialog is open can't merge, so its row stays.
    expect(notice.retry!()).toBe(false);
  });

  it("merges again from a notice made before capture stopped and came back", async () => {
    const answer = deferredMerge();
    const user = userEvent.setup();
    const props = renderMenu();
    await closeWhileMerging(user, "button");
    await act(async () => {
      answer.reject(acrossIpc("desktop:merge-workspace-version", "Error: The engine stopped."));
      await Promise.resolve();
    });
    await waitFor(() => expect(props.onMergeNotice).toHaveBeenCalledOnce());
    const notice = props.onMergeNotice.mock.calls[0]![0];
    props.rerender({ enabled: false });
    // With capture off, Try again can't merge, so its row stays.
    expect(notice.retry!()).toBe(false);
    props.rerender({ enabled: true });
    await waitFor(() => expect(screen.getByTestId("version-menu-active").textContent).toBe("Draft"));
    deferredMerge();
    act(() => void notice.retry!());
    expect(screen.getByTestId("version-merge-confirm").textContent).toBe("Merging…");
    await waitFor(() => expect(bridgeMock.mergeWorkspaceVersion).toHaveBeenCalledTimes(2));
  });

  it("reports a closed merge that stopped partway with History to open and Try again", async () => {
    const answer = deferredMerge();
    const user = userEvent.setup();
    const props = renderMenu();
    await closeWhileMerging(user, "button");
    const failure = stoppedPartway();
    await act(async () => {
      answer.reject(failure);
      await Promise.resolve();
    });
    await waitFor(() => expect(props.onMergeNotice).toHaveBeenCalledExactlyOnceWith({
      identity: "version-merge:ws-1:draft",
      title: "dohc could not finish merging Draft into Main",
      message: "Some of Draft's changes are in Main, and History shows which.",
      cause: failure,
      retry: expect.any(Function),
      offersHistory: true,
    }));
  });

  it("names a closed merge's failure in its title alone when the error has no words", async () => {
    const answer = deferredMerge();
    const user = userEvent.setup();
    const props = renderMenu();
    await closeWhileMerging(user, "button");
    const failure = new TypeError("result.conflicts is undefined");
    await act(async () => {
      answer.reject(failure);
      await Promise.resolve();
    });
    await waitFor(() => expect(props.onMergeNotice).toHaveBeenCalledExactlyOnceWith({
      identity: "version-merge:ws-1:draft",
      message: "dohc could not merge Draft into Main.",
      cause: failure,
      retry: expect.any(Function),
    }));
  });
});

describe("mergeFilesWait", () => {
  const row = (conflictId: string, origin: "merge" | "sync", sourceVersionId: string) => ({
    conflictId, path: `${conflictId}.md`, sourceVersionId, targetVersionId: "main", origin,
    contentKind: "text" as const, currentText: "a", incomingText: "b", baseText: "",
  });

  it("reads page by page until it finds a file this merge left to decide", async () => {
    bridgeMock.listWorkspaceVersionConflicts
      .mockResolvedValueOnce({ conflicts: [row("c-1", "sync", "draft"), row("c-2", "merge", "other")], nextAfterConflictId: "c-2" })
      .mockResolvedValueOnce({ conflicts: [row("c-3", "merge", "draft")], nextAfterConflictId: "c-3" });
    await expect(mergeFilesWait("ws-1", "draft")).resolves.toBe(true);
    expect(bridgeMock.listWorkspaceVersionConflicts.mock.calls).toEqual([
      [{ workspaceId: "ws-1" }],
      [{ workspaceId: "ws-1", afterConflictId: "c-2" }],
    ]);
  });

  it("answers false once the last page holds none of them", async () => {
    bridgeMock.listWorkspaceVersionConflicts
      .mockResolvedValueOnce({ conflicts: [row("c-1", "sync", "draft")], nextAfterConflictId: "c-1" })
      .mockResolvedValueOnce({ conflicts: [], nextAfterConflictId: null });
    await expect(mergeFilesWait("ws-1", "draft")).resolves.toBe(false);
  });
});
