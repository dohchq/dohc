// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupSettingsDialog, groupAccessFrom, type GroupAccess } from "./GroupSettingsDialog";

afterEach(cleanup);

const radio = (name: string) => screen.getByRole("radio", { name });
const checked = (name: string) => radio(name).getAttribute("aria-checked") === "true";

function open(
  access: GroupAccess | (() => Promise<GroupAccess>),
  save: (level: string | null) => Promise<string | null> = vi.fn(async () => null),
  extra: { folderPath?: string; onOpenFolder?: (path: string) => void } = {},
) {
  const onClose = vi.fn();
  const load = typeof access === "function" ? access : async () => access;
  render(
    <GroupSettingsDialog
      groupName="Announcements"
      load={load}
      save={save}
      onClose={onClose}
      {...extra}
    />,
  );
  return { onClose, save };
}

describe("GroupSettingsDialog", () => {
  it("shows the member level for a Group with no rule, and saves the level picked", async () => {
    const { save, onClose } = open({ level: null, memberLevel: "comment" });
    await waitFor(() => expect(checked("Can post")).toBe(true));
    expect(screen.getByTestId("chats-group-access-follows").textContent).toBe(
      "Follows the member level, Comment.",
    );
    expect(screen.getByTestId("chats-group-access-always").textContent).toBe(
      "The owner and admins can always read and post.",
    );
    fireEvent.click(radio("View only"));
    expect(screen.queryByTestId("chats-group-access-follows")).toBeNull();
    expect(screen.getByTestId("chats-group-access-set").textContent).toBe("Set for this Group.");
    fireEvent.click(screen.getByTestId("chats-group-settings-save"));
    await waitFor(() => expect(save).toHaveBeenCalledWith("view"));
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps following the member level when a Group with no rule comes back to it", async () => {
    const { save, onClose } = open({ level: null, memberLevel: "edit" });
    await waitFor(() => expect(checked("Can post")).toBe(true));
    fireEvent.click(radio("View only"));
    fireEvent.click(radio("Can post"));
    expect(screen.queryByTestId("chats-group-access-follow")).toBeNull();
    fireEvent.click(screen.getByTestId("chats-group-settings-save"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByTestId("chats-group-access-follows").textContent).toBe(
      "Follows the member level, Edit.",
    );
  });

  it("keeps a saved rule that matches the member level until Follow the member level", async () => {
    const { save } = open({ level: "comment", memberLevel: "comment" });
    await waitFor(() => expect(checked("Can post")).toBe(true));
    expect(screen.getByTestId("chats-group-access-set").textContent).toBe("Set for this Group.");
    fireEvent.click(radio("View only"));
    fireEvent.click(radio("Can post"));
    expect(screen.getByTestId("chats-group-access-set")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chats-group-access-follow"));
    expect(screen.getByTestId("chats-group-access-follows")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chats-group-settings-save"));
    await waitFor(() => expect(save).toHaveBeenCalledWith(null));
  });

  it("warns before hiding the Group, and clears a rule to follow the member level", async () => {
    const { save } = open({ level: "view", memberLevel: "comment" });
    await waitFor(() => expect(checked("View only")).toBe(true));
    fireEvent.click(radio("No access"));
    expect(screen.getByTestId("chats-group-access-hiding").textContent).toBe(
      "Members will no longer see the Announcements Group. People who read it may keep a copy.",
    );
    fireEvent.click(screen.getByTestId("chats-group-access-follow"));
    expect(checked("Can post")).toBe(true);
    expect(screen.queryByTestId("chats-group-access-hiding")).toBeNull();
    fireEvent.click(screen.getByTestId("chats-group-settings-save"));
    await waitFor(() => expect(save).toHaveBeenCalledWith(null));
  });

  it("keeps Save off while access loads, and offers Try again when the read fails", async () => {
    let fail = true;
    const load = vi.fn(async (): Promise<GroupAccess> => {
      if (fail) throw new Error("offline");
      return { level: "none", memberLevel: "view" };
    });
    open(load);
    expect((screen.getByTestId("chats-group-settings-save") as HTMLButtonElement).disabled).toBe(
      true,
    );
    const failed = await screen.findByTestId("chats-group-access-failed");
    expect(failed.textContent).toContain("dohc could not load access.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(checked("No access")).toBe(true));
    expect(load).toHaveBeenCalledTimes(2);
    expect((screen.getByTestId("chats-group-settings-save") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("keeps the dialog open with the error in place when the save fails", async () => {
    const save = vi.fn(async () => "dohc could not change this Group's access.");
    const { onClose } = open({ level: null, memberLevel: "comment" }, save);
    await waitFor(() => expect(checked("Can post")).toBe(true));
    fireEvent.click(radio("No access"));
    fireEvent.click(screen.getByTestId("chats-group-settings-save"));
    expect((await screen.findByTestId("chats-group-access-error")).textContent).toBe(
      "dohc could not change this Group's access.",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(checked("No access")).toBe(true);
  });

  it("says members keep their access to a hidden Group's folder, and closes to show it", async () => {
    const onOpenFolder = vi.fn();
    const { onClose } = open({ level: null, memberLevel: "comment" }, undefined, {
      folderPath: "Team/Plans",
      onOpenFolder,
    });
    await waitFor(() => expect(checked("Can post")).toBe(true));
    expect(screen.queryByTestId("chats-group-access-folder")).toBeNull();
    fireEvent.click(radio("No access"));
    expect(screen.getByTestId("chats-group-access-hiding").textContent).toBe(
      "Members will no longer see the Announcements Group. Their access to files in Plans stays the same.",
    );
    fireEvent.click(screen.getByTestId("chats-group-access-folder"));
    expect(onOpenFolder).toHaveBeenCalledWith("Team/Plans");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("groupAccessFrom", () => {
  const owner = { role: "owner", state: "active" };
  const rules = [{ channelWireId: "g1", level: "none" as const }];

  // The relay answers the owner an empty rule list before anyone is invited.
  it("says only you are here until someone else is in the workspace or can join it", () => {
    expect(
      groupAccessFrom(
        { memberLevel: "comment", people: [owner], groupRules: [], inviteLink: null },
        "g1",
      ),
    ).toBe("no-members");
    expect(
      groupAccessFrom(
        {
          memberLevel: "comment",
          people: [owner, { role: "member", state: "removed" }],
          groupRules: rules,
          inviteLink: { enabled: false },
        },
        "g2",
      ),
    ).toBe("no-members");
  });

  it("reads the Group's rule once someone else is invited", () => {
    const people = [owner, { role: "member", state: "invited" }];
    const list = { people, groupRules: rules, inviteLink: null };
    expect(groupAccessFrom({ ...list, memberLevel: "comment" }, "g1")).toEqual({
      level: "none",
      memberLevel: "comment",
    });
    expect(groupAccessFrom({ ...list, memberLevel: "view" }, "g2")).toEqual({
      level: null,
      memberLevel: "view",
    });
  });

  // The first person to join by the link must not see a Group the owner meant to hide.
  it("offers access while the invite link is on, before anyone joins", () => {
    expect(
      groupAccessFrom(
        { memberLevel: "comment", people: [owner], groupRules: [], inviteLink: { enabled: true } },
        "g1",
      ),
    ).toEqual({ level: null, memberLevel: "comment" });
  });

  // A rule still applies to the next person who joins, so it stays visible and changeable.
  it("shows a Group's own rule after everyone else has left", () => {
    expect(
      groupAccessFrom(
        {
          memberLevel: "comment",
          people: [owner, { role: "member", state: "removed" }],
          groupRules: rules,
          inviteLink: null,
        },
        "g1",
      ),
    ).toEqual({ level: "none", memberLevel: "comment" });
  });
});
