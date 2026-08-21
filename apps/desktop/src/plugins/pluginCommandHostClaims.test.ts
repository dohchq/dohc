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
      // what happens when its own start found an activation already in
      // flight, so it never performed the zero-to-running transition
      // itself.
      claims.claim(key);
      claims.release(key);

      expect(claims.consumeStartedHost(key)).toBe(false);
    });

    it("leaves an unconsumed marker intact for a later check to spend", () => {
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

  describe("raiseDrainBarrier / isDraining", () => {
    it("raises and lowers a single hold via the returned function", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      expect(claims.isDraining(key)).toBe(false);
      const lower = claims.raiseDrainBarrier(key);
      expect(claims.isDraining(key)).toBe(true);
      lower();
      expect(claims.isDraining(key)).toBe(false);
    });

    it("does not touch the claim count", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      claims.raiseDrainBarrier(key);

      expect(claims.has(key)).toBe(false);
    });

    // Two independent holds on the same key — a rebuild's own hold and,
    // nested inside it, its old-runtime stop's own hold — must compose:
    // neither's lower may bring the barrier down while the other is
    // still up.
    it("keeps the barrier up while a nested hold is still outstanding, even after the outer hold lowers", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      const lowerOuter = claims.raiseDrainBarrier(key);
      const lowerInner = claims.raiseDrainBarrier(key);

      lowerInner();
      expect(claims.isDraining(key)).toBe(true);

      lowerOuter();
      expect(claims.isDraining(key)).toBe(false);
    });

    it("calling the returned lower more than once has no further effect", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      const lowerFirst = claims.raiseDrainBarrier(key);
      claims.raiseDrainBarrier(key);

      lowerFirst();
      lowerFirst();
      expect(claims.isDraining(key)).toBe(true);
    });
  });

  describe("drain", () => {
    it("raises a hold even with zero claims outstanding, and resolves immediately with the lower", async () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";

      expect(claims.isDraining(key)).toBe(false);
      const drained = claims.drain(key);
      expect(claims.isDraining(key)).toBe(true);

      const lower = await drained;
      expect(claims.isDraining(key)).toBe(true);
      lower();
      expect(claims.isDraining(key)).toBe(false);
    });

    it("raises a hold the instant it is called, and resolves once its one claim releases", async () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";
      claims.claim(key);

      const drained = claims.drain(key);
      // Synchronous: a caller checking right after calling drain() must
      // see it, with no await between the two.
      expect(claims.isDraining(key)).toBe(true);

      let settled = false;
      void drained.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      claims.release(key);
      const lower = await drained;

      expect(settled).toBe(true);
      expect(claims.isDraining(key)).toBe(true);
      lower();
      expect(claims.isDraining(key)).toBe(false);
    });

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
      // does not extend its own wait even if one landed anyway.
      claims.claim(key);

      claims.release(key);
      await Promise.resolve();
      expect(settled).toBe(false);

      claims.release(key);
      await drained;

      expect(settled).toBe(true);
    });

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

  describe("reset", () => {
    it("clears an outstanding claim, so has() reports false and a later release is a no-op", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";
      claims.claim(key);
      expect(claims.has(key)).toBe(true);

      claims.reset(key);

      expect(claims.has(key)).toBe(false);
      // A release that arrives after reset must not throw or resurrect
      // a claim reset already discarded.
      expect(() => claims.release(key)).not.toThrow();
      expect(claims.has(key)).toBe(false);
    });

    it("clears the started-host marker, so a later consume reports false", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";
      claims.markStartedHost(key);

      claims.reset(key);

      expect(claims.consumeStartedHost(key)).toBe(false);
    });

    it("clears an outstanding drain hold, so isDraining reports false", () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";
      claims.raiseDrainBarrier(key);
      expect(claims.isDraining(key)).toBe(true);

      claims.reset(key);

      expect(claims.isDraining(key)).toBe(false);
    });

    it("resolves a pending drain waiter instead of leaving it hanging", async () => {
      const claims = new PluginCommandHostClaims();
      const key = "workspace-1\0example-plugin";
      claims.claim(key);

      const drained = claims.drain(key);
      let settled = false;
      void drained.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      claims.reset(key);
      await drained;

      expect(settled).toBe(true);
    });

    it("only touches the key it is given, leaving another key's state intact", () => {
      const claims = new PluginCommandHostClaims();
      const resetKey = "workspace-1\0example-plugin";
      const otherKey = "workspace-2\0example-plugin";
      claims.claim(resetKey);
      claims.claim(otherKey);
      claims.markStartedHost(resetKey);
      claims.markStartedHost(otherKey);
      claims.raiseDrainBarrier(resetKey);
      claims.raiseDrainBarrier(otherKey);

      claims.reset(resetKey);

      expect(claims.has(resetKey)).toBe(false);
      expect(claims.consumeStartedHost(resetKey)).toBe(false);
      expect(claims.isDraining(resetKey)).toBe(false);

      expect(claims.has(otherKey)).toBe(true);
      expect(claims.consumeStartedHost(otherKey)).toBe(true);
      expect(claims.isDraining(otherKey)).toBe(true);
    });
  });
});
