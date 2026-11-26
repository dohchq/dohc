// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";
import { FileCommentsReader } from "./FileCommentsReader";
import { useFileComments } from "./fileComments";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe() {
  const comments = useFileComments("workspace-1", "docs/plan.md");
  return <output data-testid="anchors">{JSON.stringify(comments?.anchors ?? null)}</output>;
}

it("reports a failed read with Try again, and clears the row once Try again reads", async () => {
  const listFileChats = vi.fn().mockRejectedValueOnce(new Error("engine stopped"));
  vi.stubGlobal("dohcDesktop", { listFileChats, onWorkspaceActivity: () => () => {} });
  const notices = { report: vi.fn(), clear: vi.fn() };
  render(
    <WorkspaceSessionProvider workspaceId="workspace-1">
      <FileCommentsReader
        workspaceId="workspace-1"
        path="docs/plan.md"
        closed={false}
        notices={notices}
      />
      <Probe />
    </WorkspaceSessionProvider>,
  );

  await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(1));
  const failure = notices.report.mock.calls[0]![0];
  expect(failure.identity).toBe("about-chats:docs/plan.md");

  listFileChats.mockResolvedValue({
    fileObjectId: "object-1",
    threads: [{ id: "thread-1", title: "Why?", createdAtMs: 1, updatedAtMs: 1, quote: "the plan" }],
  });
  act(() => failure.retry());

  await waitFor(() =>
    expect(screen.getByTestId("anchors").textContent).toBe(
      JSON.stringify([{ threadId: "thread-1", quote: "the plan" }]),
    ),
  );
  expect(notices.clear).toHaveBeenCalledWith("about-chats:docs/plan.md");
});
