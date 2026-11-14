// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OutsideChange } from "@dohc/workspace-contracts/outside-changes";
import { deferred } from "../../testing/deferred";
import { useOutsideChangeNotices } from "./useOutsideChangeNotices";
import { useShellError } from "./useShellError";

afterEach(cleanup);
const change: OutsideChange = { path: "notes/plan.md", firstObservedAtMs: 1 };

function fixture() {
  const keepOutsideChange = vi.fn(async (_input: { workspaceId: string; path: string }) => ({
    kept: true,
  }));
  const revealExplorerPath = vi.fn(async () => undefined);
  Object.assign(window, {
    dohcDesktop: { platform: "win32", keepOutsideChange, revealExplorerPath },
  });
  const view = renderHook(
    ({ changes, workspaceId }: { changes: OutsideChange[]; workspaceId: string }) => {
      const shell = useShellError(workspaceId);
      useOutsideChangeNotices({
        workspaceId,
        changes,
        reportShellFailure: shell.reportShellFailure,
        clearIdentity: shell.clearIdentity,
      });
      return shell;
    },
    { initialProps: { changes: [change], workspaceId: "workspace" } },
  );
  return { ...view, keepOutsideChange, revealExplorerPath };
}

it("shows a row with no Dismiss that keeps the change as a copy or shows the file", async () => {
  const f = fixture();
  const row = f.result.current.shellErrors[0]!;
  expect(f.result.current.shellErrors).toHaveLength(1);
  expect(row).toMatchObject({
    tone: "warning",
    title: "Not in the live note: notes/plan.md",
    identity: "outside-change:notes/plan.md",
    retry: null,
    noDismiss: true,
    target: { to: "file", path: "notes/plan.md" },
  });
  expect(row.action?.label).toBe("Keep a copy");
  expect(row.action?.additional?.map(({ label }) => label)).toEqual(["Show in File Explorer"]);
  expect(JSON.stringify(row)).not.toContain("Stop");

  act(() => row.action!.additional![0]!.run());
  expect(f.revealExplorerPath).toHaveBeenCalledWith({
    workspaceId: "workspace",
    path: "notes/plan.md",
  });
  act(() => row.action!.run());
  expect(f.keepOutsideChange).toHaveBeenCalledWith({
    workspaceId: "workspace",
    path: "notes/plan.md",
  });
  await waitFor(() => expect(f.result.current.shellErrors).toHaveLength(0));
});

it("keeps one row while the change stays held, and clears it once the file matches the note", () => {
  const f = fixture();
  f.rerender({ changes: [{ ...change }], workspaceId: "workspace" });
  expect(f.result.current.shellErrors).toHaveLength(1);
  f.rerender({ changes: [], workspaceId: "workspace" });
  expect(f.result.current.shellErrors).toHaveLength(0);
});

it("reports a failed keep with Try again, and paints nothing after the workspace changed", async () => {
  const f = fixture();
  const failed = deferred<{ kept: boolean }>();
  f.keepOutsideChange.mockImplementationOnce(() => failed.promise);
  act(() => f.result.current.shellErrors[0]!.action!.run());
  await act(async () => failed.reject(new Error("disk full")));
  const failure = f.result.current.shellErrors.find((row) => row.retry !== null)!;
  expect(failure.message).toContain("dohc could not keep the outside change to notes/plan.md.");

  const late = deferred<{ kept: boolean }>();
  f.keepOutsideChange.mockImplementationOnce(() => late.promise);
  act(() => failure.retry!());
  f.rerender({ changes: [], workspaceId: "other" });
  await act(async () => late.reject(new Error("disk full")));
  expect(f.result.current.shellErrors).toHaveLength(0);
});
