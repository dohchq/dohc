// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetBacklinksResult } from "../ipc/bridgeContract";
import { BacklinksPanel } from "./BacklinksPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubBacklinks(result: GetBacklinksResult) {
  const getBacklinks = vi.fn(async () => result);
  vi.stubGlobal("dohcDesktop", { getBacklinks });
  return getBacklinks;
}

function stubBacklinksWithChatFailure(result: GetBacklinksResult) {
  const getBacklinks = vi.fn(async () => result);
  const listChatFileMentions = vi.fn(async () => {
    throw new Error("Chats are unavailable for this workspace");
  });
  vi.stubGlobal("dohcDesktop", { getBacklinks, listChatFileMentions });
  return { getBacklinks, listChatFileMentions };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function backlinksSource(title: string): GetBacklinksResult {
  return {
    sources: [
      {
        sourcePath: `notes/${title.toLowerCase()}.md`,
        sourceTitle: title,
        snippets: [
          {
            text: `From ${title}`,
            line: 1,
            highlightStart: 5,
            highlightEnd: 5 + title.length,
          },
        ],
      },
    ],
  };
}

const TWO_SOURCES: GetBacklinksResult = {
  sources: [
    {
      sourcePath: "notes/alpha.md",
      sourceTitle: "Alpha",
      snippets: [
        { text: "See [[Target]] here.", line: 2, highlightStart: 4, highlightEnd: 14 },
      ],
    },
    {
      sourcePath: "notes/beta.md",
      sourceTitle: "Beta",
      snippets: [
        { text: "Also [[Target]].", line: 5, highlightStart: 5, highlightEnd: 15 },
        { text: "And again [[Target]].", line: 9, highlightStart: 10, highlightEnd: 20 },
      ],
    },
  ],
};

describe("BacklinksPanel", () => {
  it("renders the total mention count and each source with its snippets", async () => {
    stubBacklinks(TWO_SOURCES);
    render(<BacklinksPanel workspaceId="ws-1" path="notes/target.md" />);

    await screen.findByTestId("backlinks");
    // Total mentions across sources (1 + 2), not the source count.
    expect(screen.getByTestId("backlinks-count").textContent).toBe("3");
    expect(screen.getAllByTestId("backlink-source")).toHaveLength(2);
    expect(screen.getAllByTestId("backlink-snippet")).toHaveLength(3);
    // The linked text is marked out of the surrounding snippet.
    expect(screen.getAllByText("[[Target]]").length).toBeGreaterThan(0);
  });

  it("keeps ordinary backlinks when chat mention lookup fails", async () => {
    const { listChatFileMentions } = stubBacklinksWithChatFailure(TWO_SOURCES);
    render(
      <BacklinksPanel
        workspaceId="ws-1"
        path="notes/target.md"
        chatMentionsAvailable
      />,
    );

    await screen.findByTestId("backlinks");
    expect(listChatFileMentions).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      path: "notes/target.md",
    });
    expect(screen.getByTestId("backlinks-count").textContent).toBe("3");
    expect(screen.getAllByTestId("backlink-source")).toHaveLength(2);
    expect(screen.queryByTestId("chat-file-mentions")).toBeNull();
  });

  // `listChatFileMentions` is a Chats call: it goes through
  // requireEngineCapture in main, so a workspace with no capture — a shared
  // view — can only be refused. The refusal is swallowed by the .catch above,
  // which is why nothing else can see this call. Backlinks themselves are not
  // an engine call and must still be read.
  it("asks for no chat mentions when the caller says they are unavailable", async () => {
    const { getBacklinks, listChatFileMentions } =
      stubBacklinksWithChatFailure(TWO_SOURCES);
    render(<BacklinksPanel workspaceId="ws-1" path="notes/target.md" />);

    await screen.findByTestId("backlinks");
    expect(getBacklinks).toHaveBeenCalled();
    expect(listChatFileMentions).not.toHaveBeenCalled();
    expect(screen.getByTestId("backlinks-count").textContent).toBe("3");
  });

  it("opens the source document when a mention is clicked", async () => {
    stubBacklinks(TWO_SOURCES);
    const onOpenPath = vi.fn();
    render(
      <BacklinksPanel
        workspaceId="ws-1"
        path="notes/target.md"
        onOpenPath={onOpenPath}
      />,
    );

    await screen.findByTestId("backlinks");
    await userEvent.click(screen.getAllByTestId("backlink-snippet")[0]!);
    expect(onOpenPath).toHaveBeenCalledWith("notes/alpha.md");

    await userEvent.click(screen.getAllByTestId("backlink-source")[1]!);
    expect(onOpenPath).toHaveBeenCalledWith("notes/beta.md");
  });

  it("collapses and expands via the header button", async () => {
    stubBacklinks(TWO_SOURCES);
    render(<BacklinksPanel workspaceId="ws-1" path="notes/target.md" />);

    await screen.findByTestId("backlinks");
    const toggle = screen.getByTestId("backlinks-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("backlink-source")).toBeNull();
  });

  it("renders nothing when there are no mentions", async () => {
    const getBacklinks = stubBacklinks({ sources: [] });
    const { container } = render(
      <BacklinksPanel workspaceId="ws-1" path="notes/target.md" />,
    );

    await waitFor(() => expect(getBacklinks).toHaveBeenCalled());
    expect(container.querySelector("[data-testid='backlinks']")).toBeNull();
  });

  it("degrades to nothing when the bridge lacks getBacklinks", () => {
    vi.stubGlobal("dohcDesktop", {});
    const { container } = render(
      <BacklinksPanel workspaceId="ws-1" path="notes/target.md" />,
    );
    expect(container.querySelector("[data-testid='backlinks']")).toBeNull();
  });

  it("never renders results loaded for a previous workspace or path", async () => {
    const workspaceA = deferred<GetBacklinksResult>();
    const workspaceB = deferred<GetBacklinksResult>();
    const getBacklinks = vi.fn((input: { workspaceId: string }) =>
      input.workspaceId === "ws-a" ? workspaceA.promise : workspaceB.promise,
    );
    vi.stubGlobal("dohcDesktop", { getBacklinks });
    const view = render(
      <BacklinksPanel workspaceId="ws-a" path="notes/target.md" />,
    );

    view.rerender(
      <BacklinksPanel workspaceId="ws-b" path="notes/other.md" />,
    );
    expect(getBacklinks).toHaveBeenLastCalledWith({
      workspaceId: "ws-b",
      path: "notes/other.md",
    });

    await act(async () => {
      workspaceB.resolve(backlinksSource("Current"));
      await workspaceB.promise;
    });
    expect((await screen.findByTestId("backlink-source")).textContent).toContain(
      "Current",
    );

    await act(async () => {
      workspaceA.resolve(backlinksSource("Stale"));
      await workspaceA.promise;
    });
    expect(screen.getByTestId("backlink-source").textContent).toContain("Current");
    expect(screen.queryByText("Stale")).toBeNull();
  });

  it("refreshes backlinks when the window regains focus", async () => {
    const getBacklinks = vi
      .fn()
      .mockResolvedValueOnce(backlinksSource("Initial"))
      .mockResolvedValueOnce(backlinksSource("Focused"));
    vi.stubGlobal("dohcDesktop", { getBacklinks });
    render(<BacklinksPanel workspaceId="ws-a" path="notes/target.md" />);

    expect((await screen.findByTestId("backlink-source")).textContent).toContain(
      "Initial",
    );
    act(() => window.dispatchEvent(new Event("focus")));

    await waitFor(() =>
      expect(screen.getByTestId("backlink-source").textContent).toContain(
        "Focused",
      ),
    );
    expect(screen.queryByText("Initial")).toBeNull();
    expect(getBacklinks).toHaveBeenCalledTimes(2);
  });

  it("keeps the current backlinks when a focus refresh fails", async () => {
    const focused = deferred<GetBacklinksResult>();
    const getBacklinks = vi
      .fn()
      .mockResolvedValueOnce(backlinksSource("Initial"))
      .mockReturnValueOnce(focused.promise);
    vi.stubGlobal("dohcDesktop", { getBacklinks });
    render(<BacklinksPanel workspaceId="ws-a" path="notes/target.md" />);
    expect((await screen.findByTestId("backlink-source")).textContent).toContain(
      "Initial",
    );

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(getBacklinks).toHaveBeenCalledTimes(2));
    await act(async () => {
      focused.reject(new Error("focus refresh failed"));
      await focused.promise.catch(() => undefined);
    });

    expect(screen.getByTestId("backlink-source").textContent).toContain("Initial");
  });

  it("clears the current backlinks when a workspace refresh fails", async () => {
    const refreshed = deferred<GetBacklinksResult>();
    const getBacklinks = vi
      .fn()
      .mockResolvedValueOnce(backlinksSource("Initial"))
      .mockReturnValueOnce(refreshed.promise);
    vi.stubGlobal("dohcDesktop", { getBacklinks });
    const view = render(
      <BacklinksPanel
        workspaceId="ws-a"
        path="notes/target.md"
        refreshKey={0}
      />,
    );
    expect((await screen.findByTestId("backlink-source")).textContent).toContain(
      "Initial",
    );

    view.rerender(
      <BacklinksPanel
        workspaceId="ws-a"
        path="notes/target.md"
        refreshKey={1}
      />,
    );
    await waitFor(() => expect(getBacklinks).toHaveBeenCalledTimes(2));
    await act(async () => {
      refreshed.reject(new Error("workspace refresh failed"));
      await refreshed.promise.catch(() => undefined);
    });

    await waitFor(() => expect(screen.queryByTestId("backlinks")).toBeNull());
  });

  it("does not let the initial response overwrite a newer focus refresh", async () => {
    const initial = deferred<GetBacklinksResult>();
    const focused = deferred<GetBacklinksResult>();
    const getBacklinks = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(focused.promise);
    vi.stubGlobal("dohcDesktop", { getBacklinks });
    render(<BacklinksPanel workspaceId="ws-a" path="notes/target.md" />);
    await waitFor(() => expect(getBacklinks).toHaveBeenCalledOnce());

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(getBacklinks).toHaveBeenCalledTimes(2));
    await act(async () => {
      focused.resolve(backlinksSource("Current"));
      await focused.promise;
    });
    expect((await screen.findByTestId("backlink-source")).textContent).toContain(
      "Current",
    );

    await act(async () => {
      initial.resolve(backlinksSource("Stale"));
      await initial.promise;
    });
    expect(screen.getByTestId("backlink-source").textContent).toContain("Current");
    expect(screen.queryByText("Stale")).toBeNull();
  });
});
