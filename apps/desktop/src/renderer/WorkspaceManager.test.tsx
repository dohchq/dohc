// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuCommand, ReadCrashReportResult, UpdateCheckResult } from "../ipc/bridgeContract";
import type { Workspace } from "./DesktopWorkspaceShell";
import { deferred } from "../testing/deferred";
import { byRecency, openedLabel, WorkspaceManager } from "./WorkspaceManager";
import { namesList, removalFacts } from "./workspaceRemoval";

let menuListener: ((command: MenuCommand) => void) | null = null;
const sendMenuCommand = (command: MenuCommand) => act(() => menuListener?.(command));

const bridge = {
  getDefaultWorkspaceRoot: vi.fn(async () => "/home/sam/dohc"),
  pickWorkspaceRoot: vi.fn(async (): Promise<string | null> => "/home/sam/projects/research"),
  suggestWorkspaceFolderName: vi.fn(async (payload: { rootPath: string; name: string }) => payload.name),
  createLocalWorkspace: vi.fn(async () => ({
    workspaceId: "ws-1",
    rootPath: "/home/sam/dohc/personal",
    kind: "personal" as const,
    mode: "local-first" as const,
  })),
  attachWorkspaceFolder: vi.fn(async () => ({
    workspaceId: "ws-attached",
    rootPath: "/home/sam/projects/research",
    kind: "personal" as const,
    mode: "local-first" as const,
  })),
  getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
  listWorkspaceFiles: vi.fn(async () => ({ files: [] })),
  createWorkspaceFile: vi.fn(async () => ({ path: "notes/welcome.md" })),
  importWorkspaceFiles: vi.fn(async () => ({ imported: [], skipped: 0 })),
  cloudStatus: vi.fn(async () => ({ connected: false })),
  cloudLoginStart: vi.fn(),
  cloudJoinWorkspace: vi.fn(),
  listRelayShares: vi.fn(),
  retryShareHandoff: vi.fn(async () => undefined),
  dismissShareHandoff: vi.fn(async () => undefined),
  forgetWorkspace: vi.fn(async () => undefined),
  revealWorkspaceFolder: vi.fn(async () => undefined),
  openWorkspaceWindow: vi.fn(async () => undefined),
  openWorkspaceManager: vi.fn(async () => undefined),
  closeThisWindow: vi.fn(async () => undefined),
  onMenuCommand: vi.fn((listener: (command: MenuCommand) => void) => {
    menuListener = listener;
    return () => { if (menuListener === listener) menuListener = null; };
  }),
  checkForUpdates: vi.fn(async (): Promise<UpdateCheckResult> => ({
    checked: true, state: { status: "checking", message: "Checking for updates" },
  })),
  // The notice dock the connection surfaces raise their failures into.
  getUpdateState: vi.fn(async () => ({ status: "idle" as const, message: "Up to date" })),
  onUpdateState: vi.fn(() => () => undefined),
  readCrashReport: vi.fn(async (): Promise<ReadCrashReportResult> => ({ report: null, sendTo: null })),
  sendCrashReport: vi.fn(async () => ({ sent: true })),
  dismissCrashReport: vi.fn(async () => undefined),
  onCrashReportChanged: vi.fn(() => () => undefined),
  windowRole: "workspace",
  platform: "linux" as NodeJS.Platform,
};

// The location line: the parent folder, then the new workspace's own folder.
const location = () => screen.getByTestId("new-workspace-location").textContent;
const locationReads = (path: string) => waitFor(() => expect(location()).toBe(path));
const nameField = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Workspace name" });
const LONG_NAME = "Family trip to Lisbon and Porto with my grandparents in 2027";

const KNOWN = [
  { workspaceId: "ws-a", rootPath: "/home/sam/dohc/personal", kind: "personal" as const, mode: "local-first" as const },
  { workspaceId: "ws-b", rootPath: "/home/sam/dohc/team", kind: "personal" as const, mode: "local-first" as const },
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
      await screen.findByText("Connect your server to open the share from your browser."),
    ).toBeTruthy();
    expect(screen.getByTestId("cloud-sync-panel")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /create workspace/i })).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: "Back" }));
    expect(onDismissShareHandoff).toHaveBeenCalledOnce();
  });

  it("suggests ~/dohc as the workspace location", async () => {
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    expect(nameField().value).toBe("Personal");
  });

  it("opens with the name in the folder tab selected, so typing replaces it and Enter creates", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    const name = nameField();
    expect(document.activeElement).toBe(name);
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, "Personal".length]);
    await locationReads("/home/sam/dohc/Personal");

    await user.keyboard("Trip");
    expect(name.value).toBe("Trip");
    expect(location()).toBe("/home/sam/dohc/Trip");
    await user.keyboard("{Enter}");
    expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/home/sam/dohc/Trip" }),
    );
  });

  it("moves from the name to Change, Create workspace, then the three other ways in", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    expect(document.activeElement).toBe(nameField());
    const order: string[] = [];
    for (let step = 0; step < 5; step += 1) {
      await user.tab();
      const focused = document.activeElement;
      order.push(focused?.getAttribute("aria-label") ?? focused?.textContent ?? "");
    }
    expect(order).toEqual([
      "Change location",
      "Create workspace",
      "Open folder",
      "Open a share",
      "Join a synced workspace",
    ]);
  });

  it("draws the sheets in the folder as a picture, with nothing to focus", async () => {
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    const sheets = screen.getByTestId("folder-sheets");
    expect(sheets.getAttribute("aria-hidden")).toBe("true");
    expect(sheets.querySelectorAll("a, button, input, [tabindex]")).toHaveLength(0);
  });

  it.each([
    ["Open folder", "Use a folder of files you already have."],
    ["Open a share", "Open files someone shared with you."],
    ["Join a synced workspace", "Bring over a workspace you sync through your server."],
  ])("puts what %s does in its tooltip and description", async (label, detail) => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    const button = screen.getByRole("button", { name: label });
    expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toBe(detail);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.hover(button);
    expect(screen.getByRole("tooltip").textContent).toBe(detail);
    await user.unhover(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps a long name whole and shows the full location in a tooltip", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    await user.keyboard(LONG_NAME);
    expect(location()).toBe(`/home/sam/dohc/${LONG_NAME}`);
    await user.hover(screen.getByTestId("new-workspace-location"));
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toBe(`/home/sam/dohc/${LONG_NAME}`);
    await user.unhover(screen.getByTestId("new-workspace-location"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.hover(screen.getByTestId("new-workspace-location"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.keyboard("{Enter}");
    expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: `/home/sam/dohc/${LONG_NAME}` }),
    );
  });

  it("shows the start of a long name once focus leaves it", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    await user.keyboard(LONG_NAME);
    const name = nameField();
    // jsdom does not scroll; stand in for the field scrolled to its caret.
    let scrolled = 240;
    Object.defineProperty(name, "scrollLeft", { configurable: true, get: () => scrolled, set: (value: number) => { scrolled = value; } });
    await user.tab();
    expect(screen.getByRole("button", { name: "Change location" })).toBe(document.activeElement);
    expect(scrolled).toBe(0);
  });

  it("shows a refused create beside the location and keeps the typed name", async () => {
    const user = userEvent.setup();
    bridge.createLocalWorkspace.mockRejectedValueOnce(new Error("That folder name is not allowed."));
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    await user.keyboard("Trip? Lisbon{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That folder name is not allowed.");
    expect(alert.previousElementSibling?.contains(screen.getByTestId("new-workspace-location"))).toBe(true);
    expect(nameField().value).toBe("Trip? Lisbon");
    expect(screen.getByRole("button", { name: /create workspace/i })).toHaveProperty("disabled", false);
  });

  it("creates the folder under the name the user typed", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    const name = nameField();
    await user.clear(name);
    await user.type(name, "research{Enter}");
    expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/home/sam/dohc/research" }),
    );
  });

  // The name's error, under the folder tab and above the location line.
  const expectNameError = (message: string) => {
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(message);
    expect(alert.id).toBe("new-workspace-name-error");
    expect(alert.querySelector("svg")?.closest("[aria-hidden]")?.getAttribute("aria-hidden")).toBe("true");
    expect(alert.nextElementSibling?.contains(screen.getByTestId("new-workspace-location"))).toBe(true);
    expect(nameField().getAttribute("aria-invalid")).toBe("true");
    expect(nameField().getAttribute("aria-describedby")).toBe(alert.id);
    expect(nameField().className).toContain("shadow-[inset_0_-1px_0_var(--dohc-danger)]");
  };
  const expectNoNameError = () => {
    expect(screen.queryByRole("alert")).toBeNull();
    expect(nameField().hasAttribute("aria-invalid")).toBe(false);
    expect(nameField().hasAttribute("aria-describedby")).toBe(false);
    expect(nameField().className).not.toContain("danger");
  };

  it("labels the name field above its tab", async () => {
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    const label = screen.getByText("Workspace name", { selector: "label" });
    expect(label.getAttribute("for")).toBe(nameField().id);
    expect(screen.getByLabelText("Workspace name", { selector: "input" })).toBe(nameField());
  });

  it.each([
    ["", "Enter a workspace name."],
    ["   ", "Enter a workspace name."],
    [".", 'Choose a name other than "." or "..".'],
    ["..", 'Choose a name other than "." or "..".'],
    ["a/b", "Use a name without slashes."],
    ["a\\b", "Use a name without slashes."],
  ])("keeps Create on for %j, and pressing it says what to fix and focuses the name", async (typed, message) => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    const create = screen.getByRole("button", { name: /create workspace/i });
    await user.clear(nameField());
    if (typed) await user.keyboard(typed);
    expect(nameField().value).toBe(typed);
    expectNoNameError();
    expect(create).toHaveProperty("disabled", false);

    await user.click(create);
    expectNameError(message);
    expect(document.activeElement).toBe(nameField());
    expect(create).toHaveProperty("disabled", false);
    expect(bridge.createLocalWorkspace).not.toHaveBeenCalled();
  });

  it("checks the name when focus leaves it, and clears the error once the person types", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    await user.clear(nameField());
    await user.keyboard("a/");
    expectNoNameError();
    await user.tab();
    expectNameError("Use a name without slashes.");
    expect(screen.getByRole("button", { name: "Change location" })).toBe(document.activeElement);

    await user.click(nameField());
    await user.keyboard("{Backspace}");
    expectNoNameError();
    await user.keyboard("{Enter}");
    expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(expect.objectContaining({ rootPath: "/home/sam/dohc/a" }));
  });

  it.each([
    ["Trip?", "A name cannot contain a question mark (?). Remove it."],
    ["CON", 'Windows keeps "CON" for itself. Choose another name.'],
    ["Trip.", "Windows removes dots and spaces at the end of a name. Remove the ending dot or space."],
  ])("says on Enter why Windows refuses %s, and creates nothing", async (typed, message) => {
    bridge.platform = "win32";
    try {
      const user = userEvent.setup();
      render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
      await locationReads("\\home\\sam\\dohc\\Personal");
      const create = screen.getByRole("button", { name: /create workspace/i });
      await user.keyboard(typed);
      expectNoNameError();
      await user.keyboard("{Enter}");
      expectNameError(message);
      expect(document.activeElement).toBe(nameField());
      expect(create).toHaveProperty("disabled", false);
      expect(bridge.createLocalWorkspace).not.toHaveBeenCalled();

      await user.clear(nameField());
      await user.keyboard("Trip");
      expectNoNameError();
      await user.keyboard("{Enter}");
      expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(expect.objectContaining({ rootPath: "/home/sam/dohc/Trip" }));
    } finally {
      bridge.platform = "linux";
    }
  });

  it("creates a name typed with a trailing space under the trimmed name on Windows", async () => {
    bridge.platform = "win32";
    try {
      const user = userEvent.setup();
      render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
      await locationReads("\\home\\sam\\dohc\\Personal");
      await user.keyboard("Trip {Enter}");
      expectNoNameError();
      expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(expect.objectContaining({ rootPath: "/home/sam/dohc/Trip" }));
    } finally {
      bridge.platform = "linux";
    }
  });

  it("keeps the typed name while it is refused", async () => {
    bridge.platform = "win32";
    try {
      const user = userEvent.setup();
      render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
      await locationReads("\\home\\sam\\dohc\\Personal");
      await user.keyboard("Trip? Lisbon{Enter}");
      expectNameError("A name cannot contain a question mark (?). Remove it.");
      expect(nameField().value).toBe("Trip? Lisbon");
      await user.keyboard("{Backspace>8/} Lisbon");
      expect(nameField().value).toBe("Trip Lisbon");
      expectNoNameError();
    } finally {
      bridge.platform = "linux";
    }
  });

  it.each(["linux", "darwin"] as const)("allows names only Windows refuses on %s", async (platform) => {
    bridge.platform = platform;
    try {
      const user = userEvent.setup();
      render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
      await locationReads("/home/sam/dohc/Personal");
      for (const typed of ["Trip?", "CON"]) {
        await user.clear(nameField());
        await user.keyboard(typed);
        fireEvent.blur(nameField());
        expectNoNameError();
        expect(screen.getByRole("button", { name: /create workspace/i })).toHaveProperty("disabled", false);
      }
    } finally {
      bridge.platform = "linux";
    }
  });

  it("creates nothing in the old location while the picked one is still loading", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    const slowCheck = deferred<string>();
    bridge.suggestWorkspaceFolderName.mockReturnValueOnce(slowCheck.promise);
    await user.click(screen.getByRole("button", { name: "Change location" }));
    await waitFor(() => expect(bridge.suggestWorkspaceFolderName).toHaveBeenCalledTimes(2));
    const create = screen.getByRole("button", { name: /create workspace/i });
    expect(create).toHaveProperty("disabled", true);
    fireEvent.submit(create.closest("form")!);
    expect(bridge.createLocalWorkspace).not.toHaveBeenCalled();

    await act(async () => slowCheck.resolve("Personal"));
    await locationReads("/home/sam/projects/research/Personal");
    await user.click(create);
    expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/home/sam/projects/research/Personal" }),
    );
  });

  it("lets the user choose another folder", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await user.click(
      await screen.findByRole("button", { name: "Change location" }),
    );
    expect(bridge.pickWorkspaceRoot).toHaveBeenCalledOnce();
    await locationReads("/home/sam/projects/research/Personal");
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
        rootPath: "/home/sam/dohc/Personal",
      }),
    );
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
    );
  });

  it("makes Change secondary after a create folder error and keeps Create enabled", async () => {
    const user = userEvent.setup();
    bridge.createLocalWorkspace.mockRejectedValueOnce(new Error("dohc does not have permission to use this file or folder."));
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    expect(screen.getByRole("button", { name: "Change location" }).classList.contains("border")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    await screen.findByText("dohc does not have permission to use this file or folder.");
    const change = screen.getByRole("button", { name: "Change location" });
    expect(change.classList.contains("border")).toBe(true);
    expect(change.classList.contains("h-6")).toBe(true);
    expect(screen.getByRole("button", { name: "Create workspace" })).toHaveProperty("disabled", false);

    await user.click(change);
    await locationReads("/home/sam/projects/research/Personal");
    expect(screen.queryByText("dohc does not have permission to use this file or folder.")).toBeNull();
    expect(screen.getByRole("button", { name: "Change location" }).classList.contains("border")).toBe(false);
  });

  it("keeps Change in its quiet form for a name error", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    await user.clear(nameField());
    fireEvent.blur(nameField());
    expect(nameField().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("button", { name: "Change location" }).classList.contains("border")).toBe(false);
  });

  it("reports default workspace root failures and still lets the person pick a folder", async () => {
    const user = userEvent.setup();
    bridge.getDefaultWorkspaceRoot.mockRejectedValueOnce(new Error("No home dir"));

    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);

    expect(await screen.findByText("No home dir")).toBeTruthy();
    expect(location()).toBe("Choose a folder");
    const change = screen.getByRole("button", { name: "Change location" });
    expect(change).toHaveProperty("disabled", false);
    expect(change.classList.contains("border")).toBe(true);
    expect(screen.getByRole("button", { name: /create workspace/i })).toHaveProperty("disabled", true);

    await user.click(change);
    await locationReads("/home/sam/projects/research/Personal");
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
    // The error changes Change's look, not the button, so keyboard focus stays on it.
    expect(screen.getByRole("button", { name: "Change location" })).toBe(change);
    expect(document.activeElement).toBe(change);

    await user.click(change);
    expect(document.activeElement).toBe(change);
    await locationReads("/home/sam/projects/research/Personal");
    await act(async () => slowDefault.resolve("/home/sam/dohc"));
    expect(location()).toBe("/home/sam/projects/research/Personal");
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
    await act(async () => slowDefault.resolve("/home/sam/stale"));
    expect(location()).not.toContain("/home/sam/stale");
    await locationReads("/home/sam/dohc/Personal");
    expect(screen.getByRole("button", { name: /create workspace/i })).toHaveProperty("disabled", false);
  });

  it("suggests the first name no folder in the location has", async () => {
    const user = userEvent.setup();
    // ~/dohc still holds personal from an earlier install; the picked folder
    // holds nothing.
    bridge.suggestWorkspaceFolderName.mockImplementationOnce(async ({ name }) => `${name} 2`);
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal 2");
    expect(bridge.suggestWorkspaceFolderName).toHaveBeenCalledWith({ rootPath: "/home/sam/dohc", name: "Personal" });
    const name = nameField();
    expect(name.value).toBe("Personal 2");
    expect([name.selectionStart, name.selectionEnd], "still selected, so typing replaces it").toEqual([0, "Personal 2".length]);

    await user.click(screen.getByRole("button", { name: "Change location" }));
    await locationReads("/home/sam/projects/research/Personal");
    expect(name.value).toBe("Personal");
  });

  it("keeps a name the person typed when the location changes", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    await user.keyboard("Trip");
    bridge.suggestWorkspaceFolderName.mockClear();
    await user.click(screen.getByRole("button", { name: "Change location" }));
    await locationReads("/home/sam/projects/research/Trip");
    expect(bridge.suggestWorkspaceFolderName).not.toHaveBeenCalled();
  });

  it("keeps a slow name check for the default from overwriting a picked folder", async () => {
    const user = userEvent.setup();
    const slowCheck = deferred<string>();
    bridge.suggestWorkspaceFolderName.mockReturnValueOnce(slowCheck.promise);
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await waitFor(() => expect(bridge.suggestWorkspaceFolderName).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: /create workspace/i }), "no Create before the name is known").toHaveProperty("disabled", true);

    await user.click(screen.getByRole("button", { name: "Change location" }));
    await locationReads("/home/sam/projects/research/Personal");
    await act(async () => slowCheck.resolve("Personal 2"));
    expect(location()).toBe("/home/sam/projects/research/Personal");
  });

  it.each(["link", "shares", "notices"])("shows the attach refusal for reserved id %s in a toast and Notices", async (workspaceId) => {
    const body = `Its workspace ID, ${workspaceId}, is reserved. Change workspaceId in .dohc/manifest.json, then open the folder again.`;
    bridge.attachWorkspaceFolder.mockRejectedValueOnce(new Error(
      `Error invoking remote method 'attachWorkspaceFolder': ReservedWorkspaceIdError: ${body}`,
    ));
    const user = userEvent.setup();
    const onReady = vi.fn();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={onReady} />);
    await user.click(await screen.findByRole("button", { name: "Open folder" }));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText("dohc can't open this folder")).toBeTruthy();
    expect(within(toast).getByText(body)).toBeTruthy();
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(onReady).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = screen.getByTestId("notice-center");
    expect(within(notices).getByText("dohc can't open this folder")).toBeTruthy();
    expect(within(notices).getByText(body)).toBeTruthy();
  });
  it("attaches an existing folder as a workspace", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={onReady} />);
    await user.click(
      await screen.findByRole("button", { name: "Open folder" }),
    );
    expect(bridge.attachWorkspaceFolder).toHaveBeenCalledWith({
      rootPath: "/home/sam/projects/research",
    });
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-attached" }),
    );
  });

  it("never requires login and never renders auth fields", async () => {
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    expect(screen.queryByLabelText(/email|password/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /sign in|log in|sign up/i }))
      .toBeNull();
  });

  it("offers joining a synced workspace, gated on sign-in", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    await user.click(
      screen.getByTestId("first-run-join-synced"),
    );
    expect(await screen.findByTestId("join-synced-workspace")).toBeTruthy();
    // No session yet: the panel asks for sign-in before showing the code
    // field, and the normal cloud sign-in is embedded right there.
    expect(
      await screen.findByText(/connect your server first, then enter the code/i),
    ).toBeTruthy();
    expect(screen.queryByTestId("join-sync-code")).toBeNull();
    // Back returns to the normal first-run card.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("button", { name: /create workspace/i }),
    ).toBeTruthy();
  });

  it("keeps a connection failure after the route that raised it closes", async () => {
    const user = userEvent.setup();
    bridge.cloudLoginStart.mockRejectedValueOnce(
      new Error("dohc found no dohc server at https://dohc.example.test."),
    );
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    await user.click(screen.getByTestId("first-run-join-synced"));

    fireEvent.change(await screen.findByTestId("cloud-server-url"), {
      target: { value: "https://dohc.example.test" },
    });
    await user.click(screen.getByTestId("cloud-connect-start"));
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "dohc found no dohc server at https://dohc.example.test.",
    );

    // Leaving the route takes the panel away. The failure is the manager's,
    // so it stays on screen with its way forward.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByTestId("join-synced-workspace")).toBeNull();
    expect(screen.getByTestId("workspace-shell-error")).toBeTruthy();

    // Try again reopens the route the failure came from, with the address
    // that attempt used.
    await user.click(screen.getByTestId("workspace-shell-error-retry"));
    expect(await screen.findByTestId("join-synced-workspace")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByTestId("cloud-server-url") as HTMLInputElement).value).toBe(
        "https://dohc.example.test",
      ),
    );
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it.each(["linux", "darwin"] as const)("answers the menu commands that need no workspace (%s)", async (platform) => {
    bridge.platform = platform;
    try {
      render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
      await locationReads("/home/sam/dohc/Personal");

      // A new id per run: a failure this renderer already toasted stays quiet.
      bridge.checkForUpdates.mockResolvedValueOnce({
        checked: true,
        state: { status: "error", message: "feed returned 500", canCheck: true, failure: { step: "check", id: platform === "linux" ? 1 : 2 } },
      });
      sendMenuCommand("check-updates");
      const toast = await screen.findByTestId("workspace-shell-error");
      expect(toast.textContent).toContain("dohc could not check for updates");
      expect(toast.textContent).toContain("feed returned 500");
      expect(bridge.checkForUpdates).toHaveBeenCalledOnce();

      // Workspace commands have nothing to act on here.
      sendMenuCommand("settings");
      sendMenuCommand("new-file");
      expect(screen.queryByRole("dialog")).toBeNull();

      // Nothing here is a tab, so Close tab closes the window on macOS.
      sendMenuCommand("close-tab");
      expect(bridge.closeThisWindow).toHaveBeenCalledTimes(platform === "darwin" ? 1 : 0);
    } finally {
      bridge.platform = "linux";
    }
  });

  it("shows a crash report, and hands Send report to main", async () => {
    const user = userEvent.setup();
    const text = "dohc crash report\n\nProcess: window";
    bridge.readCrashReport.mockResolvedValueOnce({
      report: { revision: 1, through: 1, source: "window", problems: 1, atMs: 1_000, text },
      sendTo: "reports.example.test",
    });
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);

    expect((await screen.findByTestId("crash-report-toast")).textContent).toContain(
      "A dohc window stopped unexpectedly",
    );
    await user.click(screen.getByTestId("crash-report-toast-send"));
    await waitFor(() => expect(bridge.sendCrashReport).toHaveBeenCalledWith({}));
    // The report is gone, and the manager says it went.
    await waitFor(() => expect(screen.queryByTestId("crash-report-toast")).toBeNull());
    expect((await screen.findByTestId("workspace-shell-notice")).textContent).toContain("Report sent");
  });

  it("reads like a desktop app, not a marketing page", async () => {
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
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
    // The row names the workspace over its path; the full path is its title.
    const team = screen.getByTitle("/home/sam/dohc/team");
    expect(team.textContent).toBe("team/home/sam/dohc/team");
    await user.click(team);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-b" }));
  });

  it("lists the most recently opened workspace first and says when", async () => {
    const now = Date.now();
    const stamped = [
      { ...KNOWN[0], lastOpenedAt: now - 3 * 24 * 60 * 60_000 },
      { ...KNOWN[1], lastOpenedAt: now - 5 * 60_000 },
      { workspaceId: "ws-c", rootPath: "/home/sam/dohc/never", kind: "personal" as const, mode: "local-first" as const },
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

  it("removes a workspace from the list and refreshes, with no message", async () => {
    const user = userEvent.setup();
    const onForgot = vi.fn(async () => [KNOWN[0]]);
    render(
      <WorkspaceManager workspaces={KNOWN} current={KNOWN[0]} onForgot={onForgot} onOpenWorkspace={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "More for team" }));
    const remove = screen.getByRole("menuitem", { name: "Remove from list" });
    expect(remove.className).not.toContain("text-danger");
    await user.click(remove);
    expect(bridge.forgetWorkspace).toHaveBeenCalledWith({ workspaceId: "ws-b" });
    expect(onForgot).toHaveBeenCalledOnce();
    expect(screen.queryByText(/folder was not deleted/)).toBeNull();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("raises a failed removal as a toast and one Notices row, not inline, and Try again removes again", async () => {
    const user = userEvent.setup();
    const onForgot = vi.fn(async () => [KNOWN[0]]);
    bridge.forgetWorkspace.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'desktop:forget-workspace': Error: This workspace changed while this ran. Try again.",
    ));
    render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={onForgot} onOpenWorkspace={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "More for team" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    const toast = await screen.findByTestId("workspace-shell-error");
    // Try again is the button, so the words don't say it again.
    expect(toast.textContent).toContain(
      "dohc could not remove this workspace from the list. This workspace changed while this ran.",
    );
    expect(toast.textContent).not.toContain("Try again.");
    expect(screen.getAllByRole("alert")).toEqual([toast]);
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = screen.getByTestId("notice-center");
    expect(
      within(notices).getAllByText("dohc could not remove this workspace from the list. This workspace changed while this ran."),
    ).toHaveLength(1);
    expect(onForgot).not.toHaveBeenCalled();

    await user.click(within(notices).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onForgot).toHaveBeenCalledOnce());
    expect(bridge.forgetWorkspace).toHaveBeenCalledTimes(2);
    expect(bridge.forgetWorkspace).toHaveBeenLastCalledWith({ workspaceId: "ws-b" });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(screen.queryByTestId("connection-notices")).toBeNull();
  });

  it.each([
    { path: "from the menu", synced: false },
    { path: "from its dialog", synced: true },
  ])("files only a list refresh that fails after a removal $path, and Try again only refreshes", async ({ synced }) => {
    const user = userEvent.setup();
    const rows = synced ? [KNOWN[0], { ...KNOWN[1], sync: "on" as const }] : KNOWN;
    const onForgot = vi
      .fn<() => Promise<Workspace[]>>()
      .mockRejectedValueOnce(new Error("The workspace list could not be read."))
      .mockResolvedValue([KNOWN[0]]);
    render(<WorkspaceManager workspaces={rows} current={null} onForgot={onForgot} onOpenWorkspace={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "More for team" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    if (synced) await user.click(screen.getByTestId("workspace-remove-confirm-button"));

    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not refresh the workspace list.");
    expect(toast.textContent).not.toContain("could not remove");
    expect(screen.queryByTestId("workspace-remove-confirm")).toBeNull();

    await user.click(within(toast).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onForgot).toHaveBeenCalledTimes(2));
    expect(bridge.forgetWorkspace).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("connection-notices")).toBeNull();
  });

  it.each([
    { order: "an older refresh that works leaves a newer failure", newer: "fails", older: "works" },
    { order: "an older refresh that fails stays quiet after a newer one worked", newer: "works", older: "fails" },
  ] as const)("only the newest list refresh reports: $order", async ({ newer, older }) => {
    const user = userEvent.setup();
    const first = deferred<Workspace[]>();
    const onForgot = vi
      .fn<() => Promise<Workspace[]>>()
      .mockReturnValueOnce(first.promise)
      .mockImplementationOnce(async () => {
        if (newer === "fails") throw new Error("The workspace list could not be read.");
        return [];
      });
    render(<WorkspaceManager workspaces={KNOWN} current={null} onForgot={onForgot} onOpenWorkspace={() => {}} />);
    const remove = async (name: string) => {
      await user.click(await screen.findByRole("button", { name: `More for ${name}` }));
      await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    };
    await remove("team");
    await remove("personal");
    await waitFor(() => expect(onForgot).toHaveBeenCalledTimes(2));
    if (newer === "fails") await screen.findByTestId("workspace-shell-error");

    await act(async () => {
      if (older === "works") first.resolve([]);
      else first.reject(new Error("The workspace list could not be read."));
      await first.promise.catch(() => {});
    });
    if (newer === "fails") {
      expect(screen.getByTestId("workspace-shell-error").textContent).toContain("dohc could not refresh the workspace list.");
    } else {
      expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
      expect(screen.queryByTestId("connection-notices")).toBeNull();
    }
  });

  it("asks first when the row holds more than its place, and Cancel keeps it", async () => {
    const user = userEvent.setup();
    const synced = [KNOWN[0], { ...KNOWN[1], sync: "on" as const, joinedChatCount: 2 }];
    render(<WorkspaceManager workspaces={synced} current={null} onForgot={async () => synced} onOpenWorkspace={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "More for team" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));

    const dialog = screen.getByTestId("workspace-remove-confirm");
    expect(within(dialog).getByRole("heading").textContent).toBe("Remove team from this list?");
    expect(dialog.textContent).toContain("Sync turns off. Turn it on again in Settings › Sync and sharing.");
    expect(dialog.textContent).toContain("2 shared chats leave this workspace.");
    const confirm = screen.getByTestId("workspace-remove-confirm-button");
    expect(confirm.textContent).toBe("Remove from list");
    expect(confirm.className).not.toContain("danger");
    expect(bridge.forgetWorkspace).not.toHaveBeenCalled();
    // Focus starts on the confirm button, as in every confirm dialog, and the
    // left arrow reaches Cancel.
    expect(document.activeElement).toBe(confirm);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByTestId("workspace-remove-cancel"));
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("workspace-remove-confirm")).toBeNull();
    expect(bridge.forgetWorkspace).not.toHaveBeenCalled();
  });

  it("shows a failed removal in its dialog, then removes on the next try", async () => {
    const user = userEvent.setup();
    const synced = [KNOWN[0], { ...KNOWN[1], sync: "paused" as const }];
    const onForgot = vi.fn(async () => [KNOWN[0]]);
    const removal = deferred<undefined>();
    bridge.forgetWorkspace.mockRejectedValueOnce(new Error("disk full")).mockReturnValueOnce(removal.promise);
    render(<WorkspaceManager workspaces={synced} current={null} onForgot={onForgot} onOpenWorkspace={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "More for team" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    await user.click(screen.getByTestId("workspace-remove-confirm-button"));

    expect((await screen.findByTestId("workspace-remove-error")).textContent).toBe("disk full");
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(onForgot).not.toHaveBeenCalled();

    const confirm = screen.getByTestId("workspace-remove-confirm-button") as HTMLButtonElement;
    await user.click(confirm);
    expect(confirm.textContent).toBe("Removing…");
    expect(confirm.disabled).toBe(true);
    await act(async () => removal.resolve(undefined));
    await waitFor(() => expect(screen.queryByTestId("workspace-remove-confirm")).toBeNull());
    expect(bridge.forgetWorkspace).toHaveBeenLastCalledWith({ workspaceId: "ws-b" });
    expect(onForgot).toHaveBeenCalledOnce();
  });

  it("says what each kind of hold loses, with names", () => {
    const base = KNOWN[0];
    const mount = (label: string, extra: object = {}) => ({ shareId: `s-${label}`, label, granterEmail: null, access: "view" as const, ...extra });
    expect(removalFacts(base)).toEqual([]);
    expect(removalFacts({ ...base, sync: "paused" })).toEqual([
      "Its paused sync ends. Turn sync on again in Settings › Sync and sharing.",
    ]);
    expect(removalFacts({ ...base, joinedChatCount: 1 })).toEqual([
      "1 shared chat leaves this workspace. In Chats, join it again from Shared with you or Message requests, unless its share has ended.",
    ]);
    expect(removalFacts({ ...base, joinedChatCount: 3 })).toEqual([
      "3 shared chats leave this workspace. In Chats, join groups again from Shared with you and direct messages from Message requests, unless their share has ended.",
    ]);
    expect(removalFacts({ ...base, shareMounts: [mount("Trip"), mount("Old", { ended: true })] })).toEqual([
      "Shared folder Trip stops refreshing, and its files stay. A share added again with its code arrives as a new folder.",
    ]);
    expect(removalFacts({ ...base, shareMounts: [mount("Trip"), mount("Budget")] })).toEqual([
      "Shared folders Trip and Budget stop refreshing, and their files stay. A share added again with its code arrives as a new folder.",
    ]);
    expect(removalFacts({ ...base, shareView: { shareId: "s", granterEmail: null, access: "view" } })).toEqual([
      "Its folder stays but stops refreshing. To open the share again, choose that folder in Open folder, or use its share code.",
    ]);
    expect(removalFacts({ ...base, shareView: { shareId: "s", granterEmail: null, ended: true } })).toEqual([]);
    expect(namesList(["A", "B", "C"])).toBe("A, B and C");
    expect(namesList(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 more");
  });

  it("raises a failed open as a toast, then Try again opens it", async () => {
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
    await user.click(await screen.findByTitle("/home/sam/dohc/team"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("That folder is gone.");
    expect(toast.textContent).not.toContain("remote method");
    expect(screen.getAllByTestId("workspace-manager-row")).toHaveLength(2);

    await user.click(screen.getByTestId("workspace-shell-error-retry"));
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
  });

  it("raises a failed open from the create route as a toast", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn(async () => {
      throw new Error("No window for that workspace.");
    });
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={onOpen} />);
    await user.click(await screen.findByRole("button", { name: /create workspace/i }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }));
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "No window for that workspace.",
    );
  });

  it("raises a failed folder reveal as a toast with Try again", async () => {
    const user = userEvent.setup();
    bridge.revealWorkspaceFolder.mockRejectedValueOnce(new Error("no file manager"));
    render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "More for personal" }));
    await user.click(screen.getByRole("menuitem", { name: "Show in file manager" }));
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "dohc could not show this workspace's folder.",
    );
    await user.click(screen.getByTestId("workspace-shell-error-retry"));
    await waitFor(() => expect(bridge.revealWorkspaceFolder).toHaveBeenCalledTimes(2));
  });

  it("takes back a failed folder reveal when the row menu then shows it", async () => {
    const user = userEvent.setup();
    bridge.revealWorkspaceFolder.mockRejectedValueOnce(new Error("no file manager"));
    render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "More for personal" }));
    await user.click(screen.getByRole("menuitem", { name: "Show in file manager" }));
    await screen.findByTestId("workspace-shell-error");

    await user.click(screen.getByRole("button", { name: "More for personal" }));
    await user.click(screen.getByRole("menuitem", { name: "Show in file manager" }));
    // The toast and its Notices row are both gone.
    await waitFor(() => expect(screen.queryByTestId("connection-notices")).toBeNull());
  });

  it("asks on Try again when a row gained sync after its removal failed", async () => {
    const user = userEvent.setup();
    bridge.forgetWorkspace.mockRejectedValueOnce(new Error("disk full"));
    const view = render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "More for team" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    await screen.findByTestId("workspace-shell-error");

    const synced = [KNOWN[0], { ...KNOWN[1], sync: "on" as const }];
    view.rerender(
      <WorkspaceManager workspaces={synced} current={null} onForgot={async () => synced} onOpenWorkspace={() => {}} />,
    );
    await user.click(screen.getByTestId("workspace-shell-error-retry"));
    expect(await screen.findByTestId("workspace-remove-confirm")).toBeTruthy();
    expect(bridge.forgetWorkspace).toHaveBeenCalledTimes(1);
  });

  it("keeps another row's dialog and the retried failure when Try again cannot ask yet", async () => {
    const user = userEvent.setup();
    bridge.forgetWorkspace.mockRejectedValueOnce(new Error("disk full"));
    const view = render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "More for team" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    await screen.findByTestId("workspace-shell-error");

    // Both rows now hold sync, and personal's dialog is open.
    const synced = KNOWN.map((row) => ({ ...row, sync: "on" as const }));
    view.rerender(
      <WorkspaceManager workspaces={synced} current={null} onForgot={async () => synced} onOpenWorkspace={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: "More for personal" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    const dialog = screen.getByTestId("workspace-remove-confirm");
    expect(within(dialog).getByRole("heading").textContent).toBe("Remove personal from this list?");

    await user.click(screen.getByTestId("workspace-shell-error-retry"));
    expect(within(screen.getByTestId("workspace-remove-confirm")).getByRole("heading").textContent)
      .toBe("Remove personal from this list?");
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
      "dohc could not remove this workspace from the list.",
    );
    expect(bridge.forgetWorkspace).toHaveBeenCalledTimes(1);
  });

  it("lets the first of two removal requests in one turn ask, and keeps the second's failure", async () => {
    const user = userEvent.setup();
    bridge.forgetWorkspace.mockRejectedValueOnce(new Error("disk full"));
    const view = render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "More for team" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    await screen.findByTestId("workspace-shell-error");
    const synced = KNOWN.map((row) => ({ ...row, sync: "on" as const }));
    view.rerender(
      <WorkspaceManager workspaces={synced} current={null} onForgot={async () => synced} onOpenWorkspace={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: "More for personal" }));
    const removePersonal = screen.getByRole("menuitem", { name: "Remove from list" });
    const retryTeam = screen.getByTestId("workspace-shell-error-retry");

    // No render between the two: the second must still see the first's dialog.
    act(() => {
      fireEvent.click(removePersonal);
      fireEvent.click(retryTeam);
    });
    expect(within(screen.getByTestId("workspace-remove-confirm")).getByRole("heading").textContent)
      .toBe("Remove personal from this list?");
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
      "dohc could not remove this workspace from the list.",
    );
    expect(bridge.forgetWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does nothing on Try again when the row has left the list", async () => {
    const user = userEvent.setup();
    bridge.forgetWorkspace.mockRejectedValueOnce(new Error("disk full"));
    const view = render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "More for team" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    await screen.findByTestId("workspace-shell-error");

    view.rerender(
      <WorkspaceManager workspaces={[KNOWN[0]]} current={null} onForgot={async () => [KNOWN[0]]} onOpenWorkspace={() => {}} />,
    );
    await user.click(screen.getByTestId("workspace-shell-error-retry"));
    await waitFor(() => expect(screen.queryByTestId("connection-notices")).toBeNull());
    expect(bridge.forgetWorkspace).toHaveBeenCalledTimes(1);
  });

  it("takes back an earlier removal failure when the removal then succeeds", async () => {
    const user = userEvent.setup();
    bridge.forgetWorkspace.mockRejectedValueOnce(new Error("disk full"));
    render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "More for team" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    await screen.findByTestId("workspace-shell-error");
    await user.click(screen.getByRole("button", { name: "More for team" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    await waitFor(() => expect(screen.queryByTestId("connection-notices")).toBeNull());
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
    const reveal = screen.getByRole("menuitem", { name: "Show in file manager" });
    await waitFor(() => expect(document.activeElement).toBe(reveal));

    await user.keyboard("{ArrowDown}");
    const remove = screen.getByRole("menuitem", { name: "Remove from list" });
    await waitFor(() => expect(document.activeElement).toBe(remove));
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
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(64);
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "More for team" });
    // Viewport-fixed, so the scrolling list's overflow cannot clip it; a
    // row near the bottom opens its menu upward, 4px over the trigger.
    expect(menu.className).toContain("fixed");
    expect(menu.style.top).toBe("");
    expect(menu.style.bottom).toBe(`${600 - 570 + 4}px`);
    expect(Number.parseFloat(menu.style.left)).toBe(304 - 176);
  });

  it.each([
    ["darwin", "Show in Finder"],
    ["win32", "Show in File Explorer"],
    ["linux", "Show in file manager"],
  ] as const)("reveals a workspace folder from the row menu, named for the %s file manager", async (platform, label) => {
    bridge.platform = platform;
    try {
      const user = userEvent.setup();
      render(
        <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
      );
      await user.click(await screen.findByRole("button", { name: "More for personal" }));
      await user.click(screen.getByRole("menuitem", { name: label }));
      expect(bridge.revealWorkspaceFolder).toHaveBeenCalledWith({ workspaceId: "ws-a" });
    } finally {
      bridge.platform = "linux";
    }
  });

  it("shows no list on first run", async () => {
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await locationReads("/home/sam/dohc/Personal");
    expect(screen.queryByTestId("workspace-manager-row")).toBeNull();
  });
});
