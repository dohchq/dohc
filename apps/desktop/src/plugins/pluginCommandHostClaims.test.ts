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

  // round-10 finding 2: a rebuild's old-runtime stop must wait for
  // claims that already exist, and refuse ones that arrive after —
  // otherwise it could dispose the transport under a command still
  // running its side effects, or never finish if new commands keep
  // arriving.
  //
  // round-11: the barrier (isDraining) and the wait (drain()'s promise)
  // are two different lifetimes. The wait ends once existing claims
  // release; the caller's own teardown (PluginHost.stop()) still has
  // real work left after that, so the barrier stays up until the caller
  // explicitly calls clearDrain() — never merely because drain()
  // resolved.
  describe("isDraining / drain / clearDrain", () => {
    it("marks a key draining even with zero claims outstanding, and resolves immediately", async () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      expect(claims.isDraining(key)).toBe(false);
      const drained = claims.drain(key);
      // A "zero-claim rebuild" still marks: a command racing in before
      // the caller's own teardown finishes must be refused just the
      // same as one that raced a real claim (round-11).
      expect(claims.isDraining(key)).toBe(true);

      await drained;
      // The wait is over, but the barrier itself outlives it.
      expect(claims.isDraining(key)).toBe(true);
    });

    it("marks a key draining the instant drain() is called, and resolves once its one claim releases — but the barrier stays up", async () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";
      claims.claim(key);

      const drained = claims.drain(key);
      // Synchronous: a caller checking right after calling drain() must
      // see it, with no await between the two — the exact ordering
      // isDraining()'s own guard in stopPluginHostIfUnclaimed relies on.
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

      claims.clearDrain(key);
      expect(claims.isDraining(key)).toBe(false);
    });

    it("waits for every claim that existed when it began, not ones that arrive after", async () => {
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

      // A claim arriving mid-drain would extend the wait if drain() re-armed
      // on it — it must not: this key is already draining, so a real caller
      // refuses this claim before it ever reaches claim().
      expect(claims.isDraining(key)).toBe(true);

      claims.release(key);
      await drained;

      expect(settled).toBe(true);
    });

    it("only clearDrain() lowers the barrier — a caller's own stop can take real time after the wait ends", async () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      await claims.drain(key);
      expect(claims.isDraining(key)).toBe(true);
      expect(claims.isDraining(key)).toBe(true);
      expect(claims.isDraining(key)).toBe(true);

      claims.clearDrain(key);

      expect(claims.isDraining(key)).toBe(false);
    });

    it("clearing an undrained key is a no-op", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      claims.clearDrain(key);

      expect(claims.isDraining(key)).toBe(false);
    });
  });
});
