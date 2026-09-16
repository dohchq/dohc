import { afterEach, expect, it, vi } from "vitest";
import { registered, cleanupLiveDeliveryFixtures } from "./liveCommittedDeliveryTestSupport.js";
import { createLiveTickets } from "../../../services/sync-relay/src/liveTickets.js";
import { liveBrowserActor } from "../../../services/sync-relay/src/liveBrowserContext.js";
import { createLinkLiveBrowserResolver } from "../../../services/sync-relay/src/linkLiveBrowserAuth.js";
import { hashLinkBearer, hashLinkProfileSecret } from "../../../services/sync-relay/src/linkSecurity.js";
import { createLiveJournalHistoryAuthority } from "../../../services/sync-relay/src/storage/liveJournalHistory.js";

const audience = "https://share.example.test", key = "k".repeat(32);
const bearer = Buffer.alloc(32, 3).toString("base64url"), profile = Buffer.alloc(32, 7).toString("base64url");
const close: Array<() => void> = [];
afterEach(() => { for (const fn of close.splice(0).reverse()) fn(); vi.restoreAllMocks(); cleanupLiveDeliveryFixtures(); });

function setup(options: {linkDiscussionPrincipalLimit?: number; workspaceQuotaBytes?: number} = {}) {
  let time = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => time);
  const f = registered({ ...options, liveTickets: { retainedTicketsPerPrincipalGrant: 2, expiredTicketCleanupBatchSize: 1, now: () => time } });
  close.push(f.close);
  f.storage.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({ namespace: "link-history", reconciled: true }));
  f.raw.exec("UPDATE sync_relay_share_grants SET principal_kind='link', principal_user_id=NULL WHERE grant_id='grant'");
  const scope = { kind: "link" as const, workspaceId: "workspace", shareId: "share", grantId: "grant",
    sessionId: "link-session", capabilityHash: hashLinkBearer(bearer, key), profileTokenHash: hashLinkProfileSecret(profile, key) };
  expect(f.storage.mintLinkSession({ session: { sessionId: scope.sessionId, capabilityHash: scope.capabilityHash,
    grantId: scope.grantId, generation: 4, mintedAtMs: 999, expiresAtMs: 61_000 } })).toBe(true);
  const report = async () => {
    const current = f.storage.resolveLiveObjectHostBinding(scope, f.input.evidence.document.objectId);
    return current.kind === "current" ? { connection: current.host, binding: current.binding } : null;
  };
  const hostReports = { currentBinding: vi.fn(report) };
  const tickets = createLiveTickets({ storage: f.storage, audience, key, hostReports });
  const mint = () => tickets.mint({ objectId: f.input.evidence.document.objectId }, scope);
  const actor = liveBrowserActor(scope);
  const rowCount = (table: string) => Number(f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  const enrollment = () => ({ principals: rowCount("sync_relay_link_principals"),
    session: f.storage.findLinkSessionByCapabilityHash(scope.capabilityHash),
    usage: f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()!.usage_bytes,
    revision: f.raw.prepare("SELECT discussion_revision FROM sync_relay_shares WHERE share_id=?").get(scope.shareId)!.discussion_revision });
  return { ...f, scope, actor, tickets, mint, report, hostReports, rowCount, enrollment, setTime(value: number) { time = value; } };
}

it("enrolls a fresh authenticated editor without a comment and persists server-derived link attribution", async () => {
  const f = setup();
  const resolver = createLinkLiveBrowserResolver({ storage: f.storage, linkKey: key });
  const request = new Request(`${audience}/private`, { method: "POST", headers: {
    authorization: `Bearer ${bearer}`, "x-dohc-link-profile-secret": profile,
  }, body: JSON.stringify({ principalId: "forged", workspaceId: "other" }) });
  expect(await resolver.resolve(request, "abcdefghijkl")).toEqual(f.scope);
  expect(request.bodyUsed).toBe(false);
  const before = f.enrollment();
  expect(await f.report()).not.toBeNull();
  expect(f.enrollment()).toEqual(before);
  const minted = await f.mint();
  expect(minted).not.toBeNull();
  const ticket = await f.tickets.redeem(minted!.token, f.scope);
  expect(ticket?.authority.principalKind).toBe("link");
  expect(f.rowCount("sync_relay_share_discussion_messages")).toBe(0);
  const principal = f.storage.findLinkSessionByCapabilityHash(f.scope.capabilityHash)!.principalId;
  expect(f.storage.getLinkPrincipal(principal!)?.displayName).toBeNull();
  const result = f.storage.commitLiveUpdateJournal(f.capture(f.update(), "link-edit", f.actor));
  expect(result.result.kind).toBe("accepted");
  expect(result.admitted?.metadata.accepted.authority).toEqual({ principalKind: "link", principalId: principal, grantId: "grant", grantGeneration: 4 });
  expect(f.raw.prepare("SELECT principal_kind, principal_id, grant_id FROM sync_relay_live_update_journal").get())
    .toEqual({ principal_kind: "link", principal_id: principal, grant_id: "grant" });
  expect(JSON.stringify(result)).not.toContain(f.scope.capabilityHash);
  expect(JSON.stringify(ticket)).not.toContain(f.scope.sessionId);
});

type State = ReturnType<typeof setup>;
const mutations: Array<[string, (f: State) => void]> = [
  ["expired session", f => f.setTime(61_000)],
  ["replaced session", f => f.raw.exec("DELETE FROM sync_relay_link_sessions")],
  ["rotated grant", f => f.raw.exec("UPDATE sync_relay_share_grants SET generation=5")],
  ["revoked grant", f => f.raw.exec("UPDATE sync_relay_share_grants SET status='revoked', revoked_at_ms=1000")],
  ["downgraded grant", f => f.raw.exec("UPDATE sync_relay_share_grants SET access='comment'")],
  ["changed profile", f => f.raw.exec("UPDATE sync_relay_link_principals SET profile_token_hash='different'")],
  ["blocked principal", f => f.raw.exec("UPDATE sync_relay_link_principals SET blocked_at_ms=1000")],
  ["paused writes", f => f.raw.exec("UPDATE sync_relay_shares SET link_writes_paused_at_ms=1000")],
  ["changed selector", f => f.raw.prepare("UPDATE sync_relay_shares SET selector_json=?").run(JSON.stringify({ paths: ["elsewhere"], versionId: null }))],
  ["advanced restore fence", f => f.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1")],
  ["advanced host epoch", f => f.raw.exec("UPDATE sync_relay_session_host_control SET host_epoch=host_epoch+1")],
  ["closed lineage", f => f.raw.exec("UPDATE sync_relay_live_documents SET admission_state='closed'")],
  ["changed host", f => { f.storage.disconnectLiveHost({ ...f.input.host, updatedAtMs: 1000, guard() {} }); }],
];

it.each(mutations)("rechecks %s after validation without a journal write or receipt", async (_name, mutate) => {
  const f = setup(), minted = await f.mint();
  expect(await f.tickets.redeem(minted!.token, f.scope)).not.toBeNull();
  const input = f.capture(f.update(), "refused-link-edit", f.actor);
  const before = f.journalRows();
  mutate(f);
  const result = f.storage.commitLiveUpdateJournal(input);
  expect(result.result.kind).toBe(_name === "changed host" ? "retry" : "refused");
  expect(result.admitted).toBeNull();
  expect(f.journalRows()).toEqual(before);
});

it.each(mutations)("rechecks %s after the redemption host report without consuming the ticket", async (_name, mutate) => {
  const f = setup(), minted = await f.mint();
  const held = await f.report();
  f.hostReports.currentBinding.mockImplementationOnce(async () => { mutate(f); return held; });
  expect(await f.tickets.redeem(minted!.token, f.scope)).toBeNull();
  expect(f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual({ redeemed_at_ms: null });
  expect(f.rowCount("sync_relay_live_update_journal")).toBe(0);
});

it.each(mutations.filter(([name]) => name !== "changed profile" && name !== "blocked principal"))(
  "rechecks %s after a fresh editor's host report without enrollment", async (_name, mutate) => {
    const f = setup(), held = await f.report();
    f.hostReports.currentBinding.mockImplementationOnce(async () => { mutate(f); return held; });
    expect(await f.mint()).toBeNull();
    expect(f.rowCount("sync_relay_link_principals")).toBe(0);
    expect(f.rowCount("sync_relay_live_session_tickets")).toBe(0);
  });

it("rolls enrollment, profile binding, accounting and activity revision back if a later host comparison refuses", async () => {
  const f = setup(), before = f.enrollment(), held = await f.report();
  f.hostReports.currentBinding.mockResolvedValueOnce({ ...held!, connection: { ...held!.connection, connectionId: "stale" } });
  expect(await f.mint()).toBeNull();
  expect(f.enrollment()).toEqual(before);
  expect(f.rowCount("sync_relay_live_session_tickets")).toBe(0);
});

it("keeps ticket and profile continuity through refresh while retiring the old bearer", async () => {
  const f = setup(), minted = await f.mint();
  const old = f.storage.findLinkSessionByCapabilityHash(f.scope.capabilityHash)!;
  const next = { ...f.scope, capabilityHash: hashLinkBearer(Buffer.alloc(32, 4).toString("base64url"), key) };
  expect(f.storage.replaceLinkSession({ currentSession: old, session: { sessionId: next.sessionId, capabilityHash: next.capabilityHash,
    grantId: next.grantId, generation: 4, mintedAtMs: 1000, expiresAtMs: 70_000 }, guard() {} })).toBe(true);
  expect(f.rowCount("sync_relay_live_session_tickets")).toBe(1);
  expect(f.storage.findLinkSessionByCapabilityHash(old.capabilityHash)).toBeNull();
  expect(f.storage.findLinkSessionByCapabilityHash(next.capabilityHash)).toMatchObject({ sessionId: old.sessionId, principalId: old.principalId });
  expect(await f.tickets.redeem(minted!.token, f.scope)).toBeNull();
  const tickets = createLiveTickets({ storage: f.storage, audience, key, hostReports: { currentBinding: async (context, objectId) => {
    const current = f.storage.resolveLiveObjectHostBinding(context, objectId);
    return current.kind === "current" ? { connection: current.host, binding: current.binding } : null;
  } } });
  expect((await tickets.redeem(minted!.token, next))?.authority.principalId).toBe(old.principalId);
  expect(await tickets.redeem(minted!.token, next)).toBeNull();
  const fresh = await tickets.mint({ objectId: f.input.evidence.document.objectId }, next);
  const redeemed = await tickets.redeem(fresh!.token, next);
  expect(redeemed?.authority.principalId).toBe(old.principalId);
  expect(f.storage.commitLiveUpdateJournal(f.capture(f.update(), "refreshed-edit", liveBrowserActor(next))).result.kind).toBe("accepted");
  expect(f.rowCount("sync_relay_link_principals")).toBe(1);
});

it.each(["mint", "redeem"] as const)("rejects a credential renewed during the %s host report", async operation => {
  const f = setup(), minted = await f.mint(), held = await f.report();
  const old = f.storage.findLinkSessionByCapabilityHash(f.scope.capabilityHash)!;
  f.hostReports.currentBinding.mockImplementationOnce(async () => {
    expect(f.storage.replaceLinkSession({ currentSession: old, session: { ...old,
      capabilityHash: hashLinkBearer("renewed-during-report", key), mintedAtMs: 1000, expiresAtMs: 70_000 }, guard() {} })).toBe(true);
    return held;
  });
  expect(await (operation === "mint" ? f.mint() : f.tickets.redeem(minted!.token, f.scope))).toBeNull();
  expect(f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual({ redeemed_at_ms: null });
  expect(f.rowCount("sync_relay_live_session_tickets")).toBe(1);
});

it("rejects profile/session/grant/workspace/kind replay and consumes exactly once", async () => {
  const f = setup(), minted = await f.mint();
  for (const context of [
    { ...f.scope, profileTokenHash: hashLinkProfileSecret("another", key) }, { ...f.scope, sessionId: "other" },
    { ...f.scope, grantId: "other" }, { ...f.scope, workspaceId: "other" }, { ...f.scope, shareId: "other" },
    { kind: "named" as const, userId: "reader", workspaceId: "workspace", shareId: "share", grantId: "grant" },
  ]) expect(await f.tickets.redeem(minted!.token, context)).toBeNull();
  const results = await Promise.all([f.tickets.redeem(minted!.token, f.scope), f.tickets.redeem(minted!.token, f.scope)]);
  expect(results.filter(Boolean)).toHaveLength(1);
});


it("reads session expiry with the actual writer lock held, independently of the earlier received timestamp", async () => {
  const f = setup(), minted = await f.mint();
  expect(await f.tickets.redeem(minted!.token, f.scope)).not.toBeNull();
  const input = f.capture(f.update(), "expires-at-writer", f.actor);
  expect(input.receivedAtMs).toBeLessThan(61_000);
  f.raw.exec("PRAGMA busy_timeout=0");
  vi.spyOn(Date, "now").mockImplementation(() => {
    expect(() => f.raw.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
    return 61_000;
  });
  expect(f.storage.commitLiveUpdateJournal(input)).toEqual({ result: {kind: "refused", reason: "authority-refused"}, admitted: null });
  expect(f.rowCount("sync_relay_live_update_journal")).toBe(0);
});

it("shares the existing principal cap with discussion and does not charge a refused fresh profile", async () => {
  const f = setup({linkDiscussionPrincipalLimit: 1});
  expect(await f.mint()).not.toBeNull();
  const next = {...f.scope, sessionId: "other-session", capabilityHash: hashLinkBearer("other", key), profileTokenHash: hashLinkProfileSecret("other", key)};
  expect(f.storage.mintLinkSession({session: {sessionId: next.sessionId, capabilityHash: next.capabilityHash,
    grantId: next.grantId, generation: 4, mintedAtMs: 999, expiresAtMs: 61_000}})).toBe(true);
  const before = f.enrollment();
  expect(await f.tickets.mint({objectId: f.input.evidence.document.objectId}, next)).toBeNull();
  expect(f.enrollment()).toEqual(before);
  expect(f.storage.findLinkSessionByCapabilityHash(next.capabilityHash)?.principalId).toBeNull();
});

it("checks principal workspace quota before enrollment and keeps all its state on refusal", async () => {
  const f = setup({workspaceQuotaBytes: 1_000_000});
  f.raw.exec("UPDATE sync_relay_workspace_usage SET usage_bytes=999999 WHERE workspace_id='workspace'");
  const before = f.enrollment();
  await expect(f.mint()).rejects.toThrow("Live-ticket operation failed");
  expect(f.enrollment()).toEqual(before);
  expect(f.rowCount("sync_relay_live_session_tickets")).toBe(0);
});

it("requires the retained session coordinate only for link tickets and refuses damaged persisted bindings", async () => {
  const f = setup();
  expect(await f.mint()).not.toBeNull();
  expect(() => f.raw.exec("UPDATE sync_relay_live_session_tickets SET link_session_id=NULL")).toThrow(/CHECK/);
  expect(() => f.raw.exec("UPDATE sync_relay_live_session_tickets SET principal_kind='named'")).toThrow(/CHECK/);
  const minted = await f.mint();
  f.raw.exec("PRAGMA ignore_check_constraints=ON; UPDATE sync_relay_live_session_tickets SET link_session_id=NULL");
  await expect(f.tickets.redeem(minted!.token, f.scope)).rejects.toThrow("Live-ticket operation failed");
});
