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
      versionId: "version-7",
    });
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
