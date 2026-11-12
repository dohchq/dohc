import { describe, expect, it } from "vitest";
import { MAX_WORKSPACE_MEMBERS, memberPermissions, parseWorkspaceMembersView } from "./workspaceMembers";

const owner = { memberId: "owner", role: "owner", state: "active", name: "Ice", email: "ice@example.com", invitedAtMs: null, joinedAtMs: 1, removedAtMs: null };
const sam = { memberId: "m1", role: "member", state: "active", name: "Sam", email: null, invitedAtMs: 2, joinedAtMs: 3, removedAtMs: null };

describe("parseWorkspaceMembersView", () => {
  it("reads a member's view", () => {
    const view = parseWorkspaceMembersView({
      workspaceId: "w1", workspaceName: "Community", viewer: { memberId: "m1", role: "member" },
      memberLevel: "comment", inviteLink: null, people: [{ ...owner, email: null }, sam],
    });
    expect(view?.people.map((person) => person.name)).toEqual(["Ice", "Sam"]);
  });

  it("refuses a member's view that carries emails, invites, or the invite link", () => {
    const base = { workspaceId: "w1", workspaceName: "Community", viewer: { memberId: "m1", role: "member" }, memberLevel: "comment", inviteLink: null };
    expect(parseWorkspaceMembersView({ ...base, people: [owner] })).toBeNull();
    expect(parseWorkspaceMembersView({ ...base, people: [{ ...sam, state: "invited" }] })).toBeNull();
    expect(parseWorkspaceMembersView({ ...base, inviteLink: { enabled: false, url: null }, people: [] })).toBeNull();
  });

  it("refuses an owner entry that is not the owner, and an unreadable level", () => {
    const base = { workspaceId: "w1", workspaceName: "C", viewer: { memberId: "owner", role: "owner" }, inviteLink: { enabled: true, url: "https://x/join#t" } };
    expect(parseWorkspaceMembersView({ ...base, memberLevel: "comment", people: [{ ...sam, memberId: "owner" }] })).toBeNull();
    expect(parseWorkspaceMembersView({ ...base, memberLevel: "Edit", people: [owner] })).toBeNull();
    expect(parseWorkspaceMembersView({ ...base, memberLevel: "edit", inviteLink: { enabled: true, url: null }, people: [owner] })).toBeNull();
  });
});

describe("the people limit", () => {
  const base = { workspaceId: "w1", workspaceName: "C", viewer: { memberId: "owner", role: "owner" }, memberLevel: "comment", inviteLink: { enabled: false, url: null } };
  const people = (count: number, state: string) => Array.from({ length: count }, (_, n) => ({ ...sam, memberId: `${state}-${n}`, state, email: "x@example.com", removedAtMs: state === "removed" ? 4 : null }));

  it("counts invited and active people, not removed ones", () => {
    const full = [owner, ...people(MAX_WORKSPACE_MEMBERS, "active")];
    expect(parseWorkspaceMembersView({ ...base, people: [...full, ...people(5, "removed")] })?.people).toHaveLength(MAX_WORKSPACE_MEMBERS + 6);
    expect(parseWorkspaceMembersView({ ...base, people: [...full, ...people(1, "invited")] })).toBeNull();
  });
});

describe("memberPermissions", () => {
  it("keeps admin changes and ending membership with the owner", () => {
    expect(memberPermissions("admin")).toMatchObject({ setAdmins: false, removeMembers: true, removeAdmins: false, endForEveryone: false, leave: true });
    expect(memberPermissions("owner")).toMatchObject({ setAdmins: true, endForEveryone: true, leave: false });
    expect(memberPermissions("member")).toMatchObject({ invite: false, leave: true });
  });
});
