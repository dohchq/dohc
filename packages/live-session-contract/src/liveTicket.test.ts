import { describe, expect, it } from "vitest";
import {
  LIVE_TICKET_ENTROPY_BYTES,
  LIVE_TICKET_LIFETIME_MS,
  LIVE_TICKET_TOKEN_PATTERN,
  parseLiveTicketClaims,
  parseLiveTicketToken,
  parseRedeemedLiveTicket,
} from "./liveTicket.js";

function claim() {
  return {
    ticketId: "ticket-1",
    audience: "https://share.example.test",
    authority: { principalKind: "named", principalId: "user-1", grantId: "grant-1", grantGeneration: 3 },
    binding: {
      workspaceId: "workspace-1", mainVersionId: "main", objectId: "object-1",
      lineageClaimId: "lineage-1", currentPath: "notes/owner.md",
      selectorPaths: ["notes/owner.md"], restoreFenceGeneration: 7,
    },
    hostEpoch: 2,
    mintedAtMs: 1_000,
    expiresAtMs: 31_000,
  };
}

describe("shared live-ticket claims", () => {
  it("owns the named authority and canonical binding without retaining input aliases", () => {
    const input = {
      ticketId: "ticket-1",
      audience: "https://share.example.test",
      authority: {
        principalKind: "named",
        principalId: "user-1",
        grantId: "grant-1",
        grantGeneration: 3,
      },
      binding: {
        workspaceId: "workspace-1",
        mainVersionId: "main",
        objectId: "object-1",
        lineageClaimId: "lineage-1",
        currentPath: "notes//./owner.md",
        selectorPaths: ["z/other.md", "notes\\owner.md", "notes/owner.md"],
        restoreFenceGeneration: 7,
      },
      hostEpoch: 2,
      mintedAtMs: 1_000,
      expiresAtMs: 31_000,
    };
    const parsed = parseLiveTicketClaims(input);

    input.ticketId = "changed-ticket";
    input.authority.principalId = "changed-user";
    input.binding.objectId = "changed-object";
    input.binding.selectorPaths.splice(0, input.binding.selectorPaths.length, "changed.md");

    expect(parsed).toEqual({
      ticketId: "ticket-1",
      audience: "https://share.example.test",
      authority: {
        principalKind: "named",
        principalId: "user-1",
        grantId: "grant-1",
        grantGeneration: 3,
      },
      binding: {
        workspaceId: "workspace-1",
        mainVersionId: "main",
        objectId: "object-1",
        lineageClaimId: "lineage-1",
        currentPath: "notes/owner.md",
        selectorPaths: ["notes/owner.md", "z/other.md"],
        restoreFenceGeneration: 7,
      },
      hostEpoch: 2,
      mintedAtMs: 1_000,
      expiresAtMs: 31_000,
    });
  });
});

describe("live-ticket token representation", () => {
  const token = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  const expected = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];

  it("decodes independent byte vectors and returns fresh arrays", () => {
    expect(LIVE_TICKET_ENTROPY_BYTES).toBe(32);
    expect(LIVE_TICKET_LIFETIME_MS).toBe(30_000);
    expect(LIVE_TICKET_TOKEN_PATTERN).toBe("^[0-9a-f]{64}$");
    const first = parseLiveTicketToken(token);
    expect(first).toBeInstanceOf(Uint8Array);
    expect([...first]).toEqual(expected);
    first.fill(255);
    expect([...parseLiveTicketToken(token)]).toEqual(expected);
    expect([...parseLiveTicketToken("ff".repeat(32))]).toEqual(Array(32).fill(255));
  });

  it.each([
    null, undefined, 1, {}, new String(token), "", token.slice(1), token + "0",
    token.toUpperCase(), " " + token, token + " ", token + "\n", token + "\r\n",
    token.slice(0, 63) + "\n", token.slice(0, 63) + "g", "0x" + token,
  ])("refuses malformed token %# without normalization", value => {
    expect(() => parseLiveTicketToken(value)).toThrow(TypeError);
  });
});

describe("live-ticket authority and coordinates", () => {
  it("preserves named and link representations without accepting owner authority", () => {
    for (const principalKind of ["named", "link"]) {
      const input = claim();
      input.authority.principalKind = principalKind;
      expect(parseLiveTicketClaims(input).authority).toEqual(input.authority);
    }
    expect(() => parseLiveTicketClaims({ ...claim(), authority: {
      principalKind: "owner", principalId: "owner-1", grantId: null, grantGeneration: null,
    } })).toThrow(TypeError);
  });

  it("uses canonical identifier, authority, binding, and epoch bounds", () => {
    const input = claim();
    input.ticketId = "é".repeat(256);
    expect(parseLiveTicketClaims(input).ticketId).toBe(input.ticketId);
    for (const ticketId of ["", "é".repeat(256) + "a", "x\u0000", "x\ud800", "x\udfff"]) {
      expect(() => parseLiveTicketClaims({ ...claim(), ticketId })).toThrow();
    }
    for (const hostEpoch of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "2"]) {
      expect(() => parseLiveTicketClaims({ ...claim(), hostEpoch })).toThrow();
    }
    expect(() => parseLiveTicketClaims({ ...claim(), authority: { ...claim().authority, grantGeneration: 0 } })).toThrow();
    expect(() => parseLiveTicketClaims({ ...claim(), binding: { ...claim().binding, currentPath: "../outside.md" } })).toThrow();
  });
});

describe("live-ticket audience and time", () => {
  it("accepts canonical HTTP and HTTPS origins up to the exact byte boundary", () => {
    const boundary = "https://" + "a.".repeat(1019) + "aa";
    expect(new TextEncoder().encode(boundary).byteLength).toBe(2_048);
    for (const audience of ["http://localhost:8080", "https://share.example.test", "https://[::1]:8443", boundary]) {
      expect(parseLiveTicketClaims({ ...claim(), audience }).audience).toBe(audience);
    }
    expect(() => parseLiveTicketClaims({ ...claim(), audience: boundary + "a" })).toThrow(TypeError);
  });

  it.each([
    null, 123, "https://example.test/", "https://example.test/path", "https://example.test?x",
    "https://example.test#x", "https://user:password@example.test", "https://example.test:443",
    "HTTPS://example.test", "https://EXAMPLE.test", " https://example.test", "https://example.test\n",
    "https://example.test\u007f", "https://\ud800.test", "https://\udfff.test", "https://é.test",
    "file:///tmp", "ws://example.test", "null", "",
  ])("refuses noncanonical or malformed audience %#", audience => {
    expect(() => parseLiveTicketClaims({ ...claim(), audience })).toThrow(TypeError);
  });

  it("enforces safe exact lifetime and inclusive issue/exclusive expiry redemption", () => {
    for (const mintedAtMs of [0, Number.MAX_SAFE_INTEGER - 30_000]) {
      const input = { ...claim(), mintedAtMs, expiresAtMs: mintedAtMs + 30_000 };
      expect(parseLiveTicketClaims(input).expiresAtMs).toBe(input.expiresAtMs);
      for (const redeemedAtMs of [mintedAtMs, input.expiresAtMs - 1]) {
        expect(parseRedeemedLiveTicket({ ...input, redeemedAtMs }).redeemedAtMs).toBe(redeemedAtMs);
      }
      expect(() => parseRedeemedLiveTicket({ ...input, redeemedAtMs: input.expiresAtMs })).toThrow(TypeError);
      expect(() => parseRedeemedLiveTicket({ ...input, redeemedAtMs: mintedAtMs - 1 })).toThrow(TypeError);
    }
    expect(() => parseLiveTicketClaims({ ...claim(), mintedAtMs: Number.MAX_SAFE_INTEGER - 29_999, expiresAtMs: Number.MAX_SAFE_INTEGER })).toThrow(TypeError);
    for (const expiresAtMs of [30_999, 31_001]) {
      expect(() => parseLiveTicketClaims({ ...claim(), expiresAtMs })).toThrow(TypeError);
    }
    for (const field of ["mintedAtMs", "expiresAtMs", "redeemedAtMs"]) {
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1000", null]) {
        expect(() => parseRedeemedLiveTicket({ ...claim(), redeemedAtMs: 1_000, [field]: value })).toThrow(TypeError);
      }
    }
  });
});

describe("live-ticket descriptor snapshots", () => {
  for (const location of ["claims", "authority", "binding"] as const) {
    it(`refuses inherited, extra, missing, and accessor ${location} fields without calling getters`, () => {
      const fields = Object.keys(location === "claims" ? claim() : claim()[location]);
      for (const field of fields) {
        for (const kind of ["missing", "inherited", "accessor"] as const) {
          const input = claim();
          const target: Record<string, unknown> = location === "claims" ? input : input[location];
          const value = target[field];
          delete target[field];
          let getterCalls = 0;
          if (kind === "inherited") Object.setPrototypeOf(target, { [field]: value });
          if (kind === "accessor") Object.defineProperty(target, field, { enumerable: true, get() { getterCalls += 1; return value; } });
          expect(() => parseLiveTicketClaims(input)).toThrow(TypeError);
          expect(getterCalls).toBe(0);
        }
      }
      for (const extra of ["extra", Symbol("extra")]) {
        const input = claim();
        const target = location === "claims" ? input : input[location];
        Object.defineProperty(target, extra, { value: 1 });
        expect(() => parseLiveTicketClaims(input)).toThrow(TypeError);
      }
    });
  }

  it("requires the distinct seven-field and eight-field envelopes", () => {
    expect(() => parseRedeemedLiveTicket(claim())).toThrow(TypeError);
    expect(() => parseLiveTicketClaims({ ...claim(), redeemedAtMs: 1_000 })).toThrow(TypeError);
    expect(() => parseRedeemedLiveTicket({ ...claim(), redeemedAtMs: 1_000, extra: true })).toThrow(TypeError);
    const input = { ...claim(), redeemedAtMs: 1_000 };
    let calls = 0;
    Object.defineProperty(input, "redeemedAtMs", { get() { calls += 1; return 1_000; } });
    expect(() => parseRedeemedLiveTicket(input)).toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it("rejects sparse, inherited, accessor, and extra selector entries", () => {
    for (const kind of ["sparse", "inherited", "accessor", "extra", "symbol"] as const) {
      const input = claim();
      const selectors = input.binding.selectorPaths;
      let calls = 0;
      if (["sparse", "inherited", "accessor"].includes(kind)) delete selectors[0];
      if (kind === "inherited") Object.setPrototypeOf(selectors, { 0: "notes/owner.md" });
      if (kind === "accessor") Object.defineProperty(selectors, "0", { get() { calls += 1; return "notes/owner.md"; } });
      if (kind === "extra") Object.defineProperty(selectors, "extra", { value: "notes/owner.md" });
      if (kind === "symbol") Object.defineProperty(selectors, Symbol("extra"), { value: true });
      expect(() => parseLiveTicketClaims(input)).toThrow(TypeError);
      expect(calls).toBe(0);
    }
    for (const selectorPaths of [[], Array(101).fill("notes/owner.md")]) {
      expect(() => parseLiveTicketClaims({ ...claim(), binding: { ...claim().binding, selectorPaths } })).toThrow(TypeError);
    }
  });

  it("turns reflection failures into invalid input without leaking thrown values", () => {
    for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const) {
      const input = new Proxy(claim(), { [trap]() { throw new Error("private-value"); } });
      expect(() => parseLiveTicketClaims(input)).toThrow(TypeError);
      expect(() => parseLiveTicketClaims(input)).not.toThrow("private-value");
    }
    const revoked = Proxy.revocable(claim(), {});
    revoked.revoke();
    expect(() => parseLiveTicketClaims(revoked.proxy)).toThrow(TypeError);
  });

  it("returns separate owned redeemed snapshots for each parse", () => {
    const input = { ...claim(), redeemedAtMs: 1_000 };
    const first = parseRedeemedLiveTicket(input);
    const second = parseRedeemedLiveTicket(input);
    Object.assign(first.authority, { principalId: "changed" });
    Object.assign(first.binding, { objectId: "changed" });
    (first.binding.selectorPaths as string[]).push("changed.md");
    expect(second).toEqual(input);
    expect(parseRedeemedLiveTicket(input)).toEqual(second);
  });
});
