import {afterEach, expect, it, vi} from "vitest";
import {LINK_REFUSALS, linkRefusalBody} from "@dohc/security-contract/link-refusal";
import {createLinkLiveHttp} from "../../sync-relay/src/linkLiveHttp";
import {hashLinkBearer} from "../../sync-relay/src/linkSecurity";
import {audience, fixture, key, scope} from "../../sync-relay/src/liveTickets.test-helper";
import {createLinkLiveClient} from "./linkLiveClient";

const transport = {maxConnections: 8, maxConnectionsPerSession: 2, maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4,
  maxPendingRequests: 4, maxRequestBytes: 4096, maxResponseBytes: 8192, maxPendingBytes: 4096, maxFragments: 8, maxBufferedChunks: 16,
  upgradeTimeoutMs: 1000, idleTimeoutMs: 5000, drainTimeoutMs: 100};
const editor = {provider: {frames: {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384},
  maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384},
  maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4},
  maxHttpResponseBytes: 16384, maxSocketBufferedBytes: 16384, connectTimeoutMs: 2000, sendTimeoutMs: 500, drainPollMs: 10};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close();});

it.each(["missing", "bad", "expired", "revoked", "outside", "absent", "view", "comment", "offline"] as const)(
  "carries the relay's %s refusal through the shared human/agent HTTP path", async mode => {
    const f = await fixture(); cleanup.push(f.close); vi.spyOn(Date, "now").mockReturnValue(1000);
    const token = "A".repeat(43), profile = "B".repeat(43), exchangeKey = "x".repeat(32);
    f.raw.exec("UPDATE sync_relay_share_grants SET principal_kind='link', principal_user_id=NULL");
    f.storage.mintLinkSession({session: {sessionId: "link-session", capabilityHash: hashLinkBearer(token, key), grantId: scope.grantId,
      generation: 4, mintedAtMs: 999, expiresAtMs: mode === "expired" ? 1000 : 61000}});
    if (mode === "revoked") f.storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 1000});
    if (mode === "view" || mode === "comment") f.raw.prepare("UPDATE sync_relay_share_grants SET access=?").run(mode);
    if (mode === "offline") vi.spyOn(f.storage, "resolveLiveObjectHostBinding").mockReturnValue({kind: "refused", reason: "host-unavailable"});
    const relay = createLinkLiveHttp({storage: f.storage, linkKey: key, hosts: new Set(["relay.test"]), publicOrigin: audience, exchangeKey, limits: transport});
    const client = createLinkLiveClient({relayUrl: "https://relay.test", publicOrigin: audience, exchangeKey, browserLimits: editor,
      limits: {maxPendingRequests: 4, maxRequestBytes: 4096, maxResponseBytes: 8192, timeoutMs: 1000},
      resolveMaterial: async () => mode === "missing" ? {ok: false, status: 404} : {
        ok: true, capabilityToken: mode === "bad" ? "z".repeat(43) : token, profileSecret: profile, setCookie: null, currentCapability: async () => token},
      fetchRelay: async request => {request.headers.set("host", "relay.test"); return relay(request);}});
    const response = await client.handle(new Request(`${audience}/api/live/link-document`, {method: "POST",
      headers: {host: new URL(audience).host, origin: audience, "content-type": "application/json", cookie: "protected=session"},
      body: JSON.stringify({discriminator: "abcdefghijkl", path: mode === "outside" ? "private/a.md" : mode === "absent" ? "docs/missing.md" : "docs/a.md"})}));
    const code = mode === "view" ? "link_view_access" : mode === "comment" ? "link_comment_access" : mode === "offline" ? "link_live_unavailable" : null;
    expect([response.status, await response.json()]).toEqual(code ? [LINK_REFUSALS[code].status, linkRefusalBody(code)] : [404, {ok: false, error: "not found"}]);
  },
);
