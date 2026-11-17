import { describe, expect, it } from "vitest";
import {
  MEMBER_ACTION_ROLES,
  memberMay,
  type MemberAction,
  type WorkspaceRole,
} from "./workspaceMembers";

describe("memberMay", () => {
  // Every action, with the roles that may do it.
  const matrix: Record<MemberAction, readonly WorkspaceRole[]> = {
    list: ["owner", "admin", "member"],
    invite: ["owner", "admin"],
    level: ["owner", "admin"],
    link: ["owner", "admin"],
    remove: ["owner", "admin"],
    letBackIn: ["owner", "admin"],
    role: ["owner"],
    end: ["owner"],
  };

  it("follows the role table for every action and role", () => {
    expect(Object.keys(matrix).sort()).toEqual(Object.keys(MEMBER_ACTION_ROLES).sort());
    for (const [action, allowed] of Object.entries(matrix) as [
      MemberAction,
      readonly WorkspaceRole[],
    ][]) {
      for (const role of ["owner", "admin", "member"] as const) {
        expect(memberMay(role, action), `${role} ${action}`).toBe(allowed.includes(role));
      }
    }
  });

  it("lets only the owner remove an admin", () => {
    expect(memberMay("owner", "remove", "admin")).toBe(true);
    expect(memberMay("admin", "remove", "admin")).toBe(false);
    expect(memberMay("admin", "remove", "member")).toBe(true);
    expect(memberMay("member", "remove", "member")).toBe(false);
  });
});
