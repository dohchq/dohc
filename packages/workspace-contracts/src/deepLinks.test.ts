import { describe, expect, it } from "vitest";
import {
  buildConnectServerUrl,
  buildShareHandoffUrl,
  buildWorkLinkHandoffUrl,
  parseConnectServerUrl,
  parseShareHandoffUrl,
  parseWorkLinkHandoffUrl,
} from "./deepLinks";

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
  ])("round-trips a canonical relay coordinate: %s", (relay) => {
    expect(parseShareHandoffUrl(buildShareHandoffUrl(code, relay))).toEqual({
      code,
      relayUrl: relay,
    });
  });

  it.each(["", "bad/code", "a".repeat(42), "a".repeat(44), `${code}\n`, "a".repeat(42) + "K"])(
    "refuses an invalid code: %j",
    (value) => {
      expect(() => buildShareHandoffUrl(value, relayUrl)).toThrow("invalid handoff code");
    },
  );

  it.each([
    "",
    "https://Relay.Example/",
    "https://user:pass@relay.example",
    "https://relay.example?q=secret",
    "https://relay.example#secret",
    "file:///tmp/relay",
  ])("refuses an invalid relay coordinate: %j", (relay) => {
    expect(() => buildShareHandoffUrl(code, relay)).toThrow("invalid handoff relay coordinate");
  });

  it.each([
    "dohc://graph",
    "dohc://chats",
    "dohc://app/trip",
    "tab://graph",
    "tab://chats",
    `tab://open/${code}?relay=https%3A%2F%2Frelay.example`,
  ])("does not accept an internal tab id: %s", (path) => {
    expect(parseShareHandoffUrl(path)).toBeNull();
  });
});

describe("work link deep links", () => {
  const server = "https://dohc.example";

  it("builds and parses the open-in-dohc URL for a work link", () => {
    const url = `dohc://l/${code}?server=https%3A%2F%2Fdohc.example`;
    expect(buildWorkLinkHandoffUrl({ server, reference: code })).toBe(url);
    expect(parseWorkLinkHandoffUrl(url)).toEqual({ server, reference: code });
    expect(parseWorkLinkHandoffUrl(`DOHC://L/${code}?server=https%3A%2F%2Fdohc.example`)).toEqual({
      server,
      reference: code,
    });
  });

  it.each(["http://localhost:3000", "https://dohc.example:8443"])(
    "round-trips a server origin: %s",
    (origin) => {
      expect(
        parseWorkLinkHandoffUrl(buildWorkLinkHandoffUrl({ server: origin, reference: code })),
      ).toEqual({ server: origin, reference: code });
    },
  );

  it.each([
    "",
    "https://dohc.example/",
    "https://dohc.example/base",
    "https://Dohc.Example",
    "https://user:pass@dohc.example",
    "https://dohc.example:443",
    "file:///tmp",
  ])("refuses a server that is not a canonical origin: %j", (origin) => {
    expect(() => buildWorkLinkHandoffUrl({ server: origin, reference: code })).toThrow(
      "invalid work link server",
    );
  });

  it.each(["", "a".repeat(42), "a".repeat(44), `${code}\n`])(
    "refuses an invalid reference: %j",
    (reference) => {
      expect(() => buildWorkLinkHandoffUrl({ server, reference })).toThrow(
        "invalid work reference",
      );
    },
  );

  it.each([
    `dohc://l/${code}?server=https://dohc.example`,
    `dohc://l/${code}?server=https%3a%2f%2fdohc.example`,
    `dohc://l/${code}?server=https%3A%2F%2Fdohc.example%2F`,
    `dohc://l/${code}?server=https%3A%2F%2Fdohc.example&x=1`,
    `dohc://l/${code}?server=https%3A%2F%2Fdohc.example#x`,
    `dohc://l/${code}?relay=https%3A%2F%2Fdohc.example`,
    `dohc://open/${code}?server=https%3A%2F%2Fdohc.example`,
    `dohc://l/${code}/?server=https%3A%2F%2Fdohc.example`,
    `dohc://l/${code}?server=%E0%A4%A`,
    ` dohc://l/${code}?server=https%3A%2F%2Fdohc.example`,
  ])("refuses a malformed work link deep link: %s", (raw) => {
    expect(parseWorkLinkHandoffUrl(raw)).toBeNull();
  });

  it("keeps the two hosts apart", () => {
    expect(parseShareHandoffUrl(buildWorkLinkHandoffUrl({ server, reference: code }))).toBeNull();
    expect(parseWorkLinkHandoffUrl(buildShareHandoffUrl(code, relayUrl))).toBeNull();
  });
});

describe("connect server deep links", () => {
  it("names the server a person asked dohc to connect to", () => {
    const url = "dohc://connect?server=https%3A%2F%2Fdrive.dohc.computer";
    expect(buildConnectServerUrl("https://drive.dohc.computer")).toBe(url);
    expect(parseConnectServerUrl(url)).toBe("https://drive.dohc.computer");
    expect(parseConnectServerUrl("DOHC://Connect/?server=https%3A%2F%2Fdrive.dohc.computer")).toBe(
      "https://drive.dohc.computer",
    );
    expect(parseConnectServerUrl(buildConnectServerUrl("http://localhost:4100"))).toBe(
      "http://localhost:4100",
    );
  });

  it.each([
    "dohc://connect?server=https%3A%2F%2Fdrive.dohc.computer%2F",
    "dohc://connect?server=https://drive.dohc.computer",
    "dohc://connect?server=https%3A%2F%2Fu%3Ap%40drive.dohc.computer",
    "dohc://connect?server=javascript%3Aalert(1)",
    "dohc://connect?server=https%3A%2F%2Fdrive.dohc.computer&next=x",
    "dohc://connect?server=%E0%A4%A",
    "dohc://connect/x?server=https%3A%2F%2Fdrive.dohc.computer",
    "dohc://open?server=https%3A%2F%2Fdrive.dohc.computer",
    "other://connect?server=https%3A%2F%2Fdrive.dohc.computer",
  ])("refuses %s", (url) => {
    expect(parseConnectServerUrl(url)).toBeNull();
  });

  it("refuses to build a link for an address that is not an origin", () => {
    expect(() => buildConnectServerUrl("https://drive.dohc.computer/account")).toThrow();
  });
});
