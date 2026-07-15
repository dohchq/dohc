import { describe, expect, it, vi } from "vitest";
import {
  DohcSdkError,
  DohcSdkErrorCodes,
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
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          calls.push({ method, params });
          if (method === "capabilities") {
            return {
              files: { read: true, write: false },
              collections: { read: false },
              provenance: { record: false },
            };
          }
          return { text: "today" };
        },
      },
    });

    await expect(client.files.read("notes/today.md")).resolves.toBe("today");
    expect(calls).toEqual([
      { method: "capabilities", params: undefined },
      { method: "files.read", params: { path: "notes/today.md" } },
    ]);
  });

  it("never presents a bounded file prefix as a complete read", async () => {
    const client = createDohcClient({
      transport: {
        async request(method) {
          if (method === "capabilities") {
            return {
              files: { read: true, write: true },
              collections: { read: false },
              provenance: { record: false },
            };
          }
          return { text: "bounded prefix", truncated: true };
        },
      },
    });

    await expect(client.files.readInfo("large.txt")).resolves.toEqual({
      text: "bounded prefix",
      truncated: true,
    });
    await expect(client.files.read("large.txt")).rejects.toMatchObject({
      code: DohcSdkErrorCodes.responseTruncated,
      message: expect.stringMatching(/read-modify-write/i),
    });
  });

  it("caches capabilities for repeated high-level operations", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          calls.push({ method, params });
          if (method === "capabilities") {
            return {
              files: { read: true, write: false },
              collections: { read: false },
              provenance: { record: false },
            };
          }
          return { text: `read:${(params as { path: string }).path}` };
        },
      },
    });

    await expect(client.files.read("notes/one.md")).resolves.toBe("read:notes/one.md");
    await expect(client.files.read("notes/two.md")).resolves.toBe("read:notes/two.md");
    expect(calls).toEqual([
      { method: "capabilities", params: undefined },
      { method: "files.read", params: { path: "notes/one.md" } },
      { method: "files.read", params: { path: "notes/two.md" } },
    ]);
  });

  it("rejects absolute file paths before contacting the host", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          calls.push({ method, params });
          return { text: "should not read" };
        },
      },
    });

    await expect(
      client.files.read("/Users/ice/private.md"),
    ).rejects.toMatchObject({
      code: DohcSdkErrorCodes.invalidInput,
      message: "File paths must be workspace-relative. Absolute paths are not allowed.",
    });
    await expect(
      client.files.read("C:\\Users\\ice\\private.md"),
    ).rejects.toMatchObject({
      code: DohcSdkErrorCodes.invalidInput,
    });
    await expect(
      client.files.read("file:///Users/ice/private.md"),
    ).rejects.toMatchObject({
      code: DohcSdkErrorCodes.invalidInput,
    });
    await expect(
      client.files.read("https://example.com/private.md"),
    ).rejects.toMatchObject({
      code: DohcSdkErrorCodes.invalidInput,
    });
    expect(calls).toEqual([]);
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

  it("rejects postMessage requests when no dohc host origin is available", async () => {
    const harness = createWindowHarness();
    const currentWindow = {
      ...harness.currentWindow,
      location: { href: "http://site.test/" },
    } as unknown as Window;
    const transport = createPostMessageTransport({
      currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 1000,
    });

    await expect(transport.request("capabilities")).rejects.toMatchObject({
      code: "DOHC_HOST_MISSING_ORIGIN",
      message: "No dohc host origin is available for this site.",
    });
    expect(harness.messages).toEqual([]);
    expect(harness.listeners.size).toBe(0);
  });

  it("rejects immediately when postMessage cannot send the request", async () => {
    const harness = createWindowHarness();
    const targetWindow = {
      postMessage: vi.fn(() => {
        throw new Error("detached window");
      }),
    } as unknown as Window;
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow,
      timeoutMs: 1000,
    });

    await expect(transport.request("capabilities")).rejects.toMatchObject({
      code: "DOHC_HOST_UNAVAILABLE",
      message: "Failed to send dohc SDK request: detached window",
    });
    expect(harness.listeners.size).toBe(0);
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
              provenance: { record: true },
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

  it("does not let collection reads provide workspace or identity scope", async () => {
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
          if (method === "collections.list") return [];
          return {};
        },
      },
    });

    await expect(client.collections.get("tasks").list()).resolves.toEqual([]);
    expect(calls).toEqual([
      { method: "capabilities", params: undefined },
      { method: "collections.list", params: { name: "tasks" } },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/workspaceId|userId|onBehalfOf/);
  });

  it("reports disabled collection reads before requesting collection data", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          calls.push({ method, params });
          return {
            files: { read: true, write: false },
            collections: { read: false },
            provenance: { record: false },
          };
        },
      },
    });

    await expect(client.collections.get("tasks").list()).rejects.toMatchObject({
      code: "DOHC_CAPABILITY_DISABLED",
      message: expect.stringMatching(/collections\.read.*disabled/i),
    });
    expect(calls).toEqual([{ method: "capabilities", params: undefined }]);
  });

  it("rejects invalid collection names before requesting collection data", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          calls.push({ method, params });
          return {
            files: { read: true, write: false },
            collections: { read: true },
            provenance: { record: false },
          };
        },
      },
    });

    await expect(client.collections.get("bad\nname").list()).rejects.toMatchObject({
      code: "DOHC_INVALID_INPUT",
      message: expect.stringMatching(/collection name/i),
    });
    expect(calls).toEqual([]);
  });

  it("reports disabled provenance recording before sending provenance data", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          calls.push({ method, params });
          return {
            files: { read: true, write: false },
            collections: { read: false },
            provenance: { record: false },
          };
        },
      },
    });

    await expect(client.provenance.record("checked")).rejects.toMatchObject({
      code: "DOHC_CAPABILITY_DISABLED",
      message: expect.stringMatching(/provenance\.record.*disabled/i),
    });
    expect(calls).toEqual([{ method: "capabilities", params: undefined }]);
  });

  it("rejects invalid provenance summaries before contacting the host", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          calls.push({ method, params });
          return {
            files: { read: true, write: false },
            collections: { read: false },
            provenance: { record: true },
          };
        },
      },
    });

    await expect(client.provenance.record(" ")).rejects.toMatchObject({
      code: "DOHC_INVALID_INPUT",
      message: expect.stringMatching(/provenance summary/i),
    });
    expect(calls).toEqual([]);
  });

  it("rejects invalid high-level client responses", async () => {
    const filesClient = createDohcClient({
      transport: {
        async request(method) {
          if (method === "capabilities") {
            return {
              files: { read: true, write: false },
              collections: { read: false },
              provenance: { record: false },
            };
          }
          return {};
        },
      },
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
      transport: {
        async request(method) {
          if (method === "capabilities") {
            return {
              files: { read: true, write: false },
              collections: { read: true },
              provenance: { record: false },
            };
          }
          return { rows: [] };
        },
      },
    });
    await expect(collectionsClient.collections.get("bad").list()).rejects.toMatchObject({
      code: "DOHC_BAD_RESPONSE",
    });

    const collectionItemsClient = createDohcClient({
      transport: {
        async request(method) {
          if (method === "capabilities") {
            return {
              files: { read: true, write: false },
              collections: { read: true },
              provenance: { record: false },
            };
          }
          return [{ id: 1 }, null];
        },
      },
    });
    await expect(collectionItemsClient.collections.get("bad").list()).rejects.toMatchObject({
      code: "DOHC_BAD_RESPONSE",
    });
  });

  it("reports disabled file reads before sending a file path", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          calls.push({ method, params });
          return {
            files: { read: false, write: false },
            collections: { read: false },
            provenance: { record: false },
          };
        },
      },
    });

    await expect(client.files.read("secret.md")).rejects.toMatchObject({
      code: "DOHC_CAPABILITY_DISABLED",
      message: expect.stringMatching(/files\.read.*disabled/i),
    });
    expect(calls).toEqual([{ method: "capabilities", params: undefined }]);
  });

  it("exposes the expanded dohc capability surface without hiding host extensions", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          calls.push({ method, params });
          if (method === "capabilities") {
            return {
              files: { read: true, write: true, list: true, watch: true },
              collections: { read: true },
              provenance: { record: true },
              workspace: { search: true },
              databases: { read: true, edit: true },
              ui: { open: true },
              future: { teleport: true },
            };
          }
          if (method === "files.list") return [{ path: "notes/today.md", kind: "file" }];
          if (method === "workspace.search") return [{ path: "notes/today.md", score: 1 }];
          if (method === "collections.list") return [{ id: "one" }];
          if (method === "databases.read") return { rows: [{ id: 1 }] };
          if (method === "databases.edit") return { changes: 1 };
          if (method === "future.teleport") return { arrived: true };
          return { ok: true };
        },
      },
    });

    await expect(client.capabilities()).resolves.toMatchObject({
      future: { teleport: true },
    });
    await expect(client.files.list("notes", { recursive: true })).resolves.toHaveLength(1);
    await expect(client.files.write("notes/today.md", "hello", { overwrite: true })).resolves.toEqual({ ok: true });
    await expect(client.workspace.search("today", { limit: 10 })).resolves.toHaveLength(1);
    await expect(client.databases.read<{ rows: unknown[] }>({
      path: "data/tasks.sqlite",
      query: "select * from tasks",
    })).resolves.toEqual({ rows: [{ id: 1 }] });
    await expect(client.databases.edit({
      path: "data/tasks.sqlite",
      operations: [{ op: "update", id: 1 }],
    })).resolves.toEqual({ changes: 1 });
    await expect(client.ui.open("dohc://atom/today", { position: "new-tab" })).resolves.toEqual({ ok: true });
    await expect(client.collections.list("tasks", { limit: 5 })).resolves.toEqual([{ id: "one" }]);
    await expect(client.provenance.record({ summary: "Updated", source: "site" })).resolves.toBeUndefined();
    await expect(client.invoke<{ arrived: boolean }>("future.teleport", { to: "home" })).resolves.toEqual({ arrived: true });

    expect(calls).toContainEqual({
      method: "files.write",
      params: { path: "notes/today.md", text: "hello", overwrite: true },
    });
    expect(calls).toContainEqual({
      method: "ui.open",
      params: { target: "dohc://atom/today", position: "new-tab" },
    });
    expect(calls).toContainEqual({
      method: "provenance.record",
      params: { summary: "Updated", source: "site" },
    });
  });

  it("supports transport subscriptions and removes event listeners on unsubscribe", async () => {
    const harness = createWindowHarness();
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 1000,
    });
    const events: unknown[] = [];
    const pendingSubscription = transport.subscribe!(
      "files.watch",
      { path: "notes" },
      (event) => events.push(event),
    );
    const subscribeRequest = harness.messages[0] as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: subscribeRequest.id,
      ok: true,
      result: { subscriptionId: "sub_1" },
    });
    const unsubscribe = await pendingSubscription;

    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      type: "event",
      subscriptionId: "sub_1",
      event: "changed",
      data: { path: "notes/today.md" },
    });
    expect(events).toEqual([{
      event: "changed",
      data: { path: "notes/today.md" },
    }]);

    const pendingUnsubscribe = unsubscribe();
    const unsubscribeRequest = harness.messages.at(-1) as { id: string; method: string; params: unknown };
    expect(unsubscribeRequest).toMatchObject({
      method: "subscriptions.unsubscribe",
      params: { subscriptionId: "sub_1" },
    });
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: unsubscribeRequest.id,
      ok: true,
      result: { ok: true },
    });
    await pendingUnsubscribe;
    expect(harness.listeners.size).toBe(0);
  });

  it("aborts postMessage requests and cleans up their listeners", async () => {
    const harness = createWindowHarness();
    const controller = new AbortController();
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 1000,
    });

    const pending = transport.request("workspace.search", { query: "today" }, {
      signal: controller.signal,
    });
    expect(harness.listeners.size).toBe(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: DohcSdkErrorCodes.aborted });
    expect(harness.listeners.size).toBe(0);
  });

  it("uses a transport subscription for files.watch and reports unsupported transports", async () => {
    const events: unknown[] = [];
    const unsubscribe = vi.fn(async () => undefined);
    const client = createDohcClient({
      transport: {
        async request(method) {
          if (method === "capabilities") {
            return {
              files: { read: true, write: true, watch: true },
              collections: { read: true },
              provenance: { record: true },
            };
          }
          return {};
        },
        async subscribe<T>(
          method: string,
          params: unknown,
          listener: (event: { event: string; data: T }) => void,
        ) {
          expect(method).toBe("files.watch");
          expect(params).toEqual({ path: "notes" });
          listener({ event: "changed", data: { path: "notes/today.md" } as T });
          return unsubscribe;
        },
      },
    });
    await expect(client.files.watch("notes", (event) => events.push(event))).resolves.toBe(unsubscribe);
    expect(events).toHaveLength(1);

    const unsupported = createDohcClient({
      transport: {
        async request() {
          return {
            files: { read: true, write: true, watch: true },
            collections: { read: true },
            provenance: { record: true },
          };
        },
      },
    });
    await expect(unsupported.files.watch("notes", () => undefined)).rejects.toMatchObject({
      code: DohcSdkErrorCodes.subscriptionsUnsupported,
    });
  });
});
