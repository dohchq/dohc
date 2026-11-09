// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerMenuEntry } from "../ipc/bridgeContract";
import { deferred } from "../testing/deferred";
import type { Workspace } from "./DesktopWorkspaceShell";
import {
  DesktopWorkspaceShell,
  OTHER_WORKSPACE,
  WORKSPACE,
  makeBridge,
  renderShell,
  shellBootstrapProps,
} from "./DesktopWorkspaceShell.testHarness";

// Main runs Show in File Explorer as its own operation, after its path checks.
// These are the rejections the renderer receives from that call.
const REMOVED = new Error(
  "Error invoking remote method 'desktop:reveal-explorer-path': Error [ENOENT]: ENOENT: no such file or directory, stat 'report.pdf'",
);
const LEFT = new Error(
  "Error invoking remote method 'desktop:reveal-explorer-path': Error: Explorer action stopped because this window changed workspaces.",
);
const ESCAPES = new Error(
  "Error invoking remote method 'desktop:reveal-explorer-path': Error: Asset path escapes workspace: report.pdf",
);
const WORDS = "dohc could not show report.pdf in File Explorer. The file or folder is not there anymore.";
const REVEAL_ENTRY: ExplorerMenuEntry = { kind: "item", label: "Show in File Explorer", id: "open-externally" };

function bridgeListing() {
  const bridge = makeBridge(Promise.resolve(null), "win32");
  bridge.listWorkspaceFiles.mockResolvedValue({
    visibility: { status: "ready" as const, rules: [] },
    files: [{ path: "report.pdf", kind: "file" }],
    folders: [],
  });
  bridge.readExplorerMenu.mockResolvedValue([REVEAL_ENTRY]);
  return bridge;
}

async function showReport() {
  const row = (await screen.findAllByTestId("tree-row")).find((candidate) => candidate.dataset.path === "report.pdf");
  if (!row) throw new Error("report.pdf row missing");
  fireEvent.contextMenu(row);
  fireEvent.click(await screen.findByTestId("explorer-menu-item-open-externally"));
}

// The app sends an error report for every unhandled rejection.
const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", recordUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", recordUnhandled);
});
// Node reports a rejection nobody handled once this turn's microtasks run out.
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

describe("Show in File Explorer", () => {
  it("says in a toast and a Notices row that dohc could not show a removed file, and Try again asks for the same reveal", async () => {
    const bridge = bridgeListing();
    bridge.revealExplorerPath.mockRejectedValueOnce(REMOVED);
    const user = userEvent.setup();
    renderShell(bridge);

    await showReport();
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(WORDS);
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(toast).getByRole("button", { name: "Details" })).toBeTruthy();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = (await within(await screen.findByTestId("notice-center")).findByText(WORDS)).closest("li")!;
    expect(within(row).getByRole("button", { name: "Details" })).toBeTruthy();
    await nextTurn();
    expect(unhandled).toEqual([]);

    await user.click(within(row).getByRole("button", { name: "Try again" }));
    expect(bridge.revealExplorerPath).toHaveBeenCalledTimes(2);
    expect(bridge.revealExplorerPath).toHaveBeenLastCalledWith({ workspaceId: WORKSPACE.workspaceId, path: "report.pdf" });
    await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
  });

  it("puts its own sentence before a reason main gives in its own words", async () => {
    const bridge = bridgeListing();
    bridge.revealExplorerPath.mockRejectedValueOnce(ESCAPES);
    renderShell(bridge);

    await showReport();
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(
      "dohc could not show report.pdf in File Explorer. Asset path escapes workspace: report.pdf",
    );
  });

  // DesktopRoot remounts the shell on a switch. Keeping the same shell is the
  // stricter case, and coming back to the first workspace does not revive the
  // old answer. Each time main answers that the window left.
  it.each(["remounts its shell", "keeps its shell", "keeps its shell and switches back"] as const)(
    "says nothing when the reveal answers after the window switches workspaces and %s",
    async (mode) => {
      const bridge = bridgeListing();
      const answer = deferred<undefined>();
      bridge.revealExplorerPath.mockReturnValueOnce(answer.promise);
      const shell = (workspace: Workspace) => (
        <DesktopWorkspaceShell
          workspace={workspace}
          workspaces={[WORKSPACE, OTHER_WORKSPACE]}
          {...shellBootstrapProps(bridge)}
          onSwitchWorkspace={() => {}}
        />
      );
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(WORKSPACE));

      await showReport();
      await waitFor(() => expect(bridge.revealExplorerPath).toHaveBeenCalledTimes(1));
      if (mode === "remounts its shell") {
        view.unmount();
        render(shell(OTHER_WORKSPACE));
      } else {
        view.rerender(shell(OTHER_WORKSPACE));
        if (mode === "keeps its shell and switches back") view.rerender(shell(WORKSPACE));
      }
      await act(async () => {
        answer.reject(LEFT);
        await answer.promise.catch(() => undefined);
      });
      await nextTurn();

      expect(unhandled).toEqual([]);
      expect(bridge.reportRendererError).not.toHaveBeenCalled();
      expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
      await userEvent.setup().click(screen.getByTestId("notice-center-toggle"));
      const notices = await screen.findByTestId("notice-center");
      expect(within(notices).queryByText(/changed workspaces|could not show/)).toBeNull();
    },
  );
});
