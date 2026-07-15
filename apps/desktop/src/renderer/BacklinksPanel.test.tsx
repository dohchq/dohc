// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
    render(<BacklinksPanel workspaceId="ws-1" path="notes/target.md" />);

    await screen.findByTestId("backlinks");
    expect(listChatFileMentions).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      path: "notes/target.md",
    });
    expect(screen.getByTestId("backlinks-count").textContent).toBe("3");
    expect(screen.getAllByTestId("backlink-source")).toHaveLength(2);
    expect(screen.queryByTestId("chat-file-mentions")).toBeNull();
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
});
