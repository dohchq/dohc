import { describe, expect, it, vi } from "vitest";
import { sendDeclaredHttps, type DeclaredHttpsTransport } from "./declaredHttps";
import { SafeOutboundError, type SafeOutboundRequest } from "./safeOutboundHttps";

const SECRET = "phx_live/secret+key";

function transport(answer: { status?: number; contentType?: string; body: string } | Error) {
  const sent: SafeOutboundRequest[] = [];
  const allowed: string[][] = [];
  const value: DeclaredHttpsTransport = {
    resolve: vi.fn(async (url: string, hosts: ReadonlySet<string>) => {
      allowed.push([...hosts]);
      return { href: url } as never;
    }),
    read: vi.fn(async (request: SafeOutboundRequest) => {
      sent.push(request);
      if (answer instanceof Error) throw answer;
      return {
        status: answer.status ?? 200,
        contentType: answer.contentType ?? "application/json; charset=utf-8",
        body: Buffer.from(answer.body),
      };
    }),
  };
  return { value, sent, allowed };
}

const send = (
  t: DeclaredHttpsTransport,
  secret = vi.fn(async () => ({ header: "Authorization", prefix: "Bearer ", value: SECRET })),
) =>
  sendDeclaredHttps({
    request: {
      method: "POST",
      url: "https://us.posthog.com/api/projects/1/query/",
      headers: { "Content-Type": "application/json" },
      body: '{"q":1}',
    },
    host: "us.posthog.com",
    secret,
    maxResponseBytes: 4096,
    timeoutMs: 10_000,
    transport: t,
  });

describe("sendDeclaredHttps", () => {
  it("sends to the declared host only, with the secret in its header, and returns JSON", async () => {
    const t = transport({ status: 404, body: '{"detail":"Not found"}' });
    await expect(send(t.value)).resolves.toEqual({ status: 404, data: { detail: "Not found" } });
    expect(t.allowed).toEqual([["us.posthog.com"]]);
    expect(t.sent[0]).toMatchObject({
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "User-Agent": "dohc-app/1" },
      rejectRedirects: true,
      maxResponseBytes: 4096,
      timeoutMs: 10_000,
    });
  });

  it("reads the secret only once the address is checked", async () => {
    const t = transport(new SafeOutboundError("unsafe_address", "x"));
    t.value.resolve = vi.fn(async () => {
      throw new SafeOutboundError("unsafe_address", "x");
    });
    const secret = vi.fn(async () => ({ header: "Authorization", prefix: "", value: SECRET }));
    await expect(send(t.value, secret)).rejects.toMatchObject({ code: "unsafe_address" });
    expect(secret).not.toHaveBeenCalled();
  });

  it.each([
    ["raw", `{"echo":"${SECRET}"}`],
    ["JSON-escaped", `{"echo":"phx_live\\/secret+key"}`],
    ["unicode-escaped", `{"echo":"phx_live\\u002fsecret+key"}`],
    ["URL-encoded", `{"echo":"${encodeURIComponent(SECRET)}"}`],
    ["as a key", `{"${SECRET}":1}`],
  ])("withholds an answer that repeats the secret (%s)", async (_form, body) => {
    await expect(send(transport({ body }).value)).rejects.toMatchObject({
      code: "secret_echoed",
      message: expect.not.stringContaining(SECRET),
    });
  });

  it.each([
    [{ contentType: "text/html", body: "<html>" }, "unexpected_content_type"],
    [{ contentType: "application/problem+json", body: "{" }, "invalid_json"],
  ])("refuses an answer that isn't JSON: %j", async (answer, code) => {
    await expect(send(transport(answer).value)).rejects.toMatchObject({ code });
  });

  it("names the operation's own limit, and scrubs transport errors", async () => {
    await expect(
      send(transport(new SafeOutboundError("response_too_large", "x")).value),
    ).rejects.toMatchObject({
      message: "The service's answer is over this operation's 4096-byte limit.",
    });
    await expect(send(transport(new Error(`ECONNRESET ${SECRET}`)).value)).rejects.toMatchObject({
      code: "transport_failed",
      message: expect.not.stringContaining(SECRET),
    });
  });
});
