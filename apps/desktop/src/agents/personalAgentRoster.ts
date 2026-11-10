import {
  RelayApiVersionError,
  RelayUnauthorizedError,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { z } from "zod";
import {
  PERSONAL_AGENT_REACH_LIMIT,
  PersonalAgent,
  PersonalAgentReach,
  PersonalAgentRoster,
  type PersonalAgentChange,
  type PersonalAgentChangeResult,
  type PersonalAgentsEvent,
} from "../ipc/bridgeContract";
import { relayRequest } from "../workspaces/relayRequest";

// The personal agents of the signed-in server account, cached in main. The
// relay keeps a revision per account, and every notice page carries it, so a
// change made on another computer arrives with the next notice pull. Settings
// and the @ picker read this cache; sending a message asks the relay nothing.

// The signed-in account, read from one credential snapshot.
export interface PersonalAgentSession {
  key: string;
  // The server's share-web origin, where a personal agent link starts.
  origin: string;
  relay: SyncRelayConnection;
  isCurrent(): boolean;
  // The relay refused this session's token. Ends the session if it is still current.
  unauthorized(): Promise<void>;
}

export interface PersonalAgentRosterCache {
  view(): PersonalAgentsEvent;
  // Reads the relay first when asked, or when nothing is cached for the account.
  read(refresh: boolean): Promise<PersonalAgentsEvent>;
  // A notice page answered with this revision for this account.
  revisionSeen(accountKey: string, revision: number): void;
  // The signed-in account may have changed.
  accountChanged(): void;
  change(accountKey: string, agentId: string, change: PersonalAgentChange): Promise<PersonalAgentChangeResult>;
}

const RelayAgent = z.object({
  ...PersonalAgent.shape,
  status: z.enum(["active", "signed_out", "removed"]),
  reach: z.array(z.object(PersonalAgentReach.shape)).max(PERSONAL_AGENT_REACH_LIMIT),
});
type RelayAgent = z.infer<typeof RelayAgent>;
const RelayRoster = z.object({
  ok: z.literal(true),
  revision: PersonalAgentRoster.shape.revision,
  agents: z.array(RelayAgent),
  workspaces: z.array(z.object(PersonalAgentRoster.shape.workspaces.element.shape)),
});
const RelayChange = z.object({
  ok: z.literal(true),
  revision: PersonalAgentRoster.shape.revision,
  agent: RelayAgent,
});

const SESSION_EXPIRED = "Your server session expired. Sign in again, then retry.";
const OTHER_ACCOUNT = "Sign in to the account this agent belongs to, then try again.";

// A refusal whose words this module chose. `refresh` re-reads the roster,
// because the refusal means the cache is behind the relay.
class Refusal extends Error {
  constructor(message: string, readonly refresh: boolean) {
    super(message);
  }
}

function toAgent(agent: RelayAgent): PersonalAgent | null {
  if (agent.status === "removed") return null;
  return {
    agentId: agent.agentId,
    name: agent.name,
    hue: agent.hue,
    reportedProduct: agent.reportedProduct,
    reportedVersion: agent.reportedVersion,
    status: agent.status,
    createdAtMs: agent.createdAtMs,
    signedInAtMs: agent.signedInAtMs,
    lastActionAtMs: agent.lastActionAtMs,
    reach: agent.reach.map(entry => ({ workspaceId: entry.workspaceId, level: entry.level })),
  };
}

function hostOf(origin: string): string {
  return new URL(origin).host;
}

function requestFor(agentId: string, change: PersonalAgentChange): { path: string; init: RequestInit } {
  const base = `/sync/personal-agents/${encodeURIComponent(agentId)}`;
  if (change.kind === "sign-out" || change.kind === "remove" || change.kind === "restore") {
    return { path: `${base}/${change.kind}`, init: { method: "POST" } };
  }
  const body = change.kind === "name" ? { name: change.name }
    : change.kind === "hue" ? { hue: change.hue }
    : { reach: change.reach };
  return {
    path: `${base}/${change.kind}`,
    init: { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  };
}

function invalidWords(change: PersonalAgentChange, host: string): string {
  if (change.kind === "name") return "Enter a name of 1 to 40 characters.";
  if (change.kind === "reach") return `A workspace you chose no longer syncs to ${host}.`;
  return `${host} refused this change.`;
}

// What a failed read or change says, when the cause is not a refusal above.
function failureWords(error: unknown, host: string, what: string): string {
  if (error instanceof RelayApiVersionError) return error.message;
  if (error instanceof TypeError || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) {
    return `dohc could not reach ${host}. Check your connection.`;
  }
  return `${host} could not ${what}.`;
}

export function createPersonalAgentRoster(deps: {
  // The signed-in account, or null when nobody is signed in to a relay.
  session(): Promise<PersonalAgentSession | null>;
  onChanged(view: PersonalAgentsEvent): void;
}): PersonalAgentRosterCache {
  type Cached = { key: string; origin: string; roster: PersonalAgentRoster | null; failure: string | null };
  let cached: Cached | null = null;
  // Rises with each change answer applied, so a read that started before one
  // can't put back what the change replaced.
  let changes = 0;
  let running: Promise<void> | null = null;
  let again = false;

  function set(next: Cached | null): void {
    cached = next;
    deps.onChanged(view());
  }

  function view(): PersonalAgentsEvent {
    if (!cached) return { accounts: [] };
    return {
      accounts: [{
        accountKey: cached.key,
        host: hostOf(cached.origin),
        agentLinkOrigin: cached.origin,
        roster: cached.roster,
        failure: cached.failure,
      }],
    };
  }

  async function readOnce(): Promise<void> {
    const session = await deps.session();
    if (!session) {
      if (cached) set(null);
      return;
    }
    if (cached?.key !== session.key) set({ key: session.key, origin: session.origin, roster: null, failure: null });
    const changesAtStart = changes;
    const host = hostOf(session.origin);
    try {
      const response = await relayRequest({
        relay: session.relay,
        path: "/sync/personal-agents",
        errors: { 404: () => new Refusal(`${host} has no personal agents. Its server needs an update.`, false) },
        label: "Personal agents",
      });
      const answer = RelayRoster.parse(await response.json());
      if (!session.isCurrent() || cached?.key !== session.key) return;
      if (changes !== changesAtStart) {
        again = true;
        return;
      }
      set({
        ...cached,
        roster: {
          revision: answer.revision,
          agents: answer.agents.map(toAgent).filter((agent): agent is PersonalAgent => agent !== null),
          workspaces: answer.workspaces.map(workspace => ({ workspaceId: workspace.workspaceId, name: workspace.name })),
        },
        failure: null,
      });
    } catch (error) {
      if (error instanceof RelayUnauthorizedError) await session.unauthorized();
      if (!session.isCurrent() || cached?.key !== session.key) return;
      const failure = error instanceof RelayUnauthorizedError ? SESSION_EXPIRED
        : error instanceof Refusal ? error.message
        : failureWords(error, host, "list your personal agents");
      set({ ...cached, failure });
    }
  }

  function refresh(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await readOnce();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  // Puts a change answer into the cache. When the cache missed a revision in
  // between, it keeps its old revision and reads the whole roster again.
  function apply(key: string, answer: z.infer<typeof RelayChange>): void {
    if (!cached || cached.key !== key || !cached.roster) {
      void refresh();
      return;
    }
    changes++;
    const agent = toAgent(answer.agent);
    const others = cached.roster.agents.filter(entry => entry.agentId !== answer.agent.agentId);
    const agents = agent === null ? others
      : [...others, agent].sort((a, b) => a.createdAtMs - b.createdAtMs || (a.agentId < b.agentId ? -1 : 1));
    const caughtUp = answer.revision === cached.roster.revision + 1;
    set({
      ...cached,
      roster: { ...cached.roster, agents, revision: caughtUp ? answer.revision : cached.roster.revision },
      failure: null,
    });
    if (!caughtUp) void refresh();
  }

  return {
    view,

    async read(refreshFirst) {
      if (refreshFirst || !cached?.roster) await refresh();
      return view();
    },

    revisionSeen(accountKey, revision) {
      if (cached?.key === accountKey && cached.roster?.revision === revision) return;
      void refresh();
    },

    accountChanged() {
      void refresh();
    },

    async change(accountKey, agentId, change) {
      const session = await deps.session();
      if (!session || session.key !== accountKey) return { ok: false, error: OTHER_ACCOUNT };
      const host = hostOf(session.origin);
      const name = cached?.key === accountKey
        ? cached.roster?.agents.find(agent => agent.agentId === agentId)?.name ?? "this agent"
        : "this agent";
      const { path, init } = requestFor(agentId, change);
      try {
        const response = await relayRequest({
          relay: session.relay,
          path,
          init,
          errors: {
            400: () => new Refusal(invalidWords(change, host), change.kind === "reach"),
            404: () => new Refusal(`dohc could not find ${name} on ${host}.`, true),
            409: () => new Refusal(`Sign out ${name} before you remove it.`, true),
            503: () => new Refusal(`${host} could not change ${name} right now. Try again shortly.`, false),
          },
          label: "Personal agent change",
        });
        const answer = RelayChange.parse(await response.json());
        if (session.isCurrent()) apply(session.key, answer);
        return { ok: true, personalAgents: view() };
      } catch (error) {
        if (error instanceof RelayUnauthorizedError) {
          await session.unauthorized();
          return { ok: false, error: SESSION_EXPIRED };
        }
        if (error instanceof Refusal) {
          if (error.refresh) void refresh();
          return { ok: false, error: error.message };
        }
        return { ok: false, error: failureWords(error, host, `change ${name}`) };
      }
    },
  };
}
