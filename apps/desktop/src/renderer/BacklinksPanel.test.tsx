// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkQueryPage, type BacklinksFixture } from "../testing/linkQueryPage.fixture";
import { BacklinksPanel } from "./BacklinksPanel";

import { deferred } from "../testing/deferred";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubBacklinks(result: BacklinksFixture) {
  const linksIn = vi.fn(async () => result);
  vi.stubGlobal("dohcDesktop", { linksIn: (...args: unknown[]) => Promise.resolve((linksIn as (...args: unknown[]) => Promise<BacklinksFixture>)(...args)).then(linkQueryPage) });
  return linksIn;
}

function stubBacklinksWithChatFailure(result: BacklinksFixture) {
  const linksIn = vi.fn(async () => result);
  const listChatFileMentions = vi.fn(async () => {
    throw new Error("Chats are unavailable for this workspace");
  });
  vi.stubGlobal("dohcDesktop", { linksIn: () => linksIn().then(linkQueryPage), listChatFileMentions });
  return { linksIn, listChatFileMentions };
}

function backlinksSource(title: string): BacklinksFixture {
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

const TWO_SOURCES: BacklinksFixture = {
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
    const { linksIn, listChatFileMentions } =
      stubBacklinksWithChatFailure(TWO_SOURCES);
    render(<BacklinksPanel workspaceId="ws-1" path="notes/target.md" />);

    await screen.findByTestId("backlinks");
    expect(linksIn).toHaveBeenCalled();
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
    const linksIn = stubBacklinks({ sources: [] });
    const { container } = render(
      <BacklinksPanel workspaceId="ws-1" path="notes/target.md" />,
    );

    await waitFor(() => expect(linksIn).toHaveBeenCalled());
    expect(container.querySelector("[data-testid='backlinks']")).toBeNull();
  });

  it("degrades to nothing when the bridge lacks linksIn", () => {
    vi.stubGlobal("dohcDesktop", {});
    const { container } = render(
      <BacklinksPanel workspaceId="ws-1" path="notes/target.md" />,
    );
    expect(container.querySelector("[data-testid='backlinks']")).toBeNull();
  });

  it("never renders results loaded for a previous workspace or path", async () => {
    const workspaceA = deferred<BacklinksFixture>();
    const workspaceB = deferred<BacklinksFixture>();
    const linksIn = vi.fn((input: { workspaceId: string }) =>
      input.workspaceId === "ws-a" ? workspaceA.promise : workspaceB.promise,
    );
    vi.stubGlobal("dohcDesktop", { linksIn: (...args: unknown[]) => Promise.resolve((linksIn as (...args: unknown[]) => Promise<BacklinksFixture>)(...args)).then(linkQueryPage) });
    const view = render(
      <BacklinksPanel workspaceId="ws-a" path="notes/target.md" />,
    );

    view.rerender(
      <BacklinksPanel workspaceId="ws-b" path="notes/other.md" />,
    );
    expect(linksIn).toHaveBeenLastCalledWith({
      workspaceId: "ws-b",
      subject: { path: "notes/other.md" },
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
    const linksIn = vi
      .fn()
      .mockResolvedValueOnce(backlinksSource("Initial"))
      .mockResolvedValueOnce(backlinksSource("Focused"));
    vi.stubGlobal("dohcDesktop", { linksIn: (...args: unknown[]) => Promise.resolve((linksIn as (...args: unknown[]) => Promise<BacklinksFixture>)(...args)).then(linkQueryPage) });
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
    expect(linksIn).toHaveBeenCalledTimes(2);
  });

  it("keeps the current backlinks when a focus refresh fails", async () => {
    const focused = deferred<BacklinksFixture>();
    const linksIn = vi
      .fn()
      .mockResolvedValueOnce(backlinksSource("Initial"))
      .mockReturnValueOnce(focused.promise);
    vi.stubGlobal("dohcDesktop", { linksIn: (...args: unknown[]) => Promise.resolve((linksIn as (...args: unknown[]) => Promise<BacklinksFixture>)(...args)).then(linkQueryPage) });
    render(<BacklinksPanel workspaceId="ws-a" path="notes/target.md" />);
    expect((await screen.findByTestId("backlink-source")).textContent).toContain(
      "Initial",
    );

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(linksIn).toHaveBeenCalledTimes(2));
    await act(async () => {
      focused.reject(new Error("focus refresh failed"));
      await focused.promise.catch(() => undefined);
    });

    expect(screen.getByTestId("backlink-source").textContent).toContain("Initial");
  });

  it("keeps the pending initial result when a focus refresh fails", async () => {
    const initial = deferred<BacklinksFixture>();
    const focused = deferred<BacklinksFixture>();
    const linksIn = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(focused.promise);
    vi.stubGlobal("dohcDesktop", { linksIn: (...args: unknown[]) => Promise.resolve((linksIn as (...args: unknown[]) => Promise<BacklinksFixture>)(...args)).then(linkQueryPage) });
    render(<BacklinksPanel workspaceId="ws-a" path="notes/target.md" />);
    await waitFor(() => expect(linksIn).toHaveBeenCalledOnce());

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(linksIn).toHaveBeenCalledTimes(2));
    await act(async () => {
      focused.reject(new Error("focus refresh failed"));
      await focused.promise.catch(() => undefined);
    });

    await act(async () => {
      initial.resolve(backlinksSource("Initial"));
      await initial.promise;
    });
    expect((await screen.findByTestId("backlink-source")).textContent).toContain(
      "Initial",
    );
  });

  it("clears the current backlinks when a workspace refresh fails", async () => {
    const refreshed = deferred<BacklinksFixture>();
    const linksIn = vi
      .fn()
      .mockResolvedValueOnce(backlinksSource("Initial"))
      .mockReturnValueOnce(refreshed.promise);
    vi.stubGlobal("dohcDesktop", { linksIn: (...args: unknown[]) => Promise.resolve((linksIn as (...args: unknown[]) => Promise<BacklinksFixture>)(...args)).then(linkQueryPage) });
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
    await waitFor(() => expect(linksIn).toHaveBeenCalledTimes(2));
    await act(async () => {
      refreshed.reject(new Error("workspace refresh failed"));
      await refreshed.promise.catch(() => undefined);
    });

    await waitFor(() => expect(screen.queryByTestId("backlinks")).toBeNull());
  });

  it("does not let the initial response overwrite a newer focus refresh", async () => {
    const initial = deferred<BacklinksFixture>();
    const focused = deferred<BacklinksFixture>();
    const linksIn = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(focused.promise);
    vi.stubGlobal("dohcDesktop", { linksIn: (...args: unknown[]) => Promise.resolve((linksIn as (...args: unknown[]) => Promise<BacklinksFixture>)(...args)).then(linkQueryPage) });
    render(<BacklinksPanel workspaceId="ws-a" path="notes/target.md" />);
    await waitFor(() => expect(linksIn).toHaveBeenCalledOnce());

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(linksIn).toHaveBeenCalledTimes(2));
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

it("paints engine pages without waiting for chat refresh, including sources beyond the old scan limit", async () => {
  const chats = deferred<{ mentions: [] }>();
  const second = deferred<ReturnType<typeof linkQueryPage>>();
  const first = linkQueryPage(backlinksSource("File5001"));
  first.nextCursor = "next";
  const linksIn = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(second.promise);
  vi.stubGlobal("dohcDesktop", { linksIn, listChatFileMentions: () => chats.promise });
  render(<BacklinksPanel workspaceId="ws" path="target.md" chatMentionsAvailable />);
  await screen.findAllByText("File5001");
  await act(async () => { second.resolve(linkQueryPage(backlinksSource("File5002"))); });
  await screen.findAllByText("File5002");
  expect(linksIn).toHaveBeenCalledWith({ workspaceId: "ws", subject: { path: "target.md" }, cursor: "next" });
  await act(async () => chats.resolve({ mentions: [] }));
});
