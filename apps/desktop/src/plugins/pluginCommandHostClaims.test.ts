import { describe, expect, it } from "vitest";
import { PluginCommandHostClaims } from "./pluginCommandHostClaims";

describe("PluginCommandHostClaims", () => {
  it("keeps an overlapping command claim until its final release", () => {
    const claims = new PluginCommandHostClaims();

    claims.claim("workspace-1\0example-plugin");
    claims.claim("workspace-1\0example-plugin");
    claims.release("workspace-1\0example-plugin");

    expect(claims.has("workspace-1\0example-plugin")).toBe(true);

    claims.release("workspace-1\0example-plugin");

    expect(claims.has("workspace-1\0example-plugin")).toBe(false);
  });

  // round-9 finding 1: a command's own cold start (claim: false) takes no
  // panelStartedHosts entry, so nothing else ever recorded whether this
  // host is running only because of it. These three pins are the exact
  // scenarios the round asked for, at the level this class actually owns.
  describe("markStartedHost / consumeStartedHost", () => {
    it("marks a single cold command start consumable once its one claim releases", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      claims.claim(key);
      claims.markStartedHost(key);
      claims.release(key);

      expect(claims.has(key)).toBe(false);
      expect(claims.consumeStartedHost(key)).toBe(true);
      // Consuming clears it: nothing left for a second check to find.
      expect(claims.consumeStartedHost(key)).toBe(false);
    });

    it("keeps the marker through every overlapping command, until the last one releases", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      claims.claim(key);
      claims.markStartedHost(key);
      // A second command joins the same already-running host.
      claims.claim(key);

      claims.release(key);
      expect(claims.has(key)).toBe(true);

      claims.release(key);
      expect(claims.has(key)).toBe(false);
      expect(claims.consumeStartedHost(key)).toBe(true);
    });

    it("never marks a command that found the host already running", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      // The command claims the host but never calls markStartedHost —
      // exactly what happens when its own start found an activation
      // already in flight, so it never performed the zero-to-running
      // transition itself.
      claims.claim(key);
      claims.release(key);

      expect(claims.consumeStartedHost(key)).toBe(false);
    });

    it("leaves an unconsumed marker intact for a later check to spend", () => {
      // Simulates a panel opening mid-command: stopPluginHostIfUnclaimed's
      // own hasAnotherPanel check would stop it from ever reaching
      // consumeStartedHost, so the marker must survive for the panel's
      // own eventual close to consume instead.
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      claims.claim(key);
      claims.markStartedHost(key);
      claims.release(key);

      // consumeStartedHost deliberately not called here — a caller gated
      // by another still-true condition never reaches it.
      expect(claims.consumeStartedHost(key)).toBe(true);
    });
  });

  // The drain barrier's full history: round-10 finding 2 (a rebuild's
  // old-runtime stop must wait for claims that already exist, and refuse
  // ones that arrive after); round-11 (the barrier and the wait for
  // claims to empty are two different lifetimes — the caller's own
  // teardown still has real work left once claims are empty); round-12
  // finding 1 (a rebuild-class action's own barrier must cover its WHOLE
  // run, not only the stop inside it); round-13 findings 1 and 2 (raising
  // has to happen before an action is even enqueued, and different
  // callers — an action and a narrower operation nested inside it — need
  // independent, refcounted holds so one's lower can never undo the
  // other's still-active hold).
  describe("raiseDrainBarrier / lowerDrainBarrier / isDraining", () => {
    it("raises and lowers a single hold", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      expect(claims.isDraining(key)).toBe(false);
      claims.raiseDrainBarrier(key);
      expect(claims.isDraining(key)).toBe(true);
      claims.lowerDrainBarrier(key);
      expect(claims.isDraining(key)).toBe(false);
    });

    it("does not touch the claim count", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      claims.raiseDrainBarrier(key);

      expect(claims.has(key)).toBe(false);
    });

    // round-13 findings 1 and 2: a rebuild's own wide hold (raised before
    // it is even enqueued) and its nested old-runtime stop's narrower
    // hold are two independent owners of the same key's barrier — the
    // genuine behavioral claim a single boolean flag could never
    // distinguish (two raises look identical to one).
    it("keeps the barrier up while a nested hold is still outstanding, even after the outer hold lowers", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      // The outer hold: a rebuild raises this before it is even enqueued.
      claims.raiseDrainBarrier(key);
      // The nested hold: its own old-runtime stop raises a second,
      // independent hold once it actually begins draining.
      claims.raiseDrainBarrier(key);

      // The nested hold's own caller lowers only its own hold once its
      // narrower protected work (the stop) finishes — long before the
      // outer rebuild action itself has settled.
      claims.lowerDrainBarrier(key);
      expect(claims.isDraining(key)).toBe(true);

      // Only once the outer action's own hold also lowers does the
      // barrier actually come down.
      claims.lowerDrainBarrier(key);
      expect(claims.isDraining(key)).toBe(false);
    });

    it("lowering a key with no hold outstanding is a no-op", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      claims.lowerDrainBarrier(key);

      expect(claims.isDraining(key)).toBe(false);
    });
  });

  describe("drain", () => {
    it("raises a hold even with zero claims outstanding, and resolves immediately — the hold itself outlives the resolve", async () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      expect(claims.isDraining(key)).toBe(false);
      const drained = claims.drain(key);
      // A "zero-claim rebuild" still raises a hold: a command racing in
      // before the caller's own teardown finishes must be refused just
      // the same as one that raced a real claim (round-11).
      expect(claims.isDraining(key)).toBe(true);

      await drained;
      // The wait is over, but the hold this raised outlives it — only
      // the caller's own lowerDrainBarrier() brings it down.
      expect(claims.isDraining(key)).toBe(true);
    });

    it("raises a hold the instant it is called, and resolves once its one claim releases — the hold stays up", async () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";
      claims.claim(key);

      const drained = claims.drain(key);
      // Synchronous: a caller checking right after calling drain() must
      // see it, with no await between the two — the exact ordering
      // isDraining()'s own guard in invokePluginCommand relies on.
      expect(claims.isDraining(key)).toBe(true);

      let settled = false;
      void drained.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      claims.release(key);
      await drained;

      expect(settled).toBe(true);
      // A command arriving right now — after the last claim released,
      // before the caller's own stop has actually finished — must still
      // be refused (round-11).
      expect(claims.isDraining(key)).toBe(true);

      claims.lowerDrainBarrier(key);
      expect(claims.isDraining(key)).toBe(false);
    });

    // round-13 finding 5: the previous version of this test claimed a
    // late claim "would extend the wait if drain() re-armed on it" but
    // never actually added one — it only reasserted isDraining(), which
    // the tests above already cover. This version adds the late claim
    // the comment always claimed to test.
    it("waits only for the claims that existed when it began, not a claim that arrives mid-drain", async () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";
      claims.claim(key);
      claims.claim(key);

      const drained = claims.drain(key);
      let settled = false;
      void drained.then(() => {
        settled = true;
      });

      claims.release(key);
      await Promise.resolve();
      expect(settled).toBe(false);

      // A real caller refuses a new claim once isDraining() is true,
      // before it ever reaches claim() — but this proves drain() itself
      // would not extend its own wait even if one landed anyway.
      claims.claim(key);

      claims.release(key);
      await Promise.resolve();
      // The late claim is still outstanding: drain() must not have
      // settled on the two pre-existing releases alone.
      expect(settled).toBe(false);

      claims.release(key);
      await drained;

      expect(settled).toBe(true);
    });

    // round-13 finding 6: two independent drain() calls on the same key —
    // a rebuild's own wide drain and, nested inside it, its old-runtime
    // stop's own narrower drain — must both resolve once claims empty,
    // instead of the second registration silently replacing the first's.
    it("resolves every concurrent waiter on the same key, not only the most recent", async () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";
      claims.claim(key);

      const first = claims.drain(key);
      const second = claims.drain(key);
      let firstSettled = false;
      let secondSettled = false;
      void first.then(() => {
        firstSettled = true;
      });
      void second.then(() => {
        secondSettled = true;
      });

      claims.release(key);
      await Promise.all([first, second]);

      expect(firstSettled).toBe(true);
      expect(secondSettled).toBe(true);
    });
  });
});
