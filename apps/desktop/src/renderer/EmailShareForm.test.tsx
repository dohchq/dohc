// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automationShareWarning } from "./automationShareCheck";
import { EmailShareForm } from "./EmailShareForm";

const SHARE_CODE = "dohc-share:share-1:http://relay.test";

const bridgeMock = {
  automationShareImpact: vi.fn(),
  createRelayShare: vi.fn(),
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
  bridgeMock.automationShareImpact.mockResolvedValue({ stops: [] });
});

afterEach(() => {
  cleanup();
});

// The level is chosen from the menu on the access itself.
async function chooseAccess(user: ReturnType<typeof userEvent.setup>, level: "view" | "edit") {
  await user.click(screen.getByTestId("share-access"));
  await user.click(await screen.findByTestId(`share-access-${level}`));
}

const spend = {
  automationId: "collection:Trip#spend",
  automationName: "Spend",
  collectionPath: "Trip",
  target: "Budget",
  action: "change" as const,
};

it.each([["Trip"], ["first.md", "second.md"]])(
  "discloses full History beside the edit choice for %j",
  async (...paths) => {
    const user = userEvent.setup();
    render(
      <EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths }} onDone={() => {}} />,
    );
    const line = "They can see the full History.";
    await user.click(screen.getByTestId("share-access"));
    expect((await screen.findByTestId("share-access-edit")).textContent).toContain(line);
    expect(screen.getByTestId("share-access-view").textContent).not.toContain(line);
  },
);

describe("automation steps a share would stop", () => {
  it("says so in one sentence before an Edit share, and makes the share on the second Invite", async () => {
    const user = userEvent.setup();
    bridgeMock.automationShareImpact.mockResolvedValue({ stops: [spend] });
    render(
      <EmailShareForm
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["Trip"] }}
        onDone={() => {}}
      />,
    );
    await user.type(screen.getByTestId("share-email"), "ana@dohc.test");
    await chooseAccess(user, "edit");
    await user.click(screen.getByTestId("share-create"));

    expect(bridgeMock.automationShareImpact).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "ana@dohc.test",
      paths: ["Trip"],
      access: "edit",
    });
    expect(bridgeMock.createRelayShare).not.toHaveBeenCalled();
    expect(screen.getByTestId("share-automation-warning").textContent).toBe(
      'This share stops the automation "Spend" in Trip, because ana@dohc.test cannot edit Budget.',
    );
    expect(screen.getByTestId("share-create").textContent).toBe("Invite anyway");

    await chooseAccess(user, "view");
    expect(screen.queryByTestId("share-automation-warning")).toBeNull();
    await chooseAccess(user, "edit");
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "ana@dohc.test",
      access: "edit",
      paths: ["Trip"],
    });
    expect(bridgeMock.automationShareImpact).toHaveBeenCalledTimes(1);
  });

  it("drops a check still running when the share on screen changes, so Invite never makes the old one", async () => {
    const user = userEvent.setup();
    let answer: (value: { stops: [] }) => void = () => undefined;
    bridgeMock.automationShareImpact.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    render(
      <EmailShareForm
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["Trip"] }}
        onDone={() => {}}
      />,
    );
    await user.type(screen.getByTestId("share-email"), "ana@dohc.test");
    await chooseAccess(user, "edit");
    await user.click(screen.getByTestId("share-create"));
    expect(screen.getByTestId("share-create").textContent).toBe("Checking automations…");

    await chooseAccess(user, "view");
    await act(async () => answer({ stops: [] }));
    expect(bridgeMock.createRelayShare).not.toHaveBeenCalled();
    expect(screen.getByTestId("share-create").textContent).toBe("Invite");

    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1",
      recipientEmail: "ana@dohc.test",
      access: "view",
      paths: ["Trip"],
    });
  });

  it("asks nothing for a View share, and shares when the check itself fails, saying so", async () => {
    const user = userEvent.setup();
    render(
      <EmailShareForm
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["Trip"] }}
        onDone={() => {}}
      />,
    );
    await user.type(screen.getByTestId("share-email"), "ana@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.automationShareImpact).not.toHaveBeenCalled();
    expect(screen.queryByTestId("share-automation-check-failed")).toBeNull();
    cleanup();

    bridgeMock.automationShareImpact.mockRejectedValue(
      new Error("dohc is still opening this workspace's automations."),
    );
    render(
      <EmailShareForm
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["Trip"] }}
        onDone={() => {}}
      />,
    );
    await user.type(screen.getByTestId("share-email"), "ana@dohc.test");
    await chooseAccess(user, "edit");
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledTimes(2);
    expect((await screen.findByTestId("share-automation-check-failed")).textContent).toBe(
      "dohc could not check which automations this share stops.",
    );
  });

  it("names each automation by its Collection's full path, and each place it could not reach", () => {
    expect(
      automationShareWarning(
        [
          { ...spend, collectionPath: "Projects/Trip" },
          { ...spend, collectionPath: "Projects/Trip" },
          {
            automationId: "collection:Home/Trip#spend",
            automationName: "Spend",
            collectionPath: "Home/Trip",
            target: "Archive",
            action: "find",
          },
        ],
        "ana@dohc.test",
      ),
    ).toBe(
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
    // Shares end from the Sharing view.
    expect(screen.getByText("You can end this share anytime from Sharing.")).toBeTruthy();

    await user.click(screen.getByTestId("share-code-copy"));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(SHARE_CODE));
  });

  it("copies the exact server invitation and retains the desktop code", async () => {
    const invitation = "https://share.example.test/s/edit/exact-grant";
    bridgeMock.createRelayShare.mockResolvedValue({
      shareId: "share-1",
      grantId: "exact-grant",
      shareCode: SHARE_CODE,
      recipientEmail: "friend@dohc.test",
      browserInvitationUrl: invitation,
    });
    const user = userEvent.setup();
    render(
      <EmailShareForm
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs"] }}
        onDone={() => {}}
      />,
    );
    await user.click(screen.getByTestId("share-access"));
    expect((await screen.findByTestId("share-access-edit")).textContent).toContain(
      "shared Markdown files live when available",
    );
    await user.click(screen.getByTestId("share-access-edit"));
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect(
      (await screen.findByTestId("share-browser-invitation")).getAttribute("data-grant-id"),
    ).toBe("exact-grant");
    const copyInvitation = screen.getByTestId("share-browser-invitation-copy");
    expect(screen.getByRole("button", { name: "Copy browser invitation" })).toBe(copyInvitation);
    await user.click(copyInvitation);
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(invitation));
    expect(await screen.findByRole("button", { name: "Browser invitation copied" })).toBe(
      copyInvitation,
    );
    expect(screen.getByTestId("share-code").textContent).toBe(SHARE_CODE);
    expect(screen.getByText(/sign in with the invited account/)).toBeTruthy();
  });

  it("ignores a creation response after the workspace changes", async () => {
    let complete!: (result: unknown) => void;
    bridgeMock.createRelayShare.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const user = userEvent.setup();
    const view = render(
      <EmailShareForm
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs"] }}
        onDone={() => {}}
      />,
    );
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    view.rerender(
      <EmailShareForm
        workspaceId="ws-2"
        target={{ kind: "paths", paths: ["docs"] }}
        onDone={() => {}}
      />,
    );
    await act(async () =>
      complete({
        shareId: "old-share",
        grantId: "old-grant",
        shareCode: SHARE_CODE,
        recipientEmail: "friend@dohc.test",
        browserInvitationUrl: "https://share.example.test/s/edit/old-grant",
      }),
    );
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
        onDone={() => {}}
      />,
    );

    expect(screen.getByTestId("share-access").textContent).toBe("Can view");
    await user.click(screen.getByTestId("share-access"));
    const levels = await screen.findAllByRole("menuitemradio", { hidden: true });
    expect(levels.map((level) => level.getAttribute("data-testid"))).toEqual([
      "share-access-view",
      "share-access-edit",
    ]);
    const [view, edit] = levels as [HTMLElement, HTMLElement];
    expect(view.getAttribute("aria-checked")).toBe("true");
    expect(view.textContent).toBe("Can viewThey can read only what you selected.");
    expect(
      edit.textContent,
      "promising 'edit what you selected' would name a right Edit does not grant",
    ).toContain("Can editThey can read only what you selected, and send you changes to accept.");
    expect(screen.queryByTestId("share-access-pending")).toBeNull();

    await user.click(edit);
    expect(screen.getByTestId("share-access").textContent).toBe("Can edit");

    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "friend@dohc.test",
      access: "edit",
      paths: ["docs/plan.md"],
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
      <EmailShareForm
        workspaceId="ws-1"
        target={{ kind: "paths", paths: [".env"] }}
        onDone={() => {}}
      />,
    );
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect((await screen.findByRole("alert")).textContent).toBe("Secret files can't be shared.");
  });
});
