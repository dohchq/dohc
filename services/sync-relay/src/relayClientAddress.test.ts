import { describe, expect, it } from "vitest";
import { relayClientAddress } from "./relayClientAddress";

const proxy = new Set(["10.233.42.2"]);

describe("relayClientAddress", () => {
  it("reads the forwarded sender only on webhook paths and only from a trusted proxy", () => {
    const hook = "/sync/hooks/token";
    expect(relayClientAddress(hook, "10.233.42.2", "203.0.113.9", proxy)).toBe("203.0.113.9");
    expect(relayClientAddress(hook, "198.51.100.4", "203.0.113.9", proxy)).toBe("198.51.100.4");
    expect(relayClientAddress("/sync/link-exchange", "10.233.42.2", "203.0.113.9", proxy)).toBe(
      "10.233.42.2",
    );
    expect(relayClientAddress(hook, "10.233.42.2", "203.0.113.9", new Set())).toBe("10.233.42.2");
    // The router decodes segments and skips empty ones, so these reach the same webhook.
    for (const path of ["/sync/%68ooks/token", "//sync//hooks/token"])
      expect(relayClientAddress(path, "10.233.42.2", "203.0.113.9", proxy)).toBe("203.0.113.9");
    expect(relayClientAddress("/sync/hooks/%E0%A4%A", "10.233.42.2", "203.0.113.9", proxy)).toBe(
      "10.233.42.2",
    );
  });
});
