import { describe, expect, it, vi } from "vitest";
import { parseRedeemedLiveTicket } from "@dohc/live-session-contract/live-ticket";
import { decodeLiveFrame, encodeLiveFrame } from "@dohc/live-session-contract/live-frame";
import { createLiveMembershipRegistry } from "./liveMembership";

function ticket(id: string, grantId = "grant-a", objectId = "object-a") {
  return parseRedeemedLiveTicket({ ticketId: id, audience: "https://share.test", authority: {
    principalKind: "named", principalId: "private-account-id", grantId, grantGeneration: 1,
  }, binding: { workspaceId: "workspace", mainVersionId: "main", objectId, lineageClaimId: "ab".repeat(32),
    currentPath: "docs/a.md", selectorPaths: ["docs"], restoreFenceGeneration: 1 },
  hostEpoch: 1, mintedAtMs: 0, expiresAtMs: 30_000, redeemedAtMs: 1 });
}
const policy = { maxSessions: 8, maxMembers: 8, maxSnapshotBytes: 153 };
const join = (registry: ReturnType<typeof createLiveMembershipRegistry>, id: string, grantId?: string, objectId?: string) =>
  registry.join({ ticket: ticket(id, grantId, objectId), invalidated: new AbortController().signal, assertCurrent() {} });

describe("live membership", () => {
  it("joins different grants to the same document without exposing credentials or identities", () => {
    const registry = createLiveMembershipRegistry(policy), first = join(registry, "private-ticket-one");
    const linkTicket = ticket("private-ticket-two", "grant-b");
    const second = registry.join({ ticket: { ...linkTicket, authority: { ...linkTicket.authority, principalKind: "link" } },
      invalidated: new AbortController().signal, assertCurrent() {} });
    const other = join(registry, "private-ticket-three", "grant-c", "object-b");
    const snapshot = first.snapshot(586), encoded = encodeLiveFrame(snapshot, 586);
    expect(snapshot.members).toHaveLength(2);
    expect(second.snapshot(586)).toEqual(snapshot);
    expect(other.snapshot(586).members).toHaveLength(1);
    expect(other.snapshot(586).members.every(id => !snapshot.members.includes(id))).toBe(true);
    expect(decodeLiveFrame(encoded, 586)).toEqual(snapshot);
    expect(Object.keys(snapshot).sort()).toEqual(["kind", "members", "overflow", "revision"]);
    expect(snapshot.members.every(id => /^[0-9a-f]{32}$/.test(id))).toBe(true);
    for (const value of ["private-account-id", "private-ticket-one", "grant-a", "workspace", "docs/a.md"]) expect(Buffer.from(encoded).includes(Buffer.from(value))).toBe(false);
    first.close(); second.close(); other.close();
  });
  it("gives each redeemed ticket and reconnect a fresh server pseudonym", () => {
    const registry = createLiveMembershipRegistry(policy), first = join(registry, "one"), second = join(registry, "two");
    const initial = first.snapshot(586).members;
    expect(new Set(initial).size).toBe(2);
    first.close(); second.close();
    const reconnected = join(registry, "three");
    expect(initial).not.toContain(reconnected.snapshot(586).members[0]);
    reconnected.close();
  });
  it("keeps host epochs and restore generations in separate membership groups", () => {
    const registry = createLiveMembershipRegistry(policy), current = join(registry, "current");
    const restored = ticket("restored"), nextHost = ticket("next-host");
    const generations = [registry.join({ ticket: { ...restored, binding: { ...restored.binding, restoreFenceGeneration: 2 } },
      invalidated: new AbortController().signal, assertCurrent() {} }),
    registry.join({ ticket: { ...nextHost, hostEpoch: 2 as typeof nextHost.hostEpoch }, invalidated: new AbortController().signal, assertCurrent() {} })];
    expect(current.snapshot(586).members).toHaveLength(1);
    expect(generations.every(member => member.snapshot(586).members.length === 1)).toBe(true);
    current.close(); generations.forEach(member => member.close());
  });
  it("enforces both member and encoded-byte bounds with explicit overflow", () => {
    const registry = createLiveMembershipRegistry({ ...policy, maxMembers: 2, maxSnapshotBytes: 57 });
    const sessions = [join(registry, "one"), join(registry, "two"), join(registry, "three")];
    expect(sessions[0].snapshot(586)).toMatchObject({ overflow: true, members: expect.any(Array) });
    expect(encodeLiveFrame(sessions[0].snapshot(586), 586)).toHaveLength(57);
    expect(sessions[0].snapshot(41).members).toHaveLength(1);
    expect(sessions[0].snapshot(25)).toMatchObject({ members: [], overflow: true });
    sessions[2].close();
    expect(sessions[0].snapshot(586)).toMatchObject({ overflow: false });
    sessions.forEach(session => session.close());
  });
  it("prunes idle peers against current authority and invalidates the removed session", () => {
    const registry = createLiveMembershipRegistry(policy), observer = join(registry, "observer");
    let authorized = true;
    const peer = registry.join({ ticket: ticket("peer", "grant-b"), invalidated: new AbortController().signal,
      assertCurrent() { if (!authorized) throw new Error("expired or blocked"); } });
    expect(observer.snapshot(586).members).toHaveLength(2);
    authorized = false;
    expect(observer.snapshot(586).members).toHaveLength(1);
    expect(peer.invalidated.aborted).toBe(true);
    expect(() => peer.snapshot(586)).toThrow();
    observer.close();
  });
  it("rechecks the recipient after waiting and removes aborted memberships", () => {
    const registry = createLiveMembershipRegistry(policy), abort = new AbortController();
    let authorized = true;
    const recipient = registry.join({ ticket: ticket("recipient"), invalidated: abort.signal,
      assertCurrent() { if (!authorized) throw new Error("recipient revoked"); } });
    const changed = vi.fn(); recipient.subscribe(changed);
    const peer = join(registry, "peer");
    expect(changed).toHaveBeenCalledTimes(1);
    authorized = false;
    expect(() => recipient.snapshot(586)).toThrow("recipient revoked");
    expect(peer.snapshot(586).members).toHaveLength(1);
    peer.close();
    const next = registry.join({ ticket: ticket("next"), invalidated: abort.signal, assertCurrent() {} });
    abort.abort();
    expect(next.invalidated.aborted).toBe(true);
  });
  it("refuses duplicate and over-capacity joins without leaking membership", () => {
    const registry = createLiveMembershipRegistry({ ...policy, maxSessions: 1 }), session = join(registry, "one");
    expect(() => join(registry, "one")).toThrow();
    expect(() => join(registry, "two")).toThrow();
    expect(session.snapshot(586).members).toHaveLength(1);
    session.close();
    const replacement = join(registry, "two");
    expect(replacement.snapshot(586).members).toHaveLength(1);
    replacement.close();
    expect(() => registry.join({ ticket: ticket("bad"), invalidated: AbortSignal.abort(), assertCurrent() {} })).toThrow();
    join(registry, "three").close();
  });
});
