// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceInviteRow,
  WorkspaceMemberRow,
} from "../ipc/bridgeContract";
import { WorkspaceManagementDialog } from "./WorkspaceManagementDialog";

const owner: WorkspaceMemberRow = {
  userId: "owner-1",
  email: "owner@dohc.test",
  role: "owner",
};

const member: WorkspaceMemberRow = {
  userId: "member-1",
  email: "member@dohc.test",
  role: "member",
};

const pendingInvite: WorkspaceInviteRow = {
  inviteId: "invite-1",
  workspaceId: "ws-members",
  email: "pending@dohc.test",
  role: "member",
  invitedBy: "owner-1",
  status: "pending",
};

const bridge = {
  listWorkspaceMembers: vi.fn(async () => ({ members: [owner, member] })),
  listWorkspaceInvites: vi.fn(async () => ({ invites: [pendingInvite] })),
  createWorkspaceInvite: vi.fn(async () => ({
    invite: {
      ...pendingInvite,
      inviteId: "invite-2",
      email: "new@dohc.test",
    },
  })),
  revokeWorkspaceInvite: vi.fn(async () => undefined),
};

vi.mock("./bridge", () => ({
  bridge: () => bridge,
}));

function renderDialog() {
  return render(
    <WorkspaceManagementDialog
      workspaceId="ws-members"
      onClose={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceManagementDialog", () => {
  it("loads members and pending invitations", async () => {
    renderDialog();

    const dialog = await screen.findByTestId("workspace-management-dialog");
    expect(within(dialog).getByText("owner@dohc.test")).toBeTruthy();
    expect(within(dialog).getByText("member@dohc.test")).toBeTruthy();
    expect(within(dialog).getByText("pending@dohc.test")).toBeTruthy();
    expect(bridge.listWorkspaceMembers).toHaveBeenCalledWith({
      workspaceId: "ws-members",
    });
    expect(bridge.listWorkspaceInvites).toHaveBeenCalledWith({
      workspaceId: "ws-members",
    });
  });

  it("creates a pending invitation and shows it immediately", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(await screen.findByTestId("workspace-invite-email"), "new@dohc.test");
    await user.click(screen.getByTestId("workspace-invite-submit"));

    await waitFor(() => {
      expect(bridge.createWorkspaceInvite).toHaveBeenCalledWith({
        workspaceId: "ws-members",
        email: "new@dohc.test",
      });
    });
    expect(await screen.findByText("Invitation sent to new@dohc.test.")).toBeTruthy();
    expect(screen.getByText("new@dohc.test")).toBeTruthy();
  });

  it("refreshes members when an invitation is immediately claimed", async () => {
    bridge.createWorkspaceInvite.mockResolvedValueOnce({
      invite: {
        ...pendingInvite,
        inviteId: "claimed-1",
        email: "existing@dohc.test",
        status: "claimed",
      },
    });
    const user = userEvent.setup();
    renderDialog();

    await user.type(
      await screen.findByTestId("workspace-invite-email"),
      "existing@dohc.test",
    );
    await user.click(screen.getByTestId("workspace-invite-submit"));

    await waitFor(() => {
      expect(bridge.listWorkspaceMembers).toHaveBeenCalledTimes(2);
      expect(screen.getByText("existing@dohc.test is now a workspace member.")).toBeTruthy();
    });
  });

  it("revokes a pending invitation", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByTestId("workspace-revoke-invite"));

    await waitFor(() => {
      expect(bridge.revokeWorkspaceInvite).toHaveBeenCalledWith({
        workspaceId: "ws-members",
        inviteId: "invite-1",
      });
    });
    expect(await screen.findByText("Revoked invite for pending@dohc.test.")).toBeTruthy();
    expect(screen.queryByText("pending@dohc.test")).toBeNull();
  });

  it("strips Electron IPC prefixes from local-only errors", async () => {
    bridge.listWorkspaceMembers.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:list-workspace-members': Error: Sync this workspace before sharing.",
      ),
    );
    renderDialog();

    const error = await screen.findByTestId("workspace-management-error");
    expect(error.textContent).toContain("Sync this workspace before sharing.");
    expect(error.textContent).not.toContain("Error invoking remote method");
  });
});
