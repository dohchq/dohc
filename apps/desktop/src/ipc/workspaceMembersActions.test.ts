import { describe, expect, it, vi } from "vitest";
import type { WorkspaceMembersView } from "@dohc/security-contract/workspace-members";
import {
  createJoinedWorkspaceGroupAction,
  createOwnedWorkspaceGroupAction,
  createWorkspaceMembersActions,
  MEMBERS_UNREACHABLE,
} from "./workspaceMembersActions";
import { memberOperations, MEMBERS_INACTIVE_MESSAGE } from "./memberOperations";
import { operationBridge, registerOperations } from "./operationTable";
import { deferred } from "../testing/deferred";

type Credentials = { userId: string; token: string };
const view = (overrides: Partial<WorkspaceMembersView> = {}): WorkspaceMembersView => ({
  workspaceId: "ws-1",
  workspaceName: "Community",
  viewer: { memberId: "owner", role: "owner" },
  memberLevel: "comment",
  inviteLink: { enabled: true, url: "https://share.test/join#token" },
  groupRules: [],
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
      role: "member",
      state: "active",
      name: "Ana",
      paletteSlot: 0,
      email: "ana@test",
      invitedAtMs: 1,
      joinedAtMs: 2,
      removedAtMs: null,
    },
  ],
  ...overrides,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness(options: { shareView?: unknown } = {}) {
  let generation = 1,
    open = true;
  const workspace = {
    workspaceId: "ws-1",
    rootPath: "C:\\Users\\me\\Community",
    shareView: options.shareView,
  };
  const relay = vi.fn(
    async (_credentials: Credentials, _path: string, _init: RequestInit): Promise<Response> =>
      json(view()),
  );
  const remote = vi.fn(
    async (_workspace: typeof workspace, _options?: { allowPaused: boolean }) => ({
      credentials: { userId: "owner", token: "secret" },
      credentialGeneration: generation,
    }),
  );
  const joinedRemote = vi.fn(async (_workspace: typeof workspace) => ({
    credentials: { userId: "ana", token: "ana-secret" },
    credentialGeneration: generation,
  }));
  const sharesChanged = vi.fn<(workspaceId: string) => void>();
  const members = createWorkspaceMembersActions<typeof workspace, Credentials>({
    remoteForWorkspace: remote,
    remoteForJoinedWorkspace: joinedRemote,
    currentCredentialGeneration: () => generation,
    relayResponse: relay,
    sharesChanged,
  });
  const listeners = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  registerOperations(
    {
      handle: (channel, listener) => listeners.set(channel, listener),
      assertTrustedSender: () => undefined,
      withActiveWorkspace: async (_event, workspaceId, message, work) => {
        const assertCurrent = () => {
          if (!open || workspaceId !== workspace.workspaceId) throw new Error(message);
        };
        assertCurrent();
        const result = await work({ workspace, assertCurrent });
        assertCurrent();
        return result;
      },
    },
    memberOperations,
    {
      workspaceMembers: ({ request }, { operation }) =>
        members(operation as Parameters<typeof members>[0], request),
    },
  );
  const bridge = operationBridge(memberOperations, (channel, payload) =>
    listeners.get(channel)!({}, payload),
  );
  return {
    bridge,
    relay,
    remote,
    joinedRemote,
    sharesChanged,
    rotate: () => {
      generation++;
    },
    close: () => {
      open = false;
    },
  };
}

const calls = (relay: ReturnType<typeof harness>["relay"]) =>
  relay.mock.calls.map(
    ([, path, init]) => `${init.method} ${path}${init.body ? ` ${String(init.body)}` : ""}`,
  );

describe("workspace members actions", () => {
  it("lists through the window's workspace and signed-in account, allowing a paused remote", async () => {
    const h = harness();
    await expect(
      h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } }),
    ).resolves.toEqual({ status: "ready", view: view() });
    expect(calls(h.relay)).toEqual(["GET /sync/ws-1/members"]);
    expect(h.relay.mock.calls[0]![0]).toEqual({ userId: "owner", token: "secret" });
    expect(h.remote.mock.calls[0]![1]).toEqual({ allowPaused: true });
  });

  it("answers refused when the relay lists no Members page for this account", async () => {
    for (const status of [403, 404]) {
      const h = harness();
      h.relay.mockResolvedValueOnce(json({ error: "no" }, status));
      await expect(
        h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } }),
      ).resolves.toEqual({ status: "refused" });
    }
  });

  it("refuses a received share view before asking the relay", async () => {
    const h = harness({
      shareView: {
        shareId: "s",
        granterEmail: null,
        genericChatWritable: false,
        grantedSelector: { paths: ["a"], versionId: null, access: "view" },
      },
    });
    await expect(
      h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } }),
    ).rejects.toThrow("Open the original workspace to manage its members.");
    expect(h.relay).not.toHaveBeenCalled();
  });

  // A joined workspace reaches the owner's Members with the person's own
  // account. The relay decides what that account sees and may change.
  describe("in a joined workspace", () => {
    const joined = (
      place: Record<string, unknown> = { membersWorkspaceId: "owner-ws", role: "member" },
    ) =>
      harness({
        shareView: {
          shareId: "s",
          granterEmail: null,
          genericChatWritable: false,
          subjectName: "Community",
          recipientUserId: "ana",
          relayUrl: "https://relay.test",
          grantedSelector: { paths: [], versionId: null, access: "comment", wholeWorkspace: true },
          ...place,
        },
      });
    const memberView = view({
      workspaceId: "owner-ws",
      viewer: { memberId: "m-ana", role: "member" },
      inviteLink: null,
      groupRules: null,
      people: view().people.map((person) => ({ ...person, email: null })),
    });

    it("lists the owner's Members with the account that joined", async () => {
      const h = joined();
      h.relay.mockResolvedValueOnce(json(memberView));
      await expect(
        h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } }),
      ).resolves.toEqual({ status: "ready", view: memberView });
      expect(calls(h.relay)).toEqual(["GET /sync/owner-ws/members"]);
      expect(h.relay.mock.calls[0]![0]).toEqual({ userId: "ana", token: "ana-secret" });
      expect(h.remote).not.toHaveBeenCalled();
    });

    it("sends an admin's invite under the workspace's own name", async () => {
      const h = joined({ membersWorkspaceId: "owner-ws", role: "admin" });
      const adminView = view({
        workspaceId: "owner-ws",
        viewer: { memberId: "m-kai", role: "admin" },
      });
      h.relay.mockResolvedValueOnce(json(adminView));
      await expect(
        h.bridge.workspaceMembers({
          workspaceId: "ws-1",
          request: { action: "invite", email: "new@test" },
        }),
      ).resolves.toEqual({ status: "ready", view: adminView });
      expect(calls(h.relay)).toEqual([
        `POST /sync/owner-ws/members/invites ${JSON.stringify({ email: "new@test", workspaceName: "Community" })}`,
      ]);
    });

    it("passes on the relay's refusal of a member's invite, saying who can invite", async () => {
      const h = joined();
      h.relay.mockResolvedValueOnce(json({ error: "members_forbidden" }, 403));
      await expect(
        h.bridge.workspaceMembers({
          workspaceId: "ws-1",
          request: { action: "invite", email: "new@test" },
        }),
      ).rejects.toThrow("dohc could not send the invite. Only the owner and admins can invite.");
      expect(calls(h.relay)).toEqual([
        `POST /sync/owner-ws/members/invites ${JSON.stringify({ email: "new@test", workspaceName: "Community" })}`,
      ]);
    });

    it("says how to recover when the view does not know its place yet", async () => {
      const h = joined({});
      await expect(
        h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } }),
      ).rejects.toThrow(
        "dohc does not know where this workspace's Members are yet. Refresh the workspace, then try again.",
      );
      expect(h.relay).not.toHaveBeenCalled();
    });

    it("refuses with the account check's reason", async () => {
      const h = joined();
      h.joinedRemote.mockRejectedValueOnce(
        new Error(
          "This computer is signed in to a different account than the one the owner invited.",
        ),
      );
      await expect(
        h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } }),
      ).rejects.toThrow(
        "This computer is signed in to a different account than the one the owner invited.",
      );
      expect(h.relay).not.toHaveBeenCalled();
    });
  });

  it("rejects a view for another workspace or one the contract refuses, instead of showing it", async () => {
    const h = harness();
    h.relay.mockResolvedValueOnce(json(view({ workspaceId: "ws-2" })));
    await expect(
      h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } }),
    ).rejects.toThrow("could not read Members");
    // A member's view must carry no emails.
    h.relay.mockResolvedValueOnce(
      json(view({ viewer: { memberId: "m-ana", role: "member" }, inviteLink: null })),
    );
    await expect(
      h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } }),
    ).rejects.toThrow("could not read Members");
  });

  it("says the server is unreachable when the request fails, and keeps the session-change error when the account changed", async () => {
    const h = harness();
    h.relay.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(
      h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } }),
    ).rejects.toThrow(MEMBERS_UNREACHABLE);
    h.relay.mockImplementationOnce(async () => {
      h.rotate();
      throw new TypeError("aborted");
    });
    await expect(
      h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } }),
    ).rejects.toThrow("Your server session changed. Try again.");
  });

  it("drops an answer that arrives after the account changed", async () => {
    const h = harness();
    const answer = deferred<Response>();
    h.relay.mockReturnValueOnce(answer.promise);
    const pending = h.bridge.workspaceMembers({
      workspaceId: "ws-1",
      request: { action: "level", level: "edit" },
    });
    await vi.waitFor(() => expect(h.relay).toHaveBeenCalled());
    h.rotate();
    answer.resolve(json(view({ memberLevel: "edit" })));
    await expect(pending).rejects.toThrow("Your server session changed. Try again.");
  });

  it("drops an answer that arrives after the window changed workspaces", async () => {
    const h = harness();
    const answer = deferred<Response>();
    h.relay.mockReturnValueOnce(answer.promise);
    const pending = h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } });
    await vi.waitFor(() => expect(h.relay).toHaveBeenCalled());
    h.close();
    answer.resolve(json(view()));
    await expect(pending).rejects.toThrow(MEMBERS_INACTIVE_MESSAGE);
  });

  it("invites with the folder's name and answers the view the relay returns, without listing again", async () => {
    const h = harness();
    await expect(
      h.bridge.workspaceMembers({
        workspaceId: "ws-1",
        request: { action: "invite", email: " bo@test " },
      }),
    ).resolves.toEqual({ status: "ready", view: view() });
    expect(calls(h.relay)).toEqual([
      'POST /sync/ws-1/members/invites {"email":"bo@test","workspaceName":"Community"}',
    ]);
  });

  it("sends each change to its route and answers the view the relay returns", async () => {
    const h = harness();
    const requests = [
      { action: "level", level: "view" },
      { action: "role", person: "m-ana", role: "admin" },
      { action: "remove", person: "m-ana" },
      { action: "letBackIn", person: "m-ana" },
      { action: "link", change: "turn-off" },
      { action: "link", change: "reset" },
      { action: "group", group: "wire-team", level: "none" },
      { action: "group", group: "wire-team", level: null },
    ] as const;
    for (const request of requests)
      await h.bridge.workspaceMembers({ workspaceId: "ws-1", request });
    expect(calls(h.relay)).toEqual([
      'POST /sync/ws-1/members/level {"level":"view","workspaceName":"Community"}',
      'POST /sync/ws-1/members/m-ana/role {"role":"admin"}',
      "POST /sync/ws-1/members/m-ana/remove {}",
      "POST /sync/ws-1/members/m-ana/let-back-in {}",
      'POST /sync/ws-1/members/invite-link {"action":"turn-off"}',
      'POST /sync/ws-1/members/invite-link {"action":"reset","workspaceName":"Community"}',
      'PUT /sync/ws-1/members/groups/wire-team/rule {"level":"none"}',
      'PUT /sync/ws-1/members/groups/wire-team/rule {"level":null}',
    ]);
  });

  it("refreshes this computer's grants after each change the relay accepts, and not after a list or a refusal", async () => {
    const h = harness();
    await h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } });
    h.relay.mockResolvedValueOnce(json({ error: "forbidden" }, 403));
    await expect(
      h.bridge.workspaceMembers({
        workspaceId: "ws-1",
        request: { action: "remove", person: "m-ana" },
      }),
    ).rejects.toThrow();
    expect(h.sharesChanged).not.toHaveBeenCalled();

    await h.bridge.workspaceMembers({
      workspaceId: "ws-1",
      request: { action: "level", level: "view" },
    });
    await h.bridge.workspaceMembers({
      workspaceId: "ws-1",
      request: { action: "remove", person: "m-ana" },
    });
    await h.bridge.workspaceMembers({
      workspaceId: "ws-1",
      request: { action: "invite", email: "bo@test" },
    });
    await h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "end" } });
    expect(h.sharesChanged.mock.calls).toEqual([["ws-1"], ["ws-1"], ["ws-1"], ["ws-1"]]);
  });

  it("refreshes this computer's grants for a change the relay accepted after the window changed workspaces or accounts", async () => {
    for (const leave of ["close", "rotate"] as const) {
      const h = harness();
      const answer = deferred<Response>();
      h.relay.mockReturnValueOnce(answer.promise);
      const pending = h.bridge.workspaceMembers({
        workspaceId: "ws-1",
        request: { action: "remove", person: "m-ana" },
      });
      await vi.waitFor(() => expect(h.relay).toHaveBeenCalled());
      if (leave === "close") h.close();
      else h.rotate();
      answer.resolve(json(view()));
      await expect(pending).rejects.toThrow();
      expect(h.sharesChanged.mock.calls).toEqual([["ws-1"]]);
    }
  });

  it("finds a person by email for the owner's tools, and says so when no one has it", async () => {
    const h = harness();
    await h.bridge.workspaceMembers({
      workspaceId: "ws-1",
      request: { action: "remove", person: "ANA@test" },
    });
    expect(calls(h.relay)).toEqual([
      "GET /sync/ws-1/members",
      "POST /sync/ws-1/members/m-ana/remove {}",
    ]);
    await expect(
      h.bridge.workspaceMembers({
        workspaceId: "ws-1",
        request: { action: "remove", person: "cy@test" },
      }),
    ).rejects.toThrow("No one in this workspace has the email cy@test.");
  });

  it("names the workspace by its folder when the relay has no membership to name it", async () => {
    const h = harness();
    h.relay.mockResolvedValueOnce(
      json(view({ workspaceName: "", inviteLink: { enabled: false, url: null } })),
    );
    await expect(
      h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } }),
    ).resolves.toMatchObject({ status: "ready", view: { workspaceName: "Community" } });
  });

  it("answers the owner's view after ending membership, and done after leaving", async () => {
    const h = harness();
    const alone = view({
      workspaceName: "",
      inviteLink: { enabled: false, url: null },
      people: [view().people[0]!],
    });
    h.relay.mockResolvedValueOnce(json(alone));
    await expect(
      h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "end" } }),
    ).resolves.toEqual({ status: "ready", view: { ...alone, workspaceName: "Community" } });
    h.relay.mockResolvedValueOnce(json({ ok: true }));
    await expect(
      h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "leave" } }),
    ).resolves.toEqual({ status: "done" });
    expect(calls(h.relay)).toEqual([
      "POST /sync/ws-1/members/end {}",
      "POST /sync/ws-1/members/leave {}",
    ]);
  });

  it("names what failed and what to do for a refused change", async () => {
    const h = harness();
    h.relay.mockResolvedValueOnce(json({ error: "forbidden" }, 403));
    await expect(
      h.bridge.workspaceMembers({
        workspaceId: "ws-1",
        request: { action: "role", person: "m-ana", role: "admin" },
      }),
    ).rejects.toThrow(
      "dohc could not change this person's role because your role in this workspace does not allow it.",
    );
  });

  it("refuses a malformed request before main runs it", async () => {
    const h = harness();
    await expect(
      h.bridge.workspaceMembers({
        workspaceId: "ws-1",
        request: { action: "invite", email: "not an email" } as never,
      }),
    ).rejects.toThrow();
    await expect(
      h.bridge.workspaceMembers({
        workspaceId: "ws-1",
        request: { action: "level", level: "owner" } as never,
      }),
    ).rejects.toThrow();
    expect(h.relay).not.toHaveBeenCalled();
  });
});

describe("an admin's New group in a joined workspace", () => {
  type Joined = { userId: string; token: string; relayUrl?: string };
  const membership = {
    shareId: "share-1",
    relayUrl: "https://relay.test",
    recipientUserId: "u-ana",
  };
  function group(
    credentials: Joined | null = {
      userId: "u-ana",
      token: "secret",
      relayUrl: "https://relay.test/",
    },
  ) {
    const relay = vi.fn(
      async (_credentials: Joined, _path: string, _init: RequestInit): Promise<Response> =>
        json({ ok: true, channelWireId: "channel_wire_new", name: "Team" }),
    );
    const create = createJoinedWorkspaceGroupAction<Joined>({
      credentials: async () => credentials,
      relayResponse: relay,
    });
    return { create, relay };
  }

  it("asks the relay for the Group as the account that joined", async () => {
    const g = group();
    await expect(g.create(membership, { name: "Team", type: "chat" })).resolves.toEqual({
      channelWireId: "channel_wire_new",
    });
    expect(calls(g.relay)).toEqual([
      `POST /sync/members/groups {"shareId":"share-1","name":"Team","type":"chat"}`,
    ]);
  });

  it.each([
    [null, "signed out"],
    [{ userId: "u-sam", token: "secret", relayUrl: "https://relay.test" }, "another account"],
    [{ userId: "u-ana", token: "secret", relayUrl: "https://other.test" }, "another server"],
  ] as const)("refuses before the relay when %s (%s)", async (credentials, _why) => {
    const g = group(credentials);
    await expect(g.create(membership, { name: "Team" })).rejects.toThrow(
      "This computer is signed in to a different account than the one the owner invited.",
    );
    expect(g.relay).not.toHaveBeenCalled();
  });

  it.each([
    [400, "Use 1 to 80 characters, including at least one letter or number."],
    [403, "dohc could not create Team because only admins create Groups here."],
    [404, "dohc could not create Team because your membership ended."],
    [413, "dohc could not create Team because this workspace is out of space."],
  ])("names a %i refusal", async (status, words) => {
    const g = group();
    g.relay.mockResolvedValueOnce(json({ error: "refused" }, status));
    await expect(g.create(membership, { name: "Team" })).rejects.toThrow(words);
  });

  it("says the server cannot be reached when the request fails", async () => {
    const g = group();
    g.relay.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(g.create(membership, { name: "Team" })).rejects.toThrow(MEMBERS_UNREACHABLE);
  });
});

describe("the owner's New group with a level", () => {
  function owned() {
    const relay = vi.fn(
      async (_credentials: Credentials, _path: string, _init: RequestInit): Promise<Response> =>
        json({ ok: true, channelWireId: "channel_wire_new", name: "Team" }),
    );
    const credentials = vi.fn(async (_workspaceId: string) => ({
      userId: "u-owner",
      token: "secret",
    }));
    const create = createOwnedWorkspaceGroupAction<Credentials>({
      credentials,
      relayResponse: relay,
    });
    return { create, relay, credentials };
  }

  it("asks the relay for the Group and its rule by the workspace's own id", async () => {
    const o = owned();
    await expect(o.create("ws-1", { name: "Team", type: "chat", level: "none" })).resolves.toEqual({
      channelWireId: "channel_wire_new",
    });
    expect(o.credentials).toHaveBeenCalledWith("ws-1");
    expect(calls(o.relay)).toEqual([
      `POST /sync/members/groups {"workspaceId":"ws-1","name":"Team","type":"chat","level":"none"}`,
    ]);
  });

  it("names a 404 as a workspace the server does not know", async () => {
    const o = owned();
    o.relay.mockResolvedValueOnce(json({ error: "not_found" }, 404));
    await expect(o.create("ws-1", { name: "Team", level: "view" })).rejects.toThrow(
      "dohc could not create Team because this workspace has not synced to your server yet. Try again once it has.",
    );
  });
});
