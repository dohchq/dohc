import { describe, expect, it, vi } from "vitest";
import type { WorkspaceMembersView } from "@dohc/security-contract/workspace-members";
import { createWorkspaceMembersActions, MEMBERS_UNREACHABLE } from "./workspaceMembersActions";
import { memberOperations, MEMBERS_INACTIVE_MESSAGE } from "./memberOperations";
import { operationBridge, registerOperations } from "./operationTable";
import { deferred } from "../testing/deferred";

type Credentials = { userId: string; token: string };
const view = (overrides: Partial<WorkspaceMembersView> = {}): WorkspaceMembersView => ({
  workspaceId: "ws-1", workspaceName: "Community",
  viewer: { memberId: "owner", role: "owner" }, memberLevel: "comment",
  inviteLink: { enabled: true, url: "https://share.test/join#token" },
  people: [
    { memberId: "owner", role: "owner", state: "active", name: "Ice", email: "ice@test", invitedAtMs: null, joinedAtMs: 1, removedAtMs: null },
    { memberId: "m-ana", role: "member", state: "active", name: "Ana", email: "ana@test", invitedAtMs: 1, joinedAtMs: 2, removedAtMs: null },
  ],
  ...overrides,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness(options: { shareView?: unknown } = {}) {
  let generation = 1, open = true;
  const workspace = { workspaceId: "ws-1", rootPath: "C:\\Users\\me\\Community", shareView: options.shareView };
  const relay = vi.fn(async (_credentials: Credentials, _path: string, _init: RequestInit): Promise<Response> => json(view()));
  const remote = vi.fn(async (_workspace: typeof workspace, _options?: { allowPaused: boolean }) =>
    ({ credentials: { userId: "owner", token: "secret" }, credentialGeneration: generation }));
  const members = createWorkspaceMembersActions<typeof workspace, Credentials>({
    remoteForWorkspace: remote, currentCredentialGeneration: () => generation, relayResponse: relay,
  });
  const listeners = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  registerOperations({
    handle: (channel, listener) => listeners.set(channel, listener),
    assertTrustedSender: () => undefined,
    withActiveWorkspace: async (_event, workspaceId, message, work) => {
      const assertCurrent = () => { if (!open || workspaceId !== workspace.workspaceId) throw new Error(message); };
      assertCurrent();
      const result = await work({ workspace, assertCurrent });
      assertCurrent();
      return result;
    },
  }, memberOperations, { workspaceMembers: ({ request }, { operation }) => members(operation as Parameters<typeof members>[0], request) });
  const bridge = operationBridge(memberOperations, (channel, payload) => listeners.get(channel)!({}, payload));
  return { bridge, relay, remote, rotate: () => { generation++; }, close: () => { open = false; } };
}

const calls = (relay: ReturnType<typeof harness>["relay"]) =>
  relay.mock.calls.map(([, path, init]) => `${init.method} ${path}${init.body ? ` ${String(init.body)}` : ""}`);

describe("workspace members actions", () => {
  it("lists through the window's workspace and signed-in account, allowing a paused remote", async () => {
    const h = harness();
    await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } }))
      .resolves.toEqual({ status: "ready", view: view() });
    expect(calls(h.relay)).toEqual(["GET /sync/ws-1/members"]);
    expect(h.relay.mock.calls[0]![0]).toEqual({ userId: "owner", token: "secret" });
    expect(h.remote.mock.calls[0]![1]).toEqual({ allowPaused: true });
  });

  it("answers refused when the relay lists no Members page for this account", async () => {
    for (const status of [403, 404]) {
      const h = harness();
      h.relay.mockResolvedValueOnce(json({ error: "no" }, status));
      await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } })).resolves.toEqual({ status: "refused" });
    }
  });

  it("refuses a received share view before asking the relay", async () => {
    const h = harness({ shareView: { shareId: "s", granterEmail: null, genericChatWritable: false, grantedSelector: { paths: ["a"], versionId: null, access: "view" } } });
    await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } }))
      .rejects.toThrow("Open the original workspace to manage its members.");
    expect(h.relay).not.toHaveBeenCalled();
  });

  it("rejects a view for another workspace or one the contract refuses, instead of showing it", async () => {
    const h = harness();
    h.relay.mockResolvedValueOnce(json(view({ workspaceId: "ws-2" })));
    await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } })).rejects.toThrow("could not read Members");
    // A member's view must carry no emails.
    h.relay.mockResolvedValueOnce(json(view({ viewer: { memberId: "m-ana", role: "member" }, inviteLink: null })));
    await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } })).rejects.toThrow("could not read Members");
  });

  it("says the server is unreachable when the request fails, and keeps the session-change error when the account changed", async () => {
    const h = harness();
    h.relay.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } })).rejects.toThrow(MEMBERS_UNREACHABLE);
    h.relay.mockImplementationOnce(async () => { h.rotate(); throw new TypeError("aborted"); });
    await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "list" } })).rejects.toThrow("Your server session changed. Try again.");
  });

  it("drops an answer that arrives after the account changed", async () => {
    const h = harness();
    const answer = deferred<Response>();
    h.relay.mockReturnValueOnce(answer.promise);
    const pending = h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "level", level: "edit" } });
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

  it("invites with the folder's name, then answers the fresh list", async () => {
    const h = harness();
    h.relay.mockResolvedValueOnce(json({ ok: true, memberId: "m-bo" }));
    await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "invite", email: " bo@test " } }))
      .resolves.toMatchObject({ status: "ready" });
    expect(calls(h.relay)).toEqual([
      'POST /sync/ws-1/members/invites {"email":"bo@test","workspaceName":"Community"}',
      "GET /sync/ws-1/members",
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
    ] as const;
    for (const request of requests) await h.bridge.workspaceMembers({ workspaceId: "ws-1", request });
    expect(calls(h.relay)).toEqual([
      'POST /sync/ws-1/members/level {"level":"view"}',
      'POST /sync/ws-1/members/m-ana/role {"role":"admin"}',
      "POST /sync/ws-1/members/m-ana/remove {}",
      "POST /sync/ws-1/members/m-ana/let-back-in {}",
      'POST /sync/ws-1/members/invite-link {"action":"turn-off"}',
      'POST /sync/ws-1/members/invite-link {"action":"reset","workspaceName":"Community"}',
    ]);
  });

  it("finds a person by email for the owner's tools, and says so when no one has it", async () => {
    const h = harness();
    await h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "remove", person: "ANA@test" } });
    expect(calls(h.relay)).toEqual(["GET /sync/ws-1/members", "POST /sync/ws-1/members/m-ana/remove {}"]);
    await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "remove", person: "cy@test" } }))
      .rejects.toThrow("No one in this workspace has the email cy@test.");
  });

  it("answers done after leaving or ending membership", async () => {
    const h = harness();
    h.relay.mockImplementation(async () => json({ ok: true }));
    await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "end" } })).resolves.toEqual({ status: "done" });
    await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "leave" } })).resolves.toEqual({ status: "done" });
    expect(calls(h.relay)).toEqual(["POST /sync/ws-1/members/end {}", "POST /sync/ws-1/members/leave {}"]);
  });

  it("names what failed and what to do for a refused change", async () => {
    const h = harness();
    h.relay.mockResolvedValueOnce(json({ error: "forbidden" }, 403));
    await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "role", person: "m-ana", role: "admin" } }))
      .rejects.toThrow("dohc could not change this person's role because your role in this workspace no longer allows it.");
  });

  it("refuses a malformed request before main runs it", async () => {
    const h = harness();
    await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "invite", email: "not an email" } as never })).rejects.toThrow();
    await expect(h.bridge.workspaceMembers({ workspaceId: "ws-1", request: { action: "level", level: "owner" } as never })).rejects.toThrow();
    expect(h.relay).not.toHaveBeenCalled();
  });
});
