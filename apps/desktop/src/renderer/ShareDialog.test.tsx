// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceShareRow } from "../ipc/bridgeContract";
import { ShareDialog } from "./ShareDialog";

function share(row: Partial<WorkspaceShareRow>): WorkspaceShareRow {
  return {
    shareId: "share-1",
    workspaceId: "ws-1",
    atomId: "atom-1",
    atomPath: "notes/a.md",
    recipientUserId: "user-1",
    recipientEmail: "peer@dohc.test",
    capability: "view",
    ...row,
  };
}

const bridge = {
  listWorkspaceShares: vi.fn(async () => ({
    shares: [
      share({ shareId: "share-1", recipientEmail: "peer@dohc.test" }),
      share({
        shareId: "share-2",
        atomPath: "notes/other.md",
        recipientEmail: "other@dohc.test",
      }),
    ],
  })),
  createWorkspaceShare: vi.fn(async () => ({
    share: share({
      shareId: "share-new",
      recipientEmail: "teammate@dohc.test",
      recipientUserId: "user-new",
      capability: "edit",
    }),
  })),
  revokeWorkspaceShare: vi.fn(async () => undefined),
  createWorkspaceInvite: vi.fn(async () => ({
    invite: {
      inviteId: "invite-1",
      workspaceId: "ws-1",
      email: "new@dohc.test",
      role: "member",
      invitedBy: "owner-1",
      status: "pending" as const,
    },
  })),
};

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ShareDialog", () => {
  it("lists shares only for the current file and revokes one by id", async () => {
    const user = userEvent.setup();
    render(
      <ShareDialog
        workspaceId="ws-1"
        path="notes/a.md"
        onClose={() => undefined}
      />,
    );

    const dialog = await screen.findByTestId("share-dialog");
    expect(await within(dialog).findByText("peer@dohc.test")).toBeTruthy();
    expect(within(dialog).queryByText("other@dohc.test")).toBeNull();

    await user.click(screen.getByLabelText("Revoke peer@dohc.test"));

    await waitFor(() => {
      expect(bridge.revokeWorkspaceShare).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        shareId: "share-1",
      });
      expect(screen.queryByText("peer@dohc.test")).toBeNull();
    });
  });

  it("creates an atom-path share with the selected capability", async () => {
    const user = userEvent.setup();
    render(
      <ShareDialog
        workspaceId="ws-1"
        path="notes/a.md"
        onClose={() => undefined}
      />,
    );

    await screen.findByText("peer@dohc.test");
    await user.type(screen.getByTestId("share-email"), "teammate@dohc.test");
    await user.selectOptions(screen.getByTestId("share-capability"), "edit");
    await user.click(screen.getByRole("button", { name: "Share" }));

    await waitFor(() => {
      expect(bridge.createWorkspaceShare).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        atomPath: "notes/a.md",
        recipientEmail: "teammate@dohc.test",
        capability: "edit",
      });
    });
    expect(await screen.findByText("teammate@dohc.test")).toBeTruthy();
    expect(screen.getByTestId("share-message").textContent).toContain(
      "Shared with teammate@dohc.test.",
    );
  });

  it("offers a workspace invite when share creation says the user is missing", async () => {
    bridge.createWorkspaceShare.mockRejectedValueOnce(
      new Error("no user with that email - invite them to the workspace instead"),
    );
    const user = userEvent.setup();
    render(
      <ShareDialog
        workspaceId="ws-1"
        path="notes/a.md"
        onClose={() => undefined}
      />,
    );

    await screen.findByText("peer@dohc.test");
    await user.type(screen.getByTestId("share-email"), "new@dohc.test");
    await user.click(screen.getByRole("button", { name: "Share" }));
    await user.click(await screen.findByTestId("share-invite"));

    await waitFor(() => {
      expect(bridge.createWorkspaceInvite).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        email: "new@dohc.test",
      });
    });
    expect(screen.getByTestId("share-message").textContent).toContain(
      "Invitation sent to new@dohc.test.",
    );
  });

  it("surfaces local-only or signed-out load failures", async () => {
    bridge.listWorkspaceShares.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:list-workspace-shares': Error: Sync this workspace before sharing.",
      ),
    );

    render(
      <ShareDialog
        workspaceId="ws-1"
        path="notes/a.md"
        onClose={() => undefined}
      />,
    );

    expect((await screen.findByTestId("share-load-error")).textContent).toBe(
      "Sync this workspace before sharing.",
    );
  });
});
