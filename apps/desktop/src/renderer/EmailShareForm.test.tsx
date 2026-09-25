// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automationShareWarning } from "./automationShareCheck";
import { EmailShareForm } from "./EmailShareForm";

const SHARE_CODE = "dohc-share:share-1:http://relay.test";

const bridgeMock = {
  automationShareImpact: vi.fn(),
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
  bridgeMock.automationShareImpact.mockResolvedValue({ stops: [] });
});

afterEach(() => {
  cleanup();
});

const spend = { automationId: "collection:Trip#spend", automationName: "Spend", collectionPath: "Trip", target: "Budget", action: "change" as const };

describe("automation steps a share would stop", () => {
  it("says so in one sentence before an Edit share, and makes the share on the second Create", async () => {
    const user = userEvent.setup();
    bridgeMock.automationShareImpact.mockResolvedValue({ stops: [spend] });
    render(<EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["Trip"] }} visible onDone={() => {}} />);
    await user.type(screen.getByTestId("share-email"), "ana@dohc.test");
    await user.click(screen.getByTestId("share-access-edit"));
    await user.click(screen.getByTestId("share-create"));

    expect(bridgeMock.automationShareImpact).toHaveBeenCalledWith({
      workspaceId: "ws-1", recipientEmail: "ana@dohc.test", paths: ["Trip"], access: "edit",
    });
    expect(bridgeMock.createRelayShare).not.toHaveBeenCalled();
    expect(screen.getByTestId("share-automation-warning").textContent).toBe(
      'This share stops the automation "Spend" in Trip, because ana@dohc.test cannot edit Budget.',
    );
    expect(screen.getByTestId("share-create").textContent).toBe("Create share anyway");

    // Another access level is another share: its own check, and no warning for View.
    await user.click(screen.getByTestId("share-access-view"));
    expect(screen.queryByTestId("share-automation-warning")).toBeNull();
    await user.click(screen.getByTestId("share-access-edit"));
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-1", recipientEmail: "ana@dohc.test", access: "edit", paths: ["Trip"],
    });
    expect(bridgeMock.automationShareImpact).toHaveBeenCalledTimes(1);
  });

  it("drops a check still running when the share on screen changes, so Create never makes the old one", async () => {
    const user = userEvent.setup();
    let answer: (value: { stops: [] }) => void = () => undefined;
    bridgeMock.automationShareImpact.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    render(<EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["Trip"] }} visible onDone={() => {}} />);
    await user.type(screen.getByTestId("share-email"), "ana@dohc.test");
    await user.click(screen.getByTestId("share-access-edit"));
    await user.click(screen.getByTestId("share-create"));
    expect(screen.getByTestId("share-create").textContent).toBe("Checking automations…");

    await user.click(screen.getByTestId("share-access-view"));
    await act(async () => answer({ stops: [] }));
    expect(bridgeMock.createRelayShare).not.toHaveBeenCalled();
    expect(screen.getByTestId("share-create").textContent).toBe("Create share");

    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1", recipientEmail: "ana@dohc.test", access: "view", paths: ["Trip"],
    });
  });

  it("asks nothing for a View share, and shares when the check itself fails, saying so", async () => {
    const user = userEvent.setup();
    render(<EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["Trip"] }} visible onDone={() => {}} />);
    await user.type(screen.getByTestId("share-email"), "ana@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.automationShareImpact).not.toHaveBeenCalled();
    expect(screen.queryByTestId("share-automation-check-failed")).toBeNull();
    cleanup();

    bridgeMock.automationShareImpact.mockRejectedValue(new Error("dohc is still opening this workspace's automations."));
    render(<EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["Trip"] }} visible onDone={() => {}} />);
    await user.type(screen.getByTestId("share-email"), "ana@dohc.test");
    await user.click(screen.getByTestId("share-access-edit"));
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledTimes(2);
    expect((await screen.findByTestId("share-automation-check-failed")).textContent).toBe(
      "dohc could not check which automations this share stops.",
    );
  });

  it("names each automation by its Collection's full path, and each place it could not reach", () => {
    expect(automationShareWarning([
      { ...spend, collectionPath: "Projects/Trip" },
      { ...spend, collectionPath: "Projects/Trip" },
      { automationId: "collection:Home/Trip#spend", automationName: "Spend", collectionPath: "Home/Trip", target: "Archive", action: "find" },
    ], "ana@dohc.test")).toBe(
      'This share stops the automations "Spend" in Projects/Trip and "Spend" in Home/Trip, because ana@dohc.test cannot edit Budget or view Archive.',
    );
    expect(automationShareWarning([spend], null)).toBe(
      'This share stops the automation "Spend" in Trip, because anyone who opens this link cannot edit Budget.',
    );
    expect(automationShareWarning([], "ana@dohc.test")).toBeNull();
  });
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
