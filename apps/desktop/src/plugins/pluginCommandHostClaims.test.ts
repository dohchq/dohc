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
});
