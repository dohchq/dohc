import { createHash } from "node:crypto";
import { expect, vi } from "vitest";
import type {
  ConsentCredentials,
  CredentialFence,
  CredentialFenceChange,
  CredentialFenceListener,
} from "@dohc/workspace-auth/credentialFence";
import { agentAccessCheck } from "./linkAuthority";
import { binding, fixture as ticketFixture, retainServiceActivation, scope } from "./liveTickets.test-helper";
import { createPersonalLiveDocumentRoute, PERSONAL_LIVE_DOCUMENT_PATH } from "./personalLiveDocumentRoutes";
import type { PersonalRunningEntry } from "./personalAgents";
import type { ServiceActivationBlock } from "./serviceActivationDriver";
import type { ServiceHostedHold } from "./serviceHostedReplication";
import { createLiveJournalHistoryAuthority } from "./storage/liveJournalHistory";
import { SERVICE_HOST_ENROLLMENTS } from "./storage/serviceHostEnrollment";
import { LINK_KEY, RELAY_EXCHANGE_KEY, SHARE_WEB_ORIGIN, testHandler } from "./testing";

const namespace = "personal-live-route-test";
const hostId = "self-host-personal-live-route-test";
const RESOURCE = `${SHARE_WEB_ORIGIN}/mcp/agent/w/${scope.workspaceId}`;

/** The Postgres fence as the relay reads it: every account at epoch 0, until it is down. */
class Fence implements CredentialFence {
  down = false;
  listener: CredentialFenceListener | undefined;
  async readEpoch(): Promise<number> {
    this.assertUp();
    return 0;
  }
  async readConsentCredentials(): Promise<ConsentCredentials | null> {
    this.assertUp();
    return null;
  }
  async changedSince(): Promise<CredentialFenceChange[]> {
    this.assertUp();
    return [];
  }
  listen(listener: CredentialFenceListener): { close(): Promise<void> } {
    this.listener = listener;
    return { close: async () => { this.listener = undefined; } };
  }
  private assertUp(): void {
    if (this.down) throw new Error("The database is unreachable.");
  }
}

function probe(): PersonalRunningEntry {
  return { agentId: "probe", ownerUserId: "probe", connectionId: "probe", fenceEpoch: 0, workspaceIds: [], kind: "wait", terminate: () => {} };
}

export type PersonalRouteFixtureOptions = { live?: false; control?: "device"; limits?: { maxMs?: number; perAgent?: number; waiters?: number } };

/**
 * The fixture's owner workspace with its rich document at docs/a.md, an
 * owner Edit share on docs, and a relay whose fence listener is up. Unless
 * `control` is "device", the relay runs the self-hosted live host.
 */
export async function personalRouteFixture(defer: (close: () => Promise<void> | void) => void, options: PersonalRouteFixtureOptions = {}) {
  const f = await ticketFixture();
  defer(f.close);
  f.storage.claimWorkspaceIdentity({ workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream" });
  f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES (?,'owner',0,'moment.append','{}',1,1)").run(scope.workspaceId);
  f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)").run(scope.workspaceId, binding.currentPath, "b".repeat(64));
  if (options.control !== "device") {
    const control = f.storage.getLiveHostControl()!;
    vi.spyOn(f.storage, "getLiveHostControl").mockReturnValue({ ...control, configuredMode: "service", configuredHostId: hostId });
  }
  const blocked = new Map<string, ServiceActivationBlock>();
  const host = {
    ready: vi.fn(() => false),
    unavailable: false,
    blocked: vi.fn((document: { objectId: string }) => blocked.get(document.objectId)),
    holdReason: vi.fn((_document: { objectId: string }): ServiceHostedHold["reason"] | undefined => undefined),
    diverged: vi.fn((_row: { workspaceId: string; replicationEpoch: string; streamIdentity: string }) => false),
  };
  const history = createLiveJournalHistoryAuthority({ namespace, reconciled: true });
  const fence = new Fence();
  const h = testHandler(f.storage, { credentialFence: fence, relayExchangeKey: RELAY_EXCHANGE_KEY });
  defer(() => h.dispose());
  fence.listener!.onUp();
  await vi.waitFor(() => h.personalAgents.register(probe())());
  const route = createPersonalLiveDocumentRoute({
    storage: f.storage, linkAuthority: h.linkAuthority, personalAgents: h.personalAgents, limiter: h.personalLimiter, nowMs: () => 2_000,
    ...(options.live === false ? {} : { live: { host, history, hostId } }),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  // Opens still held when a test ends leave with their clients.
  const clients: AbortController[] = [];
  defer(() => { for (const client of clients) client.abort(); });

  /** A personal agent of the workspace's owner, signed in at `level`, as its sign-in commits it. */
  function agent(name: string, level: "view" | "comment" | "edit" = "edit") {
    const agentId = `p-${createHash("sha256").update(name).digest("hex").slice(0, 26)}`;
    const connectionId = `connection-${name}`;
    const token = createHash("sha256").update(`token-${name}`).digest("base64url");
    const check = agentAccessCheck(token, RESOURCE, LINK_KEY)!;
    f.raw.prepare("INSERT INTO sync_relay_personal_agents(agent_id,owner_user_id,name,hue,status,epoch,created_at_ms) VALUES (?,'owner-1',?,'olive','active',1,0)")
      .run(agentId, name);
    f.raw.prepare(`INSERT INTO sync_relay_personal_agent_connections(connection_id,agent_id,owner_user_id,client_id,resource_hash,agent_epoch,fence_epoch,connected_at_ms)
      VALUES (?,?,'owner-1','client',?,1,0,0)`).run(connectionId, agentId, check.resourceHash);
    f.raw.prepare("INSERT INTO sync_relay_personal_agent_tokens(token_hash,connection_id,kind,issued_at_ms,expires_at_ms) VALUES (?,?,'access',0,?)")
      .run(check.accessTokenHash, connectionId, 4_000_000_000_000);
    f.raw.prepare("INSERT INTO sync_relay_personal_agent_reach(agent_id,workspace_id,level,start_seq) VALUES (?,?,?,0)").run(agentId, scope.workspaceId, level);
    /** What share-web forwards for the agent's open. */
    const open = (input: { workspaceId: string; path: string } = { workspaceId: scope.workspaceId, path: binding.currentPath }, client = new AbortController()) => {
      clients.push(client);
      return route(new Request(`https://relay.test${PERSONAL_LIVE_DOCUMENT_PATH}`, {
        method: "POST",
        signal: client.signal,
        headers: {
          authorization: `DohcAgent ${token}`,
          "x-dohc-agent-resource": RESOURCE,
          "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      }));
    };
    return { agentId, open };
  }

  return {
    ...f, host, blocked, route, h, fence, agent,
    input: { workspaceId: scope.workspaceId, ownerUserId: "owner-1", shareId: scope.shareId, path: binding.currentPath, nowMs: 10, guard() {} },
    read: () => f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath),
    /** The host completed the document's activation and holds it. */
    ready() {
      retainServiceActivation(f.raw, namespace, true);
      host.ready.mockReturnValue(true);
    },
    /** The open's waiters and the documents they wait on, once they are held. */
    holding: (waiters: number, documents: number) => vi.waitFor(() => expect(route.held()).toEqual({ waiters, documents })),
    /** The fixture's only Edit grant ends, so no share covers docs/a.md. */
    revoke: () => expect(f.storage.revokeShareGrant({ shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 15 }).ok).toBe(true),
    release: () => f.storage.releaseServiceHostEnrollment({ workspaceId: scope.workspaceId, objectId: binding.objectId, nowMs: 20 }),
    /** Another current rich document in the workspace, with no live history. */
    seed(path: string, objectId: string) {
      f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)").run(scope.workspaceId, path, "b".repeat(64));
      f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
        VALUES (?,?,1,?,'main',?,?,'text',1,1)`).run(scope.workspaceId, objectId, `moment-${objectId}`, path, "b".repeat(64));
    },
    /** A hosted document only an agent's open keeps: no share covers it and its owner never asked. */
    agentOnly(workspaceId: string, objectId: string, path: string) {
      f.raw.prepare(`INSERT OR IGNORE INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity,epoch_log_floor)
        VALUES (?,'owner-1',0,'epoch','stream',0)`).run(workspaceId);
      f.raw.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,
        created_at_ms,updated_at_ms,demand_at_ms,accounted_bytes) VALUES (?,?,?,'owner-1',NULL,'epoch','stream',1,1,1,1,64)`).run(workspaceId, objectId, path);
    },
  };
}
