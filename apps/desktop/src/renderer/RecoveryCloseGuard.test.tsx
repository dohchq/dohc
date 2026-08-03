// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./ErrorBoundary";
import { RecoveryCloseGuard } from "./RecoveryCloseGuard";
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
    // right here, path-labeled, whether or not the file still exists.
    // MUTATION (dialog list): drop <RecoveryList /> from the dialog — the
    // warning then demands actions it does not offer.
    const row = screen.getByTestId("recovery-list-row");
    expect(row.textContent).toContain("a.md");
    await user.click(screen.getByTestId("recovery-list-copy"));
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
    await user.click(screen.getByTestId("recovery-list-dismiss"));
    await user.click(screen.getByTestId("recovery-close-goback"));

    const second = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(false);
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
