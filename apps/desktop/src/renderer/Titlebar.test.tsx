// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Titlebar, workspaceName } from "./Titlebar";
import type { Workspace } from "./DesktopWorkspaceShell";

const workspace: Workspace = {
  workspaceId: "ws-1",
  rootPath: "/home/ice/dohc",
  kind: "personal",
  mode: "local-first",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("workspaceName", () => {
  it("uses the final path segment and ignores trailing separators", () => {
    expect(workspaceName({ ...workspace, rootPath: "/home/ice/dohc/" })).toBe("dohc");
    expect(workspaceName({ ...workspace, rootPath: "C:\\Users\\ice\\dohc\\" })).toBe("dohc");
    expect(workspaceName({ ...workspace, rootPath: "/" })).toBe("workspace");
  });
});

describe("Titlebar", () => {
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
