// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automationShareWarning } from "./automationShareCheck";
import { EmailShareForm } from "./EmailShareForm";
import type { RelayShareTarget } from "./RelayShareDialog";

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
    render(<EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths }} />);
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
    render(<EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["Trip"] }} />);
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
    render(<EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["Trip"] }} />);
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
    render(<EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["Trip"] }} />);
    await user.type(screen.getByTestId("share-email"), "ana@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.automationShareImpact).not.toHaveBeenCalled();
    expect(screen.queryByTestId("share-automation-check-failed")).toBeNull();
    cleanup();

    bridgeMock.automationShareImpact.mockRejectedValue(
      new Error("dohc is still opening this workspace's automations."),
    );
    render(<EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["Trip"] }} />);
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
  it("invites, then clears the field for the next address and says what to do next", async () => {
    const user = userEvent.setup();
    render(
      <EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["docs/plan.md"] }} />,
    );

    const field = screen.getByTestId<HTMLInputElement>("share-email");
    await user.type(field, "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));

    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "friend@dohc.test",
      access: "view",
      paths: ["docs/plan.md"],
    });
    const status = await screen.findByText(/^Invited/);
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe(
      "Invited friend@dohc.test. Copy the invitation and send it to them.",
    );
    expect(field.value).toBe("");
    expect(document.activeElement).toBe(field);
    expect(screen.getByTestId("share-create").textContent).toBe("Invite");

    const copy = screen.getByRole("button", { name: "Copy invitation" });
    expect(copy).toBe(screen.getByTestId("share-invitation-copy"));
    await user.click(copy);
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(SHARE_CODE));
    expect(await screen.findByRole("button", { name: "Invitation copied" })).toBe(copy);
  });

  it("invites a second person at the access chosen for the first", async () => {
    const user = userEvent.setup();
    render(<EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["docs"] }} />);
    await chooseAccess(user, "edit");
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test{Enter}");
    await screen.findByText(/^Invited/);

    bridgeMock.createRelayShare.mockResolvedValue({
      shareId: "share-2",
      grantId: "grant-2",
      shareCode: "dohc-share:share-2:http://relay.test",
      recipientEmail: "ana@dohc.test",
    });
    await user.keyboard("ana@dohc.test{Enter}");
    await waitFor(() =>
      expect(screen.getByText(/^Invited/).textContent).toBe(
        "Invited ana@dohc.test. Copy the invitation and send it to them.",
      ),
    );
    expect(bridgeMock.createRelayShare).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "ana@dohc.test",
      access: "edit",
      paths: ["docs"],
    });
    await user.click(screen.getByTestId("share-invitation-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("dohc-share:share-2:http://relay.test"),
    );
  });

  it("copies the browser invitation when the server gives one", async () => {
    const invitation = "https://share.example.test/s/edit/exact-grant";
    bridgeMock.createRelayShare.mockResolvedValue({
      shareId: "share-1",
      grantId: "exact-grant",
      shareCode: SHARE_CODE,
      recipientEmail: "friend@dohc.test",
      browserInvitationUrl: invitation,
    });
    const user = userEvent.setup();
    render(<EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["docs"] }} />);
    await user.click(screen.getByTestId("share-access"));
    expect((await screen.findByTestId("share-access-edit")).textContent).toContain(
      "shared Markdown files live when available",
    );
    await user.click(screen.getByTestId("share-access-edit"));
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    await user.click(await screen.findByTestId("share-invitation-copy"));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(invitation));
  });

  it("offers the share code beside an invitation that can be a browser link", async () => {
    const invitation = "https://share.example.test/s/edit/exact-grant";
    bridgeMock.createRelayShare.mockResolvedValue({
      shareId: "share-1",
      grantId: "exact-grant",
      shareCode: SHARE_CODE,
      recipientEmail: "friend@dohc.test",
      browserInvitationUrl: invitation,
    });
    const user = userEvent.setup();
    render(<EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["docs"] }} />);
    await chooseAccess(user, "edit");
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test{Enter}");

    const code = await screen.findByRole("button", { name: "Copy share code" });
    expect(code).toBe(screen.getByTestId("share-code-copy"));
    await user.click(code);
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(SHARE_CODE));
    expect(await screen.findByRole("button", { name: "Share code copied" })).toBe(code);
    await user.click(screen.getByTestId("share-invitation-copy"));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(invitation));
  });

  it.each<{ name: string; target: RelayShareTarget; level: "view" | "edit" }>([
    { name: "a View share of files", target: { kind: "paths", paths: ["docs"] }, level: "view" },
    {
      name: "an Edit share of a version",
      target: { kind: "version", versionId: "v1" },
      level: "edit",
    },
    {
      name: "an Edit share of files the relay answers without a browser invitation",
      target: { kind: "paths", paths: ["docs"] },
      level: "edit",
    },
  ])("offers one copy for $name, whose invitation is the code", async ({ target, level }) => {
    const user = userEvent.setup();
    render(<EmailShareForm workspaceId="ws-1" target={target} />);
    await chooseAccess(user, level);
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test{Enter}");

    await user.click(await screen.findByTestId("share-invitation-copy"));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(SHARE_CODE));
    expect(screen.queryByTestId("share-code-copy")).toBeNull();
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
      <EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["docs"] }} />,
    );
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    view.rerender(
      <EmailShareForm workspaceId="ws-2" target={{ kind: "paths", paths: ["docs"] }} />,
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
    expect(screen.queryByText(/^Invited/)).toBeNull();
    expect(screen.queryByTestId("share-invitation-copy")).toBeNull();
    expect(screen.getByTestId<HTMLInputElement>("share-email").value).toBe("friend@dohc.test");
    expect(screen.getByTestId("share-create").hasAttribute("disabled")).toBe(false);
  });

  it("offers View and Edit for email without promising a discussion", async () => {
    const user = userEvent.setup();
    render(
      <EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: ["docs/plan.md"] }} />,
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
    render(<EmailShareForm workspaceId="ws-1" target={{ kind: "paths", paths: [".env"] }} />);
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect((await screen.findByRole("alert")).textContent).toBe("Secret files can't be shared.");
  });
});
