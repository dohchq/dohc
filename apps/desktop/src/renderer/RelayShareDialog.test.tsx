// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayShareDialog } from "./RelayShareDialog";

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
    shareCode: "dohc-share:share-1:http://relay.test",
    recipientEmail: "friend@dohc.test",
  });
  bridgeMock.writeClipboardText.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("RelayShareDialog", () => {
  it("creates a path share and shows the copyable code", async () => {
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ path: "docs/plan.md" }}
        onClose={() => {}}
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
    expect(code.textContent).toBe("dohc-share:share-1:http://relay.test");

    await user.click(screen.getByTestId("share-code-copy"));
    expect(bridgeMock.writeClipboardText).toHaveBeenCalledWith({
      text: "dohc-share:share-1:http://relay.test",
    });
  });

  it("creates a version share addressed by version id", async () => {
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ versionId: "version-7", versionName: "review" }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/version “review”/)).toBeTruthy();

    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "friend@dohc.test",
      access: "view",
      versionId: "version-7",
    });
  });

  // The level is stated, not implied. All three are real from #646 PR3a, so
  // every option is selectable and each says exactly what it grants.
  it("offers all three levels, states each one, and sends the level it showed", async () => {
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ path: "docs/plan.md" }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId("share-access-view").getAttribute("aria-checked")).toBe(
      "true",
    );
    for (const level of ["view", "comment", "edit"] as const) {
      expect(
        screen.getByTestId(`share-access-${level}`).hasAttribute("disabled"),
        `MUTATION: ${level} disabled would refuse a level the relay now grants`,
      ).toBe(false);
    }
    expect(screen.getByTestId("share-access-helper").textContent).toBe(
      "They can read what you selected.",
    );
    // Nothing is pending any more, so the line that said so is gone.
    expect(screen.queryByTestId("share-access-pending")).toBeNull();

    // Comment takes the selection and states the right it grants.
    await user.click(screen.getByTestId("share-access-comment"));
    expect(screen.getByTestId("share-access-comment").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("share-access-helper").textContent).toBe(
      "They can read what you selected and chat about it.",
    );

    // Edit states the write-back model, not a right over the granter's files.
    await user.click(screen.getByTestId("share-access-edit"));
    expect(screen.getByTestId("share-access-edit").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      screen.getByTestId("share-access-helper").textContent,
      "MUTATION: promising 'edit what you selected' would name a right Edit does not grant",
    ).toBe("They can read, chat, and send you changes to accept.");

    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith(
      expect.objectContaining({ access: "edit" }),
    );
  });

  // The label is Ice's open question (Suggest vs Edit); the wire value is not.
  it("keeps the Edit label on the level the relay calls edit", () => {
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ path: "docs/plan.md" }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("share-access-edit").textContent).toBe("Edit");
  });

  // The dialog no longer promises a level in prose: at Edit that sentence
  // would be false, and the level now has its own control.
  it("drops the read-only claim from the lead sentence", () => {
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ path: "docs/plan.md" }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/read-only live view/)).toBeNull();
  });

  it("creates a multi-path site artifact share with a simple label", async () => {
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{
          paths: ["index.html", "assets/logo.png"],
          label: "Workspace Site",
        }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/Workspace Site/)).toBeTruthy();
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "friend@dohc.test",
      access: "view",
      paths: ["index.html", "assets/logo.png"],
    });
  });

  it("shows the handler's honest error copy (secret refusal), stripped of IPC noise", async () => {
    bridgeMock.createRelayShare.mockRejectedValue(
      new Error(
        "Error invoking remote method 'desktop:create-relay-share': Error: Secret files can't be shared.",
      ),
    );
    const user = userEvent.setup();
    render(
      <RelayShareDialog workspaceId="ws-1" target={{ path: ".env" }} onClose={() => {}} />,
    );
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    const error = await screen.findByTestId("share-error");
    expect(error.textContent).toBe("Secret files can't be shared.");
  });
});
