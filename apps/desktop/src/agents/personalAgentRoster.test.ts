import { describe, expect, it, vi } from "vitest";
import type { PersonalAgentsEvent } from "../ipc/bridgeContract";
import { createPersonalAgentRoster, type PersonalAgentSession } from "./personalAgentRoster";

// The roster cache in main against a fake relay: it reads the roster once,
// reads again only when a notice page carries another revision, and keeps
// each change the relay answers without a stale read putting it back.

const KEY = "https://server.test#https://relay.test#ana";
const AGENT_ID = `p-${"a".repeat(26)}`;

type RelayAgent = {
  agentId: string;
  name: string;
  hue: string;
  reportedProduct: string | null;
  reportedVersion: string | null;
  status: "active" | "signed_out" | "removed";
  createdAtMs: number;
  signedInAtMs: number | null;
  lastActionAtMs: number | null;
  reach: { workspaceId: string; level: "view" | "comment" }[];
};

interface FakeRelay {
  revision: number;
  agents: RelayAgent[];
  requests: string[];
  // The status every change answers with, instead of applying it.
  refuse: number | null;
  // Roster reads wait here until released.
  holdReads: boolean;
  held: Array<() => void>;
  offline: boolean;
  fetch: typeof fetch;
}

function relayAgent(overrides: Partial<RelayAgent> = {}): RelayAgent {
  return {
    agentId: AGENT_ID,
    name: "Grok Bot",
    hue: "teal",
    reportedProduct: "Grok",
    reportedVersion: "4.1",
    status: "active",
    createdAtMs: 1,
    signedInAtMs: 5,
    lastActionAtMs: null,
    reach: [{ workspaceId: "ws-1", level: "view" }],
    ...overrides,
  };
}

function fakeRelay(agents: RelayAgent[] = [relayAgent()]): FakeRelay {
  const relay: FakeRelay = {
    revision: 3,
    agents,
    requests: [],
    refuse: null,
    holdReads: false,
    held: [],
    offline: false,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      relay.requests.push(`${request.method} ${path}`);
      if (relay.offline) throw new TypeError("fetch failed");
      if (request.method === "GET" && path === "/sync/personal-agents") {
        const answer = {
          ok: true,
          revision: relay.revision,
          agents: relay.agents.map(agent => ({ ...agent })),
          workspaces: [{ workspaceId: "ws-1", name: "Trip" }],
        };
        if (relay.holdReads) await new Promise<void>(resolve => relay.held.push(resolve));
        return Response.json(answer);
      }
      if (relay.refuse !== null) return Response.json({ ok: false, error: "refused" }, { status: relay.refuse });
      const [, id, kind] = /^\/sync\/personal-agents\/([^/]+)\/([a-z-]+)$/u.exec(path) ?? [];
      const agent = relay.agents.find(entry => entry.agentId === decodeURIComponent(id ?? ""));
      if (!agent) return Response.json({ ok: false, error: "not found" }, { status: 404 });
      const body = request.method === "PUT" ? await request.json() as Partial<RelayAgent> : {};
      if (kind === "name" && body.name) agent.name = body.name;
      if (kind === "hue" && body.hue) agent.hue = body.hue;
      if (kind === "reach" && body.reach) agent.reach = body.reach;
      if (kind === "sign-out") agent.status = "signed_out";
      if (kind === "remove") agent.status = "removed";
      if (kind === "restore") agent.status = "signed_out";
      relay.revision += 1;
      return Response.json({ ok: true, revision: relay.revision, agent: { ...agent } });
    },
  };
  return relay;
}

function setup(relay: FakeRelay, signedIn: { key: string } | null = { key: KEY }) {
  const pushed: PersonalAgentsEvent[] = [];
  const unauthorized = vi.fn(async () => {});
  const session = (): PersonalAgentSession | null => signedIn && {
    key: signedIn.key,
    origin: "https://relay.test",
    relay: { baseUrl: "https://relay.test", token: "user:ana", fetch: relay.fetch },
    isCurrent: () => true,
    unauthorized,
  };
  const roster = createPersonalAgentRoster({
    session: async () => session(),
    onChanged: (view) => { pushed.push(view); },
  });
  return { roster, pushed, unauthorized };
}

function names(view: PersonalAgentsEvent): string[] {
  return view.accounts.flatMap(account => account.roster?.agents.map(agent => agent.name) ?? []);
}

function reads(relay: FakeRelay): number {
  return relay.requests.filter(request => request === "GET /sync/personal-agents").length;
}

describe("the personal agents roster in main", () => {
  it("reads the roster once and answers later reads from the cache", async () => {
    const relay = fakeRelay([relayAgent(), relayAgent({ agentId: `p-${"r".repeat(26)}`, name: "Gone", status: "removed", createdAtMs: 2 })]);
    const { roster } = setup(relay);

    const view = await roster.read(false);
    expect(view).toEqual({
      accounts: [{
        accountKey: KEY,
        host: "relay.test",
        agentLinkOrigin: "https://relay.test",
        roster: {
          revision: 3,
          agents: [{
            agentId: AGENT_ID, name: "Grok Bot", hue: "teal", reportedProduct: "Grok", reportedVersion: "4.1", status: "active",
            createdAtMs: 1, signedInAtMs: 5, lastActionAtMs: null, reach: [{ workspaceId: "ws-1", level: "view" }],
          }],
          workspaces: [{ workspaceId: "ws-1", name: "Trip" }],
        },
        failure: null,
      }],
    });
    await roster.read(false);
    expect(reads(relay)).toBe(1);
    await roster.read(true);
    expect(reads(relay)).toBe(2);
  });

  it("reads again only when a notice page carries another revision", async () => {
    const relay = fakeRelay();
    const { roster, pushed } = setup(relay);
    await roster.read(false);

    roster.revisionSeen(KEY, 3);
    expect(reads(relay)).toBe(1);

    // Another computer renames the agent, and the next notice pull says so.
    relay.agents[0]!.name = "Iris";
    relay.revision = 4;
    roster.revisionSeen(KEY, 4);
    await vi.waitFor(() => expect(names(roster.view())).toEqual(["Iris"]));
    expect(reads(relay)).toBe(2);
    expect(names(pushed.at(-1)!)).toEqual(["Iris"]);
    expect(roster.view().accounts[0]?.roster?.revision).toBe(4);
  });

  it("puts a rename the relay answers into the cache and pushes it", async () => {
    const relay = fakeRelay();
    const { roster, pushed } = setup(relay);
    await roster.read(false);

    const result = await roster.change(KEY, AGENT_ID, { kind: "name", name: "Iris" });
    expect(result.ok && names(result.personalAgents)).toEqual(["Iris"]);
    expect(relay.requests.at(-1)).toBe(`PUT /sync/personal-agents/${AGENT_ID}/name`);
    expect(names(pushed.at(-1)!)).toEqual(["Iris"]);
    // The answer was the next revision, so nothing was missed.
    expect(roster.view().accounts[0]?.roster?.revision).toBe(4);
    expect(reads(relay)).toBe(1);
    roster.revisionSeen(KEY, 4);
    expect(reads(relay)).toBe(1);
  });

  it("reads the whole roster again when a change answer skips a revision", async () => {
    const relay = fakeRelay();
    const { roster } = setup(relay);
    await roster.read(false);

    relay.revision = 5;
    await roster.change(KEY, AGENT_ID, { kind: "hue", hue: "rose" });
    await vi.waitFor(() => expect(roster.view().accounts[0]?.roster?.revision).toBe(6));
    expect(reads(relay)).toBe(2);
  });

  it("keeps a read that started before a change from putting back what it replaced", async () => {
    const relay = fakeRelay();
    const { roster, pushed } = setup(relay);
    await roster.read(false);

    relay.holdReads = true;
    roster.revisionSeen(KEY, 9);
    await vi.waitFor(() => expect(relay.held).toHaveLength(1));
    await roster.change(KEY, AGENT_ID, { kind: "name", name: "Iris" });
    const renamedAt = pushed.length;
    expect(names(pushed.at(-1)!)).toEqual(["Iris"]);

    relay.holdReads = false;
    relay.held.shift()!();
    await vi.waitFor(() => expect(reads(relay)).toBe(3));
    await vi.waitFor(() => expect(roster.view().accounts[0]?.roster?.revision).toBe(4));
    expect(pushed.slice(renamedAt).every(view => names(view).join() === "Iris")).toBe(true);
  });

  it("drops a removed agent and brings it back signed out on undo", async () => {
    const relay = fakeRelay([relayAgent({ status: "signed_out" })]);
    const { roster } = setup(relay);
    await roster.read(false);

    const removed = await roster.change(KEY, AGENT_ID, { kind: "remove" });
    expect(removed.ok && removed.personalAgents.accounts[0]?.roster?.agents).toEqual([]);
    const restored = await roster.change(KEY, AGENT_ID, { kind: "restore" });
    expect(restored.ok && restored.personalAgents.accounts[0]?.roster?.agents.map(agent => agent.status)).toEqual(["signed_out"]);
  });

  it.each([
    [404, "dohc could not find Grok Bot on relay.test.", true],
    [409, "Sign out Grok Bot before you remove it.", true],
    [503, "relay.test could not change Grok Bot right now. Try again shortly.", false],
  ])("says what a %s refusal means and reads again when the cache is behind", async (status, words, readsAgain) => {
    const relay = fakeRelay();
    const { roster } = setup(relay);
    await roster.read(false);

    relay.refuse = status;
    expect(await roster.change(KEY, AGENT_ID, { kind: "remove" })).toEqual({ ok: false, error: words });
    if (readsAgain) await vi.waitFor(() => expect(reads(relay)).toBe(2));
    else expect(reads(relay)).toBe(1);
  });

  it("ends the session when the relay refuses its token", async () => {
    const relay = fakeRelay();
    const { roster, unauthorized } = setup(relay);
    await roster.read(false);

    relay.refuse = 401;
    expect(await roster.change(KEY, AGENT_ID, { kind: "sign-out" }))
      .toEqual({ ok: false, error: "Your server session expired. Sign in again, then retry." });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("changes nothing for an account that is not signed in", async () => {
    const relay = fakeRelay();
    const { roster } = setup(relay);

    expect(await roster.change("https://server.test#https://relay.test#bo", AGENT_ID, { kind: "sign-out" }))
      .toEqual({ ok: false, error: "Sign in to the account this agent belongs to, then try again." });
    expect(relay.requests).toEqual([]);
  });

  it("says why the roster could not be read and keeps what it had", async () => {
    const relay = fakeRelay();
    const { roster } = setup(relay);
    await roster.read(false);

    relay.offline = true;
    const view = await roster.read(true);
    expect(view.accounts[0]?.failure).toBe("dohc could not reach relay.test. Check your connection.");
    expect(names(view)).toEqual(["Grok Bot"]);
  });

  it("holds no account while nobody is signed in", async () => {
    const relay = fakeRelay();
    const { roster } = setup(relay, null);

    expect(await roster.read(true)).toEqual({ accounts: [] });
    expect(relay.requests).toEqual([]);
  });
});
