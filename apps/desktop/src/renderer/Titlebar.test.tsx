// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Titlebar, workspaceName } from "./Titlebar";
import type { Workspace } from "./DesktopWorkspaceShell";

const workspace: Workspace = {
  workspaceId: "ws-1",
  rootPath: "/home/sam/dohc",
  kind: "personal",
  mode: "local-first",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("workspaceName", () => {
  it("uses the final path segment and ignores trailing separators", () => {
    expect(workspaceName({ ...workspace, rootPath: "/home/sam/dohc/" })).toBe("dohc");
    expect(workspaceName({ ...workspace, rootPath: "C:\\Users\\ice\\dohc\\" })).toBe("dohc");
    expect(workspaceName({ ...workspace, rootPath: "/" })).toBe("workspace");
  });
});

describe("Titlebar", () => {
  it("describes agent activity without nesting the status inside the chats button", () => {
    render(<Titlebar agentActive chatsSidebar={{ visible: true, onToggle: vi.fn() }} />);
    const toggle = screen.getByRole("button", { name: "Toggle chats sidebar" });
    const status = screen.getByRole("status", { name: "Agent running" });
    expect(toggle.contains(status)).toBe(false);
    expect(toggle.getAttribute("aria-describedby")).toBe(status.id);
    expect(status.textContent).toBe("Agent running");
  });

  it("shows the macOS quick-open shortcut on macOS", () => {
    vi.stubGlobal("dohcDesktop", { platform: "darwin" });

    render(<Titlebar workspace={workspace} workspaces={[workspace]} onQuickOpen={() => undefined} />);

    expect(screen.getByTestId("titlebar-quick-open").textContent).toContain("⌘P");
  });

  it("shows Ctrl P quick-open shortcut off macOS", () => {
    vi.stubGlobal("dohcDesktop", { platform: "win32" });

    render(<Titlebar workspace={workspace} workspaces={[workspace]} onQuickOpen={() => undefined} />);

    expect(screen.getByTestId("titlebar-quick-open").textContent).toContain("Ctrl P");
  });

  it("toggles the primary and chats sidebars from VS Code-style layout controls", () => {
    const onTogglePrimary = vi.fn();
    const onToggleChats = vi.fn();

    render(
      <Titlebar
        workspace={workspace}
        workspaces={[workspace]}
        primarySidebar={{ visible: true, onToggle: onTogglePrimary }}
        chatsSidebar={{ visible: false, onToggle: onToggleChats }}
      />,
    );

    const primary = screen.getByRole("button", { name: "Toggle primary sidebar" });
    const chats = screen.getByRole("button", { name: "Toggle chats sidebar" });
    expect(primary.getAttribute("aria-pressed")).toBe("true");
    expect(chats.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(primary);
    fireEvent.click(chats);
    expect(onTogglePrimary).toHaveBeenCalledOnce();
    expect(onToggleChats).toHaveBeenCalledOnce();
  });

  // The quick-open button is centered on the window, so a long workspace name
  // used to run under it and hide the status beside it. Everything on the left
  // now shares one clamped group and shortens inside it.
  it("clamps the workspace name and its status into the space left of quick-open", () => {
    vi.stubGlobal("dohcDesktop", { platform: "win32" });

    render(
      <Titlebar
        workspace={workspace}
        workspaces={[workspace]}
        onSwitchWorkspace={() => undefined}
        onQuickOpen={() => undefined}
        workspaceStatus={<span data-testid="stub-status">Local · saved</span>}
      />,
    );

    const group = screen.getByTestId("titlebar-left-group");
    expect(group.contains(screen.getByTestId("status-workspace"))).toBe(true);
    expect(group.contains(screen.getByTestId("stub-status"))).toBe(true);
    // Absolutely positioned against the window, never inside the clamp.
    expect(group.contains(screen.getByTestId("titlebar-quick-open"))).toBe(false);
  });

  it("shortens the workspace name rather than the status beside it", () => {
    render(
      <Titlebar
        workspace={{ ...workspace, rootPath: "/home/sam/launch-readiness-and-self-hosting" }}
        workspaces={[workspace]}
        onSwitchWorkspace={() => undefined}
      />,
    );

    const name = screen.getByTestId("status-workspace");
    // min-w-0 is what lets the name shrink inside the clamp; truncate is what
    // ends it in an ellipsis instead of pushing the status out of the window.
    expect(name.className).toContain("min-w-0");
    expect(name.className).toContain("truncate");
    // A shortened name stays readable on hover.
    expect(screen.getByTestId("workspace-switcher").getAttribute("title")).toBe(
      "launch-readiness-and-self-hosting",
    );
  });

  it("omits the chats layout control when the workspace has no chats sidebar", () => {
    render(
      <Titlebar
        workspace={workspace}
        workspaces={[workspace]}
        primarySidebar={{ visible: true, onToggle: () => undefined }}
      />,
    );

    expect(screen.getByTestId("titlebar-primary-sidebar")).toBeTruthy();
    expect(screen.queryByTestId("titlebar-chats-sidebar")).toBeNull();
  });
});
