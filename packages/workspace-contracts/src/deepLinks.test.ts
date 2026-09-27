import { describe, expect, it } from "vitest";
import { buildShareHandoffUrl, parseShareHandoffUrl } from "./deepLinks";

const code = "aB_9-".repeat(8) + "aB_";
const relayUrl = "https://relay.example";

describe("public deep-link contract", () => {
  it("keeps the URL already emitted by share-web", () => {
    const saved = `dohc://open/${code}?relay=https%3A%2F%2Frelay.example`;
    expect(buildShareHandoffUrl(code, relayUrl)).toBe(saved);
    expect(parseShareHandoffUrl(saved)).toEqual({ code, relayUrl });
  });

  it.each([
    "http://localhost:3000",
    "https://relay.example/base%20path",
    "https://relay.example:8443/path",
  ])("round-trips a canonical relay coordinate: %s", relay => {
    expect(parseShareHandoffUrl(buildShareHandoffUrl(code, relay))).toEqual({ code, relayUrl: relay });
  });

  it.each(["", "bad/code", "a".repeat(42), "a".repeat(44), `${code}\n`, "a".repeat(42) + "K"])("refuses an invalid code: %j", value => {
    expect(() => buildShareHandoffUrl(value, relayUrl)).toThrow("invalid handoff code");
  });

  it.each(["", "https://Relay.Example/", "https://user:pass@relay.example", "https://relay.example?q=secret", "https://relay.example#secret", "file:///tmp/relay"])("refuses an invalid relay coordinate: %j", relay => {
    expect(() => buildShareHandoffUrl(code, relay)).toThrow("invalid handoff relay coordinate");
  });

  it.each(["dohc://graph", "dohc://chats", "dohc://app/trip", "tab://graph", "tab://chats", `tab://open/${code}?relay=https%3A%2F%2Frelay.example`])("does not accept an internal tab id: %s", path => {
    expect(parseShareHandoffUrl(path)).toBeNull();
  });
});
