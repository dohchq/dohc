// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionsPage, orderVersions } from "./VersionsPage";
import { useWorkspaceVersions } from "./WorkspaceVersions";

const bridgeMock = {
  listWorkspaceVersions: vi.fn(),
  listVersionLastChanges: vi.fn(),
  countWorkspaceVersionChanges: vi.fn(),
  listWorkspaceVersionConflicts: vi.fn(),
  switchWorkspaceVersion: vi.fn(),
  createWorkspaceVersion: vi.fn(),
};

const NOW = Date.UTC(2026, 10, 4, 12);
const HOUR = 3_600_000;
const MAIN = { id: "main", name: "Main", kind: "main" as const, createdAtMs: NOW - 90 * HOUR, canMergeIntoMain: false };
const DRAFT = { id: "draft", name: "Draft", kind: "named" as const, createdAtMs: NOW - 10 * HOUR, canMergeIntoMain: true, madeFromVersionId: "main" };
const NESTED = { id: "nested", name: "Draft two", kind: "named" as const, createdAtMs: NOW - 2 * HOUR, canMergeIntoMain: false, madeFromVersionId: "draft" };
const FRESH = { id: "fresh", name: "Fresh", kind: "named" as const, createdAtMs: NOW - 5 * HOUR, canMergeIntoMain: true, madeFromVersionId: "main" };

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT, NESTED, FRESH], activeVersionId: "draft" });
  bridgeMock.listVersionLastChanges.mockResolvedValue({
    versions: [
      { versionId: "main", lastChange: { atMs: NOW - 3 * HOUR } },
      { versionId: "draft", lastChange: { atMs: NOW - HOUR, personName: "Ice" } },
      { versionId: "nested", lastChange: { atMs: NOW - 4 * HOUR } },
      { versionId: "fresh", lastChange: null },
    ],
  });
  bridgeMock.countWorkspaceVersionChanges.mockImplementation(async ({ versionId }: { versionId: string }) =>
    ({ count: versionId === "draft" ? 3 : versionId === "nested" ? 1 : 0 }));
  bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({ conflicts: [], nextAfterConflictId: null });
  bridgeMock.switchWorkspaceVersion.mockResolvedValue({ activeVersionId: "main", changedFileCount: 1 });
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function Page(props: {
  historyKey?: string;
  dirty?: boolean;
  onOpenCompare?: (versionId: string) => void;
  onReviewConflicts?: () => void;
  onError?: () => void;
}) {
  const versions = useWorkspaceVersions({
    workspaceId: "ws-1",
    enabled: true,
    activeTabDirty: props.dirty ?? false,
    beginLineageOperation: async () => () => {},
    onWorkspaceStateChanged: () => {},
    onError: () => {},
    clearError: () => {},
    onMergeNotice: () => {},
    onConflictError: () => {},
  });
  return (
    <>
      <VersionsPage
        workspaceId="ws-1"
        versions={versions}
        historyKey={props.historyKey ?? "0"}
        versionKey={0}
        onOpenCompare={props.onOpenCompare ?? (() => {})}
        onReviewConflicts={props.onReviewConflicts ?? (() => {})}
        onError={props.onError ?? (() => {})}
      />
      {versions.dialogs}
    </>
  );
}

function row(versionId: string): HTMLElement {
  const found = screen.getAllByTestId("versions-page-row").find((element) => element.dataset.versionId === versionId);
  if (!found) throw new Error(`no row for ${versionId}`);
  return found;
}

const details = (versionId: string) => within(row(versionId)).getByTestId("versions-page-details").textContent;

describe("VersionsPage", () => {
  it("lists Main first, then by last change, with a version that has none sorted by when it was made", async () => {
    render(<Page />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    expect(screen.getAllByTestId("versions-page-name").map((name) => name.textContent)).toEqual(["Main", "Draft", "Draft two", "Fresh"]);
    expect(row("draft").getAttribute("aria-current")).toBe("true");
    expect(row("main").getAttribute("aria-current")).toBeNull();
  });

  it("says where each version came from, how it differs from Main, and when it last changed", async () => {
    render(<Page />);
    // Fresh is counted last.
    await waitFor(() => expect(within(row("fresh")).queryByTestId("versions-page-count")).not.toBeNull());
    expect(details("main")).toBe("Changed 3h ago");
    expect(details("draft")).toBe("Made from Main · 3 files differ from Main · Changed 1h ago by Ice");
    expect(details("nested")).toBe("Made from Draft · 1 file differs from Main · Changed 4h ago");
    expect(details("fresh")).toBe("Made from Main 5h ago · Same as Main");
    // One at a time, in the order the rows show.
    expect(bridgeMock.countWorkspaceVersionChanges.mock.calls.map(([payload]) => payload.versionId)).toEqual(["draft", "nested", "fresh"]);
  });

  it("offers each action only where it applies", async () => {
    render(<Page />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    const actions = (versionId: string) => within(row(versionId)).queryAllByRole("button").map((button) => button.textContent);
    expect(actions("main")).toEqual(["Switch"]);
    expect(actions("draft")).toEqual(["Compare", "Merge into Main"]);
    expect(actions("nested")).toEqual(["Switch", "Compare"]);
    expect(actions("fresh")).toEqual(["Switch", "Compare", "Merge into Main"]);
  });

  it("switches and opens compare from a row", async () => {
    const onOpenCompare = vi.fn();
    const user = userEvent.setup();
    render(<Page onOpenCompare={onOpenCompare} />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    await user.click(within(row("nested")).getByTestId("versions-page-compare"));
    expect(onOpenCompare).toHaveBeenCalledExactlyOnceWith("nested");
    await user.click(within(row("main")).getByTestId("versions-page-switch"));
    await waitFor(() => expect(bridgeMock.switchWorkspaceVersion).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1", versionId: "main" }));
  });

  it("puts focus on the row once its Switch lands", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT, NESTED, FRESH], activeVersionId: "main" });
    await user.click(within(row("main")).getByTestId("versions-page-switch"));
    await waitFor(() => expect(row("main").getAttribute("aria-current")).toBe("true"));
    // The Switch it was on is gone.
    await waitFor(() => expect(document.activeElement).toBe(row("main")));
  });

  it("asks to save first when the open file has changes, then switches from the row", async () => {
    const user = userEvent.setup();
    render(<Page dirty />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    await user.click(within(row("main")).getByTestId("versions-page-switch"));
    expect(bridgeMock.switchWorkspaceVersion).not.toHaveBeenCalled();
    await user.click(await screen.findByTestId("version-switch-save-continue"));
    await waitFor(() => expect(bridgeMock.switchWorkspaceVersion).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1", versionId: "main" }));
  });

  it("creates nothing on Enter while a switch runs, and the switch still finishes", async () => {
    const switching = deferred<{ activeVersionId: string; changedFileCount: number }>();
    bridgeMock.switchWorkspaceVersion.mockReturnValue(switching.promise);
    const user = userEvent.setup();
    render(<Page />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    await user.click(screen.getByTestId("versions-page-new"));
    await user.keyboard("Idea");
    await user.click(within(row("main")).getByTestId("versions-page-switch"));
    await waitFor(() => expect(bridgeMock.switchWorkspaceVersion).toHaveBeenCalledOnce());
    await user.click(screen.getByTestId("versions-page-new-input"));
    await user.keyboard("{Enter}");
    expect(bridgeMock.createWorkspaceVersion).not.toHaveBeenCalled();
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT, NESTED, FRESH], activeVersionId: "main" });
    switching.resolve({ activeVersionId: "main", changedFileCount: 1 });
    await waitFor(() => expect(row("main").getAttribute("aria-current")).toBe("true"));
    await waitFor(() => expect(within(row("draft")).getByTestId("versions-page-switch").getAttribute("aria-disabled")).toBeNull());
  });

  it("counts again only the version you're in when its history grows", async () => {
    const { rerender } = render(<Page historyKey="0" />);
    await waitFor(() => expect(within(row("fresh")).queryByTestId("versions-page-count")).not.toBeNull());
    bridgeMock.countWorkspaceVersionChanges.mockClear();
    bridgeMock.countWorkspaceVersionChanges.mockResolvedValue({ count: 9 });
    rerender(<Page historyKey="1" />);
    await waitFor(() => expect(details("draft")).toContain("9 files differ from Main"));
    expect(bridgeMock.countWorkspaceVersionChanges.mock.calls.map(([payload]) => payload.versionId)).toEqual(["draft"]);
  });

  it("counts every version again when Main's history grows, and only its own on Try again", async () => {
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT, NESTED, FRESH], activeVersionId: "main" });
    bridgeMock.countWorkspaceVersionChanges.mockImplementation(async ({ versionId }: { versionId: string }) => {
      if (versionId === "nested") throw new Error("count failed");
      return { count: 2 };
    });
    const user = userEvent.setup();
    const { rerender } = render(<Page historyKey="0" />);
    const retry = await waitFor(() => within(row("nested")).getByTestId("versions-page-count-retry"));
    await waitFor(() => expect(within(row("fresh")).queryByTestId("versions-page-count")).not.toBeNull());
    bridgeMock.countWorkspaceVersionChanges.mockClear();
    bridgeMock.countWorkspaceVersionChanges.mockResolvedValue({ count: 5 });
    await user.click(retry);
    await waitFor(() => expect(details("nested")).toContain("5 files differ from Main"));
    expect(bridgeMock.countWorkspaceVersionChanges.mock.calls.map(([payload]) => payload.versionId)).toEqual(["nested"]);
    bridgeMock.countWorkspaceVersionChanges.mockClear();
    rerender(<Page historyKey="1" />);
    await waitFor(() => expect(bridgeMock.countWorkspaceVersionChanges).toHaveBeenCalledTimes(3));
  });

  it("counts one version at a time while history grows, and counts a changed one again after the rest", async () => {
    const first = deferred<{ count: number }>();
    bridgeMock.countWorkspaceVersionChanges.mockImplementationOnce(() => first.promise);
    const { rerender } = render(<Page historyKey="0" />);
    await waitFor(() => expect(bridgeMock.countWorkspaceVersionChanges).toHaveBeenCalledOnce());
    rerender(<Page historyKey="1" />);
    rerender(<Page historyKey="2" />);
    expect(bridgeMock.countWorkspaceVersionChanges).toHaveBeenCalledOnce();
    bridgeMock.countWorkspaceVersionChanges.mockImplementation(async ({ versionId }: { versionId: string }) =>
      ({ count: versionId === "draft" ? 7 : 0 }));
    first.resolve({ count: 3 });
    await waitFor(() => expect(details("draft")).toContain("7 files differ from Main"));
    expect(bridgeMock.countWorkspaceVersionChanges.mock.calls.map(([payload]) => payload.versionId)).toEqual(["draft", "nested", "fresh", "draft"]);
  });

  it("reaches every row while Main's history keeps growing during the counts", async () => {
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT, NESTED, FRESH], activeVersionId: "main" });
    const nested = deferred<{ count: number }>();
    const nestedAgain = deferred<{ count: number }>();
    let nestedCounts = 0;
    bridgeMock.countWorkspaceVersionChanges.mockImplementation(async ({ versionId }: { versionId: string }) => {
      if (versionId !== "nested") return { count: 0 };
      nestedCounts += 1;
      return nestedCounts === 1 ? nested.promise : nestedAgain.promise;
    });
    const { rerender } = render(<Page historyKey="0" />);
    await waitFor(() => expect(bridgeMock.countWorkspaceVersionChanges).toHaveBeenCalledTimes(2));
    // History grows while Draft two counts, as a count's own capture can make it.
    rerender(<Page historyKey="1" />);
    nested.resolve({ count: 4 });
    await waitFor(() => expect(bridgeMock.countWorkspaceVersionChanges).toHaveBeenCalledTimes(5));
    // Fresh gets its turn before the rows marked again start over.
    expect(bridgeMock.countWorkspaceVersionChanges.mock.calls.map(([payload]) => payload.versionId))
      .toEqual(["draft", "nested", "fresh", "draft", "nested"]);
    // The count marked again still shows while its next count waits.
    await waitFor(() => expect(details("nested")).toContain("4 files differ from Main"));
    nestedAgain.resolve({ count: 6 });
    await waitFor(() => expect(details("nested")).toContain("6 files differ from Main"));
  });

  it("shows Try again in place of a count that failed, and counts that version again", async () => {
    bridgeMock.countWorkspaceVersionChanges.mockImplementation(async ({ versionId }: { versionId: string }) => {
      if (versionId === "nested") throw new Error("count failed");
      return { count: 2 };
    });
    const user = userEvent.setup();
    render(<Page />);
    const retry = await waitFor(() => within(row("nested")).getByTestId("versions-page-count-retry"));
    expect(retry.getAttribute("aria-label")).toBe("dohc could not count the differences. Try again.");
    expect(details("draft")).toContain("2 files differ from Main");
    bridgeMock.countWorkspaceVersionChanges.mockResolvedValue({ count: 5 });
    await user.click(retry);
    // Try again is gone, so its row keeps the focus.
    expect(document.activeElement).toBe(row("nested"));
    await waitFor(() => expect(details("nested")).toContain("5 files differ from Main"));
    expect(bridgeMock.countWorkspaceVersionChanges).toHaveBeenLastCalledWith({ workspaceId: "ws-1", versionId: "nested" });
  });

  it("counts the files each merge left to decide, and opens the review", async () => {
    const conflict = (conflictId: string, sourceVersionId: string, origin: "merge" | "sync" = "merge") => ({
      conflictId, path: `${conflictId}.md`, sourceVersionId, targetVersionId: "main", origin, contentKind: "text",
      currentText: "a", incomingText: "b", baseText: null,
    });
    bridgeMock.listWorkspaceVersionConflicts
      .mockResolvedValueOnce({ conflicts: [conflict("c1", "draft"), conflict("c2", "draft")], nextAfterConflictId: "c2" })
      .mockResolvedValueOnce({ conflicts: [conflict("c3", "fresh"), conflict("c4", "draft", "sync")], nextAfterConflictId: null });
    const onReviewConflicts = vi.fn();
    const user = userEvent.setup();
    render(<Page onReviewConflicts={onReviewConflicts} />);
    const button = await waitFor(() => within(row("draft")).getByTestId("versions-page-conflicts"));
    expect(button.textContent).toBe("2 to decide");
    expect(within(row("draft")).getByRole("button", { name: "2 to decide", description: "Open the conflicts" })).toBe(button);
    expect(within(row("fresh")).getByTestId("versions-page-conflicts").textContent).toBe("1 to decide");
    expect(bridgeMock.listWorkspaceVersionConflicts).toHaveBeenLastCalledWith({ workspaceId: "ws-1", afterConflictId: "c2" });
    await user.click(button);
    expect(onReviewConflicts).toHaveBeenCalledOnce();
  });

  it("shows the rows sorted by when each was made when the last changes can't be read, and says so once", async () => {
    bridgeMock.listVersionLastChanges.mockRejectedValue(new Error("history failed"));
    const onError = vi.fn();
    const { rerender } = render(<Page onError={onError} />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    expect(screen.getAllByTestId("versions-page-name").map((name) => name.textContent)).toEqual(["Main", "Draft two", "Fresh", "Draft"]);
    expect(onError).toHaveBeenCalledExactlyOnceWith("dohc could not read when each version last changed.", expect.anything());
    // Not known, so no made time that would say it has no change of its own.
    await waitFor(() => expect(details("fresh")).toBe("Made from Main · Same as Main"));
    const again = Promise.reject(new Error("history failed"));
    again.catch(() => undefined);
    bridgeMock.listVersionLastChanges.mockReturnValueOnce(again);
    rerender(<Page onError={onError} historyKey="1" />);
    await act(async () => { await again.catch(() => undefined); });
    expect(bridgeMock.listVersionLastChanges).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("shows an empty state that names what stays the same when only Main exists", async () => {
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN], activeVersionId: "main" });
    render(<Page />);
    const empty = await waitFor(() => screen.getByTestId("versions-page-empty"));
    expect(empty.textContent).toContain("Make a version to try changes without touching Main.");
    expect(screen.getByTestId("versions-page-same").textContent)
      .toBe("Chats, text files over 10\u00a0MB, other files over 5\u00a0MB and files History doesn't track stay the same in every version.");
    // One New version, the empty state's. The header's shows once a version exists.
    expect(screen.getAllByTestId("versions-page-new")).toHaveLength(1);
    expect(within(empty).getByTestId("versions-page-new")).toBeTruthy();
  });

  it("opens the name field in the header, and Escape or leaving it empty puts the button back", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    await user.click(screen.getByTestId("versions-page-new"));
    const input = screen.getByTestId("versions-page-new-input");
    expect(document.activeElement).toBe(input);
    // You're in Draft, so the new version starts there.
    expect(screen.getByText(/so it can't merge into Main/).textContent).toBe("Starts from Draft, so it can't merge into Main.");
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByTestId("versions-page-new"));
    await user.click(screen.getByTestId("versions-page-new"));
    await user.tab();
    expect(screen.queryByTestId("versions-page-new-input")).toBeNull();
    await user.click(screen.getByTestId("versions-page-new"));
    await user.keyboard("Idea");
    await user.tab();
    expect((screen.getByTestId("versions-page-new-input") as HTMLInputElement).value).toBe("Idea");
  });

  it("creates the version on Enter, and keeps a refused name in the field with why", async () => {
    bridgeMock.createWorkspaceVersion.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'desktop:create-workspace-version': VersionedTextStoreError [version-name-conflict]: version-name-conflict",
    ));
    const user = userEvent.setup();
    render(<Page />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    await user.click(screen.getByTestId("versions-page-new"));
    await user.keyboard("Draft{Enter}");
    const error = await waitFor(() => screen.getByTestId("versions-page-new-error"));
    expect(error.textContent).toBe("Another version is called Draft. Choose another name.");
    bridgeMock.createWorkspaceVersion.mockResolvedValueOnce({ versions: [MAIN, DRAFT, NESTED, FRESH, { ...FRESH, id: "idea", name: "Idea" }], activeVersionId: "idea" });
    await user.clear(screen.getByTestId("versions-page-new-input"));
    await user.keyboard("Idea{Enter}");
    await waitFor(() => expect(screen.queryByTestId("versions-page-new-input")).toBeNull());
    expect(bridgeMock.createWorkspaceVersion).toHaveBeenLastCalledWith({ workspaceId: "ws-1", name: "Idea" });
    expect(document.activeElement).toBe(screen.getByTestId("versions-page-new"));
  });

  it("offers Try again when the versions can't load", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
    bridgeMock.listWorkspaceVersions.mockRejectedValue(new Error("list failed"));
    render(<Page />);
    for (let attempt = 0; attempt < 5; attempt += 1) await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    const retry = await waitFor(() => screen.getByTestId("versions-page-retry"));
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT], activeVersionId: "main" });
    await userEvent.setup().click(within(retry).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(2));
  });
});

describe("orderVersions", () => {
  it("keeps Main first even when another version changed later", () => {
    expect(orderVersions([DRAFT, MAIN], new Map([["main", { atMs: 1 }], ["draft", { atMs: 2 }]])).map((version) => version.id))
      .toEqual(["main", "draft"]);
  });
});
