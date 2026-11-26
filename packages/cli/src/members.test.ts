import { describe, expect, it, vi } from "vitest";
import { executeCli } from "./index";
import { CLI_PROTOCOL_VERSION, cliRequestSchema, parseCliResult } from "./protocol";
import { parseCliArguments } from "./args";

const view = {
  workspaceId: "ws-1",
  workspaceName: "Community",
  viewer: { memberId: "owner", role: "owner" },
  memberLevel: "comment",
  inviteLink: { enabled: true, url: "https://share.test/join#token" },
  groupRules: [{ channelWireId: "wire-news", level: "view" }],
  folderRules: [],
  people: [
    {
      memberId: "owner",
      role: "owner",
      state: "active",
      name: "Ice",
      paletteSlot: 0,
      email: "ice@test",
      invitedAtMs: null,
      joinedAtMs: 1,
      removedAtMs: null,
    },
    {
      memberId: "m-ana",
      role: "admin",
      state: "active",
      name: "Ana",
      paletteSlot: 0,
      email: "ana@test",
      invitedAtMs: 1,
      joinedAtMs: 2,
      removedAtMs: null,
    },
    {
      memberId: "m-bo",
      role: "member",
      state: "invited",
      name: null,
      paletteSlot: 0,
      email: "bo@test",
      invitedAtMs: 3,
      joinedAtMs: null,
      removedAtMs: null,
    },
    {
      memberId: "m-cy",
      role: "member",
      state: "removed",
      name: "Cy",
      paletteSlot: 0,
      email: "cy@test",
      invitedAtMs: 1,
      joinedAtMs: 2,
      removedAtMs: 4,
    },
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
    [["link", "on"], { action: "link", change: "turn-on" }],
    [["link", "off"], { action: "link", change: "turn-off" }],
    [["link", "reset"], { action: "link", change: "reset" }],
    [["end", "--everyone"], { action: "end" }],
    [["group", "Team"], { action: "group", group: "Team" }],
    [["group", "Team", "--level", "post"], { action: "group", group: "Team", level: "comment" }],
    [["group", "Team", "--level", "view"], { action: "group", group: "Team", level: "view" }],
    [["group", "Team", "--level", "none"], { action: "group", group: "Team", level: "none" }],
    [["group", "Team", "--clear"], { action: "group", group: "Team", level: null }],
    [
      ["folder", "Team/Docs", "--clear"],
      { action: "folder", change: { folder: "Team/Docs", clear: true } },
    ],
    [["remove-folder-marker", "Team/Docs"], { action: "folderMarker", folder: "Team/Docs" }],
  ])("parses members %j", (operands, request) => {
    expect(parseCliArguments(["members", ...operands], {})).toMatchObject({
      verb: "members",
      request,
    });
  });

  it.each([
    [["invite"], "Provide an email address."],
    [["invite", "not-an-email"], "Enter an email address."],
    [["level", "owner"], "Choose view, comment, or edit."],
    [["link", "maybe"], "Choose on, off, or reset."],
    [["link", "show"], "Choose on, off, or reset."],
    [["remove"], "Provide a member id or an email."],
    [["end"], "Run dohc members end --everyone to confirm."],
    [["list", "extra"], "members list does not accept"],
    [["group"], "Name a Group."],
    [["group", "Team", "--level", "comment"], "Choose post, view, or none."],
    [["group", "Team", "--level", "constructor"], "Choose post, view, or none."],
    [["group", "Team", "--level", "view", "--clear"], "Choose --level or --clear, not both."],
    [["folder", "Team"], "Set --members to view, comment, edit, or none."],
    [["folder", "Team", "--members", "edit", "--clear"], "Use --clear by itself"],
    [["folder", "Team", "--clear", "--person", "bo@test=edit"], "Use --clear by itself"],
    [["folder", "Team", "--members", "none", "--person", "bo@test"], "Enter --person as"],
  ])("refuses members %j", (operands, message) => {
    expect(() => parseCliArguments(["members", ...operands], {})).toThrow(message);
  });

  it("sends repeated folder person levels by path and prints the saved rule", async () => {
    const people = [
      { email: "bo@test", level: "comment" },
      { email: "cy@test", level: "edit" },
    ];
    const folder = "Research/Notes";
    const request = vi.fn(async () => ({
      status: "ready",
      view: {
        ...view,
        folderRules: [
          {
            ruleId: `fr_${"1".repeat(32)}`,
            revision: 1,
            members: null,
            people,
            folders: [{ path: folder, state: "covered" }],
          },
        ],
      },
    }));
    const result = await executeCli({
      argv: [
        "members",
        "folder",
        folder,
        "--members",
        "none",
        "--person",
        "bo@test=comment",
        "--person",
        "cy@test=edit",
      ],
      cwd: "/workspace",
      env: {},
      request,
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: "members",
        args: {
          cwd: expect.any(String),
          actor: "human",
          request: { action: "folder", change: { folder, members: null, people } },
        },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Research/Notes · covered\n  Members: none\n  bo@test: comment\n  cy@test: edit",
    );
  });

  it("sends the request with no workspace, and prints people, invites, and removed accounts by name, with their ids last", async () => {
    const request = vi.fn(async () => ({ status: "ready", view }));
    const result = await executeCli({
      argv: ["members", "list"],
      cwd: "/workspace",
      env: {},
      request,
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: "members",
        args: { cwd: expect.any(String), actor: "human", request: { action: "list" } },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "Community: members can comment.",
        "Invite link: https://share.test/join#token",
        "",
        "Ice · Owner · ice@test",
        "Ana · Admin · ana@test · m-ana",
        "",
        "Invites (each joins when they sign in with that address)",
        "bo@test · Invited · m-bo",
        "",
        "Removed (dohc members let-back-in <id>)",
        "Cy · Removed · cy@test · m-cy",
        "",
      ].join("\n"),
    );
  });

  it.each([
    [{ invitationEmail: "sent" }, "Emailed the invitation."],
    [
      { invitationEmail: "unavailable" },
      "No email sent: this server does not send email. Tell them to sign in to dohc with that address.",
    ],
    [
      { invitationEmail: "recent" },
      "No email sent: dohc already tried to email this invitation in the last minute. Wait a minute before trying again.",
    ],
    [
      {
        invitationEmail: "limit",
        invitationEmailLimit: { limit: 50, windowHours: 24, sent: 50 },
      },
      "No email sent: 50 of 50 invitation emails used in the last 24 hours. Tell them to sign in to dohc with that address.",
    ],
    [
      { invitationEmail: "failed" },
      "The invite stands, but dohc could not send the email. Run the same invite again to retry.",
    ],
  ])("says what became of an invite's email: %o", async (invitation, line) => {
    const result = await executeCli({
      argv: ["members", "invite", "bo@test"],
      cwd: "/workspace",
      env: {},
      request: async () => ({ status: "ready", view, invitation }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(line);
  });

  // The refusal keeps dohc as who could not, as "dohc could not reach the server." does.
  it("says that dohc could not send the invite, and who can invite", async () => {
    const request = async () => {
      throw new Error("dohc could not send the invite. Only the owner and admins can invite.");
    };
    const result = await executeCli({
      argv: ["members", "invite", "lee@test"],
      cwd: "/workspace",
      env: {},
      request,
    });
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dohc could not send the invite. Only the owner and admins can invite.\n",
    });
  });

  it("names the command that lists Members where the desktop says Reload Members", async () => {
    const request = async () => {
      throw new Error(
        "dohc could not remove this person because Members changed first. Reload Members, then try again.",
      );
    };
    const result = await executeCli({
      argv: ["members", "remove", "m-bo"],
      cwd: "/workspace",
      env: {},
      request,
    });
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "dohc could not remove this person because Members changed first. Run dohc members list, then try again.\n",
    });
  });

  it("exits with the refusal when the server lists no Members page", async () => {
    for (const argv of [
      ["members", "list"],
      ["members", "list", "--json"],
    ]) {
      const result = await executeCli({
        argv,
        cwd: "/workspace",
        env: {},
        request: async () => ({ status: "refused" }),
      });
      expect(result.exitCode, argv.join(" ")).toBe(1);
      expect(result.stdout, argv.join(" ")).toBe("");
      expect(result.stderr, argv.join(" ")).toContain(
        "Your server does not list Members for this workspace and account.",
      );
    }
  });

  it("refuses a caller-supplied workspace or leave at socket parsing", () => {
    const base = { protocolVersion: CLI_PROTOCOL_VERSION, token: "a".repeat(64), verb: "members" };
    expect(
      cliRequestSchema.safeParse({
        ...base,
        args: { cwd: "/w", actor: "human", request: { action: "list" } },
      }).success,
    ).toBe(true);
    expect(
      cliRequestSchema.safeParse({
        ...base,
        args: { cwd: "/w", actor: "human", workspaceId: "ws-2", request: { action: "list" } },
      }).success,
    ).toBe(false);
    expect(
      cliRequestSchema.safeParse({
        ...base,
        args: { cwd: "/w", actor: "human", request: { action: "list", workspaceId: "ws-2" } },
      }).success,
    ).toBe(false);
    expect(
      cliRequestSchema.safeParse({
        ...base,
        args: { cwd: "/w", actor: "human", request: { action: "leave" } },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["comment", "Members can post in Team."],
    ["view", "Members can read Team but not post."],
    ["none", "Members can't see Team."],
    [null, "Team has no access of its own: members can comment, as everywhere."],
  ] as const)("prints a Group at %s", async (level, line) => {
    const request = vi.fn(async () => ({
      status: "group",
      name: "Team",
      level,
      memberLevel: "comment",
    }));
    const result = await executeCli({
      argv: ["members", "group", "Team"],
      cwd: "/workspace",
      env: {},
      request,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${line}
`);
  });

  // New group with a level, for agents: the stored level goes to the same relay create.
  it("creates a Group with a level", () => {
    expect(
      parseCliArguments(["chat", "create-group", "Board", "--level", "post"], {}),
    ).toMatchObject({
      verb: "groupCreate",
      name: "Board",
      level: "comment",
    });
    expect(
      parseCliArguments(["chat", "create-group", "Board", "--level", "none"], {}),
    ).toMatchObject({
      verb: "groupCreate",
      name: "Board",
      level: "none",
    });
    expect(() =>
      parseCliArguments(["chat", "create-group", "Board", "--level", "edit"], {}),
    ).toThrow("--level must be post, view or none");
    expect(() =>
      parseCliArguments(["chat", "create-group", "Board", "--level", "constructor"], {}),
    ).toThrow("--level must be post, view or none");
  });

  it("pins results to the contract", () => {
    expect(parseCliResult("members", { status: "done" })).toEqual({ status: "done" });
    expect(parseCliResult("members", { status: "ready", view })).toMatchObject({ status: "ready" });
    expect(() =>
      parseCliResult("members", { status: "ready", view: { ...view, token: "secret" } }),
    ).toThrow();
    expect(() => parseCliResult("members", { status: "refused", view })).toThrow();
    expect(() =>
      parseCliResult("members", {
        status: "group",
        name: "Team",
        level: "edit",
        memberLevel: "comment",
      }),
    ).toThrow();
  });

  const owner = view.people[0]!;
  const sam = {
    memberId: "m1",
    role: "member",
    state: "active",
    name: "Sam",
    paletteSlot: 0,
    email: null,
    invitedAtMs: 2,
    joinedAtMs: 3,
    removedAtMs: null,
  };
  const memberView = {
    workspaceId: "w1",
    workspaceName: "Community",
    viewer: { memberId: "m1", role: "member" },
    memberLevel: "comment",
    inviteLink: null,
    groupRules: null,
    folderRules: null,
  };
  const ready = (value: unknown) => () =>
    parseCliResult("members", { status: "ready", view: value });

  it("reads a member's view", () => {
    expect(ready({ ...memberView, people: [{ ...owner, email: null }, sam] })()).toMatchObject({
      view: { people: [{ name: "Ice" }, { name: "Sam" }] },
    });
  });

  it("refuses a member's view that carries emails, invites, or the invite link", () => {
    expect(ready({ ...memberView, people: [owner] })).toThrow();
    expect(ready({ ...memberView, people: [{ ...sam, state: "invited" }] })).toThrow();
    expect(
      ready({ ...memberView, inviteLink: { enabled: false, url: null }, people: [] }),
    ).toThrow();
  });

  it("refuses a manager's view without the invite link or Group rules, and a member's with them", () => {
    expect(ready({ ...view, inviteLink: null })).toThrow();
    expect(ready({ ...view, groupRules: null })).toThrow();
    expect(ready({ ...memberView, groupRules: [], people: [sam] })).toThrow();
    expect(ready({ ...view, folderRules: null })).toThrow();
    expect(ready({ ...memberView, people: [], folderRules: [] })).toThrow();
  });

  it("refuses an owner entry that is not the owner, an inactive owner, a link that disagrees with itself, an unreadable level, and a colour slot outside the hues", () => {
    expect(ready({ ...view, people: [{ ...sam, memberId: "owner" }] })).toThrow();
    expect(ready({ ...view, people: [{ ...owner, memberId: "m-x" }] })).toThrow();
    expect(ready({ ...view, people: [{ ...owner, state: "removed" }] })).toThrow();
    expect(ready({ ...view, inviteLink: { enabled: true, url: null } })).toThrow();
    expect(
      ready({ ...view, inviteLink: { enabled: false, url: "https://share.test/join#token" } }),
    ).toThrow();
    expect(ready({ ...view, memberLevel: "Edit" })).toThrow();
    expect(ready({ ...view, people: [owner, { ...sam, paletteSlot: 1_000 }] })).toThrow();
  });
});
