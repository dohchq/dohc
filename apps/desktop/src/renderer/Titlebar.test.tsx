// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Titlebar, workspaceName } from "./Titlebar";
import type { Workspace } from "./DesktopWorkspaceShell";
import { initWindowFullScreen } from "./windowFullScreen";

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

function stubFullScreen(platform: NodeJS.Platform): (fullScreen: boolean) => void {
  let listener: ((event: { fullScreen: boolean }) => void) | undefined;
  vi.stubGlobal("dohcDesktop", {
    platform,
    onWindowFullScreen: (next: typeof listener) => {
      listener = next;
      return () => undefined;
    },
  });
  initWindowFullScreen();
  return (fullScreen) => listener?.({ fullScreen });
}

describe("workspaceName", () => {
  it("uses the final path segment and ignores trailing separators", () => {
    expect(workspaceName({ ...workspace, rootPath: "/home/sam/dohc/" })).toBe("dohc");
    expect(workspaceName({ ...workspace, rootPath: "C:\\Users\\ice\\dohc\\" })).toBe("dohc");
    expect(workspaceName({ ...workspace, rootPath: "/" })).toBe("workspace");
  });
});

describe("Titlebar", () => {
  it("describes agent activity without nesting the status inside the About button", () => {
    render(<Titlebar agentActive aboutSidebar={{ visible: true, onToggle: vi.fn() }} />);
    const toggle = screen.getByRole("button", { name: "Toggle About" });
    const status = screen.getByRole("status", { name: "Agent running" });
    expect(toggle.contains(status)).toBe(false);
    expect(toggle.getAttribute("aria-describedby")).toBe(status.id);
    expect(status.textContent).toBe("Agent running");
  });

  it("marks a nightly build as an alpha, and no other build", () => {
    vi.stubGlobal("dohcDesktop", { platform: "win32", releaseChannel: "nightly" });
    render(<Titlebar workspace={workspace} workspaces={[workspace]} />);
    expect(screen.getByTestId("titlebar-alpha").textContent).toBe("Alpha");
    cleanup();

    vi.stubGlobal("dohcDesktop", { platform: "win32", releaseChannel: "latest" });
    render(<Titlebar workspace={workspace} workspaces={[workspace]} />);
    expect(screen.queryByTestId("titlebar-alpha")).toBeNull();
  });

  it("shows the macOS quick-open shortcut on macOS", () => {
    vi.stubGlobal("dohcDesktop", { platform: "darwin" });

    render(<Titlebar workspace={workspace} workspaces={[workspace]} onQuickOpen={() => undefined} />);

    expect(screen.getByTestId("titlebar-quick-open").textContent).toContain("⌘P");
  });

  // macOS draws the traffic lights over the title bar's left end and hides
  // them in full screen. Main tells the window which state it is in.
  it("starts 12px after the macOS traffic lights, or 12px from the edge in full screen", () => {
    const sendFullScreen = stubFullScreen("darwin");
    render(<Titlebar workspace={workspace} workspaces={[workspace]} onQuickOpen={() => undefined} />);
    const titlebar = screen.getByTestId("titlebar");
    expect(titlebar.style.paddingLeft).toBe("88px");

    act(() => sendFullScreen(true));
    expect(titlebar.style.paddingLeft).toBe("12px");
    act(() => sendFullScreen(false));
    expect(titlebar.style.paddingLeft).toBe("88px");
  });

  it("keeps the window-controls inset in full screen off macOS", () => {
    const sendFullScreen = stubFullScreen("win32");
    render(<Titlebar workspace={workspace} workspaces={[workspace]} onQuickOpen={() => undefined} />);
    const titlebar = screen.getByTestId("titlebar");
    const windowed = titlebar.getAttribute("style");

    act(() => sendFullScreen(true));
    expect(titlebar.getAttribute("style")).toBe(windowed);
    act(() => sendFullScreen(false));
  });

  it("shows Ctrl P quick-open shortcut off macOS", () => {
    vi.stubGlobal("dohcDesktop", { platform: "win32" });

    render(<Titlebar workspace={workspace} workspaces={[workspace]} onQuickOpen={() => undefined} />);

    expect(screen.getByTestId("titlebar-quick-open").textContent).toContain("Ctrl P");
  });

  it("toggles the primary sidebar and the About rail from VS Code-style layout controls", () => {
    const onTogglePrimary = vi.fn();
    const onToggleAbout = vi.fn();

    render(
      <Titlebar
        workspace={workspace}
        workspaces={[workspace]}
        primarySidebar={{ visible: true, onToggle: onTogglePrimary }}
        aboutSidebar={{ visible: false, onToggle: onToggleAbout }}
      />,
    );

    const primary = screen.getByRole("button", { name: "Toggle primary sidebar" });
    const about = screen.getByRole("button", { name: "Toggle About" });
    expect(primary.getAttribute("aria-pressed")).toBe("true");
    expect(about.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(primary);
    fireEvent.click(about);
    expect(onTogglePrimary).toHaveBeenCalledOnce();
    expect(onToggleAbout).toHaveBeenCalledOnce();
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

  // The breadcrumb: the mark, the workspace's own name, then its version and
  // one saved dot. The product word shows only before a workspace is open.
  it("reads mark, workspace, version, then the saved dot, with no product word", () => {
    render(
      <Titlebar
        workspace={workspace}
        workspaces={[workspace]}
        onSwitchWorkspace={() => undefined}
        version={<button type="button" data-testid="stub-version">Main</button>}
        workspaceStatus={<span data-testid="stub-status" role="status" aria-label="Local · saved" />}
      />,
    );
    const group = screen.getByTestId("titlebar-left-group");
    const name = screen.getByTestId("workspace-switcher");
    const version = screen.getByTestId("stub-version");
    const status = screen.getByTestId("stub-status");
    expect(group.contains(version)).toBe(true);
    expect(name.compareDocumentPosition(version) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(version.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The switcher names the workspace and nothing else.
    expect(name.textContent).toBe("dohc");
    expect(group.textContent).toBe("dohcMain");
    // The separator hides with its version while the picker has nothing to name.
    expect(version.parentElement?.className).toContain("empty:hidden");
    expect(version.parentElement?.className).toContain("before:content-['/']");
  });

  it("names the product only before a workspace is open", () => {
    render(<Titlebar />);
    expect(screen.getByTestId("titlebar-left-group").textContent).toBe("dohc");
  });

  it("draws no version separator when versions are off", () => {
    render(
      <Titlebar
        workspace={{ ...workspace, rootPath: "/home/sam/trip" }}
        workspaces={[workspace]}
        onSwitchWorkspace={() => undefined}
        workspaceStatus={<span data-testid="stub-status" />}
      />,
    );
    expect(screen.getByTestId("titlebar-left-group").querySelector("[class*=\"before:content-['/']\"]")).toBeNull();
    expect(screen.getByTestId("titlebar-left-group").textContent).toBe("trip");
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

  it("closes the workspace switcher on Escape and returns focus to it", () => {
    render(
      <Titlebar workspace={workspace} workspaces={[workspace]} onSwitchWorkspace={() => undefined} />,
    );
    const trigger = screen.getByTestId("workspace-switcher");

    fireEvent.click(trigger);
    expect(screen.getByRole("listbox", { name: "Workspaces" })).toBeTruthy();
    const option = screen.getByTestId("workspace-switcher-option").querySelector("button")!;
    option.focus();
    fireEvent.keyDown(option, { key: "Escape" });

    expect(screen.queryByRole("listbox", { name: "Workspaces" })).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("marks only a shared workspace in the switcher", () => {
    const shared = { ...workspace, workspaceId: "ws-2", rootPath: "/trip", kind: "shared" as const };
    render(
      <Titlebar workspace={workspace} workspaces={[workspace, shared]} onSwitchWorkspace={() => undefined} />,
    );

    fireEvent.click(screen.getByTestId("workspace-switcher"));
    const [personalRow, sharedRow] = screen.getAllByTestId("workspace-switcher-option");
    expect(personalRow!.textContent).toBe("dohc");
    expect(sharedRow!.textContent).toBe("tripShared");
  });

  it("closes the workspace switcher on a press outside it, not inside it", () => {
    render(
      <div>
        <button type="button">Elsewhere</button>
        <Titlebar workspace={workspace} workspaces={[workspace]} onSwitchWorkspace={() => undefined} />
      </div>,
    );

    fireEvent.click(screen.getByTestId("workspace-switcher"));
    fireEvent.pointerDown(screen.getByTestId("workspace-switcher-option"));
    expect(screen.getByRole("listbox", { name: "Workspaces" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("listbox", { name: "Workspaces" })).toBeNull();
  });

  // A drag region takes presses before the page sees them. styles.css turns
  // drag regions off while the root says a menu is open.
  it("marks a menu open while the switcher is open, so a press on the titlebar closes it", () => {
    render(
      <Titlebar workspace={workspace} workspaces={[workspace]} onSwitchWorkspace={() => undefined} />,
    );
    const titlebar = screen.getByTestId("titlebar");
    expect(document.documentElement.dataset.menuOpen).toBeUndefined();

    fireEvent.click(screen.getByTestId("workspace-switcher"));
    expect(document.documentElement.dataset.menuOpen).toBe("");
    fireEvent.pointerDown(titlebar);

    expect(screen.queryByRole("listbox", { name: "Workspaces" })).toBeNull();
    expect(document.documentElement.dataset.menuOpen).toBeUndefined();
  });

  it("omits the About layout control when the workspace has no About rail", () => {
    render(
      <Titlebar
        workspace={workspace}
        workspaces={[workspace]}
        primarySidebar={{ visible: true, onToggle: () => undefined }}
      />,
    );

    expect(screen.getByTestId("titlebar-primary-sidebar")).toBeTruthy();
    expect(screen.queryByTestId("titlebar-about-sidebar")).toBeNull();
  });
});

it("returns focus after choosing a workspace", async () => {
  const second = { ...workspace, workspaceId: "ws-2", rootPath: "/second" };
  render(<Titlebar workspace={workspace} workspaces={[workspace, second]} onSwitchWorkspace={() => {}} />);
  const trigger = screen.getByTestId("workspace-switcher");
  trigger.focus();
  fireEvent.click(trigger);
  const option = screen.getAllByTestId("workspace-switcher-option")[1]!;
  option.focus();
  fireEvent.click(option);
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
