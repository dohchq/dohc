import { it, expect, vi } from "vitest";
import {
  MessageChannel as NodeMessageChannel,
  type MessagePort as NodeMessagePort,
} from "node:worker_threads";
import { once } from "node:events";
import { attachAppCollectionBroker } from "@dohc/app-browser/broker";

function harness(
  send: (
    body: unknown,
    signal: AbortSignal,
    request: { activated: boolean },
  ) => Promise<Response> = async (body) => Response.json(body),
) {
  vi.stubGlobal("MessageChannel", NodeMessageChannel);
  const frame = new EventTarget();
  let port!: NodeMessagePort;
  Object.assign(frame, {
    contentWindow: {
      postMessage(message: unknown, target: string, ports: NodeMessagePort[]) {
        expect(message).toEqual({ kind: "dohc-app-channel", version: 1 });
        expect(target).toBe("*");
        expect(ports).toHaveLength(1);
        port = ports[0]!;
      },
    },
  });
  const lifetime = new AbortController();
  attachAppCollectionBroker(frame as HTMLIFrameElement, send, lifetime.signal);
  frame.dispatchEvent(new Event("load"));
  const request = (body: unknown) => {
    const response = once(port, "message");
    port.postMessage(body);
    return response.then(([value]) => value);
  };
  return {
    frame,
    port,
    lifetime,
    request,
    close() {
      lifetime.abort();
      vi.unstubAllGlobals();
    },
  };
}
it("forwards collection list/create and returns data without session material", async () => {
  const calls: unknown[] = [];
  const f = harness(async (body) => {
    calls.push(body);
    return Response.json({ records: [], nextPath: null });
  });
  try {
    expect(await f.request({ id: "list", op: "collection.list", limit: 50 })).toEqual({
      id: "list",
      ok: true,
      value: { records: [], nextPath: null },
    });
    expect(
      (
        await f.request({
          id: "create",
          op: "collection.create",
          idempotencyKey: "vote",
          fields: { destination: "Tokyo" },
        })
      ).ok,
    ).toBe(true);
    expect(await f.request({ id: "fetch", op: "fetch", url: "https://private" })).toEqual({
      id: "fetch",
      ok: false,
      status: 400,
    });
    expect(
      await f.request({ id: "extra", op: "collection.list", limit: 1, authorityRevision: 99 }),
    ).toEqual({ id: "extra", ok: false, status: 400 });
    expect(calls).toHaveLength(2);
  } finally {
    f.close();
  }
});
it("reports the bootstrap window activation and refuses one the app sends", async () => {
  // The page opened already activated, as a browser can open it.
  let isActive = true;
  vi.stubGlobal("navigator", {
    userActivation: {
      get isActive() {
        return isActive;
      },
    },
  });
  const seen: unknown[] = [];
  const f = harness(async (_body, _signal, request) => {
    seen.push(request);
    return Response.json({});
  });
  try {
    expect((await f.request({ id: "opened", op: "collection.list", limit: 1 })).ok).toBe(true);
    isActive = false;
    expect((await f.request({ id: "idle", op: "collection.list", limit: 1 })).ok).toBe(true);
    isActive = true;
    expect((await f.request({ id: "pressed", op: "collection.list", limit: 1 })).ok).toBe(true);
    isActive = false;
    expect(
      (
        await f.request({
          id: "claimed",
          op: "collection.create",
          idempotencyKey: "vote",
          fields: { destination: "Tokyo" },
          activated: true,
        })
      ).status,
    ).toBe(400);
    expect(seen).toEqual([{ activated: false }, { activated: false }, { activated: true }]);
  } finally {
    f.close();
  }
});
it("forwards backend operations, uploads, and file reads while rejecting supplied authority", async () => {
  const calls: unknown[] = [];
  const f = harness(async (body) => {
    calls.push(body);
    return Response.json({ result: null });
  });
  try {
    const invoke = {
      id: "invoke",
      op: "backend.invoke",
      operation: "register",
      idempotencyKey: "attempt-1",
      input: {},
    };
    const uploadBytes = new Uint8Array([37, 80, 68, 70]).buffer;
    const upload = {
      id: "upload",
      op: "backend.upload",
      idempotencyKey: "upload-1",
      name: "receipt.pdf",
      contentType: "application/pdf",
      bytes: uploadBytes,
    };
    const file = {
      id: "file",
      op: "backend.file",
      fileId: "file_0123456789abcdef",
      operation: "receipt.read",
      input: {},
    };
    const attempt = {
      id: "attempt",
      op: "backend.attempt",
      operation: "register",
      request: { action: "get" },
    };
    for (const body of [invoke, upload, attempt]) expect((await f.request(body)).ok).toBe(true);
    for (const body of [
      { ...invoke, caller: { kind: "owner" } },
      { ...upload, path: "private" },
      { ...file, authorityRevision: 1 },
    ])
      expect((await f.request(body)).status).toBe(400);
    expect((await f.request({ ...attempt, principalKey: "other" })).status).toBe(400);
    expect(calls).toEqual([invoke, upload, attempt]);
  } finally {
    f.close();
  }
});
it("uses bounded binary file budgets without widening operation replies", async () => {
  const largeBytes = new Uint8Array(15 * 1024 * 1024);
  largeBytes.set([37, 80, 68, 70, 45]);
  const fileMeta = {
    fileId: "file_0123456789abcdef",
    name: "report.pdf",
    contentType: "application/pdf",
    byteLength: largeBytes.byteLength,
    sha256: "a".repeat(64),
  };
  const f = harness(async (body) => {
    const req = body as { op?: string };
    if (req.op === "backend.file") {
      return new Response(largeBytes, {
        headers: {
          "content-type": "application/octet-stream",
          "x-dohc-app-file": encodeURIComponent(JSON.stringify(fileMeta)),
        },
      });
    }
    if (req.op === "backend.invoke") return Response.json({ text: "A".repeat(2 * 1024 * 1024) });
    return Response.json({ file: fileMeta, replayed: false });
  });
  try {
    const fileRes = (await f.request({
      id: "file",
      op: "backend.file",
      fileId: "file_0123456789abcdef",
      operation: "receipt.read",
      input: {},
    })) as { ok: boolean; value?: { file: typeof fileMeta; bytes: ArrayBuffer } };
    expect(fileRes.ok).toBe(true);
    expect(fileRes.value?.file).toEqual(fileMeta);
    expect(fileRes.value?.bytes).toBeInstanceOf(ArrayBuffer);
    expect(fileRes.value?.bytes.byteLength).toBe(largeBytes.byteLength);
    expect(
      (
        await f.request({
          id: "invoke",
          op: "backend.invoke",
          operation: "read",
          idempotencyKey: "read-1",
          input: {},
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await f.request({
          id: "large",
          op: "backend.invoke",
          operation: "read",
          idempotencyKey: "read-1",
          input: "x".repeat(128 * 1024),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await f.request({
          id: "upload",
          op: "backend.upload",
          idempotencyKey: "upload-1",
          name: "file",
          contentType: "application/pdf",
          bytes: new Uint8Array(15 * 1024 * 1024).buffer,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await f.request({
          id: "oversize",
          op: "backend.upload",
          idempotencyKey: "upload-2",
          name: "file",
          contentType: "application/pdf",
          bytes: new Uint8Array(20 * 1024 * 1024 + 1).buffer,
        })
      ).status,
    ).toBe(413);
  } finally {
    f.close();
  }
});
it("bounds backend workflow bursts while preserving the collection budget", async () => {
  const f = harness();
  try {
    for (let index = 0; index < 30; index++)
      expect(
        (
          await f.request({
            id: "u" + index,
            op: "backend.upload",
            idempotencyKey: "upload-" + index,
            name: "file",
            contentType: "application/pdf",
            bytes: new Uint8Array([37, 80, 68, 70]).buffer,
          })
        ).ok,
      ).toBe(true);
    for (let index = 0; index < 12; index++)
      expect((await f.request({ id: "c" + index, op: "collection.list", limit: 1 })).ok).toBe(true);
    expect((await f.request({ id: "list", op: "collection.list", limit: 1 })).status).toBe(429);
    expect(
      (
        await f.request({
          id: "invoke",
          op: "backend.invoke",
          operation: "register",
          idempotencyKey: "attempt-1",
          input: {},
        })
      ).status,
    ).toBe(429);
  } finally {
    f.close();
  }
});
it("bounds requests, pending messages and repeated request ids", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = harness(async () => {
    await held;
    return Response.json({});
  });
  try {
    expect(
      await f.request({
        id: "large",
        op: "collection.create",
        idempotencyKey: "vote",
        fields: { text: "x".repeat(17000) },
      }),
    ).toEqual({ id: "large", ok: false, status: 413 });
    f.port.postMessage({ id: "held", op: "collection.list", limit: 1 });
    expect(await f.request({ id: "held", op: "collection.list", limit: 1 })).toEqual({
      id: "held",
      ok: false,
      status: 429,
      error: {
        code: "duplicate_id",
        message:
          "Duplicate request id: at most 1 in-flight request per id (1 already active). Wait for it to finish or use a new id.",
      },
    });
    for (const id of ["b", "c", "d"]) f.port.postMessage({ id, op: "collection.list", limit: 1 });
    expect(await f.request({ id: "overflow", op: "collection.list", limit: 1 })).toEqual({
      id: "overflow",
      ok: false,
      status: 429,
      error: {
        code: "rate_limited",
        message:
          "Rate limit reached: at most 4 concurrent requests allowed (4 currently in flight). Wait for an active request to finish, then try again.",
      },
    });
  } finally {
    f.close();
    release();
  }
});
it.each(["frame", "session"])(
  "closes the channel and cancels pending responses on stale %s",
  async (kind) => {
    let admitted!: () => void, release!: () => void, signal!: AbortSignal;
    const ready = new Promise<void>((resolve) => {
        admitted = resolve;
      }),
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    const f = harness(async (_body, current) => {
      signal = current;
      admitted();
      await hold;
      return Response.json({ private: "must not arrive" });
    });
    try {
      f.port.postMessage({ id: "pending", op: "collection.list", limit: 1 });
      await ready;
      const closed = once(f.port, "close");
      if (kind === "frame") f.frame.dispatchEvent(new Event("load"));
      else f.lifetime.abort();
      expect(signal.aborted).toBe(true);
      await closed;
      release();
    } finally {
      f.close();
      release();
    }
  },
);
it("passes authority refusal and conflict while hiding arbitrary upstream errors", async () => {
  const statuses = [404, 409, 500];
  const f = harness(async () => new Response(null, { status: statuses.shift()! }));
  try {
    for (const [id, status] of [
      ["revoked", 404],
      ["conflict", 409],
      ["offline", 503],
    ] as const)
      expect(await f.request({ id, op: "collection.list", limit: 1 })).toEqual({
        id,
        ok: false,
        status,
      });
  } finally {
    f.close();
  }
});
it("bounds reply bytes and cancels unread error bodies", async () => {
  let cancelled = false;
  const responses = [
    new Response("x".repeat(1024 * 1024 + 1)),
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 404 },
    ),
  ];
  const f = harness(async () => responses.shift()!);
  try {
    expect(await f.request({ id: "large", op: "collection.list", limit: 1 })).toEqual({
      id: "large",
      ok: false,
      status: 503,
    });
    expect(await f.request({ id: "error", op: "collection.list", limit: 1 })).toEqual({
      id: "error",
      ok: false,
      status: 404,
    });
    expect(cancelled).toBe(true);
  } finally {
    f.close();
  }
});

it("returns safe app refusal text and hides invalid backend errors", async () => {
  const values = [
    { code: "full", message: "This session is full." },
    { code: "full", message: "private", stack: "secret" },
    { code: "full", message: "x".repeat(8193) },
  ];
  const f = harness(async () => Response.json(values.shift(), { status: 409 }));
  try {
    const request = {
      op: "backend.invoke",
      operation: "register",
      idempotencyKey: "attempt-1",
      input: {},
    };
    expect(await f.request({ ...request, id: "safe" })).toEqual({
      id: "safe",
      ok: false,
      status: 409,
      error: { code: "full", message: "This session is full." },
    });
    for (const id of ["private", "large"])
      expect(await f.request({ ...request, id })).toEqual({ id, ok: false, status: 503 });
  } finally {
    f.close();
  }
});

it("observes handshake, pre-forward rejections, and post-validation outcomes without breaking delivery", async () => {
  vi.stubGlobal("MessageChannel", NodeMessageChannel);
  const frame = new EventTarget();
  let port!: NodeMessagePort;
  Object.assign(frame, {
    contentWindow: {
      postMessage(_message: unknown, _target: string, ports: NodeMessagePort[]) {
        port = ports[0]!;
      },
    },
  });
  const events: unknown[] = [];
  const replies = [
    () => Response.json({ result: { ok: 1 }, revision: 1, replayed: false }),
    () => Response.json({ code: "workshop_full", message: "Full" }, { status: 409 }),
    () => Response.json({ code: "bad", message: "bad", extra: true }, { status: 409 }),
  ];
  const lifetime = new AbortController();
  attachAppCollectionBroker(
    frame as HTMLIFrameElement,
    async () => replies.shift()!(),
    lifetime.signal,
    (event) => {
      events.push(event);
      if (event.kind === "handshake-delivered") throw new Error("observer failure ignored");
    },
  );
  try {
    frame.dispatchEvent(new Event("load"));
    const send = (body: unknown) => {
      const reply = once(port, "message");
      port.postMessage(body);
      return reply.then(([value]) => value);
    };
    port.postMessage({ id: "", op: "backend.invoke", operation: "bookSeat" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await send({ id: "bad-keys", op: "backend.invoke", operation: "bookSeat" })).toEqual({
      id: "bad-keys",
      ok: false,
      status: 400,
    });
    expect(
      await send({
        id: "ok-1",
        op: "backend.invoke",
        operation: "bookSeat",
        idempotencyKey: "k1",
        input: {},
      }),
    ).toMatchObject({ id: "ok-1", ok: true });
    expect(
      await send({
        id: "refused-1",
        op: "backend.invoke",
        operation: "bookSeat",
        idempotencyKey: "k2",
        input: {},
      }),
    ).toMatchObject({ id: "refused-1", ok: false, status: 409 });
    expect(
      await send({
        id: "bad-409",
        op: "backend.invoke",
        operation: "bookSeat",
        idempotencyKey: "k3",
        input: {},
      }),
    ).toEqual({ id: "bad-409", ok: false, status: 503 });
    expect(events).toEqual([
      { kind: "handshake-delivered" },
      {
        kind: "rejected",
        reason: "invalid_id",
        status: null,
        op: "backend.invoke",
        operation: "bookSeat",
      },
      {
        kind: "rejected",
        reason: "invalid_keys",
        status: 400,
        op: "backend.invoke",
        operation: "bookSeat",
      },
      { kind: "started", id: "ok-1", op: "backend.invoke", operation: "bookSeat" },
      {
        kind: "completed",
        id: "ok-1",
        op: "backend.invoke",
        operation: "bookSeat",
        status: 200,
        ok: true,
      },
      { kind: "started", id: "refused-1", op: "backend.invoke", operation: "bookSeat" },
      {
        kind: "completed",
        id: "refused-1",
        op: "backend.invoke",
        operation: "bookSeat",
        status: 409,
        ok: false,
        refusalCode: "workshop_full",
      },
      { kind: "started", id: "bad-409", op: "backend.invoke", operation: "bookSeat" },
      {
        kind: "completed",
        id: "bad-409",
        op: "backend.invoke",
        operation: "bookSeat",
        status: 503,
        ok: false,
      },
    ]);
  } finally {
    lifetime.abort();
    vi.unstubAllGlobals();
  }
});

it("forwards one-way dataset.changed push events, accepts readOnly: true, and supports local session limits", async () => {
  vi.stubGlobal("MessageChannel", NodeMessageChannel);
  const frame = new EventTarget();
  let port!: NodeMessagePort;
  let handshake: unknown;
  Object.assign(frame, {
    contentWindow: {
      postMessage(message: unknown, _target: string, ports: NodeMessagePort[]) {
        handshake = message;
        port = ports[0]!;
      },
    },
  });
  const received: unknown[] = [];
  const lifetime = new AbortController();
  const broker = attachAppCollectionBroker(
    frame as HTMLIFrameElement,
    async (body) => {
      received.push(body);
      return Response.json({ result: { ok: true }, revision: 1, replayed: false });
    },
    lifetime.signal,
    undefined,
    { maxPending: 12, backendBurst: 120, backendRefillMs: 50 },
  );
  try {
    broker.notifyDatasetChanged("expenses", 2);
    broker.notifyDatasetChanged("BadAlias", 9);
    broker.notifyDatasetChanged("expenses", -1);
    frame.dispatchEvent(new Event("load"));
    expect(handshake).toEqual({ kind: "dohc-app-channel", version: 1, maxInFlight: 8 });

    const liveEvent = once(port, "message");
    broker.notifyDatasetChanged("BadAlias", 9);
    broker.notifyDatasetChanged("expenses", -1);
    broker.notifyDatasetChanged("workouts", 3);
    expect((await liveEvent)[0]).toEqual({
      kind: "dataset.changed",
      dataset: "workouts",
      revision: 3,
    });

    const send = (body: unknown) => {
      const reply = once(port, "message");
      port.postMessage(body);
      return reply.then(([value]) => value);
    };
    expect(
      await send({
        id: "ro-ok",
        op: "backend.invoke",
        operation: "listExpenses",
        idempotencyKey: "read-1",
        input: {},
        dataset: "expenses",
        readOnly: true,
      }),
    ).toMatchObject({ id: "ro-ok", ok: true });
    expect(
      await send({
        id: "ro-false",
        op: "backend.invoke",
        operation: "listExpenses",
        idempotencyKey: "read-2",
        input: {},
        readOnly: false,
      }),
    ).toEqual({ id: "ro-false", ok: false, status: 400 });
    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>).readOnly).toBe(true);
  } finally {
    lifetime.abort();
    vi.unstubAllGlobals();
  }
});

it("surfaces explicit rate-limit details on token exhaustion and upstream Retry-After", async () => {
  const f = harness(
    async () =>
      new Response("secret internal stack", { status: 429, headers: { "retry-after": "7" } }),
  );
  try {
    const upstream = await f.request({
      id: "up-429",
      op: "backend.invoke",
      operation: "list",
      idempotencyKey: "k-up",
      input: {},
    });
    expect(upstream).toEqual({
      id: "up-429",
      ok: false,
      status: 429,
      error: {
        code: "rate_limited",
        message: "Rate limit reached by app host (HTTP 429). Try again in 7 s.",
        retryAfterMs: 7000,
      },
    });
    expect(JSON.stringify(upstream)).not.toContain("secret");
  } finally {
    f.close();
  }

  let now = 1_000_000;
  const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
  const f2 = harness();
  try {
    for (let i = 0; i < 30; i++) {
      expect(
        (
          await f2.request({
            id: `b-${i}`,
            op: "backend.invoke",
            operation: "list",
            idempotencyKey: `k-${i}`,
            input: {},
          })
        ).ok,
      ).toBe(true);
    }
    const limited = await f2.request({
      id: "b-over",
      op: "backend.invoke",
      operation: "list",
      idempotencyKey: "k-over",
      input: {},
    });
    expect(limited).toMatchObject({
      id: "b-over",
      ok: false,
      status: 429,
      error: {
        code: "rate_limited",
        retryAfterMs: 2000,
      },
    });
    expect(limited.error.message).toContain("30 of 30 backend requests");
    expect(limited.error.message).toContain("60 s burst window");
    expect(limited.error.message).toContain("Try again in 2 s");
    now += 2000;
    expect(
      (
        await f2.request({
          id: "b-after",
          op: "backend.invoke",
          operation: "list",
          idempotencyKey: "k-after",
          input: {},
        })
      ).ok,
    ).toBe(true);
  } finally {
    nowSpy.mockRestore();
    f2.close();
  }
});

it("gates host.copy and host.print on user activation, size bounds, and anti-spam cooldowns without consuming backend slots", async () => {
  vi.stubGlobal("MessageChannel", NodeMessageChannel);
  let isActive = false;
  vi.stubGlobal("navigator", {
    userActivation: {
      get isActive() {
        return isActive;
      },
    },
  });
  let now = 2_000_000;
  const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
  const frame = new EventTarget();
  let port!: NodeMessagePort;
  Object.assign(frame, {
    contentWindow: {
      postMessage(_message: unknown, _target: string, ports: NodeMessagePort[]) {
        port = ports[0]!;
      },
    },
  });
  const copied: string[] = [];
  const printed: Array<{ height?: number }> = [];
  let releasePrint!: () => void;
  let releaseBackend!: () => void;
  const backendGate = new Promise<void>((resolve) => {
    releaseBackend = resolve;
  });
  const lifetime = new AbortController();
  const events: unknown[] = [];
  attachAppCollectionBroker(
    frame as HTMLIFrameElement,
    async () => {
      await backendGate;
      return Response.json({ result: null, revision: 1, replayed: false });
    },
    lifetime.signal,
    (event) => events.push(event),
    undefined,
    {
      copyText: async (text) => {
        copied.push(text);
      },
      print: async (options) => {
        printed.push(options);
        await new Promise<void>((resolve) => {
          releasePrint = resolve;
        });
      },
    },
  );
  try {
    frame.dispatchEvent(new Event("load"));
    const send = (body: unknown) => {
      const reply = once(port, "message");
      port.postMessage(body);
      return reply.then(([value]) => value);
    };

    expect(await send({ id: "c-no-act", op: "host.copy", text: "secret" })).toEqual({
      id: "c-no-act",
      ok: false,
      status: 409,
      error: {
        code: "user_activation_required",
        message: "Clipboard copy requires a recent click or key press.",
      },
    });
    expect(await send({ id: "p-no-act", op: "host.print" })).toEqual({
      id: "p-no-act",
      ok: false,
      status: 409,
      error: {
        code: "user_activation_required",
        message: "Printing requires a recent click or key press.",
      },
    });
    expect(copied).toEqual([]);
    expect(printed).toEqual([]);

    isActive = true;
    expect(await send({ id: "c-bad-key", op: "host.copy", text: "ok", extra: 1 })).toEqual({
      id: "c-bad-key",
      ok: false,
      status: 400,
    });
    const oversize = await send({ id: "c-big", op: "host.copy", text: "a".repeat(65_537) });
    expect(oversize).toEqual({
      id: "c-big",
      ok: false,
      status: 413,
      error: {
        code: "payload_too_large",
        message: "Clipboard text exceeded its limit of 65536 bytes (used 65537 bytes).",
      },
    });

    for (let i = 0; i < 4; i++) {
      port.postMessage({
        id: `hold-${i}`,
        op: "backend.invoke",
        operation: "slow",
        idempotencyKey: `s-${i}`,
        input: {},
      });
    }
    expect(await send({ id: "c-ok", op: "host.copy", text: "JOIN-1234" })).toEqual({
      id: "c-ok",
      ok: true,
      value: { copied: true },
    });
    expect(copied).toEqual(["JOIN-1234"]);

    const copySpam = await send({ id: "c-spam", op: "host.copy", text: "SECOND" });
    expect(copySpam).toMatchObject({
      id: "c-spam",
      ok: false,
      status: 429,
      error: { code: "rate_limited", retryAfterMs: 1000 },
    });
    now += 1000;
    expect(await send({ id: "c-ok-2", op: "host.copy", text: "KEY-5678" })).toEqual({
      id: "c-ok-2",
      ok: true,
      value: { copied: true },
    });

    expect(await send({ id: "p-bad-h", op: "host.print", height: 0 })).toEqual({
      id: "p-bad-h",
      ok: false,
      status: 400,
    });
    expect(await send({ id: "p-ok", op: "host.print", height: 2400 })).toEqual({
      id: "p-ok",
      ok: true,
      value: { printed: true },
    });
    expect(printed).toEqual([{ height: 2400 }]);

    const printWhileOpen = await send({ id: "p-nested", op: "host.print" });
    expect(printWhileOpen).toMatchObject({
      id: "p-nested",
      ok: false,
      status: 429,
      error: { code: "rate_limited" },
    });
    expect(printWhileOpen.error.message).toContain("at most 1 print dialog at a time");

    releasePrint();
    await Promise.resolve();
    now += 1000;
    const printSameClick = await send({ id: "p-cooldown", op: "host.print" });
    expect(printSameClick).toMatchObject({
      id: "p-cooldown",
      ok: false,
      status: 429,
      error: { code: "rate_limited", retryAfterMs: 4500 },
    });
    expect(printSameClick.error.message).toContain("5.5 s");

    now += 4500;
    expect(await send({ id: "p-ok-2", op: "host.print" })).toEqual({
      id: "p-ok-2",
      ok: true,
      value: { printed: true },
    });
    releasePrint();
    expect(events).toContainEqual({
      kind: "completed",
      id: "c-no-act",
      op: "host.copy",
      status: 409,
      ok: false,
      refusalCode: "user_activation_required",
    });
    expect(events).toContainEqual({
      kind: "completed",
      id: "c-ok",
      op: "host.copy",
      status: 200,
      ok: true,
    });
    expect(events).toContainEqual({
      kind: "completed",
      id: "p-ok",
      op: "host.print",
      status: 200,
      ok: true,
    });
  } finally {
    releaseBackend();
    nowSpy.mockRestore();
    lifetime.abort();
    vi.unstubAllGlobals();
  }
});
