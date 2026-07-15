// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceGraphResult } from "../../ipc/bridgeContract";
import { GraphView } from "./GraphView";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function graph(path: string): WorkspaceGraphResult {
  return {
    nodes: [{ path, title: path, incoming: 0, outgoing: 0 }],
    edges: [],
    unresolvedLinks: 0,
    scannedFileCount: 1,
    omittedFileCount: 0,
    truncatedFileCount: 0,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GraphView", () => {
  it("hides chat mentions when Chats is unavailable", async () => {
    const readWorkspaceGraph = vi.fn(async () => ({
      nodes: [],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 0,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    vi.stubGlobal("dohcDesktop", { readWorkspaceGraph });

    render(
      <GraphView
        workspaceId="ws-unflagged"
        activePath={null}
        refreshKey="0"
        chatMentionsAvailable={false}
        onOpenPath={vi.fn()}
      />,
    );

    await waitFor(() => expect(readWorkspaceGraph).toHaveBeenCalled());
    expect(screen.queryByTestId("graph-chat-mentions-toggle")).toBeNull();
    expect(readWorkspaceGraph).toHaveBeenCalledWith({
      workspaceId: "ws-unflagged",
      includeChatMentions: false,
    });
  });

  it("loads the workspace graph and opens a clicked document", async () => {
    const onOpenPath = vi.fn();
    vi.stubGlobal("dohcDesktop", {
      readWorkspaceGraph: vi.fn(async () => ({
        nodes: [
          { path: "alpha.md", title: "Alpha", incoming: 1, outgoing: 1 },
          { path: "beta.md", title: "Beta", incoming: 1, outgoing: 0 },
        ],
        edges: [{ source: "alpha.md", target: "beta.md", kind: "wikilink" }],
        unresolvedLinks: 1,
        scannedFileCount: 2,
        omittedFileCount: 0,
        truncatedFileCount: 0,
      })),
    });

    render(
      <GraphView
        workspaceId="ws-graph"
        activePath="alpha.md"
        refreshKey="0"
        onOpenPath={onOpenPath}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("graph-view").getAttribute("data-state")).toBe(
        "ready",
      ),
    );
    expect(screen.getByTestId("graph-doc-count").textContent).toBe("2 docs");
    expect(screen.getByTestId("graph-link-count").textContent).toBe("1 link");
    expect(screen.getByTestId("graph-unresolved-count").textContent).toContain(
      "1 unresolved",
    );
    const graphNodes = await screen.findAllByTestId("graph-node");
    expect(
      graphNodes
        .find((node) => node.dataset.path === "beta.md")
        ?.getAttribute("aria-label"),
    ).toBe("Open or focus beta.md");

    await userEvent.click(
      graphNodes.find((node) => node.dataset.path === "beta.md")!,
    );
    expect(onOpenPath).toHaveBeenCalledWith("beta.md");
  });

  it("clears the previous workspace while the next graph loads and rejects a late repaint", async () => {
    const lateWorkspaceA = deferred<WorkspaceGraphResult>();
    const workspaceB = deferred<WorkspaceGraphResult>();
    const readWorkspaceGraph = vi.fn(
      (input: { workspaceId: string }) => {
        if (input.workspaceId === "workspace-a") {
          return readWorkspaceGraph.mock.calls.length === 1
            ? Promise.resolve(graph("a.md"))
            : lateWorkspaceA.promise;
        }
        return workspaceB.promise;
      },
    );
    vi.stubGlobal("dohcDesktop", { readWorkspaceGraph });

    const { rerender } = render(
      <GraphView
        workspaceId="workspace-a"
        activePath={null}
        refreshKey="0"
        onOpenPath={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Open or focus a.md" }),
    ).toBeTruthy();

    rerender(
      <GraphView
        workspaceId="workspace-a"
        activePath={null}
        refreshKey="1"
        onOpenPath={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Open or focus a.md" }),
    ).toBeTruthy();

    rerender(
      <GraphView
        workspaceId="workspace-b"
        activePath={null}
        refreshKey="0"
        onOpenPath={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Open or focus a.md" }),
    ).toBeNull();
    expect(screen.getByText("Building graph…")).toBeTruthy();

    await act(async () => {
      lateWorkspaceA.resolve(graph("late-a.md"));
      await lateWorkspaceA.promise;
    });
    expect(
      screen.queryByRole("button", { name: "Open or focus late-a.md" }),
    ).toBeNull();
    expect(screen.getByText("Building graph…")).toBeTruthy();

    await act(async () => {
      workspaceB.resolve(graph("b.md"));
      await workspaceB.promise;
    });
    expect(
      await screen.findByRole("button", { name: "Open or focus b.md" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Open or focus late-a.md" }),
    ).toBeNull();
  });

  it("enables mention overlays and routes heading and chat nodes", async () => {
    const headingNode = {
      path: "heading:object-plan:scope",
      kind: "heading" as const,
      filePath: "docs/plan.md",
      headingAnchor: "scope",
      title: "#Scope",
      incoming: 1,
      outgoing: 1,
    };
    const chatNode = {
      path: "chat-thread:thread-1",
      kind: "chat-thread" as const,
      threadId: "thread-1",
      channelId: "channel-1",
      channelName: "planning",
      channelSlug: "planning",
      channelKind: "channel" as const,
      title: "Planning discussion",
      incoming: 0,
      outgoing: 1,
    };
    const readWorkspaceGraph = vi.fn(
      async (input: { includeChatMentions?: boolean }) => ({
        nodes: input.includeChatMentions
          ? [
              {
                path: "docs/plan.md",
                kind: "file" as const,
                filePath: "docs/plan.md",
                title: "Plan",
                incoming: 1,
                outgoing: 0,
              },
              headingNode,
              chatNode,
            ]
          : [],
        edges: [],
        unresolvedLinks: 0,
        scannedFileCount: 1,
        omittedFileCount: 0,
        truncatedFileCount: 0,
      }),
    );
    vi.stubGlobal("dohcDesktop", { readWorkspaceGraph });
    const onOpenPath = vi.fn();
    const onOpenChatThread = vi.fn();
    render(
      <GraphView
        workspaceId="ws-graph"
        activePath={null}
        refreshKey="0"
        chatMentionsAvailable
        onOpenPath={onOpenPath}
        onOpenChatThread={onOpenChatThread}
      />,
    );

    await waitFor(() => expect(readWorkspaceGraph).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
    await waitFor(() =>
      expect(readWorkspaceGraph).toHaveBeenLastCalledWith({
        workspaceId: "ws-graph",
        includeChatMentions: true,
      }),
    );

    const rows = await screen.findAllByTestId("graph-file-row");
    await userEvent.click(
      rows.find((row) => row.getAttribute("data-path") === headingNode.path)!,
    );
    expect(onOpenPath).toHaveBeenCalledWith("docs/plan.md", "scope");

    await userEvent.click(
      rows.find((row) => row.getAttribute("data-path") === chatNode.path)!,
    );
    expect(onOpenChatThread).toHaveBeenCalledWith(expect.objectContaining(chatNode));
  });
});
