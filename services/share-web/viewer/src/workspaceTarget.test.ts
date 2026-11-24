import { expect, it } from "vitest";
import { ownerPagePath, viewSession, workspaceTarget } from "./workspaceTarget";

it("reads a member's grant, an owner's workspace and the list from the page's path", () => {
  expect(workspaceTarget("/s/workspace/grant-1")).toEqual({ kind: "member", grantId: "grant-1" });
  expect(workspaceTarget("/s/workspace/owner/ws_1.a:b-c")).toEqual({
    kind: "owner",
    workspaceId: "ws_1.a:b-c",
  });
  expect(workspaceTarget(ownerPagePath("ws:1"))).toEqual({ kind: "owner", workspaceId: "ws:1" });
  expect(workspaceTarget("/workspaces")).toEqual({ kind: "list" });
});

it("refuses a workspace id with other characters, too long or badly encoded", () => {
  for (const path of [
    "/s/workspace/owner/a%2Fb",
    "/s/workspace/owner/a%20b",
    `/s/workspace/owner/${"a".repeat(257)}`,
    "/s/workspace/owner/%E0%A4%A",
    "/s/workspace/owner/a/b",
    "/s/workspace/",
  ])
    expect(workspaceTarget(path), path).toBeNull();
  expect(workspaceTarget(`/s/workspace/owner/${"a".repeat(256)}`)).not.toBeNull();
});

it("names the grant or the owned workspace as the session the view routes read", () => {
  expect(viewSession({ kind: "member", grantId: "grant-1" })).toBe("member.grant-1");
  expect(viewSession({ kind: "owner", workspaceId: "ws-1" })).toBe("owner.ws-1");
});
