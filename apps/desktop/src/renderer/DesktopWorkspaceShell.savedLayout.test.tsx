// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceUiState } from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { deferred, type Deferred } from "../testing/deferred";
import { CollectionFieldWriteHost } from "./collections/recordFieldWrites";
import type { Workspace } from "./DesktopWorkspaceShell";
import {
  DesktopWorkspaceShell,
  OTHER_WORKSPACE,
  STORED_STATE,
  SYNC_STATUS,
  WORKSPACE,
  makeBridge,
  shellBootstrapProps,
  storedStateWithTabs,
} from "./DesktopWorkspaceShell.testHarness";

// What a person sees and what is written, in order, for each ordinary way a
// workspace's saved layout loads. Each trace was recorded on the shell before
// the saved layout moved out of it, and must not change. Words and delays are
// spelled out here, not imported, so the trace does not follow the code.

const WAITED = "Your saved tabs didn't load within 4 minutes.";
const RESTORE = "Restore tabs brings them back. Until you pick it, tab changes aren't saved.";
const READ_LIMIT_MS = 4 * 60_000;
const COVER_LINES_MS = 5_000;
const SAVE_DELAY_MS = 500;
const refused = () => new Error("dohc has not finished opening this workspace.");
const stoppedRead = () => new Error(
  "Error invoking remote method 'desktop:get-workspace-ui-state': Error [stopped=read]: This workspace is no longer open in this window.",
);
const name = (workspaceId: string) => (workspaceId === WORKSPACE.workspaceId ? "A" : "B");

function layout(state: WorkspaceUiState): string {
  const groups = state.editorGroups
    .map((group) => group.tabs.map((tab) => (tab === group.activeTab ? `${tab}*` : tab)).join(" ") || "none")
    .join(" | ");
  return state.sidebarVisible ? groups : `${groups}, side panel hidden`;
}

// The window as a person sees it: what covers the workbench, the tabs (the
// active one starred), an open dialog, the side panel, a toast, and Notices.
function seen(): string {
  const parts: string[] = [];
  const cover = screen.queryByTestId("workspace-preparing");
  if (cover) {
    const lines = [...cover.querySelectorAll("p")].filter((line) => !line.classList.contains("invisible"));
    parts.push(`cover: ${lines.map((line) => line.textContent).join(" / ")}`);
  } else if (screen.queryByTestId("workspace-open-failed")) {
    parts.push("open failed");
  } else if (screen.queryByTestId("workspace-old-window")) {
    parts.push("old window");
  }
  if (screen.queryByTestId("workspace-workbench")?.hasAttribute("inert")) parts.push("inert");
  const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"][data-testid^="tab-"]')]
    .map((tab) => `${tab.dataset.testid!.slice("tab-".length)}${tab.dataset.active === "true" ? "*" : ""}`);
  parts.push(`tabs: ${tabs.join(" ") || "none"}`);
  if (!screen.queryByTestId("side-panel")) parts.push("side panel hidden");
  if (document.querySelector("[data-dohc-modal='true']")) parts.push("dialog open");
  const toast = screen.queryByTestId("workspace-shell-notice");
  if (toast) parts.push(`toast: ${toast.textContent}`);
  parts.push(screen.getByTestId("notice-center-toggle").getAttribute("aria-label")!);
  return parts.join(" | ");
}

type OldWindow = { openElsewhere: boolean } | null;

// Every layout read waits for the test, and every read, answer, write, and
// look at the window lands in one log. A write repeating the one before it is
// logged once; "unmount" and other marks separate them.
function recordedShell(options: { open?: () => Promise<typeof SYNC_STATUS> } = {}) {
  const log: string[] = [];
  const reads: Array<{ workspaceId: string; answer: Deferred<WorkspaceUiState | null> }> = [];
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    getWorkspaceUiState: vi.fn((payload: { workspaceId: string }) => {
      log.push(`read ${name(payload.workspaceId)}`);
      const answer = deferred<WorkspaceUiState | null>();
      reads.push({ workspaceId: payload.workspaceId, answer });
      return answer.promise;
    }),
    setWorkspaceUiState: vi.fn(async (payload: { workspaceId: string; state: WorkspaceUiState }) => {
      const entry = `write ${name(payload.workspaceId)}: ${layout(payload.state)}`;
      if (log.at(-1) !== entry) log.push(entry);
    }),
  });
  if (options.open) bridge.openWorkspace = vi.fn(options.open);
  bridge.exportWorkspaceZip.mockImplementation(async () => {
    log.push("export ran");
    return { status: "cancelled" } as never;
  });
  vi.stubGlobal("dohcDesktop", bridge);
  const shell = (workspace: Workspace, oldWindow: OldWindow) => (
    <>
      <CollectionFieldWriteHost />
      <DesktopWorkspaceShell
        workspace={workspace}
        workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
        oldWindow={oldWindow}
      />
    </>
  );
  const view = render(shell(WORKSPACE, null));
  const look = () => log.push(`seen: ${seen()}`);
  const settle = async (index: number) => {
    await act(async () => {
      await reads[index]!.answer.promise.catch(() => undefined);
    });
    await act(async () => {});
  };
  return {
    bridge,
    log,
    reads,
    look,
    mark: (words: string) => log.push(words),
    show: (workspace: Workspace, oldWindow: OldWindow = null) => view.rerender(shell(workspace, oldWindow)),
    unmount: () => {
      log.push("unmount");
      view.unmount();
    },
    // Waits for read `index` to be asked, then answers it.
    answer: async (index: number, state: WorkspaceUiState | null) => {
      await waitFor(() => expect(reads.length).toBeGreaterThan(index));
      log.push(`answer ${index + 1}: ${state ? layout(state) : "nothing saved"}`);
      reads[index]!.answer.resolve(state);
      await settle(index);
    },
    fail: async (index: number, error: Error = refused()) => {
      await waitFor(() => expect(reads.length).toBeGreaterThan(index));
      log.push(`answer ${index + 1}: ${error.message.includes("stopped=read") ? "fails, window stopped" : "fails"}`);
      reads[index]!.answer.reject(error);
      await settle(index);
    },
    // Lets saving's delay pass.
    wait: (ms = SAVE_DELAY_MS + 100) => act(() => vi.advanceTimersByTimeAsync(ms)),
  };
}

const ready = () => waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
const coverGone = () => waitFor(() => expect(screen.queryByTestId("workspace-preparing")).toBeNull());
const unload = () => window.dispatchEvent(new Event("beforeunload"));
const activity = (workspaceId = WORKSPACE.workspaceId) => act(() => (window.dohcDesktop as unknown as ReturnType<typeof makeBridge>).emitWorkspaceActivity({ workspaceId }));

async function pressRestoreTabs() {
  fireEvent.click(screen.getByTestId("notice-center-toggle"));
  const center = await screen.findByTestId("notice-center");
  const row = (await within(center).findByText(new RegExp(`^${RESTORE.slice(0, 20)}`))).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "Restore tabs" }));
  fireEvent.click(screen.getByTestId("notice-center-toggle"));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the saved layout, as a person sees it and as it is written", () => {
  it("opens with a saved layout", async () => {
    const shell = recordedShell();
    await ready();
    shell.look();
    unload();
    shell.mark("window unloads");
    await shell.answer(0, STORED_STATE);
    await coverGone();
    shell.look();
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual([
      "read A",
      "seen: cover: Preparing this workspace | inert | tabs: none | Notices",
      "window unloads",
      "answer 1: b.md*",
      "seen: tabs: b.md* | Notices",
      "write A: b.md*",
      "unmount",
      "write A: b.md*",
    ]);
  });

  it("opens with nothing saved", async () => {
    const shell = recordedShell();
    await ready();
    await shell.answer(0, null);
    await coverGone();
    shell.look();
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual([
      "read A",
      "answer 1: nothing saved",
      "seen: tabs: none | Notices",
      "unmount",
      "write A: none",
    ]);
  });

  it("opens on the defaults when the read fails, reads again at once, and saves nothing", async () => {
    const shell = recordedShell();
    await ready();
    await shell.fail(0);
    await coverGone();
    shell.look();
    await shell.wait();
    unload();
    shell.mark("window unloads");
    shell.unmount();

    expect(shell.log).toEqual([
      "read A",
      "answer 1: fails",
      "read A",
      "seen: tabs: none | Notices",
      "window unloads",
      "unmount",
    ]);
  });

  it("says what the cover waits for once a read is slow, then lifts with the saved layout", async () => {
    const shell = recordedShell();
    await ready();
    shell.look();
    await shell.wait(COVER_LINES_MS - 1_000);
    shell.mark("4 seconds after admission");
    shell.look();
    await shell.wait(1_000);
    shell.mark("5 seconds after admission");
    shell.look();
    await shell.answer(0, STORED_STATE);
    await coverGone();
    shell.look();
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual([
      "read A",
      "seen: cover: Preparing this workspace | inert | tabs: none | Notices",
      "4 seconds after admission",
      "seen: cover: Preparing this workspace | inert | tabs: none | Notices",
      "5 seconds after admission",
      "seen: cover: Preparing this workspace / dohc is still waiting for this workspace to open, so it can bring back your saved tabs. / Choose another workspace from the title bar. | inert | tabs: none | Notices",
      "answer 1: b.md*",
      "seen: tabs: b.md* | Notices",
      "write A: b.md*",
      "unmount",
      "write A: b.md*",
    ]);
  });

  it.each([
    ["the read then works", "works"],
    ["the read then fails", "fails"],
  ] as const)("reads nothing until Try again opens a workspace that failed to open, and %s", async (_, outcome) => {
    let opens = 0;
    const shell = recordedShell({
      open: async () => {
        opens += 1;
        if (opens === 1) throw new Error("engine refused");
        return SYNC_STATUS;
      },
    });
    const failed = await screen.findByTestId("workspace-open-failed");
    await act(async () => {});
    shell.look();
    unload();
    shell.mark("window unloads");
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    shell.mark("Try again");
    await ready();
    shell.look();
    if (outcome === "works") await shell.answer(0, STORED_STATE);
    else await shell.fail(0);
    await coverGone();
    shell.look();
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual(outcome === "works"
      ? [
        "seen: open failed | inert | tabs: none | Notices",
        "window unloads",
        "Try again",
        "read A",
        "seen: cover: Preparing this workspace | inert | tabs: none | Notices",
        "answer 1: b.md*",
        "seen: tabs: b.md* | Notices",
        "write A: b.md*",
        "unmount",
        "write A: b.md*",
      ]
      : [
        "seen: open failed | inert | tabs: none | Notices",
        "window unloads",
        "Try again",
        "read A",
        "seen: cover: Preparing this workspace | inert | tabs: none | Notices",
        "answer 1: fails",
        "read A",
        "seen: tabs: none | Notices",
        "unmount",
      ]);
  });

  it("restores the saved layout on activity after a failed read when no tab is open, and saving starts", async () => {
    const shell = recordedShell();
    await ready();
    await shell.fail(0);
    await shell.fail(1);
    await coverGone();
    act(() => shell.bridge.emitMenuCommand("toggle-sidebar"));
    shell.mark("toggle side panel");
    shell.look();
    await shell.wait();
    await activity();
    shell.mark("activity");
    await shell.answer(2, STORED_STATE);
    shell.look();
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual([
      "read A",
      "answer 1: fails",
      "read A",
      "answer 2: fails",
      "toggle side panel",
      "seen: tabs: none | side panel hidden | Notices",
      "read A",
      "activity",
      "answer 3: b.md*",
      "seen: tabs: b.md* | Notices",
      "write A: b.md*",
      "unmount",
      "write A: b.md*",
    ]);
  });

  it("reads once at a time when activity comes during a read after a failed one", async () => {
    const shell = recordedShell();
    await ready();
    await shell.fail(0);
    await waitFor(() => expect(shell.reads).toHaveLength(2));
    await activity();
    shell.mark("activity while read 2 runs");
    await act(async () => {});
    await shell.fail(1);
    await shell.answer(2, null);
    shell.look();
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual([
      "read A",
      "answer 1: fails",
      "read A",
      "activity while read 2 runs",
      "answer 2: fails",
      "read A",
      "answer 3: nothing saved",
      "seen: tabs: none | Notices",
      "write A: none",
      "unmount",
      "write A: none",
    ]);
  });

  it("offers Restore tabs when a later read works while a tab is open, and saves nothing until it is picked", async () => {
    const shell = recordedShell();
    await ready();
    await shell.fail(0);
    await shell.fail(1);
    await coverGone();
    act(() => shell.bridge.emitWorkspaceActivated(WORKSPACE, "a.md"));
    shell.mark("the OS opens a.md");
    await screen.findByTestId("tab-a.md");
    await activity();
    shell.mark("activity");
    await shell.answer(2, STORED_STATE);
    shell.look();
    await shell.wait();
    act(() => shell.bridge.emitMenuCommand("toggle-sidebar"));
    shell.mark("toggle side panel");
    await shell.wait();
    await pressRestoreTabs();
    shell.mark("Restore tabs");
    await screen.findByTestId("tab-b.md");
    shell.look();
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual([
      "read A",
      "answer 1: fails",
      "read A",
      "answer 2: fails",
      "the OS opens a.md",
      "read A",
      "activity",
      "answer 3: b.md*",
      "seen: tabs: a.md* | Notices, 1 unread",
      "toggle side panel",
      "Restore tabs",
      "seen: tabs: b.md a.md* | Notices",
      "write A: b.md a.md*",
      "unmount",
      "write A: b.md a.md*",
    ]);
  });

  it("says when the reads have waited 4 minutes, and takes it back when a read works", async () => {
    const shell = recordedShell();
    await ready();
    await waitFor(() => expect(shell.reads).toHaveLength(1));
    vi.setSystemTime(Date.now() + READ_LIMIT_MS);
    shell.mark("4 minutes pass");
    await shell.fail(0);
    await screen.findByTestId("workspace-shell-notice");
    shell.look();
    await shell.answer(1, STORED_STATE);
    shell.look();
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual([
      "read A",
      "4 minutes pass",
      "answer 1: fails",
      "read A",
      "seen: tabs: none | toast: dohc opened this workspace without your saved tabsYour saved tabs didn't load within 4 minutes. They come back the next time the workspace opens. Until then, tab changes aren't saved.Details | Notices, 1 unread",
      "answer 2: b.md*",
      "seen: tabs: b.md* | Notices",
      "write A: b.md*",
      "unmount",
      "write A: b.md*",
    ]);
  });

  it("stops reading, and says nothing, when a read fails because the window stopped", async () => {
    const shell = recordedShell();
    await ready();
    await shell.fail(0);
    await shell.fail(1, stoppedRead());
    await activity();
    shell.mark("activity");
    await shell.wait(READ_LIMIT_MS + 1_000);
    shell.mark("4 minutes pass");
    shell.look();
    shell.unmount();

    expect(shell.log).toEqual([
      "read A",
      "answer 1: fails",
      "read A",
      "answer 2: fails, window stopped",
      "activity",
      "4 minutes pass",
      "seen: tabs: none | Notices",
      "unmount",
    ]);
  });

  it("drops commands under the cover except Settings, and runs them once the layout applies", async () => {
    const shell = recordedShell();
    await ready();
    act(() => {
      shell.bridge.emitMenuCommand("toggle-sidebar");
      shell.bridge.emitMenuCommand("export-workspace");
    });
    shell.mark("toggle side panel, export");
    act(() => shell.bridge.emitMenuCommand("settings"));
    shell.mark("Settings");
    await waitFor(() => expect(document.querySelector("[data-dohc-modal='true']")).not.toBeNull());
    shell.look();
    await shell.answer(0, STORED_STATE);
    await coverGone();
    shell.look();
    fireEvent.keyDown(document.querySelector("[data-dohc-modal='true']")!, { key: "Escape" });
    await waitFor(() => expect(document.querySelector("[data-dohc-modal='true']")).toBeNull());
    act(() => shell.bridge.emitMenuCommand("toggle-sidebar"));
    shell.mark("toggle side panel");
    shell.look();
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual([
      "read A",
      "toggle side panel, export",
      "Settings",
      "seen: cover: Preparing this workspace | inert | tabs: none | dialog open | Notices",
      "answer 1: b.md*",
      "seen: tabs: b.md* | dialog open | Notices",
      "toggle side panel",
      "seen: tabs: b.md* | side panel hidden | Notices",
      "write A: b.md*, side panel hidden",
      "unmount",
      "write A: b.md*, side panel hidden",
    ]);
  });

  it("holds files opened before the workspace opens and under the cover, and opens them in order after the layout", async () => {
    const open = deferred<typeof SYNC_STATUS>();
    const shell = recordedShell({ open: () => open.promise });
    await waitFor(() => expect(shell.bridge.openWorkspace).toHaveBeenCalledOnce());
    act(() => shell.bridge.emitWorkspaceActivated(WORKSPACE, "a.md"));
    shell.mark("the OS opens a.md before admission");
    await act(async () => open.resolve(SYNC_STATUS));
    await ready();
    act(() => shell.bridge.emitWorkspaceActivated(WORKSPACE, "c.md"));
    shell.mark("the OS opens c.md under the cover");
    shell.look();
    await shell.answer(0, storedStateWithTabs(["b.md"]));
    await screen.findByTestId("tab-c.md");
    shell.look();
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual([
      "the OS opens a.md before admission",
      "read A",
      "the OS opens c.md under the cover",
      "seen: cover: Preparing this workspace | inert | tabs: none | Notices",
      "answer 1: b.md*",
      "seen: tabs: b.md a.md c.md* | Notices",
      "write A: b.md a.md c.md*",
      "unmount",
      "write A: b.md a.md c.md*",
    ]);
  });

  it("closes restored tabs whose files are gone once the files are listed", async () => {
    const shell = recordedShell();
    await ready();
    await shell.answer(0, storedStateWithTabs(["b.md", "gone.md"], "gone.md"));
    await waitFor(() => expect(screen.queryByTestId("tab-gone.md")).toBeNull());
    shell.look();
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual([
      "read A",
      "answer 1: b.md gone.md*",
      "seen: tabs: b.md* | Notices",
      "write A: b.md*",
      "unmount",
      "write A: b.md*",
    ]);
  });

  it("reads and saves only for the workspace shown, A then B then A in one shell", async () => {
    const opens: Array<Deferred<typeof SYNC_STATUS>> = [];
    const shell = recordedShell({
      open: () => {
        const status = deferred<typeof SYNC_STATUS>();
        opens.push(status);
        return status.promise;
      },
    });
    await waitFor(() => expect(opens).toHaveLength(1));
    await act(async () => opens[0]!.resolve(SYNC_STATUS));
    await shell.answer(0, storedStateWithTabs(["a.md"]));
    await coverGone();
    shell.look();
    await shell.wait();
    shell.show(OTHER_WORKSPACE);
    shell.mark("show B");
    await waitFor(() => expect(opens).toHaveLength(2));
    shell.look();
    await shell.wait();
    shell.show(WORKSPACE);
    shell.mark("show A");
    await waitFor(() => expect(opens).toHaveLength(3));
    await shell.wait();
    await act(async () => opens[1]!.resolve(SYNC_STATUS));
    shell.mark("B's open answers");
    await act(async () => {});
    shell.look();
    await act(async () => opens[2]!.resolve(SYNC_STATUS));
    shell.mark("A's second open answers");
    await shell.answer(1, storedStateWithTabs(["b.md"]));
    await coverGone();
    shell.look();
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual([
      "read A",
      "answer 1: a.md*",
      "seen: tabs: a.md* | Notices",
      "write A: a.md*",
      "show B",
      "seen: cover: Preparing this workspace / dohc is checking your existing files before editing starts. | inert | tabs: a.md* | Notices",
      "write B: a.md*",
      "show A",
      "write A: a.md*",
      "B's open answers",
      "seen: cover: Preparing this workspace / dohc is checking your existing files before editing starts. | inert | tabs: a.md* | Notices",
      "read A",
      "A's second open answers",
      "answer 2: b.md*",
      "seen: tabs: b.md* | Notices",
      "write A: b.md*",
      "unmount",
      "write A: b.md*",
    ]);
  });

  it("neither reads again nor stops saving when Forget leaves the window and the workspace is activated again", async () => {
    const shell = recordedShell();
    await ready();
    await shell.answer(0, STORED_STATE);
    await coverGone();
    await shell.wait();
    shell.show(WORKSPACE, { openElsewhere: false });
    shell.mark("forgotten");
    await act(async () => {});
    shell.look();
    act(() => shell.bridge.emitWorkspaceActivated(WORKSPACE));
    shell.mark("activated again");
    shell.show(WORKSPACE, null);
    shell.mark("the window may edit it again");
    await act(async () => {});
    shell.look();
    act(() => shell.bridge.emitMenuCommand("toggle-sidebar"));
    shell.mark("toggle side panel");
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual([
      "read A",
      "answer 1: b.md*",
      "write A: b.md*",
      "forgotten",
      "seen: old window | inert | tabs: b.md* | Notices",
      "activated again",
      "the window may edit it again",
      "seen: tabs: b.md* | Notices",
      "toggle side panel",
      "write A: b.md*, side panel hidden",
      "unmount",
      "write A: b.md*, side panel hidden",
    ]);
  });

  it("saves nothing when the app closes during restoration, and the newest layout when it closes after", async () => {
    const shell = recordedShell();
    await ready();
    unload();
    shell.mark("window unloads under the cover");
    shell.unmount();
    await shell.answer(0, STORED_STATE);

    const again = recordedShell();
    await ready();
    await again.answer(0, STORED_STATE);
    await coverGone();
    await again.wait();
    act(() => again.bridge.emitMenuCommand("toggle-sidebar"));
    again.mark("toggle side panel");
    unload();
    again.mark("window unloads at once");
    again.unmount();

    expect([...shell.log, "--", ...again.log]).toEqual([
      "read A",
      "window unloads under the cover",
      "unmount",
      "answer 1: b.md*",
      "--",
      "read A",
      "answer 1: b.md*",
      "write A: b.md*",
      "toggle side panel",
      "write A: b.md*, side panel hidden",
      "window unloads at once",
      "unmount",
      "write A: b.md*, side panel hidden",
    ]);
  });

  describe("after an update", () => {
    const SEEN_KEY = "dohc.whatsNew.seen";
    beforeEach(() => {
      localStorage.setItem(SEEN_KEY, "an-older-release");
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: { request: (_name: string, take: () => unknown) => Promise.resolve(take()) },
      });
    });
    afterEach(() => {
      localStorage.removeItem(SEEN_KEY);
      Reflect.deleteProperty(navigator, "locks");
    });

    it("opens What's new over the restored file and ends the switch on it", async () => {
      const before = rendererMarks.readSwitchTimeline().at(-1)?.ordinal ?? 0;
      const shell = recordedShell();
      await ready();
      await shell.answer(0, STORED_STATE);
      await screen.findByTestId("whats-new-page");
      shell.look();
      await waitFor(() => expect(rendererMarks.readSwitchTimeline().find((entry) => entry.ordinal > before)?.phases["restored-active-surface-ready"]).toEqual(expect.any(Number)));
      shell.mark("restored surface ready");
      await shell.wait();
      shell.unmount();

      expect(shell.log).toEqual([
        "read A",
        "answer 1: b.md*",
        "seen: tabs: b.md dohc://whats-new* | Notices",
        "restored surface ready",
        "write A: b.md tab://whats-new*",
        "unmount",
        "write A: b.md tab://whats-new*",
      ]);
    });
  });

  it.each([
    ["a restored file, once its editor shows", STORED_STATE],
    ["nothing restored, at once", null],
  ] as const)("ends the switch on %s", async (_, stored) => {
    const before = rendererMarks.readSwitchTimeline().at(-1)?.ordinal ?? 0;
    const phase = () => rendererMarks.readSwitchTimeline().find((entry) => entry.ordinal > before)?.phases["restored-active-surface-ready"] !== undefined;
    const shell = recordedShell();
    await ready();
    shell.mark(`surface ready before the read answers: ${phase()}`);
    await shell.answer(0, stored);
    await coverGone();
    if (stored) await screen.findByTestId("view-markdown");
    await waitFor(() => expect(phase()).toBe(true));
    shell.look();
    await shell.wait();
    shell.unmount();

    expect(shell.log).toEqual(stored
      ? [
        "read A",
        "surface ready before the read answers: false",
        "answer 1: b.md*",
        "seen: tabs: b.md* | Notices",
        "write A: b.md*",
        "unmount",
        "write A: b.md*",
      ]
      : [
        "read A",
        "surface ready before the read answers: false",
        "answer 1: nothing saved",
        "seen: tabs: none | Notices",
        "unmount",
        "write A: none",
      ]);
  });
});
