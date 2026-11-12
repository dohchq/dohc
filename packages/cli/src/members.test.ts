import { describe, expect, it, vi } from "vitest";
import { executeCli } from "./index";
import { CLI_PROTOCOL_VERSION, cliRequestSchema, parseCliResult } from "./protocol";
import { parseCliArguments } from "./args";

const view = {
  workspaceId: "ws-1", workspaceName: "Community",
  viewer: { memberId: "owner", role: "owner" }, memberLevel: "comment",
  inviteLink: { enabled: true, url: "https://share.test/join#token" },
  people: [
    { memberId: "owner", role: "owner", state: "active", name: "Ice", email: "ice@test", invitedAtMs: null, joinedAtMs: 1, removedAtMs: null },
    { memberId: "m-ana", role: "admin", state: "active", name: "Ana", email: "ana@test", invitedAtMs: 1, joinedAtMs: 2, removedAtMs: null },
    { memberId: "m-bo", role: "member", state: "invited", name: null, email: "bo@test", invitedAtMs: 3, joinedAtMs: null, removedAtMs: null },
    { memberId: "m-cy", role: "member", state: "removed", name: "Cy", email: "cy@test", invitedAtMs: 1, joinedAtMs: 2, removedAtMs: 4 },
  ],
};

describe("dohc members", () => {
  it.each([
    [["list"], { action: "list" }],
    [["invite", "bo@test"], { action: "invite", email: "bo@test" }],
    [["remove", "m-ana"], { action: "remove", person: "m-ana" }],
    [["remove", "ana@test"], { action: "remove", person: "ana@test" }],
    [["level", "edit"], { action: "level", level: "edit" }],
    [["admin", "m-ana"], { action: "role", person: "m-ana", role: "admin" }],
    [["member", "m-ana"], { action: "role", person: "m-ana", role: "member" }],
    [["let-back-in", "m-cy"], { action: "letBackIn", person: "m-cy" }],
    [["link", "show"], { action: "list" }],
    [["link", "on"], { action: "link", change: "turn-on" }],
    [["link", "off"], { action: "link", change: "turn-off" }],
    [["link", "reset"], { action: "link", change: "reset" }],
    [["end", "--everyone"], { action: "end" }],
  ])("parses members %j", (operands, request) => {
    expect(parseCliArguments(["members", ...operands], {})).toMatchObject({ verb: "members", request });
  });

  it.each([
    [["invite"], "Provide an email address."],
    [["invite", "not-an-email"], "Enter an email address."],
    [["level", "owner"], "Choose view, comment, or edit."],
    [["link", "maybe"], "Choose show, on, off, or reset."],
    [["remove"], "Provide a member id or an email."],
    [["end"], "Run dohc members end --everyone to confirm."],
    [["list", "extra"], "members list does not accept"],
  ])("refuses members %j", (operands, message) => {
    expect(() => parseCliArguments(["members", ...operands], {})).toThrow(message);
  });

  it("sends the request with no workspace, and prints people, invites, and removed accounts with their ids", async () => {
    const request = vi.fn(async () => ({ status: "ready", view }));
    const result = await executeCli({ argv: ["members", "list"], cwd: "/workspace", env: {}, request });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ verb: "members", args: { cwd: expect.any(String), actor: "human", request: { action: "list" } } }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe([
      "Community: members can comment.",
      "Invite link: https://share.test/join#token",
      "",
      "owner · Owner · Ice · ice@test",
      "m-ana · Admin · Ana · ana@test",
      "",
      "Invites",
      "m-bo · Invited · bo@test",
      "",
      "Removed (dohc members let-back-in <id>)",
      "m-cy · Removed · Cy · cy@test",
      "",
    ].join("\n"));
  });

  it("exits with the refusal when the server lists no Members page", async () => {
    const result = await executeCli({ argv: ["members", "list"], cwd: "/workspace", env: {}, request: async () => ({ status: "refused" }) });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Your server does not list Members for this workspace and account.");
  });

  it("refuses a caller-supplied workspace or leave at socket parsing", () => {
    const base = { protocolVersion: CLI_PROTOCOL_VERSION, token: "a".repeat(64), verb: "members" };
    expect(cliRequestSchema.safeParse({ ...base, args: { cwd: "/w", actor: "human", request: { action: "list" } } }).success).toBe(true);
    expect(cliRequestSchema.safeParse({ ...base, args: { cwd: "/w", actor: "human", workspaceId: "ws-2", request: { action: "list" } } }).success).toBe(false);
    expect(cliRequestSchema.safeParse({ ...base, args: { cwd: "/w", actor: "human", request: { action: "list", workspaceId: "ws-2" } } }).success).toBe(false);
    expect(cliRequestSchema.safeParse({ ...base, args: { cwd: "/w", actor: "human", request: { action: "leave" } } }).success).toBe(false);
  });

  it("pins results to the contract", () => {
    expect(parseCliResult("members", { status: "done" })).toEqual({ status: "done" });
    expect(() => parseCliResult("members", { status: "ready", view: { ...view, token: "secret" } })).toThrow();
    expect(() => parseCliResult("members", { status: "refused", view })).toThrow();
  });
});
