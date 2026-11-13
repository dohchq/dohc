// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeptTyping, MenuCommand, ReadCrashReportResult, UpdateCheckResult } from "../ipc/bridgeContract";
import type { Workspace } from "./DesktopWorkspaceShell";
import { deferred } from "../testing/deferred";
import { WorkspaceManager } from "./WorkspaceManager";

let menuListener: ((command: MenuCommand) => void) | null = null;

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
  markCrashReportRead: vi.fn(async () => undefined),
  onCrashReportChanged: vi.fn(() => () => undefined),
  onNoticesChanged: vi.fn(() => () => undefined),
  listKeptTyping: vi.fn(async (): Promise<KeptTyping[]> => []),
  dismissKeptTyping: vi.fn(async () => undefined),
  windowRole: "workspace",
  platform: "linux" as NodeJS.Platform,
};

// The location line: the parent folder, then the new workspace's own folder.
const location = () => screen.getByTestId("new-workspace-location").textContent;
const locationReads = (path: string) => waitFor(() => expect(location()).toBe(path));
const nameField = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Workspace name" });

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

describe("workspace manager", () => {

  // A first join that fails leaves no workspace, so the manager is the only
  // place its kept typing can show.
  it("offers typing kept from a workspace no longer listed, with no workspace open", async () => {
    const kept = { workspaceId: "joined-then-failed", recordId: "b".repeat(64), path: "plan.md", text: "typed while joining" };
    bridge.listKeptTyping.mockResolvedValueOnce([kept]);
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    fireEvent.click(await screen.findByTestId("notice-center-toggle"));
    const row = screen.getByTestId("notice-kept-typing");
    expect(row.textContent).toContain("plan.md");
    fireEvent.click(within(row).getByTestId("recovery-dismiss"));
    fireEvent.click(within(row).getByTestId("recovery-dismiss-confirm"));
    await waitFor(() => expect(bridge.dismissKeptTyping).toHaveBeenCalledWith({ workspaceId: kept.workspaceId, recordId: kept.recordId }));
    await waitFor(() => expect(screen.queryByTestId("notice-kept-typing")).toBeNull());
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
    ["CON", 'Windows keeps "CON" for itself. Choose another name.'],
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
    await locationReads("/home/sam/projects/research/Personal");
    expect(screen.queryByText("Dialog unavailable")).toBeNull();
    expect(screen.getByRole("button", { name: "Change location" })).toBe(change);
    expect(document.activeElement).toBe(change);
    await act(async () => slowDefault.resolve("/home/sam/dohc"));
    expect(location()).toBe("/home/sam/projects/research/Personal");
  });

  // A folder that can never be a workspace: the toast leads with why and
  // offers another folder, not Try again. The folder is in Details.
  it.each([
    ["reserved id link", "ReservedWorkspaceIdError", "This folder's workspace ID, link, is reserved. Change workspaceId in .dohc/manifest.json, then open the folder again."],
  ])("shows the attach refusal for %s in a toast and Notices, with Choose another folder", async (_case, name, body) => {
    bridge.attachWorkspaceFolder.mockRejectedValueOnce(new Error(
      `Error invoking remote method 'attachWorkspaceFolder': ${name}: ${body}`,
    ));
    const user = userEvent.setup();
    const onReady = vi.fn();
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={onReady} />);
    await user.click(await screen.findByRole("button", { name: "Open folder" }));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent?.startsWith(body)).toBe(true);
    expect(toast.textContent).not.toContain("/home/sam/projects/research");
    expect(within(toast).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(toast).queryByTestId("workspace-shell-error-copy")).toBeNull();
    await user.click(within(toast).getByRole("button", { name: "Details" }));
    await user.click(within(toast).getByRole("button", { name: "Copy details" }));
    expect((await navigator.clipboard.readText()).split("\n")).toContain("Chosen folder: /home/sam/projects/research");
    expect(onReady).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = screen.getByTestId("notice-center");
    const row = within(notices).getByText(body).closest("li")!;
    expect(within(row).queryByRole("button", { name: "Try again" })).toBeNull();

    await user.click(within(row).getByRole("button", { name: "Choose another folder" }));
    await waitFor(() => expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-attached" })));
    expect(bridge.pickWorkspaceRoot).toHaveBeenCalledTimes(2);
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
});

describe("workspace manager with registered workspaces", () => {

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
});
