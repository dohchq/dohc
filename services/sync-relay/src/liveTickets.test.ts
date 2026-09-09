import { expect, it, vi } from "vitest";
import { createLiveTickets } from "./liveTickets.js";
import { audience, binding, fixture, key, report, scope } from "./liveTickets.test-helper.js";
import { hashLiveTicketToken } from "./liveTicketSecurity.js";
import { openSyncRelayStorage } from "./storage.js";

it("mints one server-derived live ticket and redeems it exactly once", async () => {
  const state = await fixture();
  try {
    const entropy = vi.fn(() => new Uint8Array(32).fill(1));
    const service = createLiveTickets({ storage: state.storage, audience, key, entropy,
      newTicketId: () => "ticket-1", hostReports: { currentBinding: async () => report } });
    const minted = await service.mint({ objectId: binding.objectId }, scope);
    expect(minted).toEqual({ token: "01".repeat(32), expiresAtMs: 31000 });
    expect(entropy).toHaveBeenCalledExactlyOnceWith(32);
    expect(await service.redeem(minted!.token, scope)).toMatchObject({ ticketId: "ticket-1", binding,
      authority: { principalKind: "named", principalId: scope.userId, grantId: scope.grantId, grantGeneration: 4 }, redeemedAtMs: 1000 });
    expect(await service.redeem(minted!.token, scope)).toBeNull();
  } finally { await state.close(); }
});

it("captures browser scope and request before awaiting the host report", async () => {
  const state = await fixture();
  try {
    let resolveReport!: (value: typeof report) => void;
    const pending = new Promise<typeof report>(resolve => { resolveReport = resolve; });
    const service = createLiveTickets({ storage: state.storage, audience, key,
      hostReports: { currentBinding: async candidate => { (candidate as { userId: string }).userId = "host-mutated"; return pending; } } });
    const context = { ...scope };
    const input = { objectId: binding.objectId };
    const minted = service.mint(input, context);
    context.userId = "mutated";
    input.objectId = "mutated";
    resolveReport(structuredClone(report));
    expect(await minted).not.toBeNull();
  } finally { await state.close(); }
});

it("rejects extra browser authority and hostile descriptors without reading them", async () => {
  const state = await fixture();
  try {
    const callback = vi.fn(async () => report);
    const getter = vi.fn(() => binding.objectId);
    const service = createLiveTickets({ storage: state.storage, audience, key, hostReports: { currentBinding: callback } });
    for (const value of [
      { objectId: binding.objectId, userId: scope.userId }, Object.create({ objectId: binding.objectId }),
      Object.defineProperty({}, "objectId", { get: getter }),
      new Proxy({ objectId: binding.objectId }, { ownKeys() { getter(); return ["objectId"]; } }),
    ]) expect(await service.mint(value, scope)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  } finally { await state.close(); }
});

it("leaves the canonical credential redeemable after every malformed spelling", async () => {
  const state = await fixture();
  try {
    const callback = vi.fn(async () => report);
    const service = createLiveTickets({ storage: state.storage, audience, key, entropy: () => new Uint8Array(32).fill(171),
      hostReports: { currentBinding: callback } });
    const minted = await service.mint({ objectId: binding.objectId }, scope);
    for (const token of [minted!.token.toUpperCase(), ` ${minted!.token}`, `${minted!.token} `, `0x${minted!.token}`,
      minted!.token.slice(1), `${minted!.token}0`, "g".repeat(64), null, {}, "00".repeat(32)]) {
      expect(await service.redeem(token, scope)).toBeNull();
    }
    expect(callback).toHaveBeenCalledTimes(1);
    expect(await service.redeem(minted!.token, scope)).not.toBeNull();
  } finally { await state.close(); }
});

it("copies the configured key and draws entropy once on a collision", async () => {
  const state = await fixture();
  try {
    const mutableKey = new Uint8Array(key);
    const entropyBytes = new Uint8Array(32).fill(1);
    const entropy = vi.fn(() => entropyBytes);
    let id = 0;
    const service = createLiveTickets({ storage: state.storage, audience, key: mutableKey, entropy,
      newTicketId: () => `id-${++id}`, hostReports: { currentBinding: async () => report } });
    mutableKey.fill(0);
    const minted = await service.mint({ objectId: binding.objectId }, scope);
    expect(state.raw.prepare("SELECT token_hash FROM sync_relay_live_session_tickets").get()).toEqual({ token_hash: hashLiveTicketToken("01".repeat(32), key) });
    expect(await service.mint({ objectId: binding.objectId }, scope)).toBeNull();
    expect(entropy).toHaveBeenCalledTimes(2);
    entropyBytes.fill(9);
    expect(minted!.token).toBe("01".repeat(32));
    expect(await service.redeem(minted!.token, scope)).not.toBeNull();
  } finally { await state.close(); }
});

it("rechecks authority after an asynchronous redemption report", async () => {
  const state = await fixture();
  try {
    let reportCount = 0;
    const service = createLiveTickets({ storage: state.storage, audience, key, hostReports: { currentBinding: async () => {
      if (++reportCount === 2) state.raw.exec("UPDATE sync_relay_share_grants SET generation=5");
      return report;
    } } });
    const minted = await service.mint({ objectId: binding.objectId }, scope);
    expect(await service.redeem(minted!.token, scope)).toBeNull();
    expect(state.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual({ redeemed_at_ms: null });
  } finally { await state.close(); }
});

it("keeps storage failures internal and strips credential-bearing errors", async () => {
  const state = await fixture();
  try {
    const token = "01".repeat(32);
    const hash = hashLiveTicketToken(token, key);
    const failure = new Error(`private ${token} ${hash}`);
    const service = createLiveTickets({ storage: {
      mintLiveTicket: () => { throw failure; }, readLiveTicketTarget: () => { throw failure; },
      redeemLiveTicket: () => { throw failure; },
    }, audience, key, entropy: () => new Uint8Array(32).fill(1), hostReports: { currentBinding: async () => report } });
    for (const operation of [() => service.mint({ objectId: binding.objectId }, scope), () => service.redeem(token, scope)]) {
      const error = await operation().catch(value => value as Error);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected an internal failure");
      expect(String(error)).toBe("Error: Live-ticket operation failed.");
      expect(error.stack).not.toContain(token);
      expect(error.stack).not.toContain(hash);
      const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(hash);
      expect(error.cause).toBeUndefined();
    }
  } finally { await state.close(); }
});

it("owns returned selectors and rejects hostile report fields without invocation", async () => {
  const state = await fixture();
  try {
    const getter = vi.fn(() => "docs");
    const paths = ["docs"];
    Object.defineProperty(paths, "0", { get: getter });
    let candidate = { ...report, binding: { ...binding, selectorPaths: paths } };
    const service = createLiveTickets({ storage: state.storage, audience, key, hostReports: { currentBinding: async () => candidate } });
    expect(await service.mint({ objectId: binding.objectId }, scope)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    candidate = { ...report, connection: Object.defineProperty({ ...report.connection }, "connectionId", { get: getter }) };
    expect(await service.mint({ objectId: binding.objectId }, scope)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    candidate = structuredClone(report);
    const minted = await service.mint({ objectId: binding.objectId }, scope);
    const redeemed = await service.redeem(minted!.token, scope);
    (redeemed!.binding.selectorPaths as string[]).push("outside");
    expect(state.raw.prepare("SELECT selector_paths_json FROM sync_relay_live_session_tickets").get()).toEqual({ selector_paths_json: '["docs"]' });
  } finally { await state.close(); }
});

it("gives simultaneous redemptions through two real database handles one winner", async () => {
  const state = await fixture();
  const second = openSyncRelayStorage(state.path, state.config);
  try {
    let release!: () => void;
    const bothArrived = new Promise<void>(resolve => { release = resolve; });
    let arrivals = 0;
    const first = createLiveTickets({ storage: state.storage, audience, key, hostReports: { currentBinding: async () => report } });
    const minted = await first.mint({ objectId: binding.objectId }, scope);
    const hostReports = { currentBinding: async () => {
      if (++arrivals === 2) release();
      await bothArrived;
      return report;
    } };
    const competitors = [state.storage, second].map(storage => createLiveTickets({ storage, audience, key, hostReports }));
    const results = await Promise.all(competitors.map(service => service.redeem(minted!.token, scope)));
    expect(arrivals).toBe(2);
    expect(results.filter(result => result !== null)).toHaveLength(1);
    expect(results.filter(result => result === null)).toHaveLength(1);
  } finally { second.close(); await state.close(); }
});
