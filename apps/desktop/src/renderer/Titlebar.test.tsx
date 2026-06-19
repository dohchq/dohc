// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
});
