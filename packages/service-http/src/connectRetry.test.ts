import { describe, expect, it } from "vitest";
import { withConnectRetry } from "./connectRetry";

function connectError(code: string): TypeError {
  const cause = Object.assign(new Error(code), { code });
  return new TypeError("fetch failed", { cause });
}

describe("withConnectRetry", () => {
  it("retries pre-connect failures until the upstream answers", async () => {
    let attempts = 0;
    const retrying = withConnectRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw connectError("ECONNREFUSED");
        return new Response("ok", { status: 200 });
      },
      { timeoutMs: 2_000, intervalMs: 5 },
    );

    const response = await retrying("http://sync-relay:1788/ready");
    expect(response.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it("retries AggregateError when every inner error is a pre-connect error", async () => {
    let attempts = 0;
    const retrying = withConnectRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          const aggregate = new AggregateError([
            Object.assign(new Error("v6"), { code: "ECONNREFUSED" }),
            Object.assign(new Error("v4"), { code: "ECONNREFUSED" }),
          ]);
          throw new TypeError("fetch failed", { cause: aggregate });
        }
        return new Response("ok");
      },
      { timeoutMs: 2_000, intervalMs: 5 },
    );

    const response = await retrying("http://sync-relay:1788/ready");
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("never retries HTTP error responses or post-connect socket errors", async () => {
    let statusAttempts = 0;
    const retryingStatus = withConnectRetry(
      async () => {
        statusAttempts += 1;
        return new Response("bad gateway", { status: 502 });
      },
      { timeoutMs: 2_000, intervalMs: 5 },
    );
    expect((await retryingStatus("http://sync-relay:1788/ready")).status).toBe(502);
    expect(statusAttempts).toBe(1);

    let resetAttempts = 0;
    const retryingReset = withConnectRetry(
      async () => {
        resetAttempts += 1;
        throw connectError("ECONNRESET");
      },
      { timeoutMs: 2_000, intervalMs: 5 },
    );
    await expect(retryingReset("http://sync-relay:1788/ready")).rejects.toThrow("fetch failed");
    expect(resetAttempts).toBe(1);
  });

  it("clones Request bodies only when retryRequestBody is enabled", async () => {
    let disabledAttempts = 0;
    const noBodyRetry = withConnectRetry(
      async () => {
        disabledAttempts += 1;
        throw connectError("ECONNREFUSED");
      },
      { timeoutMs: 2_000, intervalMs: 5 },
    );
    await expect(
      noBodyRetry(new Request("http://sync-relay:1788/sync", { method: "POST", body: "data" })),
    ).rejects.toThrow("fetch failed");
    expect(disabledAttempts).toBe(1);

    const bodies: string[] = [];
    const withBodyRetry = withConnectRetry(
      async (input) => {
        const request = input as Request;
        bodies.push(await request.text());
        if (bodies.length < 3) throw connectError("ECONNREFUSED");
        return new Response("signed-in", { status: 200 });
      },
      { timeoutMs: 2_000, intervalMs: 5, retryRequestBody: true },
    );
    const response = await withBodyRetry(
      new Request("http://workspace-api:1786/api/auth/sign-in/email", {
        method: "POST",
        body: '{"email":"a@b.test"}',
      }),
    );
    expect(response.status).toBe(200);
    expect(bodies).toEqual([
      '{"email":"a@b.test"}',
      '{"email":"a@b.test"}',
      '{"email":"a@b.test"}',
    ]);
  });

  it("retries bodyless Request objects and stops immediately when signal aborts", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const retrying = withConnectRetry(
      async () => {
        attempts += 1;
        if (attempts === 2) controller.abort();
        throw connectError("ENOTFOUND");
      },
      { timeoutMs: 2_000, intervalMs: 500 },
    );
    await expect(
      retrying(new Request("http://sync-relay:1788/ready", { signal: controller.signal })),
    ).rejects.toThrow("fetch failed");
    expect(attempts).toBe(2);
  });

  it("never retries ReadableStream init bodies", async () => {
    let attempts = 0;
    const retrying = withConnectRetry(
      async () => {
        attempts += 1;
        throw connectError("ECONNREFUSED");
      },
      { timeoutMs: 2_000, intervalMs: 5 },
    );
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    await expect(
      retrying("http://sync-relay:1788/upload", {
        method: "POST",
        body: stream,
        // @ts-expect-error Node fetch accepts duplex for streaming bodies
        duplex: "half",
      }),
    ).rejects.toThrow("fetch failed");
    expect(attempts).toBe(1);
  });
});
