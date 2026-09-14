// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceManager } from "./WorkspaceManager";

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
  forgetWorkspace: vi.fn(async () => undefined),
  revealWorkspaceFolder: vi.fn(async () => undefined),
  platform: "linux",
};

const KNOWN = [
  { workspaceId: "ws-a", rootPath: "/home/ice/dohc/personal", kind: "personal" as const, mode: "local-first" as const },
  { workspaceId: "ws-b", rootPath: "/home/ice/dohc/team", kind: "personal" as const, mode: "local-first" as const },
];

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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

  it("reports default workspace root failures", async () => {
    bridge.getDefaultWorkspaceRoot.mockRejectedValueOnce(new Error("No home dir"));

    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);

    expect(await screen.findByText("No home dir")).toBeTruthy();
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
      <WorkspaceManager workspaces={KNOWN} current={KNOWN[0]} onForgot={async () => KNOWN} onOpenWorkspace={onOpen} onBack={() => {}} />,
    );
    const rows = await screen.findAllByTestId("workspace-manager-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("/home/ice/dohc/team")).toBeTruthy();
    await user.click(screen.getByText("team"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-b" }));
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

  it("reveals a workspace folder from the row menu", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceManager workspaces={KNOWN} current={null} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "More for personal" }));
    await user.click(screen.getByRole("menuitem", { name: "Reveal in folder" }));
    expect(bridge.revealWorkspaceFolder).toHaveBeenCalledWith({ workspaceId: "ws-a" });
  });

  it("shows no list and no back button on first run", async () => {
    render(<WorkspaceManager workspaces={[]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />);
    await screen.findByText("/home/ice/dohc/");
    expect(screen.queryByTestId("workspace-manager-row")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to workspace" })).toBeNull();
  });
});

describe("workspace shelf", () => {
  it("orders folders by last opened and marks the shared one", async () => {
    const shared = {
      workspaceId: "ws-c",
      rootPath: "/home/ice/dohc/shared/trip",
      kind: "personal" as const,
      mode: "local-first" as const,
      lastOpenedAt: 1_000,
      shareView: { shareId: "s-1", granterEmail: "maya@dohc.app", access: "read-only" as const },
    };
    const recent = { ...KNOWN[0]!, lastOpenedAt: 3_000 };
    const old = { ...KNOWN[1]!, lastOpenedAt: 2_000 };
    render(
      <WorkspaceManager workspaces={[old, shared, recent]} current={null} onForgot={async () => []} onOpenWorkspace={() => {}} />,
    );
    const rows = await screen.findAllByTestId("workspace-manager-row");
    expect(rows.map((row) => row.getAttribute("data-workspace-id"))).toEqual(["ws-a", "ws-b", "ws-c"]);
    expect(screen.getByText("Shared by maya")).toBeTruthy();
    expect(screen.getAllByText("Local only")).toHaveLength(2);
    expect(screen.getByTestId("workspace-manager-new")).toBeTruthy();
  });

  it("opens the new-workspace card from the dashed folder and comes back", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceManager workspaces={KNOWN} current={KNOWN[0]!} onForgot={async () => KNOWN} onOpenWorkspace={() => {}} />,
    );
    await user.click(await screen.findByTestId("workspace-manager-new"));
    expect(await screen.findByLabelText("Folder name")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByTestId("workspace-manager-new")).toBeTruthy();
  });
});
