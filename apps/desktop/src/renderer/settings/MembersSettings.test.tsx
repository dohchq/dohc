// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMembersView, WorkspacePerson } from "@dohc/security-contract/workspace-members";
import type { MembersRequest, MembersResult } from "@dohc/cli/members";
import type { CloudStatusResult } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import type { CloudSettings } from "./CloudSyncSettings";
import { MembersSettings, membersGate } from "./MembersSettings";

const person = (overrides: Partial<WorkspacePerson> & Pick<WorkspacePerson, "memberId">): WorkspacePerson => ({
  role: "member", state: "active", name: null, email: null, invitedAtMs: 1, joinedAtMs: 2, removedAtMs: null, ...overrides,
});
const owner = person({ memberId: "owner", role: "owner", name: "Ice", email: "ice@test", invitedAtMs: null });
const ana = person({ memberId: "m-ana", role: "admin", name: "Ana", email: "ana@test" });
const bo = person({ memberId: "m-bo", name: "Bo", email: "bo@test" });
const cy = person({ memberId: "m-cy", state: "invited", email: "cy@test", joinedAtMs: null });
const dee = person({ memberId: "m-dee", state: "removed", name: "Dee", email: "dee@test", removedAtMs: 3 });

function ownerView(overrides: Partial<WorkspaceMembersView> = {}): WorkspaceMembersView {
  return {
    workspaceId: "ws-1", workspaceName: "Community",
    viewer: { memberId: "owner", role: "owner" }, memberLevel: "comment",
    inviteLink: { enabled: true, url: "https://share.test/join#secret" },
    people: [owner, ana, bo, cy, dee],
    ...overrides,
  };
}
const adminView = () => ownerView({ viewer: { memberId: "m-ana", role: "admin" } });
const memberView = (): WorkspaceMembersView => ({
  workspaceId: "ws-1", workspaceName: "Community",
  viewer: { memberId: "m-bo", role: "member" }, memberLevel: "edit", inviteLink: null,
  people: [owner, ana, bo].map((entry) => ({ ...entry, email: null })),
});

const status = (overrides: Partial<CloudStatusResult> = {}): CloudStatusResult => ({
  connected: true, email: "ice@test", serverUrl: "https://sync.test", workspaceSynced: true,
  workspaceSyncConnected: true, workspaceServerUrl: "https://sync.test", ...overrides,
});
const cloud = (overrides: Partial<CloudSettings> = {}): CloudSettings => ({
  status: status(), unreadable: false, onChanged: vi.fn(), onConnect: vi.fn(), onError: vi.fn(),
  onAccountError: vi.fn(), onDeleteAccount: vi.fn(), ...overrides,
});

const bridge = {
  workspaceMembers: vi.fn(async (_payload: { workspaceId: string; request: MembersRequest }): Promise<MembersResult> =>
    ({ status: "ready", view: ownerView() })),
};

function renderMembers(overrides: Partial<Parameters<typeof MembersSettings>[0]> = {}) {
  const props: Parameters<typeof MembersSettings>[0] = {
    workspaceId: "ws-1", workspaceName: "Community", cloud: cloud(), onOpenSync: vi.fn(), onError: vi.fn(), onClearError: vi.fn(),
    ...overrides,
  };
  const view = render(<MembersSettings {...props} />);
  return { props, view, rerender: (next: Partial<typeof props>) => view.rerender(<MembersSettings {...props} {...next} />) };
}
const row = (memberId: string) => document.querySelector<HTMLElement>(`[data-testid="settings-members-row"][data-member-id="${memberId}"]`)!;
const requests = () => bridge.workspaceMembers.mock.calls.map(([payload]) => payload.request);
async function openMenu(memberId: string) {
  await userEvent.click(within(row(memberId)).getByTestId("settings-members-row-menu"));
  // The menu opens in the top layer, which jsdom does not show.
  return screen.getAllByRole("menuitem", { hidden: true }).map((item) => item.textContent);
}

beforeEach(() => {
  bridge.workspaceMembers.mockImplementation(async () => ({ status: "ready", view: ownerView() }));
  vi.stubGlobal("dohcDesktop", bridge);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  bridge.workspaceMembers.mockReset();
  vi.clearAllMocks();
});

describe("Members page", () => {
  it("shows the owner every person with their email, invites, removed accounts, and the owner's controls", async () => {
    renderMembers();
    await screen.findByTestId("settings-members-page");
    expect(within(screen.getByTestId("settings-members-people")).getAllByTestId("settings-members-row").map((entry) => entry.dataset.memberId))
      .toEqual(["owner", "m-ana", "m-bo"]);
    expect(within(row("owner")).getByText("You")).toBeTruthy();
    expect(row("m-bo").textContent).toContain("bo@test");
    expect(within(screen.getByTestId("settings-members-invites")).getByText("cy@test")).toBeTruthy();
    expect(within(screen.getByTestId("settings-members-removed")).getByRole("button", { name: "Let back in" })).toBeTruthy();
    expect(screen.getByTestId("settings-members-link-url").textContent).toBe("https://share.test/join#secret");
    expect(screen.getByTestId("settings-members-level-words").textContent).toBe("Members can read everything, post in Groups, and comment on files.");
    expect(screen.getByTestId("settings-members-end")).toBeTruthy();
    expect(screen.queryByTestId("settings-members-leave")).toBeNull();
    expect(within(row("owner")).queryByTestId("settings-members-row-menu")).toBeNull();
    expect(await openMenu("m-ana")).toEqual(["Make member", "Remove from workspace"]);
  });

  it("gives an admin no role changes and no way to remove another admin", async () => {
    bridge.workspaceMembers.mockImplementation(async () => ({ status: "ready", view: adminView() }));
    renderMembers();
    await screen.findByTestId("settings-members-page");
    expect(within(row("m-ana")).queryByTestId("settings-members-row-menu")).toBeNull();
    expect(await openMenu("m-bo")).toEqual(["Remove from workspace"]);
    expect(screen.getByTestId("settings-members-leave")).toBeTruthy();
    expect(screen.queryByTestId("settings-members-end")).toBeNull();
    expect(screen.getByTestId("settings-members-invite")).toBeTruthy();
  });

  it("shows a member names and roles only, the level as words, and Leave", async () => {
    bridge.workspaceMembers.mockImplementation(async () => ({ status: "ready", view: memberView() }));
    renderMembers();
    const page = await screen.findByTestId("settings-members-page");
    expect(page.textContent).not.toMatch(/@test/u);
    expect(screen.queryByTestId("settings-members-invite")).toBeNull();
    expect(screen.queryByTestId("settings-members-link")).toBeNull();
    expect(screen.queryByTestId("settings-members-level-control")).toBeNull();
    expect(screen.getByTestId("settings-members-level-words").textContent).toBe("Members can read, comment, and edit documents and Collections.");
    expect(screen.queryAllByTestId("settings-members-row-menu")).toHaveLength(0);
    expect(screen.queryByTestId("settings-members-invites")).toBeNull();
    expect(screen.getByTestId("settings-members-leave")).toBeTruthy();
  });

  it("welcomes an owner who is alone", async () => {
    bridge.workspaceMembers.mockImplementation(async () => ({ status: "ready", view: ownerView({ people: [owner], inviteLink: { enabled: false, url: null } }) }));
    renderMembers();
    expect((await screen.findByTestId("settings-members-alone")).textContent).toContain("Only you are in this workspace.");
    expect(screen.queryByTestId("settings-members-link-url")).toBeNull();
    expect(screen.queryByTestId("settings-members-link-reset")).toBeNull();
  });

  it.each([
    ["signed-out", { status: status({ connected: false }) }, "Connect to sync.test to see who is in this workspace.", "Connect server"],
    ["not-synced", { status: status({ workspaceSynced: false, workspaceSyncConnected: false }) }, "Turn on sync to invite people to this workspace.", "Set up sync"],
    ["other-account", { status: status({ workspaceSyncConnected: false }) }, "Resume sync to see who is in this workspace.", "Sync and sharing"],
    ["other-server", { status: status({ serverUrl: "https://other.test" }) }, "This workspace syncs with sync.test.", "Sync and sharing"],
    ["expired", { signInExpired: true, onSignInAgain: vi.fn() }, "until you sign in again.", "Sign in again"],
  ] as const)("asks for the one thing that lets a %s workspace list Members, without asking the server", async (reason, facts, words, action) => {
    const { props } = renderMembers({ cloud: cloud(facts) });
    const gate = screen.getByTestId("settings-members-gate");
    expect(gate.dataset.reason).toBe(reason);
    expect(gate.textContent).toContain(words);
    await userEvent.click(within(gate).getByRole("button", { name: action }));
    if (reason === "signed-out") expect(props.cloud!.onConnect).toHaveBeenCalled();
    else if (reason === "expired") expect(props.cloud!.onSignInAgain).toHaveBeenCalled();
    else expect(props.onOpenSync).toHaveBeenCalled();
    expect(bridge.workspaceMembers).not.toHaveBeenCalled();
  });

  it("loads a paused workspace, which keeps its place on the server", () => {
    expect(membersGate(cloud({ status: status({ workspaceSynced: false, workspaceSyncConnected: false, syncPause: { atMs: 1, author: { kind: "person", self: true } } }) })).kind).toBe("ready");
  });

  it("waits on the server connection, and reads it again from a failed read", async () => {
    renderMembers({ cloud: cloud({ status: null }) });
    expect(screen.getByTestId("settings-members-checking")).toBeTruthy();
    cleanup();
    const unreadable = cloud({ status: null, unreadable: true });
    renderMembers({ cloud: unreadable });
    await userEvent.click(within(screen.getByTestId("settings-members-unreadable")).getByRole("button", { name: "Try again" }));
    expect(unreadable.onChanged).toHaveBeenCalled();
  });

  it("drops a list that answers after the window changed workspaces or accounts", async () => {
    const late = deferred<MembersResult>();
    bridge.workspaceMembers.mockReturnValueOnce(late.promise);
    const { rerender } = renderMembers();
    expect(screen.getByTestId("settings-members-loading")).toBeTruthy();
    const next = deferred<MembersResult>();
    bridge.workspaceMembers.mockReturnValueOnce(next.promise);
    rerender({ workspaceId: "ws-2" });
    await act(async () => late.resolve({ status: "ready", view: ownerView() }));
    expect(screen.queryByTestId("settings-members-page")).toBeNull();
    expect(bridge.workspaceMembers.mock.calls.map(([payload]) => payload.workspaceId)).toEqual(["ws-1", "ws-2"]);

    const afterSwitch = deferred<MembersResult>();
    bridge.workspaceMembers.mockReturnValueOnce(afterSwitch.promise);
    rerender({ workspaceId: "ws-2", cloud: cloud({ status: status({ email: "bo@test" }) }) });
    await act(async () => next.resolve({ status: "ready", view: ownerView({ workspaceId: "ws-2" }) }));
    expect(screen.queryByTestId("settings-members-page")).toBeNull();
    await act(async () => afterSwitch.resolve({ status: "ready", view: memberView() }));
    expect((await screen.findByTestId("settings-members-page")).dataset.viewerRole).toBe("member");
  });

  it("drops a change's answer and its failure once the account changed", async () => {
    const { rerender, props } = renderMembers();
    await screen.findByTestId("settings-members-page");
    const answer = deferred<MembersResult>();
    bridge.workspaceMembers.mockReturnValueOnce(answer.promise);
    await openMenu("m-bo");
    await userEvent.click(screen.getByRole("menuitem", { hidden: true, name: "Make admin" }));
    bridge.workspaceMembers.mockImplementation(async () => ({ status: "ready", view: memberView() }));
    rerender({ cloud: cloud({ status: status({ email: "bo@test" }) }) });
    await screen.findByText("Leave this workspace");
    await act(async () => answer.reject(new Error("dohc could not change this person's role.")));
    expect(props.onError).not.toHaveBeenCalled();
    expect(screen.getByTestId("settings-members-page").dataset.viewerRole).toBe("member");
  });

  it("marks only the row whose change is running", async () => {
    renderMembers();
    await screen.findByTestId("settings-members-page");
    const answer = deferred<MembersResult>();
    bridge.workspaceMembers.mockReturnValueOnce(answer.promise);
    await openMenu("m-bo");
    await userEvent.click(screen.getByRole("menuitem", { hidden: true, name: "Make admin" }));
    expect(within(row("m-bo")).getByTestId("settings-members-row-busy")).toBeTruthy();
    expect(row("m-bo").getAttribute("aria-busy")).toBe("true");
    expect(within(row("m-ana")).getByTestId("settings-members-row-menu")).toBeTruthy();
    expect(requests().at(-1)).toEqual({ action: "role", person: "m-bo", role: "admin" });
    await act(async () => answer.resolve({ status: "ready", view: ownerView({ people: [owner, ana, { ...bo, role: "admin" }, cy, dee] }) }));
    expect(within(row("m-bo")).queryByTestId("settings-members-row-busy")).toBeNull();
    expect(within(row("m-bo")).getByTestId("settings-members-role").textContent).toBe("Admin");
  });

  it("keeps the newest change when an older answer arrives last", async () => {
    renderMembers();
    await screen.findByTestId("settings-members-page");
    const first = deferred<MembersResult>();
    const second = deferred<MembersResult>();
    bridge.workspaceMembers.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await userEvent.click(screen.getByRole("radio", { name: "Edit" }));
    await openMenu("m-bo");
    await userEvent.click(screen.getByRole("menuitem", { hidden: true, name: "Make admin" }));
    await act(async () => second.resolve({ status: "ready", view: ownerView({ memberLevel: "edit", people: [owner, ana, { ...bo, role: "admin" }, cy, dee] }) }));
    await act(async () => first.resolve({ status: "ready", view: ownerView({ memberLevel: "edit" }) }));
    expect(within(row("m-bo")).getByTestId("settings-members-role").textContent).toBe("Admin");
  });

  it("warns that copies stay before removing someone, and removes only on confirm", async () => {
    renderMembers();
    await screen.findByTestId("settings-members-page");
    await openMenu("m-bo");
    await userEvent.click(screen.getByRole("menuitem", { hidden: true, name: "Remove from workspace" }));
    const dialog = screen.getByTestId("settings-members-confirm-remove");
    expect(dialog.textContent).toContain("Remove Bo from Community?");
    expect(dialog.textContent).toContain("Copies already on their computers stay with them.");
    await userEvent.click(screen.getByTestId("settings-members-confirm-cancel"));
    expect(requests()).toEqual([{ action: "list" }]);
    await openMenu("m-bo");
    await userEvent.click(screen.getByRole("menuitem", { hidden: true, name: "Remove from workspace" }));
    await userEvent.click(screen.getByTestId("settings-members-confirm"));
    expect(requests().at(-1)).toEqual({ action: "remove", person: "m-bo" });
  });

  it("says existing members stay before resetting the link", async () => {
    renderMembers();
    await userEvent.click(await screen.findByTestId("settings-members-link-reset"));
    expect(screen.getByTestId("settings-members-confirm-reset").textContent).toContain("People who already joined stay.");
    await userEvent.click(screen.getByTestId("settings-members-confirm"));
    expect(requests().at(-1)).toEqual({ action: "link", change: "reset" });
  });

  it("turns the link off and lets a removed account back in without asking", async () => {
    renderMembers();
    await userEvent.click(await screen.findByRole("switch", { name: "Invite link" }));
    expect(requests().at(-1)).toEqual({ action: "link", change: "turn-off" });
    await userEvent.click(within(row("m-dee")).getByRole("button", { name: "Let back in" }));
    expect(requests().at(-1)).toEqual({ action: "letBackIn", person: "m-dee" });
  });

  it("checks the email when Invite is pressed, then invites and clears the field", async () => {
    renderMembers();
    await screen.findByTestId("settings-members-page");
    const field = screen.getByTestId("settings-members-invite-email");
    await userEvent.click(screen.getByTestId("settings-members-invite-send"));
    expect(screen.getByTestId("settings-members-invite-error").textContent).toBe("Enter an email address.");
    expect(document.activeElement).toBe(field);
    await userEvent.type(field, "BO@test{Enter}");
    expect(screen.getByTestId("settings-members-invite-error").textContent).toBe("BO@test is already in this workspace.");
    await userEvent.clear(field);
    await userEvent.type(field, " eve@test {Enter}");
    expect(requests().at(-1)).toEqual({ action: "invite", email: "eve@test" });
    expect((field as HTMLInputElement).value).toBe("");
    expect(screen.queryByTestId("settings-members-invite-error")).toBeNull();
  });

  it("reports a failed change with Try again under its own identity, keeps the typed email, and a later success takes it back", async () => {
    const { props } = renderMembers();
    await screen.findByTestId("settings-members-page");
    bridge.workspaceMembers.mockRejectedValueOnce(new Error("dohc could not send the invite because the server is busy. Try again in a minute."));
    const field = screen.getByTestId("settings-members-invite-email");
    await userEvent.type(field, "eve@test{Enter}");
    const onError = vi.mocked(props.onError!);
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    const [message, , retry, , identity] = onError.mock.calls[0]!;
    expect(message).toBe("dohc could not send the invite because the server is busy. Try again in a minute.");
    expect(identity).toBe("settings-members:ws-1:invite");
    expect((field as HTMLInputElement).value).toBe("eve@test");
    await act(async () => retry!());
    expect(requests().at(-1)).toEqual({ action: "invite", email: "eve@test" });
    expect(props.onClearError).toHaveBeenCalledWith("settings-members:ws-1:invite");
  });

  it("shows a failed list in place with Try again, and the cause in a notice", async () => {
    bridge.workspaceMembers.mockRejectedValueOnce(new Error("dohc could not reach your server. Check your connection, then try again."));
    const { props } = renderMembers();
    const failed = await screen.findByTestId("settings-members-failed");
    expect(failed.textContent).toContain("dohc could not reach your server.");
    expect(props.onError).toHaveBeenCalledWith(expect.stringContaining("could not reach"), expect.any(Error), expect.any(Function), undefined, "settings-members:ws-1");
    await userEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("settings-members-page")).toBeTruthy();
    expect(props.onClearError).toHaveBeenCalledWith("settings-members:ws-1");
  });

  it("says when the server does not list this account", async () => {
    bridge.workspaceMembers.mockResolvedValueOnce({ status: "refused" });
    renderMembers();
    expect((await screen.findByTestId("settings-members-refused")).textContent).toContain("does not show this workspace's Members");
  });

  it("leaves after a warning, then says so", async () => {
    bridge.workspaceMembers.mockImplementation(async ({ request }) =>
      request.action === "leave" ? { status: "done" } : { status: "ready", view: memberView() });
    renderMembers();
    await userEvent.click(await screen.findByTestId("settings-members-leave-open"));
    expect(screen.getByTestId("settings-members-confirm-leave").textContent).toContain("Leave Community?");
    await userEvent.click(screen.getByTestId("settings-members-confirm"));
    expect((await screen.findByTestId("settings-members-left")).textContent).toBe("You left Community.");
  });

  it("ends membership after a warning, then lists again", async () => {
    bridge.workspaceMembers.mockImplementation(async ({ request }) =>
      request.action === "end" ? { status: "done" } : { status: "ready", view: ownerView() });
    renderMembers();
    await userEvent.click(await screen.findByTestId("settings-members-end-open"));
    expect(screen.getByTestId("settings-members-confirm-end").textContent).toContain("Copies already on their computers stay with them.");
    await userEvent.click(screen.getByTestId("settings-members-confirm"));
    await vi.waitFor(() => expect(requests()).toEqual([{ action: "list" }, { action: "end" }, { action: "list" }]));
  });

  it("filters a long list by name or email", async () => {
    const many = Array.from({ length: 12 }, (_, index) => person({ memberId: `m-${index}`, name: `Person ${index}`, email: `p${index}@test` }));
    bridge.workspaceMembers.mockImplementation(async () => ({ status: "ready", view: ownerView({ people: [owner, ...many] }) }));
    renderMembers();
    await userEvent.type(await screen.findByTestId("settings-members-filter"), "p11@");
    await vi.waitFor(() => expect(within(screen.getByTestId("settings-members-people")).getAllByTestId("settings-members-row")).toHaveLength(1));
    expect(within(screen.getByTestId("settings-members-people")).getByText("13")).toBeTruthy();
    await userEvent.clear(screen.getByTestId("settings-members-filter"));
    await userEvent.type(screen.getByTestId("settings-members-filter"), "nobody");
    expect((await screen.findByTestId("settings-members-no-match")).textContent).toBe('No one matches "nobody".');
  });
});
