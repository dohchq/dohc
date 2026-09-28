import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayAutomationPress } from "@dohc/workspace-contracts/relay";
import type { CollectionAutomationPress } from "@dohc/automation-executor/collection-automations";
import {
  createRelayedPressHost,
  type HeldClaim,
  type PressHostSeam,
  type RelayedPressFailure,
  type RelayedPressHost,
} from "./relayedPresses";

// The host's side of shared-view presses against a fake relay and a fake
// host module: it runs only while the host module says so, accepts and presses
// under a hold at its host generation, and after a restart resumes only a
// press whose engine claim exists.

const WORKSPACE = "ws-1";
const HASH = "0123456789abcdef";
const press = (id: string, state: "pending" | "accepted" = "pending"): RelayAutomationPress => ({
  hostPressId: id, definitionHash: HASH, state, automationId: "collection:Invoices#paid", collectionPath: "Invoices", recordId: "rec-12", pressedBy: "user-ana", createdAtMs: 1,
});

function fakeRelay(options: { lists?: RelayAutomationPress[][]; accept?: (ids: string[]) => string[]; failSettles?: number }) {
  const lists = [...(options.lists ?? [])];
  const calls: Array<{ path: string; body: unknown }> = [];
  let failSettles = options.failSettles ?? 0;
  const waiters = new Set<() => void>();
  const changed = () => { for (const waiter of [...waiters]) waiter(); };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ path: url.pathname, body });
    changed();
    const ok = (value: Record<string, unknown>) => new Response(JSON.stringify({ ok: true, ...value }), { status: 200 });
    if (url.pathname.endsWith("/automation-presses")) {
      const next = lists.shift();
      if (next) return ok({ presses: next });
      // Nothing more: the list waits until the host stops.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (url.pathname.endsWith("/accept")) {
      const ids = body!.hostPressIds as string[];
      return ok({ accepted: options.accept ? options.accept(ids) : ids });
    }
    if (url.pathname.endsWith("/settle")) {
      if (failSettles > 0) {
        failSettles -= 1;
        return new Response("{}", { status: 503 });
      }
      return ok({ state: "settled" });
    }
    return new Response("{}", { status: 404 });
  });
  const until = (condition: () => boolean) => new Promise<void>((resolve) => {
    const check = () => { if (condition()) { waiters.delete(check); resolve(); } };
    waiters.add(check);
    check();
  });
  return { connection: { baseUrl: "https://relay.test", token: "t", fetch: fetchImpl as unknown as typeof fetch }, calls, until, changed };
}

// The host module as this loop sees it: whether this computer runs the
// workspace's automations, at which generation, and the holds a handover waits on.
function fakeHost(options: { runs?: boolean; generation?: number } = {}) {
  let runs = options.runs ?? true;
  let notify = () => undefined as void;
  let holds = 0;
  const events: string[] = [];
  const seam: PressHostSeam = {
    runsHere: async () => runs,
    stillRuns: () => runs,
    generation: () => (runs ? options.generation ?? 1 : null),
    hold: () => {
      if (!runs) return null;
      holds += 1;
      events.push("hold");
      return () => {
        holds -= 1;
        events.push("release");
        notify();
      };
    },
  };
  return {
    seam, events, held: () => holds, handOver: () => { runs = false; },
    notifying: (next: () => void) => { notify = next; },
  };
}

const hosts: RelayedPressHost[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.stop(); });

type PressInput = { automationId: string; definitionHash: string; recordId: string; pressId: string; pressedBy: string };

function hostWith(relay: ReturnType<typeof fakeRelay>, host = fakeHost(), options: {
  press?: (input: PressInput, watch: (claimId: string) => void) => Promise<CollectionAutomationPress>;
  heldClaim?: (press: RelayAutomationPress) => Promise<HeldClaim>;
} = {}) {
  const failures: RelayedPressFailure[] = [];
  const presses: PressInput[] = [];
  const loop = createRelayedPressHost({
    workspaceId: WORKSPACE,
    installId: "laptop",
    host: host.seam,
    relay: async () => relay.connection,
    heldClaim: options.heldClaim ?? (async () => null),
    press: async (input, watch) => {
      presses.push(input);
      host.events.push("press");
      const pressed = await (options.press ?? (async (_input, register) => {
        register(`claim-${input.pressId}`);
        return { busy: false, claimId: `claim-${input.pressId}`, settled: null };
      }))(input, watch);
      relay.changed();
      return { pressed, field: "Mark paid" };
    },
    notifyFailure: async (failure) => { failures.push(failure); relay.changed(); },
    onError: () => undefined,
    delay: async () => undefined,
  });
  hosts.push(loop);
  return { loop, failures, presses };
}

const accepts = (relay: ReturnType<typeof fakeRelay>) => relay.calls.filter((call) => call.path.endsWith("/accept"));
const settles = (relay: ReturnType<typeof fakeRelay>) => relay.calls.filter((call) => call.path.endsWith("/settle"));

describe("relayed press host", () => {
  it("accepts at its host generation under a hold, runs the press as the verified user's, and settles it", async () => {
    const relay = fakeRelay({ lists: [[press("p1")]] });
    const host = fakeHost({ generation: 7 });
    const { loop, presses, failures } = hostWith(relay, host);
    loop.start();
    await relay.until(() => presses.length === 1);
    expect(presses).toEqual([{ automationId: "collection:Invoices#paid", collectionPath: "Invoices", definitionHash: HASH, recordId: "rec-12", pressId: "p1", pressedBy: "user-ana" }]);
    expect(accepts(relay)[0]!.body).toEqual({ installId: "laptop", generation: 7, hostPressIds: ["p1"] });
    host.notifying(relay.changed);
    loop.runSettled({ claimId: "claim-p1", outcome: "done", error: null });
    await relay.until(() => settles(relay).length === 1);
    expect(host.events).toEqual(["hold", "press", "release"]);
    expect(settles(relay)[0]!.body).toEqual({ installId: "laptop", hostPressId: "p1", outcome: "done", error: null });
    expect(failures).toEqual([]);
  });

  it("admits nothing once a handover begins, even after the relay accepted", async () => {
    const host = fakeHost();
    // The handover begins while the accept is on its way.
    const relay = fakeRelay({ lists: [[press("p1")]], accept: (ids) => { host.handOver(); return ids; } });
    host.notifying(relay.changed);
    const { loop, presses } = hostWith(relay, host);
    loop.start();
    await relay.until(() => host.events.includes("release"));
    expect(presses).toEqual([]);
    expect(host.held()).toBe(0);
  });

  it("does nothing while another computer runs the workspace's automations", async () => {
    const relay = fakeRelay({ lists: [[press("p1")]] });
    const { loop, presses } = hostWith(relay, fakeHost({ runs: false }));
    loop.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(relay.calls).toEqual([]);
    expect(presses).toEqual([]);
  });

  it("after a restart, follows a press whose claim the engine holds without asking the relay again", async () => {
    const relay = fakeRelay({ lists: [[press("p1", "accepted")]] });
    const { loop, presses } = hostWith(relay, fakeHost(), { heldClaim: async () => ({ claimId: "claim-held", settled: null }) });
    loop.start();
    await relay.until(() => relay.calls.filter((call) => call.path.endsWith("/automation-presses")).length === 2);
    expect(presses).toEqual([]);
    expect(accepts(relay)).toEqual([]);
    loop.runSettled({ claimId: "claim-held", outcome: "done", error: null });
    await relay.until(() => settles(relay).length === 1);
  });

  it("after a restart, asks the relay again for an accepted press with no claim, and runs nothing it refuses", async () => {
    const refused = fakeRelay({ lists: [[press("p1", "accepted")]], accept: () => [] });
    const first = hostWith(refused);
    first.loop.start();
    await refused.until(() => accepts(refused).length === 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(first.presses).toEqual([]);

    const allowed = fakeRelay({ lists: [[press("p1", "accepted")]] });
    const second = hostWith(allowed);
    second.loop.start();
    await allowed.until(() => second.presses.length === 1);
    expect(accepts(allowed)).toHaveLength(1);
  });

  it("answers a press whose held claim already ended at once", async () => {
    const relay = fakeRelay({ lists: [[press("p1", "accepted")]] });
    const { loop } = hostWith(relay, fakeHost(), { heldClaim: async () => ({ claimId: "claim-p1", settled: { outcome: "ended", error: null } }) });
    loop.start();
    await relay.until(() => settles(relay).length === 1);
    expect((settles(relay)[0]!.body as { outcome: string }).outcome).toBe("ended");
  });

  it("tells the person who pressed when the run fails, is busy, or cannot start", async () => {
    const relay = fakeRelay({ lists: [[press("p1"), press("p2"), press("p3")]] });
    const { loop, failures, presses } = hostWith(relay, fakeHost(), {
      press: async (input, register) => {
        if (input.pressId === "p1") return { busy: true };
        if (input.pressId === "p2") throw new Error("Mark paid changed after it was pressed. Press it again.");
        register("claim-p3");
        return { busy: false, claimId: "claim-p3", settled: null };
      },
    });
    loop.start();
    await relay.until(() => failures.length === 2 && presses.length === 3);
    loop.runSettled({ claimId: "claim-p3", outcome: "failed", error: "Total is not a number." });
    await relay.until(() => failures.length === 3);
    expect(failures.map(({ outcome, error }) => [outcome, error])).toEqual([
      ["busy", null],
      ["failed", "Mark paid changed after it was pressed. Press it again."],
      ["failed", "Total is not a number."],
    ]);
  });

  it("sends a settle the relay did not take on the next pass", async () => {
    const relay = fakeRelay({ lists: [[press("p1")], []], failSettles: 1 });
    const { loop, presses } = hostWith(relay, fakeHost(), { press: async () => ({ busy: false, claimId: "claim-p1", settled: { outcome: "done", error: null } }) });
    loop.start();
    await relay.until(() => settles(relay).length === 2);
    expect(presses).toHaveLength(1);
  });

  it("holds only from the accept until the press returns; the run holds the host through the executor", async () => {
    const relay = fakeRelay({ lists: [[press("p1")]] });
    const host = fakeHost();
    host.notifying(relay.changed);
    const { loop, presses } = hostWith(relay, host);
    loop.start();
    await relay.until(() => presses.length === 1 && host.held() === 0);
    expect(host.events).toEqual(["hold", "press", "release"]);
    loop.runSettled({ claimId: "claim-p1", outcome: "done", error: null });
    await relay.until(() => settles(relay).length === 1);
  });

  it("follows a resumed claim with no hold of its own", async () => {
    const relay = fakeRelay({ lists: [[press("p1", "accepted")]] });
    const host = fakeHost();
    const { loop } = hostWith(relay, host, { heldClaim: async () => ({ claimId: "claim-held", settled: null }) });
    loop.start();
    await relay.until(() => relay.calls.filter((call) => call.path.endsWith("/automation-presses")).length === 2);
    expect(host.events).toEqual([]);
    loop.runSettled({ claimId: "claim-held", outcome: "done", error: null });
    await relay.until(() => settles(relay).length === 1);
  });

  it("settles a resumed press whose run a restarted executor settled before the lookup finished", async () => {
    const relay = fakeRelay({ lists: [[press("p1", "accepted")]] });
    let lookups = 0;
    let settleEarly = () => undefined as void;
    const { loop } = hostWith(relay, fakeHost(), {
      heldClaim: async () => {
        lookups += 1;
        if (lookups > 1) return { claimId: "claim-held", settled: { outcome: "done", error: null } };
        // The executor ran the claim and settled it while this lookup read it as running.
        settleEarly();
        return { claimId: "claim-held", settled: null };
      },
    });
    settleEarly = () => loop.runSettled({ claimId: "claim-held", outcome: "done", error: null });
    loop.start();
    await relay.until(() => settles(relay).length === 1);
    expect(settles(relay)[0]!.body).toEqual({ installId: "laptop", hostPressId: "p1", outcome: "done", error: null });
  });

  it("takes a resumed press again when the second lookup fails after a missed settle", async () => {
    const relay = fakeRelay({ lists: [[press("p1", "accepted")], [press("p1", "accepted")]] });
    let lookups = 0;
    let settleEarly = () => undefined as void;
    const { loop } = hostWith(relay, fakeHost(), {
      heldClaim: async () => {
        lookups += 1;
        if (lookups === 1) {
          settleEarly();
          return { claimId: "claim-held", settled: null };
        }
        if (lookups === 2) throw new Error("The workspace engine is not running.");
        return { claimId: "claim-held", settled: { outcome: "done", error: null } };
      },
    });
    settleEarly = () => loop.runSettled({ claimId: "claim-held", outcome: "done", error: null });
    loop.start();
    await relay.until(() => settles(relay).length === 1);
    expect(lookups).toBe(3);
    expect(settles(relay)[0]!.body).toEqual({ installId: "laptop", hostPressId: "p1", outcome: "done", error: null });
  });

  it("after a close, a reopened loop finds a writing run's press again through its engine claim", async () => {
    const relay = fakeRelay({ lists: [[press("p1")]] });
    const first = hostWith(relay);
    first.loop.start();
    await relay.until(() => first.presses.length === 1);
    first.loop.stop();
    // The run settles after the close; the closed loop tells no one.
    first.loop.runSettled({ claimId: "claim-p1", outcome: "done", error: null });

    const reopened = fakeRelay({ lists: [[press("p1", "accepted")]] });
    const second = hostWith(reopened, fakeHost(), { heldClaim: async () => ({ claimId: "claim-p1", settled: null }) });
    second.loop.start();
    await reopened.until(() => reopened.calls.filter((call) => call.path.endsWith("/automation-presses")).length === 2);
    second.loop.runSettled({ claimId: "claim-p1", outcome: "done", error: null });
    await reopened.until(() => settles(reopened).length === 1);
    expect(settles(relay)).toEqual([]);
    expect(second.presses).toEqual([]);
  });
});
