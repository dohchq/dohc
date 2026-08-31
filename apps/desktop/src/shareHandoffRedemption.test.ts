import { describe, expect, it, vi } from "vitest";
import {
  createShareHandoffIntentSlot,
  parseShareHandoffUrl,
  type ShareHandoffIntent,
} from "./shareHandoffIngress";

const CODE_A = "A".repeat(43);
const CODE_B = `${"b".repeat(42)}_`;
const RELAY_A = "https://relay-a.example";
const RELAY_B = "https://relay-b.example";
interface TestCredentials {
  serverUrl: string;
  relayUrl?: string;
  email: string;
  token: string;
  userId: string;
}

const CREDENTIALS_A: TestCredentials = {
  serverUrl: "https://cloud.example",
  relayUrl: "https://relay-a.example/",
  email: "account-a@dohc.test",
  token: "bearer-a",
  userId: "user-a",
};
const CREDENTIALS_B: TestCredentials = {
  serverUrl: "https://cloud.example",
  relayUrl: "https://relay-b.example",
  email: "account-b@dohc.test",
  token: "bearer-b",
  userId: "user-b",
};
const CREDENTIALS_SAME_RELAY_B: TestCredentials = {
  ...CREDENTIALS_B,
  relayUrl: "https://relay-a.example",
};

function intentFor(value: string, relayUrl = RELAY_A): ShareHandoffIntent {
  const parsed = parseShareHandoffUrl(
    `dohc://open/${value}?relay=${encodeURIComponent(relayUrl)}`,
  );
  if (!parsed) throw new Error("test handoff code is invalid");
  return parsed;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<ResponseValue>() {
  let resolve!: (value: ResponseValue) => void;
  const promise = new Promise<ResponseValue>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function harness(options?: {
  credentials?: TestCredentials | null;
  fetch?: typeof fetch;
}) {
  const module = await import("./shareHandoffRedemption");
  const intentSlot = createShareHandoffIntentSlot();
  const settledCodes: string[] = [];
  const intent = {
    ...intentSlot,
    settle(value: ShareHandoffIntent) {
      const settled = intentSlot.settle(value);
      if (settled) settledCodes.push(value.code);
      return settled;
    },
  };
  let credentials = options?.credentials ?? null;
  let credentialGeneration = 0;
  const statuses: Array<{
    status: string;
    statusId?: string;
    shareId?: string;
    email?: string;
  }> = [];
  let nextStatusId = 0;
  const fetchImpl = options?.fetch ?? vi.fn<typeof fetch>();
  const handleUnauthorized = vi.fn(async (requestCredentials: TestCredentials) => {
    if (
      credentials?.serverUrl !== requestCredentials.serverUrl ||
      credentials.userId !== requestCredentials.userId ||
      credentials.token !== requestCredentials.token
    ) {
      return false;
    }
    credentials = null;
    credentialGeneration += 1;
    return true;
  });
  const coordinator = module.createShareHandoffRedemptionCoordinator({
    intent,
    createStatusId: () => `status-${++nextStatusId}`,
    credentialSnapshot: () => ({ credentials, generation: credentialGeneration }),
    fetch: fetchImpl,
    handleUnauthorized,
    publishStatus: (status) => statuses.push(status),
  });
  return {
    coordinator,
    fetchImpl,
    intent,
    settledCodes,
    statuses,
    handleUnauthorized,
    offer(value: string, relayUrl = RELAY_A) {
      intent.offer(intentFor(value, relayUrl));
      coordinator.pendingCodeChanged();
    },
    setCredentials(next: TestCredentials | null) {
      credentials = next;
      credentialGeneration += 1;
      coordinator.credentialsChanged();
    },
    credentials: () => credentials,
  };
}

function success(shareId = "share-redeemed"): Response {
  return response(200, {
    ok: true,
    shareId,
    grantId: "grant-redeemed",
    access: "view",
  });
}

function commentSuccess(shareId = "share-comment"): Response {
  return response(200, {
    ok: true,
    shareId,
    grantId: "grant-comment",
    access: "comment",
  });
}

describe("share handoff redemption coordinator", () => {
  it("refuses a different issuer relay before acceptance without fetching", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const h = await harness({ credentials: CREDENTIALS_B, fetch: fetchImpl });

    h.offer(CODE_A, RELAY_A);

    expect(h.coordinator.status()).toEqual({
      status: "failed-wrong-server",
      statusId: "status-1",
      linkRelayUrl: RELAY_A,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    h.coordinator.accept("status-1");
    h.coordinator.retry();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("moves signed-out ingress to wrong-server only after credentials arrive", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const h = await harness({ fetch: fetchImpl });

    h.offer(CODE_A, RELAY_A);
    expect(h.coordinator.status()).toEqual({
      status: "waiting-for-sign-in",
      statusId: "status-1",
    });

    h.setCredentials(CREDENTIALS_B);
    expect(h.coordinator.status()).toEqual({
      status: "failed-wrong-server",
      statusId: "status-2",
      linkRelayUrl: RELAY_A,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("waits for the signed-in account to accept identity disclosure", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(success());
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);

    expect(h.coordinator.status()).toEqual({
      status: "waiting-for-acceptance",
      statusId: "status-1",
      email: "account-a@dohc.test",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a Comment handoff and settles the pending intent", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(commentSuccess());
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.coordinator.accept("status-1");

    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
        statusId: "status-1",
        shareId: "share-comment",
      });
    });
    expect(h.intent.pending()).toBeNull();
    expect(h.settledCodes).toEqual([CODE_A]);
  });

  it("keeps signed-out ingress waiting and requires acceptance after sign-in", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(success());
    const h = await harness({ fetch: fetchImpl });

    h.offer(CODE_A);

    expect(h.coordinator.status()).toEqual({
      status: "waiting-for-sign-in",
      statusId: "status-1",
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    h.setCredentials(CREDENTIALS_A);

    expect(h.coordinator.status()).toEqual({
      status: "waiting-for-acceptance",
      statusId: "status-2",
      email: "account-a@dohc.test",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    h.coordinator.accept("status-2");

    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
        statusId: "status-2",
        shareId: "share-redeemed",
      });
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a current accept posts exactly once to the credential relay", async () => {
    const answer = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => answer.promise);
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    h.coordinator.accept("status-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://relay-a.example/sync/link-redeem");
    expect(init).toEqual({
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer bearer-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: CODE_A }),
    });
    expect(Object.keys(JSON.parse(String(init?.body)))).toEqual(["code"]);

    answer.resolve(success());
    await vi.waitFor(() => expect(h.coordinator.status().status).toBe("done"));
    h.coordinator.accept("status-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("waits without fetching when signed-in credentials have no relay URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const h = await harness({
      credentials: { ...CREDENTIALS_A, relayUrl: undefined },
      fetch: fetchImpl,
    });

    h.offer(CODE_A);

    expect(h.coordinator.status()).toEqual({
      status: "waiting-for-sign-in",
      statusId: "status-1",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an acceptance identity after the handoff code changes", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.offer(CODE_B);

    expect(h.coordinator.status()).toEqual({
      status: "waiting-for-acceptance",
      statusId: "status-2",
      email: "account-a@dohc.test",
    });
    h.coordinator.accept("status-1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("replaces acceptance when only the issuer relay changes and ignores stale dismissal", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A, RELAY_A);
    h.offer(CODE_A, RELAY_B);
    h.coordinator.dismiss("status-1");

    expect(h.coordinator.status()).toEqual({
      status: "failed-wrong-server",
      statusId: "status-2",
      linkRelayUrl: RELAY_B,
    });
    expect(h.intent.pending()).toEqual(intentFor(CODE_A, RELAY_B));
    h.coordinator.accept("status-1");
    h.coordinator.accept("status-2");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["token rotation", { ...CREDENTIALS_A, token: "bearer-a-rotated" }],
    ["account switch", CREDENTIALS_SAME_RELAY_B],
  ])("rejects an acceptance identity after a %s", async (_label, nextCredentials) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.setCredentials(nextCredentials);

    expect(h.coordinator.status()).toEqual({
      status: "waiting-for-acceptance",
      statusId: "status-2",
      email: nextCredentials.email,
    });
    h.coordinator.accept("status-1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clears a refused code and never retries it", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(404, { ok: false, secret: CODE_A }));
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "failed-refused",
        statusId: "status-1",
      });
    });

    expect(h.intent.pending()).toBeNull();
    h.intent.offer(intentFor(CODE_A));
    const refusedStatus = h.coordinator.status();
    h.coordinator.retry();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.coordinator.status()).toEqual(refusedStatus);
  });

  it("treats an unexpected non-auth 4xx as the same generic refusal", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(409, { detail: "relay-controlled detail" }));
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "failed-refused",
        statusId: "status-1",
      });
    });
    expect(h.intent.pending()).toBeNull();
    expect(JSON.stringify(h.statuses)).not.toContain("relay-controlled detail");
  });

  it("retains a throttled code and lets a manual retry succeed", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(429, { detail: CODE_A }))
      .mockResolvedValueOnce(success());
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    await vi.waitFor(() =>
      expect(h.coordinator.status().status).not.toBe("redeeming"),
    );
    expect(h.intent.pending()).toEqual(intentFor(CODE_A));
    expect(h.coordinator.status()).toEqual({
      status: "failed-busy",
      statusId: "status-1",
    });

    h.coordinator.retry();
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
        statusId: "status-1",
        shareId: "share-redeemed",
      });
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not carry retry acceptance across a credential change", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(429, { ok: false }))
      .mockResolvedValueOnce(success());
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "failed-busy",
        statusId: "status-1",
      });
    });

    h.setCredentials(CREDENTIALS_SAME_RELAY_B);
    expect(h.coordinator.status()).toEqual({
      status: "waiting-for-acceptance",
      statusId: "status-2",
      email: "account-b@dohc.test",
    });
    h.coordinator.retry();
    h.coordinator.accept("status-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    h.coordinator.accept("status-2");
    await vi.waitFor(() => expect(h.coordinator.status().status).toBe("done"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["thrown fetch", () => Promise.reject(new Error("offline"))],
    ["relay 5xx", () => Promise.resolve(response(503, { detail: CODE_A }))],
    [
      "malformed success",
      () =>
        Promise.resolve(
          response(200, {
            ok: true,
            shareId: "share-redeemed",
            grantId: "grant-redeemed",
            access: "edit",
          }),
        ),
    ],
  ])("retains and retries after %s", async (_label, firstAnswer) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(firstAnswer as typeof fetch)
      .mockResolvedValueOnce(success());
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "failed-network",
        statusId: "status-1",
      });
    });
    expect(h.intent.pending()).toEqual(intentFor(CODE_A));

    h.coordinator.retry();
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
        statusId: "status-1",
        shareId: "share-redeemed",
      });
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("invalidates a current 401 completely, waits, and redeems after new credentials", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(401, { token: "must-not-cross" }))
      .mockResolvedValueOnce(success("share-after-login"));
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "waiting-for-sign-in",
        statusId: "status-2",
      });
    });
    expect(h.handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(h.handleUnauthorized).toHaveBeenNthCalledWith(1, CREDENTIALS_A);
    expect(h.credentials()).toBeNull();
    expect(h.intent.pending()).toEqual(intentFor(CODE_A));

    h.setCredentials(CREDENTIALS_SAME_RELAY_B);
    expect(h.coordinator.status()).toEqual({
      status: "waiting-for-acceptance",
      statusId: "status-3",
      email: "account-b@dohc.test",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    h.coordinator.accept("status-3");
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
        statusId: "status-3",
        shareId: "share-after-login",
      });
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "https://relay-a.example/sync/link-redeem",
    );
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: "Bearer bearer-b",
      "content-type": "application/json",
    });
  });

  it("does not let a stale 401 clear newer credentials or repaint newer status", async () => {
    const oldAnswer = deferred<Response>();
    const newAnswer = deferred<Response>();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => oldAnswer.promise)
      .mockImplementationOnce(() => newAnswer.promise);
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    h.setCredentials({ ...CREDENTIALS_A });
    h.coordinator.accept("status-2");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    oldAnswer.resolve(response(401, { ok: false }));
    newAnswer.resolve(success("share-new-session"));
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
        statusId: "status-2",
        shareId: "share-new-session",
      });
    });

    expect(h.settledCodes).toEqual([CODE_A]);
    expect(h.statuses).toEqual([
      {
        status: "waiting-for-acceptance",
        statusId: "status-1",
        email: "account-a@dohc.test",
      },
      { status: "redeeming", statusId: "status-1" },
      {
        status: "waiting-for-acceptance",
        statusId: "status-2",
        email: "account-a@dohc.test",
      },
      { status: "redeeming", statusId: "status-2" },
      { status: "done", statusId: "status-2", shareId: "share-new-session" },
    ]);
    expect(h.credentials()).toEqual(CREDENTIALS_A);
    expect(h.handleUnauthorized).not.toHaveBeenCalled();
    expect(h.coordinator.status()).toEqual({
      status: "done",
      statusId: "status-2",
      shareId: "share-new-session",
    });
    expect(h.intent.pending()).toBeNull();
  });

  it("does not let a stale 401 supersede a distinct newer handoff code", async () => {
    const oldAnswer = deferred<Response>();
    const newAnswer = deferred<Response>();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => oldAnswer.promise)
      .mockImplementationOnce(() => newAnswer.promise);
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    h.offer(CODE_B);
    h.coordinator.accept("status-2");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    oldAnswer.resolve(response(401, { ok: false }));
    newAnswer.resolve(success("share-new"));
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
        statusId: "status-2",
        shareId: "share-new",
      });
    });
    expect(h.settledCodes).toEqual([CODE_B]);
    expect(h.statuses).toEqual([
      {
        status: "waiting-for-acceptance",
        statusId: "status-1",
        email: "account-a@dohc.test",
      },
      { status: "redeeming", statusId: "status-1" },
      {
        status: "waiting-for-acceptance",
        statusId: "status-2",
        email: "account-a@dohc.test",
      },
      { status: "redeeming", statusId: "status-2" },
      { status: "done", statusId: "status-2", shareId: "share-new" },
    ]);
    expect(h.handleUnauthorized).not.toHaveBeenCalled();
    expect(h.credentials()).toEqual(CREDENTIALS_A);
    expect(h.intent.pending()).toBeNull();
  });

  it("keeps the distinct newer code authoritative over an older in-flight completion", async () => {
    const oldAnswer = deferred<Response>();
    const newAnswer = deferred<Response>();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => oldAnswer.promise)
      .mockImplementationOnce(() => newAnswer.promise);
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    h.offer(CODE_B);
    h.coordinator.accept("status-2");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    oldAnswer.resolve(success("share-old"));
    newAnswer.resolve(success("share-new"));
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
        statusId: "status-2",
        shareId: "share-new",
      });
    });
    expect(h.settledCodes).toEqual([CODE_B]);
    expect(h.statuses).toEqual([
      {
        status: "waiting-for-acceptance",
        statusId: "status-1",
        email: "account-a@dohc.test",
      },
      { status: "redeeming", statusId: "status-1" },
      {
        status: "waiting-for-acceptance",
        statusId: "status-2",
        email: "account-a@dohc.test",
      },
      { status: "redeeming", statusId: "status-2" },
      { status: "done", statusId: "status-2", shareId: "share-new" },
    ]);
    expect(h.intent.pending()).toBeNull();
  });

  it("never starts a second request for an exact duplicate delivery", async () => {
    const answer = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => answer.promise);
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(h.coordinator.status()).toEqual({
      status: "redeeming",
      statusId: "status-1",
    });

    answer.resolve(success());
    await vi.waitFor(() => expect(h.coordinator.status().status).toBe("done"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("dismisses retained network state and makes retry a no-op", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "failed-network",
        statusId: "status-1",
      });
    });

    const visible = h.coordinator.status();
    if (visible.status === "idle") throw new Error("handoff was not visible");
    h.coordinator.dismiss(visible.statusId);
    expect(h.coordinator.status()).toEqual({ status: "idle" });
    expect(h.intent.pending()).toBeNull();
    h.intent.offer(intentFor(CODE_A));
    h.coordinator.retry();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.coordinator.status()).toEqual({ status: "idle" });
  });

  it("keeps a newer handoff current when an older visible dismissal arrives late", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    const visibleA = h.coordinator.status();
    if (visibleA.status === "idle") throw new Error("handoff A was not visible");

    h.offer(CODE_B);
    h.coordinator.dismiss(visibleA.statusId);

    expect(h.coordinator.status()).toEqual({
      status: "waiting-for-acceptance",
      statusId: "status-2",
      email: "account-a@dohc.test",
    });
    expect(h.intent.pending()).toEqual(intentFor(CODE_B));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("publishes only the bounded status union, never relay detail or authority", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(404, {
        code: CODE_A,
        grantId: "secret-grant",
        token: "secret-token",
        relayUrl: "https://secret-relay.example",
        detail: "raw response detail",
      }));
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.coordinator.accept("status-1");
    await vi.waitFor(() => expect(h.coordinator.status().status).toBe("failed-refused"));

    const serialized = JSON.stringify(h.statuses);
    expect(serialized).not.toContain(CODE_A);
    expect(serialized).not.toContain("secret-grant");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("secret-relay");
    expect(serialized).not.toContain("raw response detail");
  });
});
