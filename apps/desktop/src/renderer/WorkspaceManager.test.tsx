// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "./DesktopWorkspaceShell";
import { deferred } from "../testing/deferred";
import { byRecency, openedLabel, WorkspaceManager } from "./WorkspaceManager";

const bridge = {
  getDefaultWorkspaceRoot: vi.fn(async () => "/home/ice/dohc"),
  pickWorkspaceRoot: vi.fn(async (): Promise<string | null> => "/home/ice/projects/research"),
  createLocalWorkspace: vi.fn(async () => ({
    workspaceId: "ws-1",
    rootPath: "/home/ice/dohc/personal",
    kind: "personal" as const,
    mode: "local-first" as const,
  })),
  attachWorkspaceFolder: vi.fn(async () => ({
    workspaceId: "ws-attached",
    rootPath: "/home/ice/projects/research",
    kind: "personal" as const,
    mode: "local-first" as const,
  })),
  getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
  listWorkspaceFiles: vi.fn(async () => ({ files: [] })),
  createWorkspaceFile: vi.fn(async () => ({ path: "notes/welcome.md" })),
  importWorkspaceFiles: vi.fn(async () => ({ imported: [], skipped: 0 })),
  cloudStatus: vi.fn(async () => ({ connected: false })),
  cloudJoinWorkspace: vi.fn(),
  listRelayShares: vi.fn(),
  retryShareHandoff: vi.fn(async () => undefined),
  dismissShareHandoff: vi.fn(async () => undefined),
  forgetWorkspace: vi.fn(async () => undefined),
  revealWorkspaceFolder: vi.fn(async () => undefined),
  openWorkspaceWindow: vi.fn(async () => undefined),
  openWorkspaceManager: vi.fn(async () => undefined),
  closeThisWindow: vi.fn(async () => undefined),
  windowRole: "workspace",
  platform: "linux",
};

const KNOWN = [
  { workspaceId: "ws-a", rootPath: "/home/ice/dohc/personal", kind: "personal" as const, mode: "local-first" as const },
  { workspaceId: "ws-b", rootPath: "/home/ice/dohc/team", kind: "personal" as const, mode: "local-first" as const },
];

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", bridge);
  // jsdom has no pointer capture; the resize handle only calls these.
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("workspace recency", () => {
  it("labels an open coarsely", () => {
    const now = 1_700_000_000_000;
    expect(openedLabel(now - 10_000, now)).toBe("now");
    expect(openedLabel(now - 5 * 60_000, now)).toBe("5m");
    expect(openedLabel(now - 3 * 60 * 60_000, now)).toBe("3h");
    expect(openedLabel(now - 30 * 60 * 60_000, now)).toBe("1d");
    expect(openedLabel(now - 4 * 24 * 60 * 60_000, now)).toBe("4d");
    expect(openedLabel(now - 20 * 24 * 60 * 60_000, now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it("sorts stamped rows newest first and keeps unstamped rows last in order", () => {
    const rows = [
      { ...KNOWN[0] },
      { ...KNOWN[1], lastOpenedAt: 5 },
      { ...KNOWN[0], workspaceId: "ws-c", lastOpenedAt: 9 },
      { ...KNOWN[0], workspaceId: "ws-d" },
    ];
    expect(byRecency(rows).map((row) => row.workspaceId)).toEqual(["ws-c", "ws-b", "ws-a", "ws-d"]);
  });
});

describe("workspace manager", () => {
  it("places a browser share handoff ahead of the ordinary first-run card", async () => {
    const onDismissShareHandoff = vi.fn();
    render(
      <WorkspaceManager
        workspaces={[]}
        current={null}
        onForgot={async () => []}
        onOpenWorkspace={() => {}}
        handoffStatus={{
          status: "waiting-for-sign-in",
          statusId: "status-test",
        }}
        onDismissShareHandoff={onDismissShareHandoff}
        onShareHandoffOpened={() => {}}
      />,
    );

    expect(
      await screen.findByText("Sign in to open the share from your browser."),
    ).toBeTruthy();
    expect(screen.getByTestId("cloud-sync-panel")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /create workspace/i })).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: "Back" }));
    expect(onDismissShareHandoff).toHaveBeenCalledOnce();
  });

  it("suggests ~/dohc as the workspace location", async () => {
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    expect(await screen.findByText("/home/ice/dohc/")).toBeTruthy();
    expect(screen.getByLabelText("Folder name")).toHaveProperty("value", "personal");
  });

  it("creates the folder under the name the user typed", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    const name = await screen.findByLabelText("Folder name");
    await user.clear(name);
    await user.type(name, "research{Enter}");
    expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/home/ice/dohc/research" }),
    );
  });

  it("refuses an empty or nested folder name", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    const name = await screen.findByLabelText("Folder name");
    const create = screen.getByRole("button", { name: /create workspace/i });
    await user.clear(name);
    expect(create).toHaveProperty("disabled", true);
    await user.type(name, "a/b");
    expect(create).toHaveProperty("disabled", true);
  });

  it("lets the user choose another folder", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await user.click(
      await screen.findByRole("button", { name: "Change location" }),
    );
    expect(bridge.pickWorkspaceRoot).toHaveBeenCalledOnce();
    expect(await screen.findByText("/home/ice/projects/research/")).toBeTruthy();
  });

  it("creates a personal workspace and hands it to the shell", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={onReady} />);
    await user.click(
      await screen.findByRole("button", { name: /create workspace/i }),
    );
    expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "personal",
        rootPath: "/home/ice/dohc/personal",
      }),
    );
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
    );
  });

  it("reports default workspace root failures and still lets the person pick a folder", async () => {
    const user = userEvent.setup();
    bridge.getDefaultWorkspaceRoot.mockRejectedValueOnce(new Error("No home dir"));

    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);

    expect(await screen.findByText("No home dir")).toBeTruthy();
    const change = screen.getByRole("button", { name: "Change location" });
    expect(change).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: /create workspace/i })).toHaveProperty("disabled", true);

    await user.click(change);
    expect(await screen.findByText("/home/ice/projects/research/")).toBeTruthy();
    expect(screen.queryByText("No home dir")).toBeNull();
    expect(screen.getByRole("button", { name: /create workspace/i })).toHaveProperty("disabled", false);
  });

  it("shows a picker failure and keeps a slow default from overwriting a picked folder", async () => {
    const user = userEvent.setup();
    const slowDefault = deferred<string>();
    bridge.getDefaultWorkspaceRoot.mockReturnValueOnce(slowDefault.promise);
    bridge.pickWorkspaceRoot.mockRejectedValueOnce(new Error("Dialog unavailable"));

    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    const change = await screen.findByRole("button", { name: "Change location" });
    await user.click(change);
    expect(await screen.findByText("Dialog unavailable")).toBeTruthy();

    await user.click(change);
    expect(await screen.findByText("/home/ice/projects/research/")).toBeTruthy();
    await act(async () => slowDefault.resolve("/home/ice/dohc"));
    expect(screen.getByText("/home/ice/projects/research/")).toBeTruthy();
    expect(screen.queryByText("/home/ice/dohc/")).toBeNull();
  });

  it("asks for the default again when the picker is cancelled before any default arrived", async () => {
    const user = userEvent.setup();
    const slowDefault = deferred<string>();
    bridge.getDefaultWorkspaceRoot.mockReturnValueOnce(slowDefault.promise);
    bridge.pickWorkspaceRoot.mockResolvedValueOnce(null);

    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    const change = await screen.findByRole("button", { name: "Change location" });
    await user.click(change);
    expect(bridge.getDefaultWorkspaceRoot).toHaveBeenCalledTimes(2);
    // The retired first answer lands and changes nothing; the second fills
    // the card.
    await act(async () => slowDefault.resolve("/home/ice/stale"));
    expect(screen.queryByText("/home/ice/stale/")).toBeNull();
    expect(await screen.findByText("/home/ice/dohc/")).toBeTruthy();
    expect(screen.getByRole("button", { name: /create workspace/i })).toHaveProperty("disabled", false);
  });

  it("attaches an existing folder as a workspace", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={onReady} />);
    await user.click(
      await screen.findByRole("button", { name: /open an existing folder/i }),
    );
    expect(bridge.attachWorkspaceFolder).toHaveBeenCalledWith({
      rootPath: "/home/ice/projects/research",
    });
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-attached" }),
    );
  });

  it("never requires login and never renders auth fields", async () => {
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await screen.findByText("/home/ice/dohc/");
    expect(screen.queryByLabelText(/email|password/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /sign in|log in|sign up/i }))
      .toBeNull();
  });

  it("offers joining a synced workspace, gated on sign-in", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await screen.findByText("/home/ice/dohc/");
    await user.click(
      screen.getByTestId("first-run-join-synced"),
    );
    expect(await screen.findByTestId("join-synced-workspace")).toBeTruthy();
    // No session yet: the panel asks for sign-in before showing the code
    // field, and the normal cloud sign-in is embedded right there.
    expect(
      await screen.findByText(/sign in first, then enter the code/i),
    ).toBeTruthy();
    expect(screen.queryByTestId("join-sync-code")).toBeNull();
    // Back returns to the normal first-run card.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("button", { name: /create workspace/i }),
    ).toBeTruthy();
  });

  it("reads like a desktop app, not a marketing page", async () => {
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await screen.findByText("/home/ice/dohc/");
    // No marketing tropes: pricing, testimonials, feature grids, sign-up CTAs.
    expect(
      screen.queryByText(/get started free|pricing|testimonial|trusted by/i),
    ).toBeNull();
    // The primary action is creating a real workspace folder.
    expect(
      screen.getByRole("button", { name: /create workspace/i }),
    ).toBeTruthy();
  });
});

describe("workspace manager with registered workspaces", () => {
  it("lists them with their paths and opens one on click", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <WorkspaceManager workspaces={KNOWN} current={KNOWN[0]} onForgot={async () => KNOWN} onOpenWorkspace={onOpen} />,
    );
    const rows = await screen.findAllByTestId("workspace-manager-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("/home/ice/dohc/team")).toBeTruthy();
    await user.click(screen.getByText("team"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-b" }));
  });

  it("lists the most recently opened workspace first and says when", async () => {
    const now = Date.now();
    const stamped = [
      { ...KNOWN[0], lastOpenedAt: now - 3 * 24 * 60 * 60_000 },
      { ...KNOWN[1], lastOpenedAt: now - 5 * 60_000 },
      { workspaceId: "ws-c", rootPath: "/home/ice/dohc/never", kind: "personal" as const, mode: "local-first" as const },
    ];
    render(
      <WorkspaceManager workspaces={stamped} current={null} onForgot={async () => stamped} onOpenWorkspace={() => {}} />,
    );
    const rows = await screen.findAllByTestId("workspace-manager-row");
    expect(rows.map((row) => row.getAttribute("data-workspace-id"))).toEqual(["ws-b", "ws-a", "ws-c"]);
    expect(rows[0]?.querySelector("time")?.textContent).toBe("5m");
    expect(rows[1]?.querySelector("time")?.textContent).toBe("3d");
    expect(rows[2]?.querySelector("time")).toBeNull();
  });

  it("resizes the list by drag and keyboard and remembers the width", () => {
    render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
    );
    const list = screen.getByTestId("workspace-manager-list");
    const handle = screen.getByTestId("workspace-manager-list-resize");
    expect(list.style.width).toBe("320px");
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 400, pointerId: 1 });
    expect(list.style.width).toBe("400px");
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(list.style.width).toBe("400px");
    expect(window.localStorage.getItem("dohc.workspace-manager.list-width")).toBe("400");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(list.style.width).toBe("384px");
    fireEvent.keyDown(handle, { key: "End" });
    expect(list.style.width).toBe("560px");
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, pointerId: 2 });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 10, pointerId: 2 });
    expect(list.style.width, "clamped to the minimum").toBe("220px");
  });

  it("forgets a workspace, refreshes, and says the folder was kept", async () => {
    const user = userEvent.setup();
    const onForgot = vi.fn(async () => [KNOWN[0]]);
    render(
      <WorkspaceManager workspaces={KNOWN} current={KNOWN[0]} onForgot={onForgot} onOpenWorkspace={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "More for team" }));
    await user.click(screen.getByRole("menuitem", { name: "Forget" }));
    expect(bridge.forgetWorkspace).toHaveBeenCalledWith({ workspaceId: "ws-b" });
    expect(onForgot).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Forgot team\. Its folder was not deleted\./)).toBeTruthy();
  });

  it("stays open with the reason when opening fails, then lets the person retry", async () => {
    const user = userEvent.setup();
    const onOpen = vi
      .fn<(workspace: Workspace) => Promise<void>>()
      .mockRejectedValueOnce(
        new Error("Error invoking remote method 'desktop:open-workspace-window': Error: That folder is gone."),
      )
      .mockResolvedValueOnce(undefined);
    render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={onOpen} />,
    );
    await user.click(await screen.findByText("team"));
    expect((await screen.findByRole("alert")).textContent).toBe("That folder is gone.");
    expect(screen.getAllByTestId("workspace-manager-row")).toHaveLength(2);

    await user.click(screen.getByText("team"));
    expect(onOpen).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows a failed open from the create route instead of dropping it", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn(async () => {
      throw new Error("No window for that workspace.");
    });
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={onOpen} />);
    await user.click(await screen.findByRole("button", { name: /create workspace/i }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No window for that workspace.");
  });

  it("drives the row menu from the keyboard and returns focus to its trigger", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
    );
    const trigger = await screen.findByRole("button", { name: "More for team" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu", { name: "More for team" })).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const reveal = screen.getByRole("menuitem", { name: "Reveal in folder" });
    await waitFor(() => expect(document.activeElement).toBe(reveal));

    await user.keyboard("{ArrowDown}");
    const forget = screen.getByRole("menuitem", { name: "Forget" });
    await waitFor(() => expect(document.activeElement).toBe(forget));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(bridge.forgetWorkspace).toHaveBeenCalledWith({ workspaceId: "ws-b" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("positions the row menu against the viewport so the list cannot clip it", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
    );
    const trigger = await screen.findByRole("button", { name: "More for team" });
    // A bottom row: the trigger sits just above the window's bottom edge.
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      top: 570, bottom: 594, left: 280, right: 304, width: 24, height: 24, x: 280, y: 570, toJSON: () => ({}),
    });
    vi.stubGlobal("innerHeight", 600);
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "More for team" });
    // Viewport-fixed, so the scrolling list's overflow cannot clip it; a
    // row near the bottom opens its menu upward.
    expect(menu.className).toContain("fixed");
    expect(Number.parseFloat(menu.style.top)).toBeLessThan(570);
    expect(Number.parseFloat(menu.style.left)).toBe(304 - 176);
  });

  it("reveals a workspace folder from the row menu", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "More for personal" }));
    await user.click(screen.getByRole("menuitem", { name: "Reveal in folder" }));
    expect(bridge.revealWorkspaceFolder).toHaveBeenCalledWith({ workspaceId: "ws-a" });
  });

  it("shows no list on first run", async () => {
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await screen.findByText("/home/ice/dohc/");
    expect(screen.queryByTestId("workspace-manager-row")).toBeNull();
  });
});
