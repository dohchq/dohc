import { describe, expect, it } from "vitest";
import type { RelayAutomationHost } from "@dohc/workspace-contracts/relay";
import {
  computerLabel,
  createAutomationHosts,
  HOST_FRESH_MS,
  hostOfAnswer,
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
  const requests: HostRequest[] = [];
  const started: Array<number | null> = [];
  const stored: Array<RelayAutomationHost | null> = [];
  const errors: unknown[] = [];
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
    finishHere: async () => {
      finishes += 1;
      return finish;
    },
    logError: (_workspaceId, error) => { errors.push(error); },
    monotonicMs: () => clock,
  });
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    hosts, requests, started, stored, errors, settle,
    advance: (ms: number) => { clock += ms; },
    setRelay: (row: RelayAutomationHost | null) => { relay = row; },
    relay: () => relay,
    setReachable: (value: boolean) => { reachable = value; },
    setSignedIn: (value: boolean) => { signedIn = value; },
    setFinish: (value: number | null) => { finish = value; },
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
    const release = w.hosts.hold("ws");
    w.setRelay(host(OTHER, 3, ME, null));
    w.advance(HOST_FRESH_MS + 1);
    await w.hosts.runsHere("ws");

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
    expect(w.hosts.stillRuns("ws")).toBe(true);
    expect(w.hosts.hold("ws")).not.toBeNull();
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

  it("does not read for a workspace that does not sync, and answers false once closed", async () => {
    const w = world({ synced: false });
    w.hosts.open("ws");
    await w.settle();
    expect(w.requests).toEqual([]);
    w.hosts.close("ws");
    expect(await w.hosts.runsHere("ws")).toBe(false);
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
