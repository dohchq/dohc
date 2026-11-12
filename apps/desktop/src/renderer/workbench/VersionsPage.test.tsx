// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withErrorWords } from "../../ipc/errorWords";
import { useShellError } from "../shell/useShellError";
import { READS_FAILED, VersionsPage, orderVersions } from "./VersionsPage";
import { useWorkspaceVersions } from "./WorkspaceVersions";

const bridgeMock = {
  listWorkspaceVersions: vi.fn(),
  listVersionLastChanges: vi.fn(),
  countWorkspaceVersionChanges: vi.fn(),
  countWorkspaceVersionConflicts: vi.fn(),
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
  bridgeMock.countWorkspaceVersionConflicts.mockResolvedValue({ versions: [], more: false });
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
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

type OnError = ComponentProps<typeof VersionsPage>["onError"];

function Page(props: {
  workspaceId?: string;
  historyKey?: string;
  versionKey?: number;
  // Reads the versions again, as a change from another computer would.
  refreshKey?: number;
  dirty?: boolean;
  onOpenCompare?: (versionId: string) => void;
  onReviewConflicts?: () => void;
  onError?: OnError;
  onSettled?: (identity: string) => void;
  // The versions list's own failure, which the shell shows as a toast.
  onVersionsError?: (message: string, cause: unknown) => void;
}) {
  const workspaceId = props.workspaceId ?? "ws-1";
  const versions = useWorkspaceVersions({
    workspaceId,
    enabled: true,
    ...(props.refreshKey === undefined ? {} : { refreshKey: props.refreshKey }),
    activeTabDirty: props.dirty ?? false,
    beginLineageOperation: async () => () => {},
    onWorkspaceStateChanged: () => {},
    onError: props.onVersionsError ?? (() => {}),
    clearError: () => {},
    onMergeNotice: () => {},
    onConflictError: () => {},
  });
  return (
    <>
      <VersionsPage
        workspaceId={workspaceId}
        versions={versions}
        historyKey={props.historyKey ?? "0"}
        versionKey={props.versionKey ?? 0}
        onOpenCompare={props.onOpenCompare ?? (() => {})}
        onReviewConflicts={props.onReviewConflicts ?? (() => {})}
        onError={props.onError ?? (() => {})}
        onSettled={props.onSettled ?? (() => {})}
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

// The Try again a failure filed with its row in Notices.
function filedRetry(onError: { mock: { calls: unknown[][] } }, call = 0): () => void {
  const retry = onError.mock.calls[call]?.[2];
  if (typeof retry !== "function") throw new Error("no Try again filed");
  return () => { retry(); };
}

// The identity a failure filed its row under.
const filedIdentity = (onError: { mock: { calls: unknown[][] } }, call = 0) => onError.mock.calls[call]?.[3];

// The page filing its rows in the shell's Notices, as the workspace shell wires it.
let shell: ReturnType<typeof useShellError> | null = null;
function ShellPage(props: { historyKey?: string; versionKey?: number }) {
  const notices = useShellError("ws-1");
  shell = notices;
  return <Page {...props} onError={notices.reportButtonError} onSettled={notices.clearIdentity} />;
}
// Each Notices row's words, and whether its toast shows.
const shownRows = () => shell!.shellErrors.map((error) => ({ message: error.message, toast: !error.seen }));
// A row's words when the last changes, the first read to fail, gave the error.
const historyFailed = (sentence: string) => withErrorWords(sentence, new Error("history failed"));

// Presses a Try again in the next render it shares with the page, once the
// page shows that render and before the page's effects for it run. A person's
// press can land there too.
let pressBeforeEffects: (press: () => void) => void = () => {};
function PressBeforeEffects() {
  const [press, setPress] = useState<{ run: () => void } | null>(null);
  pressBeforeEffects = (run) => setPress({ run });
  useLayoutEffect(() => { press?.run(); }, [press]);
  return null;
}

describe("VersionsPage", () => {
  it("lists Main first, then by last change, with a version that has none sorted by when it was made", async () => {
    render(<Page />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    expect(screen.getAllByTestId("versions-page-name").map((name) => name.textContent)).toEqual(["Main", "Draft", "Draft two", "Fresh"]);
    expect(row("draft").getAttribute("aria-current")).toBe("true");
    expect(row("main").getAttribute("aria-current")).toBeNull();
  });

  it("marks the current version with Current after its name, hidden from screen readers that hear aria-current", async () => {
    render(<Page />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    const current = within(row("draft")).getByTestId("versions-page-current");
    expect(current.textContent).toBe("Current");
    expect(current.getAttribute("aria-hidden")).toBe("true");
    expect(current.previousElementSibling).toBe(within(row("draft")).getByTestId("versions-page-name"));
    expect(screen.getAllByTestId("versions-page-current")).toHaveLength(1);
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

  it("turns off New version while a switch runs, and turns it back on when the switch finishes", async () => {
    const switching = deferred<{ activeVersionId: string; changedFileCount: number }>();
    bridgeMock.switchWorkspaceVersion.mockReturnValue(switching.promise);
    const user = userEvent.setup();
    render(<Page />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    await user.click(within(row("main")).getByTestId("versions-page-switch"));
    await waitFor(() => expect(bridgeMock.switchWorkspaceVersion).toHaveBeenCalledOnce());
    expect(screen.getByTestId<HTMLButtonElement>("versions-page-new").disabled).toBe(true);
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT, NESTED, FRESH], activeVersionId: "main" });
    switching.resolve({ activeVersionId: "main", changedFileCount: 1 });
    await waitFor(() => expect(row("main").getAttribute("aria-current")).toBe("true"));
    await waitFor(() => expect(screen.getByTestId<HTMLButtonElement>("versions-page-new").disabled).toBe(false));
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
    expect(retry.getAttribute("aria-label")).toBe("dohc could not count the files that differ from Main. Try again.");
    expect(details("draft")).toContain("2 files differ from Main");
    bridgeMock.countWorkspaceVersionChanges.mockResolvedValue({ count: 5 });
    await user.click(retry);
    // Try again is gone, so its row keeps the focus.
    expect(document.activeElement).toBe(row("nested"));
    await waitFor(() => expect(details("nested")).toContain("5 files differ from Main"));
    expect(bridgeMock.countWorkspaceVersionChanges).toHaveBeenLastCalledWith({ workspaceId: "ws-1", versionId: "nested" });
  });

  it("files one row for the counts that failed, whose Try again counts them all again", async () => {
    bridgeMock.countWorkspaceVersionChanges.mockImplementation(async ({ versionId }: { versionId: string }) => {
      if (versionId !== "draft") throw new Error("count failed");
      return { count: 2 };
    });
    const onError = vi.fn();
    const onSettled = vi.fn();
    render(<Page onError={onError} onSettled={onSettled} />);
    await waitFor(() => expect(within(row("fresh")).queryByTestId("versions-page-count-retry")).not.toBeNull());
    expect(within(row("nested")).getByTestId("versions-page-count-retry")).toBeTruthy();
    // The row is filed from an effect, which can run after the render.
    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(
      "dohc could not count the files that differ from Main.", expect.any(Error), expect.any(Function), expect.stringMatching(/^versions-reads:/), false, expect.any(Function)));
    bridgeMock.countWorkspaceVersionChanges.mockClear();
    bridgeMock.countWorkspaceVersionChanges.mockResolvedValue({ count: 4 });
    act(filedRetry(onError));
    await waitFor(() => expect(details("fresh")).toContain("4 files differ from Main"));
    expect(details("nested")).toContain("4 files differ from Main");
    expect(bridgeMock.countWorkspaceVersionChanges.mock.calls.map(([payload]) => payload.versionId).sort()).toEqual(["fresh", "nested"]);
    // Its Try again already took the row back.
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("takes back the counts' row once a row's own Try again leaves none failed, and files it again if that fails", async () => {
    bridgeMock.countWorkspaceVersionChanges.mockImplementation(async ({ versionId }: { versionId: string }) => {
      if (versionId === "nested") throw new Error("count failed");
      return { count: 2 };
    });
    const onError = vi.fn();
    const onSettled = vi.fn();
    const user = userEvent.setup();
    render(<Page onError={onError} onSettled={onSettled} />);
    await user.click(await waitFor(() => within(row("nested")).getByTestId("versions-page-count-retry")));
    await waitFor(() => expect(onSettled).toHaveBeenCalledExactlyOnceWith(filedIdentity(onError)));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(filedIdentity(onError, 1)).toBe(filedIdentity(onError));
  });

  it("takes back the counts' row once a later count works", async () => {
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT, NESTED, FRESH], activeVersionId: "main" });
    bridgeMock.countWorkspaceVersionChanges.mockImplementation(async ({ versionId }: { versionId: string }) => {
      if (versionId === "nested") throw new Error("count failed");
      return { count: 2 };
    });
    const onError = vi.fn();
    const onSettled = vi.fn();
    const { rerender } = render(<Page onError={onError} onSettled={onSettled} />);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    bridgeMock.countWorkspaceVersionChanges.mockResolvedValue({ count: 7 });
    // Main's history grew, so every version counts again.
    rerender(<Page onError={onError} onSettled={onSettled} historyKey="1" />);
    await waitFor(() => expect(details("nested")).toContain("7 files differ from Main"));
    await waitFor(() => expect(onSettled).toHaveBeenCalledExactlyOnceWith(filedIdentity(onError)));
  });

  it("files nothing for a count that fails after its version has gone", async () => {
    const nestedCount = deferred<{ count: number }>();
    bridgeMock.countWorkspaceVersionChanges.mockImplementation(({ versionId }: { versionId: string }) =>
      versionId === "nested" ? nestedCount.promise : Promise.resolve({ count: 2 }));
    const onError = vi.fn();
    const { rerender } = render(<Page onError={onError} />);
    await waitFor(() => expect(bridgeMock.countWorkspaceVersionChanges).toHaveBeenCalledWith({ workspaceId: "ws-1", versionId: "nested" }));
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT, FRESH], activeVersionId: "draft" });
    rerender(<Page onError={onError} refreshKey={1} />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(3));
    await act(async () => {
      nestedCount.reject(new Error("count failed"));
      await nestedCount.promise.catch(() => undefined);
    });
    await waitFor(() => expect(details("fresh")).toContain("2 files differ from Main"));
    expect(onError).not.toHaveBeenCalled();
  });

  it("counts the files each merge left to decide, and opens the review", async () => {
    bridgeMock.countWorkspaceVersionConflicts.mockResolvedValueOnce({
      versions: [{ versionId: "draft", count: 2 }, { versionId: "fresh", count: 1 }], more: false,
    });
    const onReviewConflicts = vi.fn();
    const user = userEvent.setup();
    render(<Page onReviewConflicts={onReviewConflicts} />);
    await waitFor(() => expect(within(row("draft")).getByTestId("versions-page-conflicts").textContent).toBe("2 to decide"));
    expect(within(row("fresh")).getByTestId("versions-page-conflicts").textContent).toBe("1 to decide");
    expect(bridgeMock.countWorkspaceVersionConflicts).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1" });
    // The count leads the details line, before where the version came from.
    expect(within(row("draft")).getByTestId("versions-page-details").firstElementChild)
      .toBe(within(row("draft")).getByTestId("versions-page-conflicts"));
    expect(details("draft")).toMatch(/^2 to decide · Made from Main · /);
    // Deciding takes Merge into Main's place.
    const actions = (versionId: string) => within(row(versionId)).queryAllByRole("button").map((button) => button.textContent);
    expect(actions("draft")).toEqual(["Compare", "Decide what to keep"]);
    expect(actions("fresh")).toEqual(["Switch", "Compare", "Decide what to keep"]);
    expect(within(row("draft")).getByRole("button", { name: "Decide what to keep", description: "Draft" }))
      .toBe(within(row("draft")).getByTestId("versions-page-decide"));
    await user.click(within(row("draft")).getByTestId("versions-page-decide"));
    expect(onReviewConflicts).toHaveBeenCalledOnce();
  });

  it("says when there are more files to decide than it read", async () => {
    bridgeMock.countWorkspaceVersionConflicts.mockResolvedValueOnce({ versions: [{ versionId: "draft", count: 5 }], more: true });
    render(<Page />);
    await waitFor(() => expect(within(row("draft")).getByTestId("versions-page-conflicts").textContent).toBe("5+ to decide"));
  });

  it("offers Merge into Main again once nothing is left to decide", async () => {
    bridgeMock.countWorkspaceVersionConflicts.mockResolvedValueOnce(DRAFT_CONFLICT);
    const { rerender } = render(<Page />);
    await waitFor(() => expect(within(row("draft")).queryByTestId("versions-page-decide")).not.toBeNull());
    expect(within(row("draft")).queryByTestId("versions-page-merge")).toBeNull();
    bridgeMock.countWorkspaceVersionConflicts.mockResolvedValueOnce({ versions: [], more: false });
    rerender(<Page versionKey={1} />);
    await waitFor(() => expect(within(row("draft")).queryByTestId("versions-page-decide")).toBeNull());
    expect(within(row("draft")).getByTestId("versions-page-merge").textContent).toBe("Merge into Main");
    expect(within(row("draft")).queryByTestId("versions-page-conflicts")).toBeNull();
  });

  it("files a failed read of the files to decide with a Try again that reads them again", async () => {
    bridgeMock.countWorkspaceVersionConflicts.mockRejectedValueOnce(new Error("conflicts failed"));
    const onError = vi.fn();
    render(<Page onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(
      "dohc could not read which merges have files to decide.", expect.any(Error), expect.any(Function), expect.stringMatching(/^versions-reads:/), false, expect.any(Function));
    bridgeMock.countWorkspaceVersionConflicts.mockResolvedValueOnce({ versions: [{ versionId: "draft", count: 1 }], more: false });
    act(filedRetry(onError));
    await waitFor(() => expect(within(row("draft")).getByTestId("versions-page-conflicts").textContent).toBe("1 to decide"));
  });

  it("takes back the files to decide's row once a later read works", async () => {
    bridgeMock.countWorkspaceVersionConflicts.mockRejectedValueOnce(new Error("conflicts failed"));
    const onError = vi.fn();
    const onSettled = vi.fn();
    const { rerender } = render(<Page onError={onError} onSettled={onSettled} />);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onSettled).not.toHaveBeenCalled();
    rerender(<Page onError={onError} onSettled={onSettled} versionKey={1} />);
    await waitFor(() => expect(onSettled).toHaveBeenCalledExactlyOnceWith(filedIdentity(onError)));
  });

  const DRAFT_CONFLICT = { versions: [{ versionId: "draft", count: 1 }], more: false };

  it("gives up on the files to decide after 30 seconds with no answer, and drops the answer that comes later", async () => {
    const late = deferred<typeof DRAFT_CONFLICT>();
    bridgeMock.countWorkspaceVersionConflicts.mockReturnValueOnce(late.promise);
    const onError = vi.fn();
    const onSettled = vi.fn();
    // Only the page's timers are fake. Testing Library's async helpers need
    // real ones, so this test uses act alone.
    vi.useRealTimers();
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
    render(<Page onError={onError} onSettled={onSettled} />);
    // The page lists the versions, then reads. No time passes.
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(bridgeMock.countWorkspaceVersionConflicts).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(29_999));
    expect(onError).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    const sentence = "dohc could not read which merges have files to decide.";
    expect(onError).toHaveBeenCalledExactlyOnceWith(sentence, expect.any(Error), expect.any(Function), expect.stringMatching(/^versions-reads:/), false, expect.any(Function));
    expect(withErrorWords(sentence, onError.mock.calls[0]![1])).toBe(`${sentence} dohc did not answer in time. Try again.`);
    // The answer that comes after the deadline shows nothing, and the row stays.
    await act(async () => late.resolve(DRAFT_CONFLICT));
    expect(within(row("draft")).queryByTestId("versions-page-conflicts")).toBeNull();
    expect(onSettled).not.toHaveBeenCalled();
    bridgeMock.countWorkspaceVersionConflicts.mockResolvedValueOnce(DRAFT_CONFLICT);
    act(filedRetry(onError));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(within(row("draft")).getByTestId("versions-page-conflicts").textContent).toBe("1 to decide");
  });

  // Only the page's timers are fake, as above, so these tests use act alone.
  const fakePageTimers = () => {
    vi.useRealTimers();
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
  };
  const DEADLINE_WORDS = "dohc did not answer in time. Try again.";

  it("gives up on when each version last changed after 30 seconds, drops the answer that comes later, and reads again on Try again", async () => {
    const late = deferred<{ versions: unknown[] }>();
    bridgeMock.listVersionLastChanges.mockReturnValueOnce(late.promise);
    const onError = vi.fn<OnError>();
    fakePageTimers();
    render(<Page onError={onError} />);
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(bridgeMock.listVersionLastChanges).toHaveBeenCalledOnce();
    // The rows wait for this read.
    expect(screen.queryAllByTestId("versions-page-row")).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(29_999));
    expect(onError).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    const sentence = "dohc could not read when each version last changed.";
    expect(onError).toHaveBeenCalledExactlyOnceWith(sentence, expect.any(Error), expect.any(Function), expect.stringMatching(/^versions-reads:/), false, expect.any(Function));
    expect(withErrorWords(sentence, onError.mock.calls[0]![1])).toBe(`${sentence} ${DEADLINE_WORDS}`);
    // The rows show, sorted by when each was made, and the later answer changes nothing.
    expect(screen.getAllByTestId("versions-page-name").map((name) => name.textContent)).toEqual(["Main", "Draft two", "Fresh", "Draft"]);
    await act(async () => late.resolve({ versions: [{ versionId: "draft", lastChange: { atMs: NOW - HOUR, personName: "Ana" } }] }));
    expect(details("draft")).not.toContain("Changed");
    act(filedRetry(onError));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(bridgeMock.listVersionLastChanges).toHaveBeenCalledTimes(2);
    expect(details("draft")).toContain("Changed 1h ago by Ice");
  });

  it("gives up on a count after 30 seconds and counts the next version, drops the answer that comes later, and counts again on Try again", async () => {
    const late = deferred<{ count: number }>();
    bridgeMock.countWorkspaceVersionChanges.mockReturnValueOnce(late.promise);
    const onError = vi.fn<OnError>();
    fakePageTimers();
    render(<Page onError={onError} />);
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(bridgeMock.countWorkspaceVersionChanges).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1", versionId: "draft" });
    await act(() => vi.advanceTimersByTimeAsync(29_999));
    // One at a time: the next count waits its turn.
    expect(bridgeMock.countWorkspaceVersionChanges).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    const sentence = "dohc could not count the files that differ from Main.";
    expect(onError).toHaveBeenCalledExactlyOnceWith(sentence, expect.any(Error), expect.any(Function), expect.stringMatching(/^versions-reads:/), false, expect.any(Function));
    expect(withErrorWords(sentence, onError.mock.calls[0]![1])).toBe(`${sentence} ${DEADLINE_WORDS}`);
    expect(within(row("draft")).getByTestId("versions-page-count-retry")).toBeTruthy();
    expect(details("nested")).toContain("1 file differs from Main");
    await act(async () => late.resolve({ count: 9 }));
    expect(details("draft")).not.toContain("9 files");
    expect(within(row("draft")).getByTestId("versions-page-count-retry")).toBeTruthy();
    act(filedRetry(onError));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(details("draft")).toContain("3 files differ from Main");
  });

  it("gives up on the versions after 30 seconds a try, drops the answer that comes later, and lists them on Try again", async () => {
    const late = deferred<{ versions: unknown[]; activeVersionId: string }>();
    bridgeMock.listWorkspaceVersions.mockImplementation(() => new Promise(() => {}));
    bridgeMock.listWorkspaceVersions.mockReturnValueOnce(late.promise);
    const onVersionsError = vi.fn();
    fakePageTimers();
    render(<Page onVersionsError={onVersionsError} />);
    await act(async () => {});
    // Five tries, each 30 seconds, a second apart.
    await act(() => vi.advanceTimersByTimeAsync(5 * 30_000 + 4 * 1_000 - 1));
    expect(bridgeMock.listWorkspaceVersions).toHaveBeenCalledTimes(5);
    expect(screen.queryByTestId("versions-page-retry")).toBeNull();
    expect(onVersionsError).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    const retry = screen.getByTestId("versions-page-retry");
    expect(onVersionsError).toHaveBeenCalledOnce();
    expect(onVersionsError.mock.calls[0]![1]).toMatchObject({ name: "EngineRequestDeadlineError" });
    await act(async () => late.resolve({ versions: [MAIN, DRAFT], activeVersionId: "main" }));
    expect(screen.queryAllByTestId("versions-page-row")).toHaveLength(0);
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN, DRAFT], activeVersionId: "main" });
    act(() => within(retry).getByRole("button", { name: "Try again" }).click());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getAllByTestId("versions-page-row")).toHaveLength(2);
  });

  it("drops a read that gives up after the page shows another workspace", async () => {
    const stale = deferred<{ versions: unknown[] }>();
    bridgeMock.listVersionLastChanges.mockReturnValueOnce(stale.promise);
    const onError = vi.fn<OnError>();
    fakePageTimers();
    const { rerender } = render(<Page workspaceId="ws-1" onError={onError} />);
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(bridgeMock.listVersionLastChanges).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1" });
    rerender(<Page workspaceId="ws-2" onError={onError} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(bridgeMock.listVersionLastChanges).toHaveBeenLastCalledWith({ workspaceId: "ws-2" });
    expect(details("draft")).toContain("Changed 1h ago by Ice");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(onError).not.toHaveBeenCalled();
    expect(details("draft")).toContain("Changed 1h ago by Ice");
  });

  it("drops an answer about the workspace the page showed before", async () => {
    const stale = deferred<typeof DRAFT_CONFLICT>();
    bridgeMock.countWorkspaceVersionConflicts.mockReturnValueOnce(stale.promise);
    const onError = vi.fn();
    const { rerender } = render(<Page workspaceId="ws-1" onError={onError} />);
    await waitFor(() => expect(bridgeMock.countWorkspaceVersionConflicts).toHaveBeenCalledWith({ workspaceId: "ws-1" }));
    rerender(<Page workspaceId="ws-2" onError={onError} />);
    await waitFor(() => expect(bridgeMock.countWorkspaceVersionConflicts).toHaveBeenLastCalledWith({ workspaceId: "ws-2" }));
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    await act(async () => stale.resolve(DRAFT_CONFLICT));
    expect(within(row("draft")).queryByTestId("versions-page-conflicts")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("shows the rows sorted by when each was made when the last changes can't be read, and says so once", async () => {
    bridgeMock.listVersionLastChanges.mockRejectedValue(new Error("history failed"));
    const onError = vi.fn();
    const { rerender } = render(<Page onError={onError} />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    expect(screen.getAllByTestId("versions-page-name").map((name) => name.textContent)).toEqual(["Main", "Draft two", "Fresh", "Draft"]);
    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(
      "dohc could not read when each version last changed.", expect.any(Error), expect.any(Function), expect.stringMatching(/^versions-reads:/), false, expect.any(Function)));
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

  it("files the last changes again when their Try again fails, and a read that works takes the row back", async () => {
    bridgeMock.listVersionLastChanges
      .mockRejectedValueOnce(new Error("history failed"))
      .mockRejectedValueOnce(new Error("history failed"));
    const onError = vi.fn();
    const onSettled = vi.fn();
    const { rerender } = render(<Page onError={onError} onSettled={onSettled} />);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    act(filedRetry(onError));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(filedIdentity(onError, 1)).toBe(filedIdentity(onError));
    expect(onSettled).not.toHaveBeenCalled();
    rerender(<Page onError={onError} onSettled={onSettled} historyKey="1" />);
    await waitFor(() => expect(details("draft")).toContain("Changed 1h ago by Ice"));
    await waitFor(() => expect(onSettled).toHaveBeenCalledExactlyOnceWith(filedIdentity(onError)));
  });

  it("files one row and one toast in the combined words when the engine is down as the page opens, and its Try again reads each read again", async () => {
    const cause = "EngineDaemonUnavailableError: Rust engine daemon exited.";
    bridgeMock.listVersionLastChanges.mockRejectedValueOnce(new Error(cause));
    bridgeMock.countWorkspaceVersionConflicts.mockRejectedValueOnce(new Error(cause));
    bridgeMock.countWorkspaceVersionChanges.mockRejectedValue(new Error(cause));
    const onError = vi.fn<OnError>();
    const onSettled = vi.fn();
    render(<Page onError={onError} onSettled={onSettled} />);
    await waitFor(() => expect(within(row("fresh")).queryByTestId("versions-page-count-retry")).not.toBeNull());
    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(
      READS_FAILED, expect.any(Error), expect.any(Function), expect.stringMatching(/^versions-reads:/), false, expect.any(Function)));
    const [sentence, error] = onError.mock.lastCall!;
    expect(withErrorWords(sentence, error)).toBe("dohc could not finish loading Versions. Try again in a moment.");
    expect(onSettled).not.toHaveBeenCalled();
    bridgeMock.countWorkspaceVersionChanges.mockResolvedValue({ count: 2 });
    act(filedRetry(onError));
    await waitFor(() => expect(details("draft")).toBe("Made from Main · 2 files differ from Main · Changed 1h ago by Ice"));
    await waitFor(() => expect(details("fresh")).toContain("2 files differ from Main"));
    expect(bridgeMock.listVersionLastChanges).toHaveBeenCalledTimes(2);
    expect(bridgeMock.countWorkspaceVersionConflicts).toHaveBeenCalledTimes(2);
    // Its Try again already took the row back, and every read works now.
    expect(onError).toHaveBeenCalledOnce();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("files nothing more when Try again is pressed as other reads fail, and reads each of them again", async () => {
    const cause = "EngineDaemonUnavailableError: Rust engine daemon exited.";
    bridgeMock.listVersionLastChanges.mockRejectedValueOnce(new Error(cause)).mockRejectedValueOnce(new Error(cause));
    const onError = vi.fn<OnError>();
    const onSettled = vi.fn();
    const page = (versionKey: number) => <><Page onError={onError} onSettled={onSettled} versionKey={versionKey} /><PressBeforeEffects /></>;
    const { rerender } = render(page(0));
    await waitFor(() => expect(details("draft")).toContain("3 files differ from Main"));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    // Everything reads again. The last changes fail again at once, and the
    // files to decide and the first count wait.
    const conflicts = deferred<{ versions: never[]; more: false }>();
    bridgeMock.countWorkspaceVersionConflicts.mockReturnValueOnce(conflicts.promise);
    const count = deferred<{ count: number }>();
    bridgeMock.countWorkspaceVersionChanges.mockReturnValueOnce(count.promise);
    rerender(page(1));
    await waitFor(() => expect(bridgeMock.countWorkspaceVersionChanges).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(bridgeMock.listVersionLastChanges).toHaveBeenCalledTimes(2));
    // Both fail, and the last changes' Try again is pressed as the page shows it.
    await act(async () => {
      pressBeforeEffects(filedRetry(onError));
      conflicts.reject(new Error(cause));
      count.reject(new Error(cause));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(onSettled).not.toHaveBeenCalled();
    await waitFor(() => expect(bridgeMock.countWorkspaceVersionChanges).toHaveBeenCalledTimes(7));
    expect(bridgeMock.countWorkspaceVersionChanges).toHaveBeenLastCalledWith({ workspaceId: "ws-1", versionId: "nested" });
    await waitFor(() => expect(details("nested")).toContain("1 file differs from Main"));
    expect(bridgeMock.listVersionLastChanges).toHaveBeenCalledTimes(3);
    expect(bridgeMock.countWorkspaceVersionConflicts).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledOnce();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("waits for the reads that started together, so both failing file one toast in the combined words", async () => {
    const conflicts = deferred<{ versions: never[]; more: false }>();
    bridgeMock.listVersionLastChanges.mockRejectedValue(new Error("history failed"));
    bridgeMock.countWorkspaceVersionConflicts.mockReturnValueOnce(conflicts.promise);
    const onError = vi.fn<OnError>();
    render(<Page onError={onError} />);
    // The last changes failed, and the counts after them are done.
    await waitFor(() => expect(details("fresh")).toBe("Made from Main · Same as Main"));
    expect(onError).not.toHaveBeenCalled();
    await act(async () => {
      conflicts.reject(new Error("conflicts failed"));
      await conflicts.promise.catch(() => undefined);
    });
    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(
      READS_FAILED, expect.any(Error), expect.any(Function), expect.stringMatching(/^versions-reads:/), false, expect.any(Function)));
    // The first failure gives the words and Copy details.
    expect(onError.mock.lastCall![1]).toMatchObject({ message: "history failed" });
  });

  it("changes a one-read row to the combined words where it stands, and keeps them when a count's Try again works", async () => {
    const nestedCount = deferred<{ count: number }>();
    bridgeMock.listVersionLastChanges.mockRejectedValue(new Error("history failed"));
    bridgeMock.countWorkspaceVersionChanges.mockImplementation(({ versionId }: { versionId: string }) =>
      versionId === "nested" ? nestedCount.promise : Promise.resolve({ count: 2 }));
    const onError = vi.fn<OnError>();
    const onSettled = vi.fn();
    const user = userEvent.setup();
    render(<Page onError={onError} onSettled={onSettled} />);
    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(
      "dohc could not read when each version last changed.", expect.any(Error), expect.any(Function), expect.stringMatching(/^versions-reads:/), false, expect.any(Function)));
    await act(async () => {
      nestedCount.reject(new Error("count failed"));
      await nestedCount.promise.catch(() => undefined);
    });
    // A second failure while the row stands: the row changes, with no new toast.
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(onError).toHaveBeenLastCalledWith(READS_FAILED, expect.any(Error), expect.any(Function), filedIdentity(onError), true, expect.any(Function));
    const retry = await waitFor(() => within(row("nested")).getByTestId("versions-page-count-retry"));
    bridgeMock.countWorkspaceVersionChanges.mockResolvedValue({ count: 5 });
    await user.click(retry);
    await waitFor(() => expect(details("nested")).toContain("5 files differ from Main"));
    // Better is not news: the last changes still fail, so the row keeps its words, with no toast.
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("files a new row and toast when a different read fails after the person dismissed a one-read row", async () => {
    bridgeMock.listVersionLastChanges.mockRejectedValue(new Error("history failed"));
    const { rerender } = render(<ShellPage />);
    await waitFor(() => expect(shownRows()).toEqual([{ message: historyFailed("dohc could not read when each version last changed."), toast: true }]));
    act(() => shell!.dismissShellError(shell!.shellErrors[0]!.id));
    expect(shownRows()).toEqual([]);
    bridgeMock.countWorkspaceVersionConflicts.mockRejectedValue(new Error("conflicts failed"));
    rerender(<ShellPage versionKey={1} />);
    await waitFor(() => expect(shownRows()).toEqual([{ message: historyFailed(READS_FAILED), toast: true }]));
  });

  it("files a new row and toast when another read fails after the person dismissed the combined row", async () => {
    bridgeMock.listVersionLastChanges.mockRejectedValue(new Error("history failed"));
    bridgeMock.countWorkspaceVersionConflicts.mockRejectedValue(new Error("conflicts failed"));
    const { rerender } = render(<ShellPage />);
    await waitFor(() => expect(shownRows()).toEqual([{ message: historyFailed(READS_FAILED), toast: true }]));
    act(() => shell!.dismissShellError(shell!.shellErrors[0]!.id));
    expect(shownRows()).toEqual([]);
    bridgeMock.countWorkspaceVersionChanges.mockRejectedValue(new Error("count failed"));
    rerender(<ShellPage historyKey="1" />);
    await waitFor(() => expect(within(row("draft")).queryByTestId("versions-page-count-retry")).not.toBeNull());
    await waitFor(() => expect(shownRows()).toEqual([{ message: historyFailed(READS_FAILED), toast: true }]));
  });

  it("files a new row and toast when a count's own Try again fails after the person dismissed its row", async () => {
    bridgeMock.countWorkspaceVersionChanges.mockImplementation(async ({ versionId }: { versionId: string }) => {
      if (versionId !== "draft") throw new Error("count failed");
      return { count: 2 };
    });
    const counted = withErrorWords("dohc could not count the files that differ from Main.", new Error("count failed"));
    const user = userEvent.setup();
    render(<ShellPage />);
    await waitFor(() => expect(within(row("fresh")).queryByTestId("versions-page-count-retry")).not.toBeNull());
    await waitFor(() => expect(shownRows()).toEqual([{ message: counted, toast: true }]));
    act(() => shell!.dismissShellError(shell!.shellErrors[0]!.id));
    await user.click(within(row("nested")).getByTestId("versions-page-count-retry"));
    await waitFor(() => expect(within(row("nested")).queryByTestId("versions-page-count-retry")).not.toBeNull());
    await waitFor(() => expect(shownRows()).toEqual([{ message: counted, toast: true }]));
  });

  it("files nothing when reads work after the person dismissed the combined row", async () => {
    bridgeMock.listVersionLastChanges.mockRejectedValue(new Error("history failed"));
    bridgeMock.countWorkspaceVersionChanges.mockImplementation(async ({ versionId }: { versionId: string }) => {
      if (versionId !== "draft") throw new Error("count failed");
      return { count: 2 };
    });
    const user = userEvent.setup();
    render(<ShellPage />);
    await waitFor(() => expect(within(row("fresh")).queryByTestId("versions-page-count-retry")).not.toBeNull());
    await waitFor(() => expect(shownRows().map((shown) => shown.message)).toEqual([historyFailed(READS_FAILED)]));
    act(() => shell!.dismissShellError(shell!.shellErrors[0]!.id));
    bridgeMock.countWorkspaceVersionChanges.mockResolvedValue({ count: 5 });
    // One count works while another still fails, then the other works too.
    await user.click(within(row("nested")).getByTestId("versions-page-count-retry"));
    await waitFor(() => expect(details("nested")).toContain("5 files differ from Main"));
    await user.click(within(row("fresh")).getByTestId("versions-page-count-retry"));
    await waitFor(() => expect(details("fresh")).toContain("5 files differ from Main"));
    // The last changes still fail, but nothing new did.
    expect(shownRows()).toEqual([]);
  });

  it("takes back a failed read's row when the page goes", async () => {
    bridgeMock.listVersionLastChanges.mockRejectedValue(new Error("history failed"));
    const onError = vi.fn();
    const onSettled = vi.fn();
    const { unmount } = render(<Page onError={onError} onSettled={onSettled} />);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onSettled).not.toHaveBeenCalled();
    unmount();
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(filedIdentity(onError));
  });

  it("files a row for each page a split shows, and one page going takes back only its own", async () => {
    bridgeMock.listVersionLastChanges.mockRejectedValue(new Error("history failed"));
    const left = { onError: vi.fn(), onSettled: vi.fn() };
    const right = { onError: vi.fn(), onSettled: vi.fn() };
    const shown = render(<Page {...left} />);
    render(<Page {...right} />);
    await waitFor(() => expect(left.onError).toHaveBeenCalledOnce());
    await waitFor(() => expect(right.onError).toHaveBeenCalledOnce());
    expect(filedIdentity(left.onError)).not.toBe(filedIdentity(right.onError));
    shown.unmount();
    expect(left.onSettled).toHaveBeenCalledExactlyOnceWith(filedIdentity(left.onError));
    expect(right.onSettled).not.toHaveBeenCalled();
  });

  it("shows the versions picture and New version when only Main exists, and its dialog names what stays the same", async () => {
    const user = userEvent.setup();
    bridgeMock.listWorkspaceVersions.mockResolvedValue({ versions: [MAIN], activeVersionId: "main" });
    render(<Page />);
    const empty = await waitFor(() => screen.getByTestId("versions-page-empty"));
    expect(empty.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
    expect(empty.textContent).toBe("Make a version to try changes without touching Main.New version…");
    // One New version, the empty state's. The header's shows once a version exists.
    expect(screen.getAllByTestId("versions-page-new")).toHaveLength(1);
    await user.click(within(empty).getByTestId("versions-page-new"));
    expect(screen.getByTestId("version-new-same").textContent)
      .toBe("Chats are the same in every version. Files over 5\u00a0MB (text over 10\u00a0MB) aren't copied, so changing one here changes it in Main too.");
  });

  it("opens the New version dialog from the header, starting from the version you're in, and Escape gives focus back", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    await user.click(screen.getByTestId("versions-page-new"));
    expect(document.activeElement).toBe(screen.getByTestId("version-new-input"));
    // You're in Draft, so the new version starts there, with Draft's last change.
    expect(screen.getByTestId("version-new-start").textContent).toBe("DraftChanged 1h ago by Ice");
    expect(screen.getByTestId("version-new-no-merge").textContent).toBe("It can't merge into Main, because it starts from Draft.");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("version-new-dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("versions-page-new"));
  });

  it("creates the version on Enter, and keeps a refused name in the dialog with why", async () => {
    bridgeMock.createWorkspaceVersion.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'desktop:create-workspace-version': VersionedTextStoreError [version-name-conflict]: version-name-conflict",
    ));
    const user = userEvent.setup();
    render(<Page />);
    await waitFor(() => expect(screen.getAllByTestId("versions-page-row")).toHaveLength(4));
    await user.click(screen.getByTestId("versions-page-new"));
    await user.keyboard("Draft{Enter}");
    const error = await waitFor(() => screen.getByTestId("version-menu-error"));
    expect(error.textContent).toBe("Another version is called Draft. Choose another name.");
    bridgeMock.createWorkspaceVersion.mockResolvedValueOnce({ versions: [MAIN, DRAFT, NESTED, FRESH, { ...FRESH, id: "idea", name: "Idea" }], activeVersionId: "idea" });
    await user.clear(screen.getByTestId("version-new-input"));
    await user.keyboard("Idea{Enter}");
    await waitFor(() => expect(screen.queryByTestId("version-new-dialog")).toBeNull());
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
