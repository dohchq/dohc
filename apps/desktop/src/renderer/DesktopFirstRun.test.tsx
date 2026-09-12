// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopFirstRun } from "./DesktopFirstRun";

const bridge = {
  getDefaultWorkspaceRoot: vi.fn(async () => "/home/ice/dohc"),
  pickWorkspaceRoot: vi.fn(async () => "/home/ice/projects/research"),
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
};

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("first run", () => {
  it("places a browser share handoff ahead of the ordinary first-run card", async () => {
    const onDismissShareHandoff = vi.fn();
    render(
      <DesktopFirstRun
        onWorkspaceReady={() => {}}
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
    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
    expect(await screen.findByText("/home/ice/dohc/")).toBeTruthy();
    expect(screen.getByLabelText("Folder name")).toHaveProperty("value", "personal");
  });

  it("creates the folder under the name the user typed", async () => {
    const user = userEvent.setup();
    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
    const name = await screen.findByLabelText("Folder name");
    await user.clear(name);
    await user.type(name, "research{Enter}");
    expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/home/ice/dohc/research" }),
    );
  });

  it("refuses an empty or nested folder name", async () => {
    const user = userEvent.setup();
    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
    const name = await screen.findByLabelText("Folder name");
    const create = screen.getByRole("button", { name: /create workspace/i });
    await user.clear(name);
    expect(create).toHaveProperty("disabled", true);
    await user.type(name, "a/b");
    expect(create).toHaveProperty("disabled", true);
  });

  it("lets the user choose another folder", async () => {
    const user = userEvent.setup();
    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
    await user.click(
      await screen.findByRole("button", { name: "Change location" }),
    );
    expect(bridge.pickWorkspaceRoot).toHaveBeenCalledOnce();
    expect(await screen.findByText("/home/ice/projects/research/")).toBeTruthy();
  });

  it("creates a personal workspace and hands it to the shell", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    render(<DesktopFirstRun onWorkspaceReady={onReady} />);
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

  it("reports default workspace root failures", async () => {
    bridge.getDefaultWorkspaceRoot.mockRejectedValueOnce(new Error("No home dir"));

    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);

    expect(await screen.findByText("No home dir")).toBeTruthy();
  });

  it("attaches an existing folder as a workspace", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    render(<DesktopFirstRun onWorkspaceReady={onReady} />);
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
    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
    await screen.findByText("/home/ice/dohc/");
    expect(screen.queryByLabelText(/email|password/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /sign in|log in|sign up/i }))
      .toBeNull();
  });

  it("offers joining a synced workspace, gated on sign-in", async () => {
    const user = userEvent.setup();
    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
    await screen.findByText("/home/ice/dohc/");
    await user.click(
      screen.getByTestId("first-run-join-synced"),
    );
    expect(await screen.findByTestId("join-synced-workspace")).toBeTruthy();
    // No session yet: the panel asks for sign-in before showing the code
    // field, and the normal cloud sign-in is embedded right there.
    expect(
      await screen.findByText(/sign in first, then paste the code/i),
    ).toBeTruthy();
    expect(screen.queryByTestId("join-sync-code")).toBeNull();
    // Back returns to the normal first-run card.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("button", { name: /create workspace/i }),
    ).toBeTruthy();
  });

  it("reads like a desktop app, not a marketing page", async () => {
    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
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
