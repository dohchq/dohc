import { describe, expect, it, vi } from "vitest";
import { discoverServer } from "./serverDiscovery";

const descriptor = { version: 1, authUrl: "https://server.test", relayUrl: "https://server.test", shareUrl: "https://server.test" };

describe("server discovery", () => {
  it("discovers endpoints without sending credentials or following redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(descriptor));
    await expect(discoverServer(" https://SERVER.test/ ", fetcher)).resolves.toEqual(descriptor);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://server.test/.well-known/dohc-server");
    expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
    expect(init?.headers).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    { ...descriptor, authUrl: "https://other.test" },
    { ...descriptor, relayUrl: "https://other.test" },
    { ...descriptor, shareUrl: "https://other.test" },
    { ...descriptor, version: 2 },
    { ...descriptor, relayUrl: "https://relay.test/api" },
    { ...descriptor, relayUrl: "https://user:password@relay.test" },
    { ...descriptor, shareUrl: "https://share.test?secret=yes" },
    { ...descriptor, unknown: true },
    { ...descriptor, networkAccess: "maybe" },
    { ...descriptor, name: "x".repeat(101) },
    { ...descriptor, name: "Bad\nname" },
    null,
    [],
  ])("rejects invalid or cross-origin auth descriptions", async value => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(value));
    await expect(discoverServer("https://server.test", fetcher)).rejects.toThrow("connection description");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("permits optional validated display metadata", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...descriptor, name: "My server", networkAccess: "private" }));
    await expect(discoverServer("https://server.test", fetcher)).resolves.toEqual({ ...descriptor, name: "My server", networkAccess: "private" });
  });

  it("rejects a remote deployment advertising loopback plaintext endpoints", async () => {
    await expect(discoverServer("https://server.test", async () => Response.json({ ...descriptor, relayUrl: "http://localhost:1788" }))).rejects.toThrow("unsupported connection description");
  });

  it("allows an explicit loopback deployment", async () => {
    const local = { version: 1, authUrl: "http://localhost:1786", relayUrl: "http://localhost:1786", shareUrl: "http://localhost:1786" };
    await expect(discoverServer(local.authUrl, async () => Response.json(local))).resolves.toEqual(local);
  });

  it.each([
    () => new Response("<html>proxy error</html>", { headers: { "content-type": "text/html" } }),
    () => new Response("not json", { headers: { "content-type": "application/json" } }),
    () => Response.json({ ...descriptor, padding: "x".repeat(16 * 1024) }),
    () => new Response(null, { status: 204, headers: { "content-type": "application/json" } }),
  ])("rejects malformed and oversized response bodies", async response => {
    await expect(discoverServer("https://server.test", async () => response())).rejects.toThrow("invalid connection description");
  });

  it("reports a missing endpoint separately from network failure", async () => {
    await expect(discoverServer("https://server.test", async () => new Response(null, { status: 404 }))).rejects.toThrow("does not provide a dohc server connection");
    await expect(discoverServer("https://server.test", async () => { throw new Error("TLS"); })).rejects.toThrow("could not reach this server");
  });
});
