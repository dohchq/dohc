import { describe, expect, it, vi } from "vitest";
import { ServerError } from "./client";
import { DEVICE_CLIENT_ID, startDeviceSignIn, waitForDeviceToken, type DeviceSignIn } from "./deviceFlow";
import { deferred, testServer, type Answer } from "./testServer";

const CODE = { device_code: "dev-1", user_code: "ABCD2345", verification_uri: "https://elsewhere.example/device",
  verification_uri_complete: "https://elsewhere.example/device?user_code=ABCD2345", expires_in: 600, interval: 3 };
const pending = { status: 400, body: { error: "authorization_pending", error_description: "pending" } } as const;

function runtime(server: ReturnType<typeof testServer>, clock = { now: 0 }) {
  const waits: number[] = [];
  return {
    waits,
    clock,
    fetch: server.fetch,
    signal: new AbortController().signal,
    now: () => clock.now,
    sleep: async (ms: number) => { waits.push(ms); clock.now += ms; },
  };
}

const start: DeviceSignIn = { deviceCode: "dev-1", userCode: "ABCD2345", approvalUrl: "", intervalMs: 3000, expiresAtMs: 600_000 };

describe("starting a device sign-in", () => {
  it("asks for a code and opens the typed server's own approval page", async () => {
    const server = testServer();
    server.on("POST", "/api/auth/device/code", { status: 200, body: CODE });
    const started = await startDeviceSignIn(server.origin, runtime(server));
    expect(started).toEqual({ deviceCode: "dev-1", userCode: "ABCD2345", approvalUrl: "https://dohc.example.com/device?user_code=ABCD2345",
      intervalMs: 5000, expiresAtMs: 600_000 });
    expect(server.calls[0]!.body).toEqual({ client_id: DEVICE_CLIENT_ID });
  });

  it("polls no faster than every 5 seconds, whatever the server asks", async () => {
    for (const [interval, ms] of [[1, 5000], [3, 5000], [10, 10_000]] as const) {
      const server = testServer();
      server.on("POST", "/api/auth/device/code", { status: 200, body: { ...CODE, interval } });
      expect((await startDeviceSignIn(server.origin, runtime(server))).intervalMs).toBe(ms);
    }
  });

    it("refuses an answer it can't use", async () => {
    const server = testServer();
    server.on("POST", "/api/auth/device/code", { status: 200, body: { ...CODE, user_code: "<script>" } });
    await expect(startDeviceSignIn(server.origin, runtime(server))).rejects.toEqual(new ServerError("invalid", 200));
  });
});

describe("polling for the token", () => {
  function poll(...answers: Answer[]) {
    const server = testServer();
    server.on("POST", "/api/auth/device/token", ...answers);
    const run = runtime(server);
    return { server, run, outcome: waitForDeviceToken(server.origin, start, run) };
  }

  it("waits the server's interval while approval is pending, then takes the token", async () => {
    const { server, run, outcome } = poll(pending, pending, { status: 200, body: { access_token: "session-token", token_type: "Bearer" } });
    expect(await outcome).toEqual({ kind: "token", token: "session-token" });
    expect(run.waits).toEqual([3000, 3000, 3000]);
    expect(server.calls[0]!.body).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "dev-1", client_id: DEVICE_CLIENT_ID });
  });

  it("adds 5 seconds to the interval on each slow_down", async () => {
    const slowDown = { status: 400, body: { error: "slow_down" } };
    const { run, outcome } = poll(slowDown, slowDown, pending, { status: 200, body: { access_token: "t" } });
    await outcome;
    expect(run.waits).toEqual([3000, 8000, 13000, 13000]);
  });

  it("stops when the person denies the code", async () => {
    expect(await poll(pending, { status: 400, body: { error: "access_denied" } }).outcome).toEqual({ kind: "denied" });
  });

  it("stops when the code expired on the server", async () => {
    expect(await poll({ status: 400, body: { error: "expired_token" } }).outcome).toEqual({ kind: "expired" });
    expect(await poll({ status: 400, body: { error: "invalid_grant" } }).outcome).toEqual({ kind: "expired" });
  });

  it("stops at the code's own expiry without asking again", async () => {
    const server = testServer();
    server.on("POST", "/api/auth/device/token", pending);
    const run = runtime(server, { now: 590_000 });
    // It asks at 593, 596 and 599 s. The next wait passes the 600 s expiry, so it stops without asking.
    expect(await waitForDeviceToken(server.origin, start, run)).toEqual({ kind: "expired" });
    expect(server.calls).toHaveLength(3);
  });

  it("returns a token that arrives after a cancel, and never aborts that request", async () => {
    const server = testServer();
    const held = deferred<Answer>();
    server.on("POST", "/api/auth/device/token", () => held.promise);
    const cancel = new AbortController();
    const run = { ...runtime(server), signal: cancel.signal };
    const outcome = waitForDeviceToken(server.origin, start, run);
    await vi.waitFor(() => expect(server.calls).toHaveLength(1));
    cancel.abort();
    expect(server.calls[0]!.signal.aborted).toBe(false);
    held.resolve({ status: 200, body: { access_token: "late" } });
    expect(await outcome).toEqual({ kind: "token", token: "late" });
  });

  it("stops at a cancel when the answer isn't a token", async () => {
    const server = testServer();
    const held = deferred<Answer>();
    server.on("POST", "/api/auth/device/token", () => held.promise);
    const cancel = new AbortController();
    const outcome = waitForDeviceToken(server.origin, start, { ...runtime(server), signal: cancel.signal });
    await vi.waitFor(() => expect(server.calls).toHaveLength(1));
    cancel.abort();
    held.resolve(pending);
    await expect(outcome).rejects.toEqual(new ServerError("cancelled"));
  });

    it("rejects when the server can't be reached or answers something else", async () => {
    await expect(poll("offline").outcome).rejects.toEqual(new ServerError("offline"));
    await expect(poll({ status: 503 }).outcome).rejects.toEqual(new ServerError("server-busy", 503));
    await expect(poll({ status: 200, body: {} }).outcome).rejects.toEqual(new ServerError("invalid", 200));
  });
});
