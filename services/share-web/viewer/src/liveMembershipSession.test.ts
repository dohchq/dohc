import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { parseRedeemedLiveTicket } from "@dohc/live-session-contract/live-ticket";
import { decodeLiveFrame, type LiveFrame, type LiveMembershipFrame } from "@dohc/live-session-contract/live-frame";
import { createNamedLiveProvider } from "./namedLiveProvider";
import { createNamedLiveFrameSession, type NamedFrameHostSession } from "../../../sync-relay/src/namedLiveFrameSession";
import { createLiveMembershipRegistry } from "../../../sync-relay/src/liveMembership";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const frames = { receive: { maxFrameBytes: 586, maxStateVectorBytes: 2048, maxUpdateBytes: 4096, maxSyncBytes: 8192 },
  maxQueuedBytes: 8192, maxQueuedFrames: 32, maxControlBytes: 586, maxControlFrames: 1, maxAssemblyBytes: 8192 };
function ticket(id: string) {
  return parseRedeemedLiveTicket({ ticketId: id, audience: "https://share.test", authority: {
    principalKind: "named", principalId: "private-person", grantId: "private-grant", grantGeneration: 1,
  }, binding: { workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "ab".repeat(32),
    currentPath: "doc.md", selectorPaths: ["doc.md"], restoreFenceGeneration: 1 },
  hostEpoch: 1, mintedAtMs: 0, expiresAtMs: 30000, redeemedAtMs: 1 });
}
function harness() {
  const registry = createLiveMembershipRegistry({ maxSessions: 8, maxMembers: 8, maxSnapshotBytes: 153 }, read => read());
  const invalidated = new AbortController(), doc = new Y.Doc();
  let authorized = true;
  const host: NamedFrameHostSession = {
    ticket: ticket("recipient"), invalidated: invalidated.signal,
    assertCurrent() { if (!authorized) throw new Error("recipient revoked"); invalidated.signal.throwIfAborted(); },
    async openSync() { return { binding: host.ticket.binding, hostVector: Y.encodeStateVector(doc), missingStateUpdate: Y.encodeStateAsUpdate(doc), appliedThroughJournalCursor: 0,
      nextApplied(signal) { return new Promise((_, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); }, close() {} }; },
    async submit() { return { result: "retry", reason: "admission-unavailable" }; },
    close() { invalidated.abort(); },
  };
  const membership = registry.join({ ticket: host.ticket, invalidated: host.invalidated, assertCurrent: () => host.assertCurrent() });
  const provider = createNamedLiveProvider({ frames, maxPendingUpdateBytes: 8192, maxPendingUpdates: 8, maxDeliveryAttempts: 2 });
  const observed: LiveFrame[] = [], watchers = new Set<() => void>(), queued: Uint8Array[] = [];
  let session: ReturnType<typeof createNamedLiveFrameSession> | undefined, stall = true, release: (() => void) | undefined;
  const changed = () => { for (const notify of [...watchers]) notify(); };
  const route = provider.connect({ async send(bytes) { if (session) session.receive(bytes); else queued.push(bytes.slice()); }, close() { session?.close(); changed(); } });
  session = createNamedLiveFrameSession({ host, frames, membership, transport: {
    async send(bytes) {
      const frame = decodeLiveFrame(bytes, frames.receive.maxFrameBytes); observed.push(frame); changed();
      await route.receive(bytes);
      if (stall && frame.kind === "membership") await new Promise<void>(resolve => { release = resolve; changed(); });
    }, close() { release?.(); release = undefined; route.disconnect(); changed(); },
  } });
  for (const bytes of queued) session.receive(bytes);
  const until = (check: () => boolean) => check() ? Promise.resolve() : new Promise<void>(resolve => {
    const notify = () => { if (check()) { watchers.delete(notify); resolve(); } }; watchers.add(notify);
  });
  const join = (id: string) => {
    const peer = registry.join({ ticket: ticket(id), invalidated: new AbortController().signal, assertCurrent() {} });
    cleanup.push(() => peer.close()); return peer;
  };
  cleanup.push(() => { session!.close(); provider.close(); provider.doc.destroy(); doc.destroy(); });
  return { session, membership, provider, observed, until, join, invalidated,
    isStalled: () => release !== undefined,
    release() { stall = false; release?.(); release = undefined; },
    revoke() { authorized = false; },
    snapshots: () => observed.filter((frame): frame is LiveMembershipFrame => frame.kind === "membership"),
  };
}

describe("membership on the real frame session and browser provider", () => {
  it("sends membership only after sync and coalesces changes behind one held control lease", async () => {
    const h = harness(); await h.until(h.isStalled);
    expect(h.provider.state().status).toBe("live");
    const first = h.join("first");
    expect(h.session.usage().outgoing).toMatchObject({ controlFrames: 1, controlBytes: 41 });
    const second = h.join("second"); first.close(); const third = h.join("third"); second.close();
    expect(h.snapshots()).toHaveLength(1);
    expect(h.session.usage().membershipDirty).toBe(true);
    h.release(); await h.until(() => h.snapshots().length === 2);
    expect(h.snapshots()[1].members).toHaveLength(2);
    expect(h.snapshots()[1]).toEqual(h.membership.snapshot(586));
    expect(h.snapshots().map(frame => frame.revision)).toEqual([1, 6]);
    third.close(); h.session.close(); await h.session.settled();
    expect(h.session.usage().outgoing.controlBytes).toBe(0);
  });
  it("reauthorizes a pending latest snapshot before response and closes its host", async () => {
    const h = harness(); await h.until(h.isStalled);
    h.join("first");
    h.join("second"); h.revoke(); h.release();
    await h.session.settled();
    expect(h.invalidated.signal.aborted).toBe(true);
    expect(h.snapshots()).toHaveLength(1);
    expect(h.provider.state().membership).toBeNull();
    expect(h.session.usage().outgoing).toMatchObject({ controlFrames: 0, controlBytes: 0 });
  });
  it("closes a stalled session and retires membership on source invalidation", async () => {
    const h = harness(); await h.until(h.isStalled);
    const peer = h.join("peer");
    h.invalidated.abort(); await h.session.settled();
    expect(h.provider.state().membership).toBeNull();
    expect(peer.snapshot(586).members).toHaveLength(1);
    expect(h.session.usage().outgoing).toMatchObject({ controlFrames: 0, controlBytes: 0 });
  });
});
