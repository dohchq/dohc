import { describe, expect, it, vi } from "vitest";
import {
  createShareHandoffIntentSlot,
  parseShareHandoffUrl,
  type ShareHandoffCode,
} from "./shareHandoffIngress";

const CODE_A = "A".repeat(43);
const CODE_B = `${"b".repeat(42)}_`;
interface TestCredentials {
  serverUrl: string;
  relayUrl?: string;
  token: string;
  userId: string;
}

const CREDENTIALS_A: TestCredentials = {
  serverUrl: "https://cloud.example",
  relayUrl: "https://relay-a.example/",
  token: "bearer-a",
  userId: "user-a",
};
const CREDENTIALS_B: TestCredentials = {
  serverUrl: "https://cloud.example",
  relayUrl: "https://relay-b.example",
  token: "bearer-b",
  userId: "user-b",
};

function code(value: string): ShareHandoffCode {
  const parsed = parseShareHandoffUrl(`dohc://open/${value}`);
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
  const intent = createShareHandoffIntentSlot();
  let credentials = options?.credentials ?? null;
  let credentialGeneration = 0;
  const statuses: Array<{ status: string; shareId?: string }> = [];
  const unauthorizedTransitions: string[] = [];
  const fetchImpl = options?.fetch ?? vi.fn<typeof fetch>();
  const coordinator = module.createShareHandoffRedemptionCoordinator({
    intent,
    credentialSnapshot: () => ({ credentials, generation: credentialGeneration }),
    fetch: fetchImpl,
    handleUnauthorized: async (requestCredentials) => {
      if (
        credentials?.serverUrl !== requestCredentials.serverUrl ||
        credentials.userId !== requestCredentials.userId ||
        credentials.token !== requestCredentials.token
      ) {
        return false;
      }
      unauthorizedTransitions.push("clear-memory");
      credentials = null;
      credentialGeneration += 1;
      unauthorizedTransitions.push("notify-changing");
      unauthorizedTransitions.push("invalidate-persisted-session");
      unauthorizedTransitions.push("notify-ready");
      return true;
    },
    publishStatus: (status) => statuses.push(status),
  });
  return {
    coordinator,
    fetchImpl,
    intent,
    statuses,
    unauthorizedTransitions,
    offer(value: string) {
      intent.offer(code(value));
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

function immediateSuccess(shareId: string): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({
      ok: true,
      shareId,
      grantId: "grant-redeemed",
      access: "view",
    }),
  } as Response;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("share handoff redemption coordinator", () => {
  it("keeps a signed-out capture waiting, then redeems once after sign-in without renderer input", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(success());
    const h = await harness({ fetch: fetchImpl });

    h.offer(CODE_A);

    expect(h.coordinator.status()).toEqual({ status: "waiting-for-sign-in" });
    expect(fetchImpl).not.toHaveBeenCalled();

    h.setCredentials(CREDENTIALS_A);

    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
        shareId: "share-redeemed",
      });
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("posts exactly the code to the current relay under the current bearer", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(success());
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

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
  });

  it("waits without fetching when signed-in credentials have no relay URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const h = await harness({
      credentials: { ...CREDENTIALS_A, relayUrl: undefined },
      fetch: fetchImpl,
    });

    h.offer(CODE_A);

    expect(h.coordinator.status()).toEqual({ status: "waiting-for-sign-in" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clears a refused code and never retries it", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(404, { ok: false, secret: CODE_A }));
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({ status: "failed-refused" });
    });

    expect(h.intent.pending()).toBeNull();
    h.coordinator.retry();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats an unexpected non-auth 4xx as the same generic refusal", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(409, { detail: "relay-controlled detail" }));
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({ status: "failed-refused" });
    });
    expect(h.intent.pending()).toBeNull();
    expect(JSON.stringify(h.statuses)).not.toContain("relay-controlled detail");
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
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({ status: "failed-network" });
    });
    expect(h.intent.pending()).toBe(CODE_A);

    h.coordinator.retry();
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
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
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({ status: "waiting-for-sign-in" });
    });
    expect(h.unauthorizedTransitions).toEqual([
      "clear-memory",
      "notify-changing",
      "invalidate-persisted-session",
      "notify-ready",
    ]);
    expect(h.intent.pending()).toBe(CODE_A);

    h.setCredentials(CREDENTIALS_B);
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
        shareId: "share-after-login",
      });
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale 401 clear newer credentials or repaint newer status", async () => {
    const oldAnswer = deferred<Response>();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => oldAnswer.promise)
      .mockResolvedValueOnce(success("share-new-session"));
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    h.setCredentials({ ...CREDENTIALS_A });
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
        shareId: "share-new-session",
      });
    });

    oldAnswer.resolve(response(401, { ok: false }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(h.credentials()).toEqual(CREDENTIALS_A);
    expect(h.unauthorizedTransitions).toEqual([]);
    expect(h.coordinator.status()).toEqual({
      status: "done",
      shareId: "share-new-session",
    });
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
    h.offer(CODE_B);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    oldAnswer.resolve(response(401, { ok: false }));
    await flushMicrotasks();
    expect(h.unauthorizedTransitions).toEqual([]);
    expect(h.credentials()).toEqual(CREDENTIALS_A);
    expect(h.intent.pending()).toBe(CODE_B);
    expect(h.coordinator.status()).toEqual({ status: "redeeming" });

    newAnswer.resolve(success("share-new"));
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
        shareId: "share-new",
      });
    });
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
    h.offer(CODE_B);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    oldAnswer.resolve(immediateSuccess("share-old"));
    await flushMicrotasks();
    expect(h.coordinator.status()).toEqual({ status: "redeeming" });
    expect(h.intent.pending()).toBe(CODE_B);

    newAnswer.resolve(success("share-new"));
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({
        status: "done",
        shareId: "share-new",
      });
    });
  });

  it("never starts a second request for an exact duplicate delivery", async () => {
    const answer = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => answer.promise);
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    h.offer(CODE_A);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    answer.resolve(success());
    await vi.waitFor(() => expect(h.coordinator.status().status).toBe("done"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("dismisses retained network state and makes retry a no-op", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const h = await harness({ credentials: CREDENTIALS_A, fetch: fetchImpl });

    h.offer(CODE_A);
    await vi.waitFor(() => {
      expect(h.coordinator.status()).toEqual({ status: "failed-network" });
    });

    h.coordinator.dismiss();
    expect(h.coordinator.status()).toEqual({ status: "idle" });
    expect(h.intent.pending()).toBeNull();
    h.coordinator.retry();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    await vi.waitFor(() => expect(h.coordinator.status().status).toBe("failed-refused"));

    const serialized = JSON.stringify(h.statuses);
    expect(serialized).not.toContain(CODE_A);
    expect(serialized).not.toContain("secret-grant");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("secret-relay");
    expect(serialized).not.toContain("raw response detail");
  });
});
