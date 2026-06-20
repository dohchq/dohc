import { describe, expect, it, vi } from "vitest";
import {
  DohcSdkError,
  createDohcClient,
  createPostMessageTransport,
  DOHC_SDK_PROTOCOL,
} from ".";

function createWindowHarness() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const messages: unknown[] = [];
  const currentWindow = {
    parent: undefined,
    location: {
      href: "http://site.test/?dohcHostOrigin=https%3A%2F%2Fhost.dohc.test",
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener(_type: "message", listener: EventListener) {
      listeners.add(listener as (event: MessageEvent) => void);
    },
    removeEventListener(_type: "message", listener: EventListener) {
      listeners.delete(listener as (event: MessageEvent) => void);
    },
  } as unknown as Window;
  const targetWindow = {
    postMessage: vi.fn((message: unknown) => {
      messages.push(message);
    }),
  } as unknown as Window;
  function dispatch(
    data: unknown,
    options: { source?: Window; origin?: string } = {},
  ) {
    const event = {
      data,
      origin: options.origin ?? "https://host.dohc.test",
      source: options.source ?? targetWindow,
    } as MessageEvent;
    for (const listener of [...listeners]) listener(event);
  }
  return { currentWindow, targetWindow, listeners, messages, dispatch };
}

describe("@dohc/sdk", () => {
  it("reads files through the configured transport", async () => {
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          expect(method).toBe("files.read");
          expect(params).toEqual({ path: "notes/today.md" });
          return { text: "today" };
        },
      },
    });

    await expect(client.files.read("notes/today.md")).resolves.toBe("today");
  });

  it("surfaces host errors with stable codes", async () => {
    const client = createDohcClient({
      transport: {
        async request() {
          throw new DohcSdkError("NOPE", "Denied");
        },
      },
    });

    await expect(client.files.read("secret.md")).rejects.toMatchObject({
      code: "NOPE",
      message: "Denied",
    });
  });

  it("posts requests and resolves matching host responses", async () => {
    const harness = createWindowHarness();
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 1000,
    });

    const pending = transport.request("capabilities");
    const request = harness.messages[0] as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: request.id,
      ok: true,
      result: { files: { read: true, write: false } },
    });

    await expect(pending).resolves.toEqual({
      files: { read: true, write: false },
    });
    expect(harness.listeners.size).toBe(0);
  });

  it("rejects host error responses", async () => {
    const harness = createWindowHarness();
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 1000,
    });

    const pending = transport.request("capabilities");
    const request = harness.messages[0] as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: request.id,
      ok: false,
      error: { code: "DENIED", message: "No access" },
    });

    await expect(pending).rejects.toMatchObject({
      code: "DENIED",
      message: "No access",
    });
    expect(harness.listeners.size).toBe(0);
  });

  it("rejects with a timeout and removes listeners when the host never responds", async () => {
    const harness = createWindowHarness();
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 5,
    });

    await expect(transport.request("capabilities")).rejects.toMatchObject({
      code: "DOHC_HOST_TIMEOUT",
    });
    expect(harness.listeners.size).toBe(0);
  });

  it("resolves concurrent requests by matching response ids", async () => {
    const harness = createWindowHarness();
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 1000,
    });

    const first = transport.request("first");
    const second = transport.request("second");
    const firstRequest = harness.messages[0] as { id: string };
    const secondRequest = harness.messages[1] as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: secondRequest.id,
      ok: true,
      result: "two",
    });
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: firstRequest.id,
      ok: true,
      result: "one",
    });

    await expect(first).resolves.toBe("one");
    await expect(second).resolves.toBe("two");
    expect(harness.listeners.size).toBe(0);
  });

  it("ignores malformed responses, wrong sources, and wrong origins", async () => {
    const harness = createWindowHarness();
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      targetOrigin: "https://host.dohc.test",
      timeoutMs: 1000,
    });

    const pending = transport.request("capabilities");
    const request = harness.messages[0] as { id: string };
    harness.dispatch({ protocol: DOHC_SDK_PROTOCOL, id: request.id, ok: true });
    harness.dispatch(
      { protocol: DOHC_SDK_PROTOCOL, id: request.id, ok: true, result: "bad-source" },
      { source: {} as Window },
    );
    harness.dispatch(
      { protocol: DOHC_SDK_PROTOCOL, id: request.id, ok: true, result: "bad-origin" },
      { origin: "https://evil.test" },
    );
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: request.id,
      ok: true,
      result: "ok",
    });

    await expect(pending).resolves.toBe("ok");
  });

  it("accepts opaque browser origins for file-based dohc hosts", async () => {
    const harness = createWindowHarness();
    const currentWindow = {
      ...harness.currentWindow,
      location: {
        href: "http://site.test/?dohcHostOrigin=file%3A%2F%2F",
      },
    } as unknown as Window;
    const transport = createPostMessageTransport({
      currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 1000,
    });

    const pending = transport.request("capabilities");
    const request = harness.messages[0] as { id: string };
    harness.dispatch(
      {
        protocol: DOHC_SDK_PROTOCOL,
        id: request.id,
        ok: true,
        result: "file-host",
      },
      { origin: "null" },
    );

    await expect(pending).resolves.toBe("file-host");
  });

  it("validates client method responses", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          calls.push({ method, params });
          if (method === "capabilities") {
            return {
              files: { read: true, write: false },
              collections: { read: true },
              provenance: { record: false },
            };
          }
          if (method === "collections.list") return [{ id: 1 }];
          if (method === "provenance.record") return { ok: true };
          return { text: "ok" };
        },
      },
    });

    await expect(client.capabilities()).resolves.toMatchObject({
      files: { read: true },
    });
    await expect(client.collections.get("tasks").list()).resolves.toEqual([{ id: 1 }]);
    await expect(client.provenance.record("checked")).resolves.toBeUndefined();
    expect(calls).toEqual([
      { method: "capabilities", params: undefined },
      { method: "collections.list", params: { name: "tasks" } },
      { method: "provenance.record", params: { summary: "checked" } },
    ]);
  });

  it("rejects invalid high-level client responses", async () => {
    const filesClient = createDohcClient({
      transport: { async request() { return {}; } },
    });
    await expect(filesClient.files.read("bad.md")).rejects.toMatchObject({
      code: "DOHC_BAD_RESPONSE",
    });

    const capabilitiesClient = createDohcClient({
      transport: { async request() { return { files: {} }; } },
    });
    await expect(capabilitiesClient.capabilities()).rejects.toMatchObject({
      code: "DOHC_BAD_RESPONSE",
    });

    const collectionsClient = createDohcClient({
      transport: { async request() { return { rows: [] }; } },
    });
    await expect(collectionsClient.collections.get("bad").list()).rejects.toMatchObject({
      code: "DOHC_BAD_RESPONSE",
    });

    const collectionItemsClient = createDohcClient({
      transport: { async request() { return [{ id: 1 }, null]; } },
    });
    await expect(collectionItemsClient.collections.get("bad").list()).rejects.toMatchObject({
      code: "DOHC_BAD_RESPONSE",
    });
  });
});
