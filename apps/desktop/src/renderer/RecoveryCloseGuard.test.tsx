// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./ErrorBoundary";
import {
  RecoveryCloseGuard,
  requestGuardedUpdateInstall,
} from "./RecoveryCloseGuard";
import { captureOrphanedDraft, resetOrphanedDrafts } from "./orphanedDrafts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetOrphanedDrafts();
});

// #567 / #579 review r4+r5: set-aside drafts live in renderer memory only,
// so closing or reloading the window is the one irreversible exit. The guard
// announces it first — and carries the full recovery list, so the warning
// offers the very actions it demands.
describe("RecoveryCloseGuard", () => {
  it("warns before closing while set-aside edits exist, offers the list, and closes on 'Close anyway'", async () => {
    const user = userEvent.setup();
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    // The guard is deliberately GLOBAL (#579 review, r6): the whole renderer
    // dies at once, so every workspace's drafts are at stake here.
    captureOrphanedDraft("ws-2", "other.md", "Also kept!");
    render(
      <RecoveryCloseGuard>
        <div data-testid="app-content" />
      </RecoveryCloseGuard>,
    );
    screen.getByTestId("app-content");

    // MUTATION (close guard): remove the beforeunload interception. The
    // close proceeds unannounced and every set-aside edit dies with it.
    const first = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(first);
    });
    expect(first.defaultPrevented).toBe(true);
    await screen.findByTestId("recovery-close-warning");

    // The dialog carries the recovery itself (#579 review, r5): Copy works
    // right here, path-labeled, whether or not the file still exists — and
    // BOTH workspaces' drafts are listed.
    // MUTATION (dialog list): drop <RecoveryList /> from the dialog — the
    // warning then demands actions it does not offer.
    const rows = screen.getAllByTestId("recovery-list-row");
    expect(rows).toHaveLength(2);
    const row = rows.find((candidate) =>
      candidate.textContent?.includes("a.md"),
    )!;
    expect(rows.some((candidate) => candidate.textContent?.includes("other.md"))).toBe(
      true,
    );
    // The GLOBAL list names each row's workspace — two workspaces can hold
    // the same path, and Copy/Dismiss must be tellable apart (#579 review,
    // r7).
    // MUTATION (workspace labels): drop the label span. Identical paths
    // from two workspaces are indistinguishable.
    const labels = screen
      .getAllByTestId("recovery-list-workspace")
      .map((label) => label.textContent);
    expect(labels).toContain("ws-1");
    expect(labels).toContain("ws-2");
    await user.click(within(row).getByTestId("recovery-list-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Kept!"),
    );

    // Go back keeps everything.
    await user.click(screen.getByTestId("recovery-close-goback"));
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();

    // Close anyway releases the guard and re-runs the close.
    const closeSpy = vi
      .spyOn(window, "close")
      .mockImplementation(() => undefined);
    const second = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(second);
    });
    await user.click(await screen.findByTestId("recovery-close-anyway"));
    expect(closeSpy).toHaveBeenCalled();
    const third = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(third);
    });
    expect(third.defaultPrevented).toBe(false);
    closeSpy.mockRestore();
  });

  it("does not intercept closing when no set-aside edits exist", async () => {
    render(
      <RecoveryCloseGuard>
        <div data-testid="app-content" />
      </RecoveryCloseGuard>,
    );
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();
  });

  it("dismissing the last draft from the dialog is resolution — the next close proceeds", async () => {
    const user = userEvent.setup();
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    const first = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(first);
    });
    await screen.findByTestId("recovery-close-warning");

    // Dismiss deletes the ONLY copy, so the destructive path REQUIRES the
    // confirm step (#579 review, r6): the first click arms it and deletes
    // nothing, and Keep backs out whole.
    // MUTATION (confirm gate): make the Dismiss button delete directly. The
    // row is gone right here and the assertions below fail.
    await user.click(screen.getByTestId("recovery-dismiss"));
    expect(screen.getByTestId("recovery-list-row")).toBeTruthy();
    await user.click(screen.getByTestId("recovery-dismiss-cancel"));
    expect(screen.getByTestId("recovery-list-row")).toBeTruthy();
    expect(screen.queryByTestId("recovery-dismiss-confirm")).toBeNull();

    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await user.click(screen.getByTestId("recovery-close-goback"));

    const second = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(false);
  });

  // #579 review r7: the user asked for a RELOAD by name; the guard's confirm
  // must resume that action, never swap it for an exit.
  it("a blocked reload resumes as a reload, never an exit", async () => {
    const user = userEvent.setup();
    const reloadRenderer = vi.fn(async () => undefined);
    vi.stubGlobal("dohcDesktop", { reloadRenderer });
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    const Thrower = (): never => {
      throw new Error("boom");
    };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    render(
      <RecoveryCloseGuard>
        <AppErrorBoundary>
          <Thrower />
        </AppErrorBoundary>
      </RecoveryCloseGuard>,
    );
    consoleError.mockRestore();

    // The crash screen's "Reload dohc": the request reaches main once, and
    // Electron then fires beforeunload — simulated here.
    await user.click(screen.getByTestId("app-crash-reload"));
    expect(reloadRenderer).toHaveBeenCalledTimes(1);
    const blocked = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(blocked);
    });
    expect(blocked.defaultPrevented).toBe(true);
    await screen.findByTestId("recovery-close-warning");
    expect(screen.getByTestId("recovery-close-anyway").textContent).toBe(
      "Reload anyway",
    );

    // MUTATION (retain the action): make the confirm call window.close()
    // unconditionally. The user asked to RELOAD and gets an exit.
    const closeSpy = vi
      .spyOn(window, "close")
      .mockImplementation(() => undefined);
    await user.click(screen.getByTestId("recovery-close-anyway"));
    expect(reloadRenderer).toHaveBeenCalledTimes(2);
    expect(closeSpy).not.toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  // #579 review r8: an update restart (quit-and-install) is another named
  // action; the guard's confirm must resume the UPDATE, not swap it for a
  // plain close that leaves the app running without the update.
  it("a blocked update restart resumes as the update, never a plain exit", async () => {
    const user = userEvent.setup();
    const installUpdate = vi.fn(async () => ({
      accepted: true,
      completed: false,
      state: {
        status: "ready" as const,
        message: "Update 1.2.4 is ready.",
        currentVersion: "1.2.3",
        channel: "latest",
        canCheck: false,
        canInstall: true,
        version: "1.2.4",
      },
    }));
    vi.stubGlobal("dohcDesktop", { installUpdate });
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );

    await requestGuardedUpdateInstall();
    expect(installUpdate).toHaveBeenCalledTimes(1);
    const blocked = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(blocked);
    });
    expect(blocked.defaultPrevented).toBe(true);
    await screen.findByTestId("recovery-close-warning");
    expect(screen.getByTestId("recovery-close-anyway").textContent).toBe(
      "Restart anyway",
    );

    // MUTATION (blocked-action slot): make the confirm call window.close()
    // for every kind. The user asked to restart into the update and the app
    // just closes — or on macOS keeps running without it.
    const closeSpy = vi
      .spyOn(window, "close")
      .mockImplementation(() => undefined);
    await user.click(screen.getByTestId("recovery-close-anyway"));
    expect(installUpdate).toHaveBeenCalledTimes(2);
    expect(closeSpy).not.toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it("a refused update install does not mislabel the next close as a restart", async () => {
    const installUpdate = vi.fn(async () => ({
      accepted: false,
      completed: false,
      state: {
        status: "idle" as const,
        message: "Updates have not been checked yet.",
        currentVersion: "1.2.3",
        channel: "latest",
        canCheck: true,
        canInstall: false,
      },
    }));
    vi.stubGlobal("dohcDesktop", { installUpdate });
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    // Main refused: nothing will unload, so the slot must clear — the next
    // plain close is a close.
    await requestGuardedUpdateInstall();
    const blocked = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(blocked);
    });
    await screen.findByTestId("recovery-close-warning");
    expect(screen.getByTestId("recovery-close-anyway").textContent).toBe(
      "Close anyway",
    );
  });

  // #579 review r5: the guard must survive a CRASH. A guard inside the
  // crashed tree unmounts with it, and the crash screen's "Reload dohc"
  // would destroy every draft silently.
  it("still warns above the crash screen, with the recovery list usable", async () => {
    const user = userEvent.setup();
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    const Thrower = (): never => {
      throw new Error("boom");
    };
    // React logs the caught error; keep the test output clean.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    render(
      <RecoveryCloseGuard>
        <AppErrorBoundary>
          <Thrower />
        </AppErrorBoundary>
      </RecoveryCloseGuard>,
    );
    consoleError.mockRestore();
    screen.getByTestId("app-crash-screen");

    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await screen.findByTestId("recovery-close-warning");
    await user.click(screen.getByTestId("recovery-list-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Kept!"),
    );
  });
});

// The wiring, not just the component: main.tsx must mount the guard ABOVE
// AppErrorBoundary. A crashed DesktopRoot leaves the crash screen up, and
// the reload it offers must still be announced.
// MUTATION (wiring): render `<AppErrorBoundary><DesktopRoot/></...>` alone
// in main.tsx (the pre-r5 shape). No guard ever mounts and the beforeunload
// below passes unprevented.
describe("main.tsx composition", () => {
  it("keeps the close guard alive above a crashed root", async () => {
    vi.doMock("./DesktopRoot", () => ({
      DesktopRoot: (): never => {
        throw new Error("boom");
      },
    }));
    // main.tsx runs initTheme(), which reads the OS theme; jsdom has no
    // matchMedia.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    const container = document.createElement("div");
    container.id = "root";
    document.body.appendChild(container);
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await import("./main");
      await screen.findByTestId("app-crash-screen");
    } finally {
      consoleError.mockRestore();
    }

    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await screen.findByTestId("recovery-close-warning");
    expect(screen.getByTestId("recovery-list-row").textContent).toContain(
      "a.md",
    );
    container.remove();
    vi.doUnmock("./DesktopRoot");
  });
});
