// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PlanUndoAgentRunResult,
  UndoAgentRunResult,
} from "@dohc/workspace-contracts/agent-run-undo";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";
import { AgentRunUndoDialog, type AgentRunUndoDialogProps } from "./AgentRunUndoDialog";

const planUndoAgentRun = vi.fn();
const undoAgentRun = vi.fn();

vi.mock("../bridge", () => ({
  bridge: () => ({
    planUndoAgentRun,
    undoAgentRun,
  }),
}));

afterEach(() => {
  cleanup();
  planUndoAgentRun.mockReset();
  undoAgentRun.mockReset();
});

function renderDialog(overrides: Partial<AgentRunUndoDialogProps> = {}) {
  const props: AgentRunUndoDialogProps = {
    workspaceId: "ws-1",
    agentRunId: "run-1",
    agentName: "Rover",
    reviewPaths: [],
    onBeforeRestore: vi.fn(async () => vi.fn()),
    onRestored: vi.fn(),
    onSuccessNotice: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(
    <WorkspaceSessionProvider workspaceId={props.workspaceId}>
      <AgentRunUndoDialog {...props} />
    </WorkspaceSessionProvider>,
  );
  return props;
}

describe("AgentRunUndoDialog", () => {
  it("shows honest copy, restorable and skipped files, DangerButton for deletions, and confirms with expectedTargets", async () => {
    const plan: PlanUndoAgentRunResult = {
      agentRunId: "run-1",
      agentName: "Rover",
      planToken: "plan-token-1",
      truncated: false,
      scannedChanges: 4,
      restorable: [
        {
          objectId: "obj-plan",
          path: "notes/plan.md",
          earliestMomentId: "m-1",
          latestMomentId: "m-2",
          momentCount: 2,
          action: "restore",
        },
        {
          objectId: "obj-check",
          path: "notes/checklist.md",
          earliestMomentId: "m-3",
          latestMomentId: "m-3",
          momentCount: 1,
          action: "delete",
        },
        {
          objectId: "obj-dirty",
          path: "notes/dirty.md",
          earliestMomentId: "m-4",
          latestMomentId: "m-4",
          momentCount: 1,
          action: "restore",
        },
      ],
      skipped: [
        {
          path: "notes/budget.md",
          reason: "later-edits",
          detail: "Changed again after this agent run.",
        },
      ],
    };
    const release = vi.fn();
    const onBeforeRestore = vi.fn(async () => release);
    planUndoAgentRun.mockResolvedValueOnce(plan);
    undoAgentRun.mockResolvedValueOnce({
      agentRunId: "run-1",
      correlationId: "restore-agent-run-1",
      truncated: false,
      restored: [
        { path: "notes/plan.md", restored: "text", restoredMomentId: "r-1" },
        { path: "notes/checklist.md", restored: "deleted", restoredMomentId: "r-2" },
      ],
      skipped: [
        {
          path: "notes/budget.md",
          reason: "later-edits",
          detail: "Changed again after this agent run.",
        },
        {
          path: "notes/dirty.md",
          reason: "local-changes",
          detail: "Has unsaved edits in this window. Save or close it first.",
        },
      ],
      failed: [],
    } satisfies UndoAgentRunResult);

    const props = renderDialog({
      reviewPaths: ["notes/dirty.md"],
      onBeforeRestore,
    });

    await screen.findByTestId("agent-run-undo-restorable");
    expect(screen.getByText("Undo changes from Rover")).toBeTruthy();
    expect(
      screen.getByText("Files saved while Rover was running on the active version."),
    ).toBeTruthy();
    expect(screen.getByText(/Collection records keep their own History/)).toBeTruthy();
    expect(screen.getByText("Restore earlier version (2 edits)")).toBeTruthy();
    expect(screen.getByText("Remove created file")).toBeTruthy();
    expect(screen.getByText("Changed again after this agent run.")).toBeTruthy();
    expect(
      screen.getByText("Has unsaved edits in this window. Save or close it first."),
    ).toBeTruthy();

    const confirm = screen.getByTestId("agent-run-undo-confirm");
    expect(confirm.textContent).toBe("Undo 2 files");
    expect(confirm.className).toContain("bg-danger-fill");

    fireEvent.click(confirm);
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));

    expect(onBeforeRestore).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(undoAgentRun).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      agentRunId: "run-1",
      expectedTargets: [
        {
          objectId: "obj-plan",
          path: "notes/plan.md",
          earliestMomentId: "m-1",
          latestMomentId: "m-2",
          action: "restore",
        },
        {
          objectId: "obj-check",
          path: "notes/checklist.md",
          earliestMomentId: "m-3",
          latestMomentId: "m-3",
          action: "delete",
        },
      ],
      reviewPaths: ["notes/dirty.md"],
    });
    expect(props.onRestored).toHaveBeenCalledTimes(1);
    expect(props.onSuccessNotice).toHaveBeenCalledWith("Undid 2 files (2 skipped).");
  });

  it("uses PrimaryButton when no created files are removed", async () => {
    planUndoAgentRun.mockResolvedValueOnce({
      agentRunId: "run-1",
      agentName: "Rover",
      planToken: "plan-token-2",
      truncated: false,
      scannedChanges: 1,
      restorable: [
        {
          objectId: "obj-plan",
          path: "notes/plan.md",
          earliestMomentId: "m-1",
          latestMomentId: "m-1",
          momentCount: 1,
          action: "restore",
        },
      ],
      skipped: [],
    } satisfies PlanUndoAgentRunResult);

    renderDialog();
    const confirm = await screen.findByTestId("agent-run-undo-confirm");
    expect(confirm.textContent).toBe("Undo 1 file");
    expect(confirm.className).toContain("bg-accent");
    expect(confirm.className).not.toContain("bg-danger-fill");
  });

  it("reports partial per-file failures to Notices and keeps details visible in the dialog", async () => {
    planUndoAgentRun.mockResolvedValueOnce({
      agentRunId: "run-1",
      agentName: "Rover",
      planToken: "plan-token-3",
      truncated: false,
      scannedChanges: 2,
      restorable: [
        {
          objectId: "obj-a",
          path: "notes/a.md",
          earliestMomentId: "m-1",
          latestMomentId: "m-1",
          momentCount: 1,
          action: "restore",
        },
        {
          objectId: "obj-b",
          path: "notes/b.md",
          earliestMomentId: "m-2",
          latestMomentId: "m-2",
          momentCount: 1,
          action: "restore",
        },
      ],
      skipped: [],
    } satisfies PlanUndoAgentRunResult);
    undoAgentRun.mockResolvedValueOnce({
      agentRunId: "run-1",
      correlationId: "restore-agent-run-2",
      truncated: false,
      restored: [{ path: "notes/b.md", restored: "text", restoredMomentId: "r-b" }],
      skipped: [],
      failed: [{ path: "notes/a.md", detail: "File is open in another app." }],
    } satisfies UndoAgentRunResult);

    const props = renderDialog();
    fireEvent.click(await screen.findByTestId("agent-run-undo-confirm"));

    await screen.findByTestId("agent-run-undo-partial");
    expect(screen.getByText("File is open in another app.")).toBeTruthy();
    expect(props.onRestored).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onError).toHaveBeenCalledWith(
      "Undid 1 file, but 1 file could not be restored.",
      expect.any(Error),
      expect.any(Function),
      expect.stringContaining("agent-run-undo:"),
    );
  });

  it("shows unreadable rules clearly and offers no confirm button", async () => {
    planUndoAgentRun.mockResolvedValueOnce({
      agentRunId: "run-1",
      agentName: null,
      planToken: "plan-token-4",
      truncated: false,
      scannedChanges: 0,
      restorable: [],
      skipped: [],
      policyUnreadable: [".dohc/files.toml"],
    } satisfies PlanUndoAgentRunResult);

    renderDialog({ agentName: null });
    const alert = await screen.findByTestId("agent-run-undo-policy-error");
    expect(alert.textContent).toContain(".dohc/files.toml");
    expect(screen.queryByTestId("agent-run-undo-confirm")).toBeNull();
  });

  it("reports actual scanned History pages and changes when truncated", async () => {
    planUndoAgentRun.mockResolvedValueOnce({
      agentRunId: "run-1",
      agentName: "Rover",
      planToken: "plan-token-5",
      truncated: true,
      scannedChanges: 11240,
      restorable: [],
      skipped: [],
    } satisfies PlanUndoAgentRunResult);

    renderDialog();
    const banner = await screen.findByTestId("agent-run-undo-truncated");
    expect(banner.textContent).toContain("250 History pages");
    expect(banner.textContent).toContain("11,240 changes");
  });

  it("uses neutral zero-undone copy when files were skipped for another window instead of changing", async () => {
    planUndoAgentRun
      .mockResolvedValueOnce({
        agentRunId: "run-1",
        agentName: "Rover",
        planToken: "plan-token-6",
        truncated: false,
        scannedChanges: 1,
        restorable: [
          {
            objectId: "obj-a",
            path: "notes/a.md",
            earliestMomentId: "m-1",
            latestMomentId: "m-1",
            momentCount: 1,
            action: "restore",
          },
        ],
        skipped: [],
      } satisfies PlanUndoAgentRunResult)
      .mockResolvedValueOnce({
        agentRunId: "run-1",
        agentName: "Rover",
        planToken: "plan-token-7",
        truncated: false,
        scannedChanges: 1,
        restorable: [],
        skipped: [
          {
            path: "notes/a.md",
            reason: "other-window",
            detail: "Open in another window. Close that window and try again.",
          },
        ],
      } satisfies PlanUndoAgentRunResult);
    undoAgentRun.mockResolvedValueOnce({
      agentRunId: "run-1",
      correlationId: "restore-agent-run-3",
      truncated: false,
      restored: [],
      skipped: [
        {
          path: "notes/a.md",
          reason: "other-window",
          detail: "Open in another window. Close that window and try again.",
        },
      ],
      failed: [],
    } satisfies UndoAgentRunResult);

    renderDialog();
    fireEvent.click(await screen.findByTestId("agent-run-undo-confirm"));

    const stale = await screen.findByTestId("agent-run-undo-stale");
    expect(stale.textContent).toBe("No files were undone. Review the skipped files below.");
  });
});
