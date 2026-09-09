// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailShareForm } from "./EmailShareForm";

const SHARE_CODE = "dohc-share:share-1:http://relay.test";

const bridgeMock = {
  createRelayShare: vi.fn(),
  writeClipboardText: vi.fn(),
};

vi.mock("./bridge", () => ({
  bridge: () => bridgeMock,
}));

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.createRelayShare.mockResolvedValue({
    shareId: "share-1",
    grantId: "grant-1",
    shareCode: SHARE_CODE,
    recipientEmail: "friend@dohc.test",
  });
  bridgeMock.writeClipboardText.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("EmailShareForm", () => {
  it("creates a path share and shows the copyable code", async () => {
    const user = userEvent.setup();
    render(
      <EmailShareForm
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        visible
        onDone={() => {}}
      />,
    );

    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));

    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "friend@dohc.test",
      access: "view",
      paths: ["docs/plan.md"],
    });
    const code = await screen.findByTestId("share-code");
    expect(code.textContent).toBe(SHARE_CODE);
    expect(screen.queryByTestId("share-browser-invitation-copy")).toBeNull();

    await user.click(screen.getByTestId("share-code-copy"));
    expect(bridgeMock.writeClipboardText).toHaveBeenCalledWith({ text: SHARE_CODE });
  });

  it("copies the exact server invitation and retains the desktop code", async () => {
    const invitation = "https://share.example.test/s/edit/exact-grant";
    bridgeMock.createRelayShare.mockResolvedValue({shareId: "share-1", grantId: "exact-grant", shareCode: SHARE_CODE,
      recipientEmail: "friend@dohc.test", browserInvitationUrl: invitation});
    const user = userEvent.setup();
    render(<EmailShareForm workspaceId="ws-1" target={{kind: "paths", paths: ["docs"]}} visible onDone={() => {}}/>);
    await user.click(screen.getByTestId("share-access-edit"));
    expect(screen.getByText(/Browser editing lets them/).textContent).toContain("shared Markdown files live when available");
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect((await screen.findByTestId("share-browser-invitation")).getAttribute("data-grant-id")).toBe("exact-grant");
    await user.click(screen.getByTestId("share-browser-invitation-copy"));
    expect(bridgeMock.writeClipboardText).toHaveBeenLastCalledWith({text: invitation});
    expect(screen.getByTestId("share-code").textContent).toBe(SHARE_CODE);
    expect(screen.getByText(/sign in with the invited account/)).toBeTruthy();
  });

  it("ignores a creation response after the workspace changes", async () => {
    let complete!: (result: unknown) => void;
    bridgeMock.createRelayShare.mockImplementation(() => new Promise(resolve => {complete = resolve;}));
    const user = userEvent.setup();
    const view = render(<EmailShareForm workspaceId="ws-1" target={{kind: "paths", paths: ["docs"]}} visible onDone={() => {}}/>);
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    view.rerender(<EmailShareForm workspaceId="ws-2" target={{kind: "paths", paths: ["docs"]}} visible onDone={() => {}}/>);
    await act(async () => complete({shareId: "old-share", grantId: "old-grant", shareCode: SHARE_CODE,
      recipientEmail: "friend@dohc.test", browserInvitationUrl: "https://share.example.test/s/edit/old-grant"}));
    expect(screen.queryByTestId("share-browser-invitation")).toBeNull();
    expect(screen.queryByTestId("share-code")).toBeNull();
    expect(screen.getByTestId("share-create").hasAttribute("disabled")).toBe(false);
  });

  it("offers View and Edit for email without promising a discussion", async () => {
    const user = userEvent.setup();
    render(
      <EmailShareForm
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        visible
        onDone={() => {}}
      />,
    );

    const emailAccess = screen.getByRole("radiogroup", { name: "Access" });
    expect(within(emailAccess).getByRole("radio", { name: "View" })).toBeTruthy();
    expect(within(emailAccess).getByRole("radio", { name: "Edit" })).toBeTruthy();
    expect(within(emailAccess).queryByRole("radio", { name: "Comment" })).toBeNull();
    expect(screen.getByTestId("share-access-view").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("share-access-helper").textContent).toBe(
      "They can read what you selected.",
    );
    expect(screen.queryByTestId("share-access-pending")).toBeNull();

    await user.click(screen.getByTestId("share-access-edit"));
    expect(screen.getByTestId("share-access-edit").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      screen.getByTestId("share-access-helper").textContent,
      "promising 'edit what you selected' would name a right Edit does not grant",
    ).toBe("They can read what you selected and send you changes to accept.");

    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "friend@dohc.test",
      access: "edit",
      paths: ["docs/plan.md"],
    });
  });

  it("keeps the Edit label on the level the relay calls edit", () => {
    render(
      <EmailShareForm
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        visible
        onDone={() => {}}
      />,
    );
    expect(screen.getByTestId("share-access-edit").textContent).toBe("Edit");
  });

  it("shows the handler's honest error copy (secret refusal), stripped of IPC noise", async () => {
    bridgeMock.createRelayShare.mockRejectedValue(
      new Error(
        "Error invoking remote method 'desktop:create-relay-share': Error: Secret files can't be shared.",
      ),
    );
    const user = userEvent.setup();
    render(
      <EmailShareForm
        workspaceId="ws-1"
        target={{ kind: "paths", paths: [".env"] }}
        visible
        onDone={() => {}}
      />,
    );
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Secret files can't be shared.",
    );
  });
});
