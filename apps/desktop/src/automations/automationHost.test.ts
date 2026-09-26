import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RelayAutomationHost } from "@dohc/workspace-contracts/relay";
import { recordNeverSynced, recordSynced } from "../workspaces/syncHistory";
import { createTestScratch } from "../workspaces/testTemp";
import {
  computerLabel,
  createAutomationHosts,
  HANDOVER_READ_FIRST_MS,
  HANDOVER_READ_MAX_MS,
  HOST_FRESH_MS,
  hostOfAnswer,
  isAutomationHost,
  relayUnreachable,
  type HostAnswer,
  type HostRequest,
} from "./automationHost";

const ME = "install-me";
const OTHER = "install-other";

const host = (installId: string, generation: number, handoverFrom: string | null, releasedThroughMs: number | null): RelayAutomationHost =>
  ({ installId, generation, handoverFrom, releasedThroughMs });

const answer = (row: RelayAutomationHost | null): HostAnswer => ({ status: 200, body: { ok: true, host: row, computers: [] } });

// A relay that records one host and answers as the routes do, and a record
// of everything the module asked and told.
function world(options: { stored?: unknown; synced?: boolean } = {}) {
  let clock = 0;
  let relay: RelayAutomationHost | null = null;
  let reachable = true;
  let signedIn = true;
  let finish: number | null = 5_000;
  let finishes = 0;
  // Runs while this computer finishes, with the handover's own check.
  let whileFinishing: ((stillHandingOver: () => boolean) => void) | null = null;
  const requests: HostRequest[] = [];
  const started: Array<number | null> = [];
  const stored: Array<RelayAutomationHost | null> = [];
  let hostChanges = 0;
  const errors: unknown[] = [];
  // The timer that reads again while a handover waits, driven by the test.
  const timers: Array<{ wake: () => void; delayMs: number; done: boolean }> = [];
  let releaseAnswer: ((request: HostRequest) => HostAnswer) | null = null;
  const hosts = createAutomationHosts({
    installId: () => ME,
    label: () => "Ice's laptop",
    synced: () => options.synced ?? true,
    send: async (_workspaceId, request) => {
      if (!signedIn) return null;
      if (!reachable) throw new Error("offline");
      requests.push(request);
      if (request.action === "check-in") {
        if (request.body.claim && relay === null) relay = host(ME, 1, null, null);
        return answer(relay);
      }
      if (releaseAnswer) return releaseAnswer(request);
      if (!relay || relay.handoverFrom !== request.body.installId || relay.generation !== request.body.generation) {
        return { status: 409, body: { ok: false, code: "conflict" } };
      }
      relay = host(relay.installId, relay.generation + 1, null, Math.max(relay.releasedThroughMs ?? 0, request.body.releasedThroughMs));
      return answer(relay);
    },
    stored: () => options.stored,
    store: (_workspaceId, row) => { stored.push(row); },
    startedHere: (_workspaceId, startAfterMs) => { started.push(startAfterMs); },
    hostChanged: () => { hostChanges += 1; },
    finishHere: async (_workspaceId, stillHandingOver) => {
      finishes += 1;
      whileFinishing?.(stillHandingOver);
      return finish;
    },
    logError: (_workspaceId, error) => { errors.push(error); },
    monotonicMs: () => clock,
    setTimer: (wake, delayMs) => {
      const timer = { wake, delayMs, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (cleared) => { for (const timer of timers) if (timer === cleared) timer.done = true; },
  });
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const armed = () => timers.filter((timer) => !timer.done).map((timer) => timer.delayMs);
  return {
    hosts, requests, started, stored, errors, settle,
    hostChanges: () => hostChanges,
    armed,
    /** Fires the one armed timer and lets its read land. */
    fire: async () => {
      const pending = timers.filter((timer) => !timer.done);
      expect(pending).toHaveLength(1);
      pending[0]!.done = true;
      pending[0]!.wake();
      await settle();
    },
    advance: (ms: number) => { clock += ms; },
    setRelay: (row: RelayAutomationHost | null) => { relay = row; },
    relay: () => relay,
    setReachable: (value: boolean) => { reachable = value; },
    setSignedIn: (value: boolean) => { signedIn = value; },
    setFinish: (value: number | null) => { finish = value; },
    whileFinishing: (run: (stillHandingOver: () => boolean) => void) => { whileFinishing = run; },
    finishes: () => finishes,
    setReleaseAnswer: (respond: ((request: HostRequest) => HostAnswer) | null) => { releaseAnswer = respond; },
  };
}

describe("automation hosts", () => {
  it("reads at open without claiming, then claims when it has schedules and no host is recorded", async () => {
    const w = world();
    w.hosts.open("ws");
    await w.settle();
    expect(w.requests).toEqual([{ action: "check-in", body: { installId: ME, label: "Ice's laptop", claim: false } }]);
    expect(await w.hosts.runsHere("ws")).toBe(true);
    expect(w.requests[1]).toEqual({ action: "check-in", body: { installId: ME, label: "Ice's laptop", claim: true } });
    expect(w.started, "a first host starts at now").toEqual([null]);
    expect(w.stored.at(-1)).toEqual(host(ME, 1, null, null));
  });

  it("reads again only when its copy is a minute old", async () => {
    const w = world();
    w.setRelay(host(ME, 3, null, null));
    w.hosts.open("ws");
    expect(await w.hosts.runsHere("ws")).toBe(true);
    expect(w.requests).toHaveLength(1);
    w.advance(HOST_FRESH_MS);
    await w.hosts.runsHere("ws");
    expect(w.requests).toHaveLength(1);
    w.advance(1);
    w.setRelay(host(OTHER, 4, null, null));
    expect(await w.hosts.runsHere("ws"), "the owner chose another computer").toBe(false);
    expect(w.requests).toHaveLength(2);
  });

  it("keeps its copy offline and signed out, and reads again when the relay answers", async () => {
    const w = world({ stored: host(ME, 2, null, null) });
    w.setReachable(false);
    w.hosts.open("ws");
    await w.settle();
    expect(await w.hosts.runsHere("ws"), "offline, the kept copy stands").toBe(true);
    expect(w.errors).toHaveLength(2);

    w.setReachable(true);
    w.setSignedIn(false);
    w.advance(HOST_FRESH_MS + 1);
    expect(await w.hosts.runsHere("ws")).toBe(true);
    expect(w.errors, "signed out is not an error").toHaveLength(2);

    w.setSignedIn(true);
    w.setRelay(host(OTHER, 3, null, null));
    w.hosts.relayAnswered("ws");
    await w.settle();
    expect(await w.hosts.runsHere("ws")).toBe(false);
    expect(w.stored.at(-1)).toEqual(host(OTHER, 3, null, null));
  });

  it("hands over: steps one last time, releases through it, and stops", async () => {
    const w = world({ stored: host(ME, 2, null, null) });
    w.setRelay(host(OTHER, 3, ME, null));
    w.hosts.open("ws");
    await w.settle();
    expect(w.requests[1]).toEqual({ action: "release", body: { installId: ME, generation: 3, releasedThroughMs: 5_000 } });
    expect(w.relay()).toEqual(host(OTHER, 4, null, 5_000));
    expect(await w.hosts.runsHere("ws")).toBe(false);
  });

  it("admits host work only while host, and hands over once admitted work ends", async () => {
    const w = world({ stored: host(ME, 2, null, null) });
    w.setRelay(host(ME, 2, null, null));
    w.hosts.open("ws");
    await w.settle();
    const release = w.hosts.hold("ws");
    expect(release).not.toBeNull();

    // The owner moves the schedules while a relayed press still runs here.
    w.setRelay(host(OTHER, 3, ME, null));
    w.advance(HOST_FRESH_MS + 1);
    expect(await w.hosts.runsHere("ws")).toBe(false);
    expect(w.hosts.stillRuns("ws")).toBe(false);
    expect(w.hosts.hold("ws"), "no new work once the handover began").toBeNull();
    await w.settle();
    expect(w.requests.map((request) => request.action), "the release waits for the press").not.toContain("release");

    release!();
    await w.settle();
    expect(w.requests.map((request) => request.action)).toContain("release");
    expect(w.relay()).toEqual(host(OTHER, 4, null, 5_000));
  });

  it("stops waiting on held work when the workspace closes, and steps nothing", async () => {
    const w = world({ stored: host(ME, 2, null, null) });
    w.setRelay(host(ME, 2, null, null));
    w.hosts.open("ws");
    await w.settle();
    const release = w.hosts.hold("ws");
    w.setRelay(host(OTHER, 3, ME, null));
    w.advance(HOST_FRESH_MS + 1);
    await w.hosts.runsHere("ws");
    w.hosts.close("ws");
    await w.settle();
    expect(w.finishes(), "no final step for a closed workspace").toBe(0);
    release!();
    await w.settle();
    expect(w.finishes()).toBe(0);
    expect(w.requests.map((request) => request.action)).not.toContain("release");
  });

  it("admits nothing while a handover waits, and drops it when the owner chose this computer back", async () => {
    const w = world({ stored: host(ME, 2, null, null) });
    w.setRelay(host(ME, 2, null, null));
    w.hosts.open("ws");
    await w.settle();
    expect(w.hostChanges(), "the same host as the kept copy").toBe(0);
    const release = w.hosts.hold("ws");
    w.setRelay(host(OTHER, 3, ME, null));
    w.advance(HOST_FRESH_MS + 1);
    await w.hosts.runsHere("ws");
    expect(w.hostChanges(), "the handover began").toBe(1);

    // Chosen back while the held press still runs.
    w.setRelay(host(ME, 4, null, null));
    w.advance(HOST_FRESH_MS + 1);
    expect(await w.hosts.runsHere("ws"), "the host is this computer again").toBe(true);
    expect(w.hosts.stillRuns("ws"), "but the handover still waits").toBe(false);
    expect(w.hosts.hold("ws")).toBeNull();

    release!();
    await w.settle();
    expect(w.finishes(), "the superseded handover steps nothing").toBe(0);
    expect(w.requests.map((request) => request.action)).not.toContain("release");
    expect(w.hostChanges(), "chosen back, then the handover ended").toBe(3);
    expect(w.hosts.stillRuns("ws")).toBe(true);
    expect(w.hosts.hold("ws")).not.toBeNull();
  });

  it("releases nothing when the owner calls the handover off while this computer finishes", async () => {
    const w = world({ stored: host(ME, 2, null, null) });
    w.setRelay(host(OTHER, 3, ME, null));
    const seen: boolean[] = [];
    w.whileFinishing((stillHandingOver) => {
      seen.push(stillHandingOver());
      // Settings chose this computer back.
      w.hosts.learned("ws", host(ME, 4, null, null));
      seen.push(stillHandingOver());
    });
    w.hosts.open("ws");
    await w.settle();
    expect(seen).toEqual([true, false]);
    expect(w.requests.map((request) => request.action)).toEqual(["check-in"]);
    expect(w.hosts.stillRuns("ws")).toBe(true);
  });

  it("reads again after a sync pull once its copy is a minute old, so a computer with no schedules learns it was chosen", async () => {
    const w = world();
    w.setRelay(host(OTHER, 2, null, null));
    w.hosts.open("ws");
    await w.settle();
    const reads = w.requests.length;
    w.hosts.relayAnswered("ws");
    await w.settle();
    expect(w.requests.length, "a fresh copy stands").toBe(reads);

    // Settings on the other computer chose this one, and the other released.
    w.setRelay(host(ME, 4, null, 8_000));
    w.advance(HOST_FRESH_MS + 1);
    w.hosts.relayAnswered("ws");
    await w.settle();
    expect(w.requests.length).toBe(reads + 1);
    expect(w.started).toEqual([8_000]);
    expect(w.hosts.stillRuns("ws")).toBe(true);
  });

  it("tries the handover again when the last step did not finish", async () => {
    const w = world({ stored: host(ME, 2, null, null) });
    w.setRelay(host(OTHER, 3, ME, null));
    w.setFinish(null);
    w.hosts.open("ws");
    await w.settle();
    expect(w.requests.map((request) => request.action)).toEqual(["check-in"]);
    w.setFinish(6_000);
    w.hosts.relayAnswered("ws");
    await w.settle();
    expect(w.requests.map((request) => request.action)).toEqual(["check-in", "check-in", "release"]);
    expect(w.relay()).toEqual(host(OTHER, 4, null, 6_000));
  });

  it("reads again when the owner changed the host before the release landed", async () => {
    const w = world({ stored: host(ME, 2, null, null) });
    w.setRelay(host(OTHER, 3, ME, null));
    w.setReleaseAnswer(() => {
      // The owner chose this computer back first.
      w.setRelay(host(ME, 4, null, null));
      return { status: 409, body: { ok: false, code: "conflict" } };
    });
    w.hosts.open("ws");
    await w.settle();
    await w.settle();
    expect(w.requests.map((request) => request.action)).toEqual(["check-in", "release", "check-in"]);
    expect(await w.hosts.runsHere("ws")).toBe(true);
  });

  it("starts after the release it waited for, and at now after a take-over", async () => {
    const w = world({ stored: host(ME, 3, OTHER, 1_000) });
    w.setRelay(host(ME, 4, null, 7_000));
    w.hosts.open("ws");
    await w.settle();
    expect(w.started).toEqual([7_000]);

    const taken = world({ stored: host(ME, 3, OTHER, 1_000) });
    taken.setRelay(host(ME, 4, null, 1_000));
    taken.hosts.open("ws");
    await taken.settle();
    expect(taken.started, "no release, so a run before now may have happened there").toEqual([null]);
  });

  it("keeps a closed workspace's holds, so a reopen finds them and a handover still waits", async () => {
    const w = world({ stored: host(ME, 2, null, null) });
    w.setRelay(host(ME, 2, null, null));
    w.hosts.open("ws");
    await w.settle();
    const release = w.hosts.hold("ws");
    expect(release).not.toBeNull();
    // Closed while a relayed press still writes: nothing new is admitted.
    w.hosts.close("ws");
    expect(w.hosts.stillRuns("ws")).toBe(false);
    expect(w.hosts.hold("ws")).toBeNull();
    // Reopened, and the owner moves the automations: the handover waits for the write.
    w.setRelay(host(OTHER, 3, ME, null));
    w.hosts.open("ws");
    await w.settle();
    expect(w.requests.map((request) => request.action)).not.toContain("release");
    release!();
    await w.settle();
    expect(w.requests.map((request) => request.action)).toContain("release");
  });

  it("forgets a closed workspace once its last hold ends", async () => {
    const w = world({ stored: host(ME, 2, null, null) });
    w.setRelay(host(ME, 2, null, null));
    w.hosts.open("ws");
    await w.settle();
    const release = w.hosts.hold("ws");
    w.hosts.close("ws");
    release!();
    expect(await w.hosts.runsHere("ws")).toBe(false);
    // A fresh open starts from the stored copy, with nothing held.
    w.hosts.open("ws");
    await w.settle();
    expect(w.hosts.hold("ws")).not.toBeNull();
  });

  it("ignores an answer older than the host it already acted on", async () => {
    const w = world({ stored: host(ME, 2, null, null) });
    w.setRelay(host(ME, 2, null, null));
    w.hosts.open("ws");
    await w.settle();
    // Settings chose another computer and this one released.
    w.hosts.learned("ws", host(OTHER, 4, null, 3_000));
    expect(w.hosts.stillRuns("ws")).toBe(false);
    // A check-in that was still out answers with the older host, then a
    // stale answer says no host at all: neither turns running back on.
    expect(w.hosts.learned("ws", host(ME, 2, null, null)), "the host it holds, not the stale answer")
      .toEqual(host(OTHER, 4, null, 3_000));
    expect(w.hosts.stillRuns("ws")).toBe(false);
    expect(w.hosts.learned("ws", null)).toEqual(host(OTHER, 4, null, 3_000));
    expect(w.hosts.stillRuns("ws")).toBe(false);
    expect(w.hosts.learned("closed-workspace", host(ME, 1, null, null)), "nothing held: the answer").toEqual(host(ME, 1, null, null));
    expect(w.started, "never started here again").toEqual([]);
    w.hosts.learned("ws", host(ME, 5, null, 4_000));
    expect(w.hosts.stillRuns("ws")).toBe(true);
  });

  it("reads again on a short timer while a handover waits, and starts at once on the release", async () => {
    const w = world({ stored: host(OTHER, 2, null, null) });
    w.setRelay(host(OTHER, 2, null, null));
    w.hosts.open("ws");
    await w.settle();
    expect(w.armed(), "no handover, so no timer").toEqual([]);

    // The owner chose this computer; the other one has not released yet.
    w.setRelay(host(ME, 3, OTHER, null));
    w.hosts.learned("ws", host(ME, 3, OTHER, null));
    expect(w.armed()).toEqual([HANDOVER_READ_FIRST_MS]);
    const reads = w.requests.length;
    await w.fire();
    expect(w.requests.length, "the timer reads even a fresh copy").toBe(reads + 1);
    expect(w.armed(), "still waiting: twice as long").toEqual([2 * HANDOVER_READ_FIRST_MS]);
    await w.fire();
    await w.fire();
    await w.fire();
    expect(w.armed(), "never longer than the cap").toEqual([HANDOVER_READ_MAX_MS]);

    // The other computer released: the next read starts this one at once.
    const changes = w.hostChanges();
    w.setRelay(host(ME, 4, null, 9_000));
    await w.fire();
    expect(w.started).toEqual([9_000]);
    expect(w.hostChanges()).toBe(changes + 1);
    expect(w.hosts.stillRuns("ws")).toBe(true);
    expect(w.armed()).toEqual([]);
  });

  it("stops the timer when a handover is called off or the workspace closes, and follows it again on reopen", async () => {
    const w = world({ stored: host(ME, 3, OTHER, null) });
    w.setReachable(false);
    w.hosts.open("ws");
    await w.settle();
    expect(w.armed(), "the kept copy shows a handover").toEqual([HANDOVER_READ_FIRST_MS]);
    w.hosts.close("ws");
    expect(w.armed()).toEqual([]);
    w.hosts.open("ws");
    await w.settle();
    expect(w.armed()).toEqual([HANDOVER_READ_FIRST_MS]);
    // Offline, the timer keeps reading at longer waits.
    await w.fire();
    expect(w.armed()).toEqual([2 * HANDOVER_READ_FIRST_MS]);

    // Back online: the owner chose the other computer back, so no handover waits.
    w.setReachable(true);
    w.setRelay(host(OTHER, 5, null, null));
    await w.fire();
    expect(w.armed()).toEqual([]);
    expect(w.hosts.stillRuns("ws")).toBe(false);

    // A new handover starts its reads short again.
    w.hosts.learned("ws", host(ME, 6, OTHER, null));
    expect(w.armed()).toEqual([HANDOVER_READ_FIRST_MS]);
  });

  it("admits a Group trigger's computer as the host when none is named, and reads nothing once one is", async () => {
    const w = world();
    w.hosts.open("ws");
    await w.hosts.admit("ws");
    expect(w.requests.at(-1), "no host named, so it claims").toEqual({ action: "check-in", body: { installId: ME, label: "Ice's laptop", claim: true } });
    expect(w.hosts.stillRuns("ws")).toBe(true);
    const reads = w.requests.length;
    w.advance(HOST_FRESH_MS + 1);
    await w.hosts.admit("ws");
    expect(w.requests.length, "a named host, even an old copy, answers at once").toBe(reads);

    const unsynced = world({ synced: false });
    unsynced.hosts.open("ws");
    await unsynced.hosts.admit("ws");
    expect(unsynced.requests, "nothing to ask before it syncs").toEqual([]);
  });

  it("tells host work once when a read fails while no host is named, and again only after an answer", async () => {
    const w = world();
    w.setReachable(false);
    w.hosts.open("ws");
    await w.settle();
    expect(w.hostChanges(), "no host confirmed, so host work decides again").toBe(1);
    w.hosts.relayAnswered("ws");
    await w.settle();
    expect(w.hostChanges(), "once, so the reads it starts do not repeat it").toBe(1);
    w.setReachable(true);
    w.hosts.relayAnswered("ws");
    await w.settle();
    expect(w.hostChanges(), "the answer: no host yet").toBe(2);
    w.setReachable(false);
    w.advance(HOST_FRESH_MS + 1);
    w.hosts.relayAnswered("ws");
    await w.settle();
    expect(w.hostChanges()).toBe(3);

    const named = world({ stored: host(OTHER, 2, null, null) });
    named.setReachable(false);
    named.hosts.open("ws");
    await named.settle();
    expect(named.hostChanges(), "a named host stands while the relay is away").toBe(0);
  });

  it("does not read for a workspace that does not sync, and answers false once closed", async () => {
    const w = world({ synced: false });
    w.hosts.open("ws");
    await w.settle();
    expect(w.requests).toEqual([]);
    w.hosts.close("ws");
    expect(await w.hosts.runsHere("ws")).toBe(false);
  });
});

describe("the automation host", () => {
  it("is the synced workspace's host as read, or this computer when the workspace never synced", async () => {
    const root = await createTestScratch("dohc-automation-host-");
    await mkdir(join(root, ".dohc"), { recursive: true });
    expect(await isAutomationHost({ rootPath: root, remote: {} }, () => true)).toBe(true);
    expect(await isAutomationHost({ rootPath: root, remote: {} }, () => false)).toBe(false);
    expect(await isAutomationHost({ rootPath: root }, () => true), "no record of whether it synced").toBe(false);
    await recordNeverSynced(root);
    expect(await isAutomationHost({ rootPath: root }, () => false)).toBe(true);
    expect(await isAutomationHost({ rootPath: root, shareView: {} }, () => true), "shared with this person").toBe(false);
    expect(await isAutomationHost(null, () => true)).toBe(false);
    recordSynced(root);
    expect(await isAutomationHost({ rootPath: root }, () => true), "synced before, so another computer may be the host").toBe(false);
  });
});

describe("host answers and labels", () => {
  it("takes only a well-formed host", () => {
    expect(hostOfAnswer({ status: 200, body: { ok: true, host: null } })).toBeNull();
    expect(hostOfAnswer(answer(host(ME, 1, null, 5))!)).toEqual(host(ME, 1, null, 5));
    expect(hostOfAnswer({ status: 409, body: { ok: true, host: null } })).toBeUndefined();
    expect(hostOfAnswer({ status: 200, body: { ok: true, host: { ...host(ME, 1, null, null), extra: 1 } } })).toBeUndefined();
    expect(hostOfAnswer({ status: 200, body: { ok: true, host: host(" padded", 1, null, null) } })).toBeUndefined();
  });

  it("tells a relay that did not answer from a failure", () => {
    expect(relayUnreachable(new TypeError("fetch failed"))).toBe(true);
    expect(relayUnreachable(new DOMException("The operation timed out.", "TimeoutError"))).toBe(true);
    expect(relayUnreachable(new DOMException("The operation was aborted.", "AbortError"))).toBe(false);
    expect(relayUnreachable(new Error("Reconnect your sharing server, then try again."))).toBe(false);
  });

  it("names the computer within the relay's bounds", () => {
    expect(computerLabel("  ice-laptop\n")).toBe("ice-laptop");
    expect([...computerLabel("x".repeat(100))]).toHaveLength(64);
    expect(computerLabel("\u0007")).toBe("This computer");
  });
});
