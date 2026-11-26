import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

type MockHttpsOptions = {
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  agent: boolean;
  servername: string;
  rejectUnauthorized: boolean;
  autoSelectFamily: boolean;
  maxHeaderSize: number;
  lookup(host: string, options: { all: boolean }, callback: (...args: unknown[]) => void): void;
};

const { httpsRequestMock } = vi.hoisted(() => ({
  httpsRequestMock: vi.fn<
    (
      url: URL,
      options: MockHttpsOptions,
      callback: (response: EventEmitter & { statusCode?: number; resume: () => void }) => void,
    ) => EventEmitter & { end: (body?: Buffer) => void; destroy: (error?: Error) => void }
  >(() => {
    throw new Error("Real network must never be contacted in unit tests");
  }),
}));

vi.mock("node:https", () => ({ request: httpsRequestMock }));

import {
  isAllowedPublicHostname,
  isPublicInternetAddress,
  parseSafeOutboundHttpsUrl,
  parseSafeOutboundJson,
  readSafeOutboundHttps,
  resolveSafeOutboundDestination,
  SafeOutboundError,
  sendSafeOutboundHttps,
} from "./safeOutboundHttps";

afterEach(() => {
  httpsRequestMock.mockReset();
});

describe("safeOutboundHttps URL and IP screening", () => {
  it.each([
    "https://api.example.com/v1/send",
    "https://API.EXAMPLE.COM:443/v1/send?x=1",
    "https://hooks.slack.com/services/T000/B000/XXX",
  ])("accepts valid public HTTPS URL %s", (raw) => {
    const parsed = parseSafeOutboundHttpsUrl(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.protocol).toBe("https:");
  });

  it.each([
    "http://api.example.com/v1",
    "https://user:pass@api.example.com/v1",
    "https://api.example.com:8443/v1",
    "https://api.example.com/v1#frag",
    "https://api.example.com/v1#",
    "https://127.0.0.1/v1",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/v1",
    "https://localhost/v1",
    "https://sync-relay/sync/hooks/abc",
    "https://postgres/query",
    "https://service.local/hook",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://home.arpa/api",
    "https://router.home.arpa/api",
    `https://${"a".repeat(64)}.example.com/v1`,
    "https://api.example.com./v1",
    "https://api.example.com/a\tb",
    "https://api.example.com/a\r\nb",
  ])("rejects unsafe URL %s", (raw) => {
    expect(parseSafeOutboundHttpsUrl(raw)).toBeNull();
  });

  it("checks public and blocked IPv4/IPv6 ranges", () => {
    expect(isPublicInternetAddress("93.184.216.34")).toBe(true);
    expect(isPublicInternetAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
    for (const bad of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "224.0.0.1",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "64:ff9b::127.0.0.1",
      "2001:db8::1",
      "2002:7f00:1::1",
      "ff02::1",
    ]) {
      expect(isPublicInternetAddress(bad), bad).toBe(false);
    }
  });

  it("refuses mixed DNS answers containing any private address", async () => {
    await expect(
      resolveSafeOutboundDestination("https://api.example.com/hook", {
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ],
      }),
    ).rejects.toMatchObject({ code: "unsafe_address" });
  });

  it("refuses mismatched address families or empty DNS answers", async () => {
    await expect(
      resolveSafeOutboundDestination("https://api.example.com/hook", {
        lookup: async () => [],
      }),
    ).rejects.toMatchObject({ code: "unsafe_address" });

    await expect(
      resolveSafeOutboundDestination("https://api.example.com/hook", {
        lookup: async () => [{ address: "93.184.216.34", family: 6 }],
      }),
    ).rejects.toMatchObject({ code: "unsafe_address" });
  });

  it("enforces allowedHosts exact matching unless subdomain patterns are opted in", () => {
    const exact = new Set(["api.resend.com"]);
    expect(
      parseSafeOutboundHttpsUrl("https://api.resend.com/emails", { allowedHosts: exact }),
    ).not.toBeNull();
    expect(
      parseSafeOutboundHttpsUrl("https://sub.api.resend.com/emails", { allowedHosts: exact }),
    ).toBeNull();
    expect(isAllowedPublicHostname("api.resend.com")).toBe(true);
    expect(isAllowedPublicHostname("sync-relay")).toBe(false);
  });
});

describe("sendSafeOutboundHttps", () => {
  function mockResponse(
    statusCode: number,
    chunks: Buffer[] = [],
    headers: Record<string, string> = {},
  ) {
    httpsRequestMock.mockImplementation((_url, options, callback) => {
      const req = Object.assign(new EventEmitter(), {
        end: vi.fn(() => {
          const res = Object.assign(new EventEmitter(), {
            statusCode,
            headers,
            resume: vi.fn(),
          });
          callback(res);
          for (const chunk of chunks) {
            if (req.destroyed) return;
            res.emit("data", chunk);
          }
          if (!req.destroyed) {
            res.emit("end");
            req.emit("close");
          }
        }),
        destroyed: false,
        destroy(error?: Error) {
          this.destroyed = true;
          if (error) req.emit("error", error);
          req.emit("close");
        },
      });
      expect(options.agent).toBe(false);
      expect(options.rejectUnauthorized).toBe(true);
      expect(options.autoSelectFamily).toBe(false);
      expect(options.servername).toBe("api.example.com");
      expect(options.headers["accept-encoding"]).toBe("identity");
      const lookupCb = vi.fn();
      options.lookup("api.example.com", { all: false }, lookupCb);
      expect(lookupCb).toHaveBeenCalledWith(null, "93.184.216.34", 4);
      options.lookup("api.example.com", { all: true }, lookupCb);
      expect(lookupCb).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
      return req;
    });
  }

  it("pins connect IP, TLS servername, disables compression, and returns 2xx status", async () => {
    const destination = await resolveSafeOutboundDestination("https://api.example.com/hook", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    mockResponse(202, [Buffer.from("ok")]);
    const status = await sendSafeOutboundHttps(
      {
        destination,
        headers: { "content-type": "application/json" },
        body: Buffer.from("{}"),
      },
      new AbortController().signal,
    );
    expect(status).toBe(202);
  });

  it("destroys redirects immediately by default", async () => {
    const destination = await resolveSafeOutboundDestination("https://api.example.com/hook", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    mockResponse(302);
    await expect(
      sendSafeOutboundHttps({ destination, headers: {} }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "redirect_refused" });
  });

  it("refuses Host header override before connecting", async () => {
    const destination = await resolveSafeOutboundDestination("https://api.example.com/hook", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    await expect(
      sendSafeOutboundHttps(
        { destination, headers: { Host: "internal.other.com" } },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SafeOutboundError);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("destroys oversized responses and scrubs transport errors", async () => {
    const destination = await resolveSafeOutboundDestination("https://api.example.com/hook", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    mockResponse(200, [Buffer.alloc(9000)]);
    await expect(
      sendSafeOutboundHttps(
        { destination, headers: {}, maxResponseBytes: 8192 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "response_too_large" });

    httpsRequestMock.mockImplementation(() => {
      const req = Object.assign(new EventEmitter(), {
        end() {
          req.emit("error", new Error("ECONNREFUSED https://secret-token@example.com"));
          req.emit("close");
        },
        destroy() {},
      });
      return req;
    });
    await expect(
      sendSafeOutboundHttps({ destination, headers: {} }, new AbortController().signal),
    ).rejects.toThrow("Outbound HTTPS request failed.");
  });

  it("refuses unverified forged destinations and ignores URL copy mutations", async () => {
    const forged = {
      href: "https://127.0.0.1/admin",
      url: new URL("https://127.0.0.1/admin"),
      canonicalHost: "127.0.0.1",
      address: "127.0.0.1",
      family: 4 as const,
    };
    await expect(sendSafeOutboundHttps({ destination: forged, headers: {} })).rejects.toMatchObject(
      { code: "unsafe_url" },
    );
    expect(httpsRequestMock).not.toHaveBeenCalled();

    const destination = await resolveSafeOutboundDestination("https://api.example.com/hook", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const copy = destination.url;
    copy.hostname = "127.0.0.1";
    copy.pathname = "/evil";
    let sentHref = "";
    httpsRequestMock.mockImplementation((url, _options, callback) => {
      sentHref = url.href;
      const req = Object.assign(new EventEmitter(), {
        end() {
          const res = Object.assign(new EventEmitter(), {
            statusCode: 200,
            headers: {},
            resume: vi.fn(),
          });
          callback(res);
          res.emit("end");
          req.emit("close");
        },
        destroy() {},
      });
      return req;
    });
    expect(await sendSafeOutboundHttps({ destination, headers: {} })).toBe(200);
    expect(sentHref).toBe("https://api.example.com/hook");
  });

  it("enforces its own finite timeout even without caller cancellation", async () => {
    const destination = await resolveSafeOutboundDestination("https://api.example.com/hook", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    httpsRequestMock.mockImplementation(() => {
      const req = Object.assign(new EventEmitter(), {
        end: vi.fn(),
        destroy(error?: Error) {
          if (error) req.emit("error", error);
          req.emit("close");
        },
      });
      return req;
    });
    await expect(
      sendSafeOutboundHttps({ destination, headers: {}, timeoutMs: 25 }),
    ).rejects.toMatchObject({ code: "transport_failed" });
  });

  it("keeps the body of a read response with its content headers, under the same caps", async () => {
    const destination = await resolveSafeOutboundDestination("https://api.example.com/q", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    mockResponse(200, [Buffer.from('{"a":'), Buffer.from("1}")], {
      "content-type": "application/json; charset=utf-8",
    });
    const response = await readSafeOutboundHttps({ destination, method: "GET", headers: {} });
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/json; charset=utf-8");
    expect(response.body.toString("utf8")).toBe('{"a":1}');

    mockResponse(200, [Buffer.alloc(8000), Buffer.alloc(8000)]);
    await expect(
      readSafeOutboundHttps({ destination, headers: {}, maxResponseBytes: 10_000 }),
    ).rejects.toMatchObject({ code: "response_too_large" });

    mockResponse(301, [], { location: "https://127.0.0.1/" });
    await expect(readSafeOutboundHttps({ destination, headers: {} })).rejects.toMatchObject({
      code: "redirect_refused",
    });
  });

  it("forces Accept-Encoding: identity and rejects non-finite or out-of-range size bounds", async () => {
    const destination = await resolveSafeOutboundDestination("https://api.example.com/hook", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    mockResponse(200);
    expect(
      await sendSafeOutboundHttps({
        destination,
        headers: { "Accept-Encoding": "gzip, br" },
      }),
    ).toBe(200);

    for (const badResponseBytes of [Number.POSITIVE_INFINITY, Number.NaN, -1, 200_000]) {
      await expect(
        sendSafeOutboundHttps({ destination, headers: {}, maxResponseBytes: badResponseBytes }),
      ).rejects.toMatchObject({ code: "unsafe_url" });
    }
    for (const badHeaderSize of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 100_000]) {
      await expect(
        sendSafeOutboundHttps({ destination, headers: {}, maxHeaderSize: badHeaderSize }),
      ).rejects.toMatchObject({ code: "unsafe_url" });
    }
  });
});

describe("parseSafeOutboundJson", () => {
  const response = (
    body: string | Buffer,
    contentType: string | null,
    contentEncoding?: string,
  ) => ({
    status: 200,
    contentType,
    contentEncoding: contentEncoding ?? null,
    body: typeof body === "string" ? Buffer.from(body, "utf8") : body,
  });

  it("reads JSON and +json bodies in UTF-8", () => {
    expect(parseSafeOutboundJson(response('{"rows":[[1,"é"]]}', "application/json"), 64)).toEqual({
      rows: [[1, "é"]],
    });
    expect(
      parseSafeOutboundJson(response("[]", 'application/vnd.api+json; charset="UTF-8"'), 64),
    ).toEqual([]);
  });

  it.each([
    ["text/html", "<html></html>"],
    ["application/json; charset=iso-8859-1", "{}"],
    [null, "{}"],
    ["application/jsonp", "{}"],
  ])("refuses %s responses", (contentType, body) => {
    expect(() => parseSafeOutboundJson(response(body, contentType), 64)).toThrowError(
      expect.objectContaining({ code: "unsupported_response" }),
    );
  });

  it("refuses compressed bodies, invalid UTF-8, invalid JSON, and nesting past the limit", () => {
    expect(() =>
      parseSafeOutboundJson(response("{}", "application/json", "gzip"), 64),
    ).toThrowError(expect.objectContaining({ code: "unsupported_response" }));
    expect(() =>
      parseSafeOutboundJson(response(Buffer.from([0x22, 0xff, 0x22]), "application/json"), 64),
    ).toThrowError(expect.objectContaining({ code: "invalid_json" }));
    expect(() => parseSafeOutboundJson(response('{"a":', "application/json"), 64)).toThrowError(
      expect.objectContaining({ code: "invalid_json" }),
    );
    expect(parseSafeOutboundJson(response("[[[1]]]", "application/json"), 3)).toEqual([[[1]]]);
    expect(() => parseSafeOutboundJson(response("[[[[1]]]]", "application/json"), 3)).toThrowError(
      expect.objectContaining({ code: "invalid_json", message: expect.stringContaining("3 deep") }),
    );
  });
});
