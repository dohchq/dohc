import { describe, expect, it, vi } from "vitest";
import {
  DohcSdkError,
  DohcSdkErrorCodes,
  createDohcClient,
  createPostMessageTransport,
  DOHC_SDK_PROTOCOL,
  DOHC_THEME_PROTOCOL,
  applyDohcTheme,
  isDohcTheme,
  isDohcThemeMessage,
  type DohcDatabaseEditRequest,
  type DohcTheme,
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

  it("does not let files.write options replace validated reserved fields", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          calls.push({ method, params });
          if (method === "capabilities") {
            return {
              files: { read: true, write: true },
              collections: { read: false },
              provenance: { record: false },
            };
          }
          return { ok: true };
        },
      },
    });

    await client.files.write("safe/status.txt", "validated", {
      path: "../outside.txt",
      text: "overridden",
      overwrite: true,
    });

    expect(calls.at(-1)).toEqual({
      method: "files.write",
      params: {
        overwrite: true,
        path: "safe/status.txt",
        text: "validated",
      },
    });
  });

  it("does not let extension option bags replace validated explicit fields", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          calls.push({ method, params });
          if (method === "capabilities") {
            return {
              files: { read: true, write: true, list: true },
              collections: { read: true },
              provenance: { record: true },
              workspace: { search: true },
              ui: { open: true },
            };
          }
          if (method === "files.list") return [];
          if (method === "workspace.search") return [];
          if (method === "collections.list") return [];
          return { ok: true };
        },
      },
    });

    await client.files.list("safe", { path: "../outside", recursive: true });
    await client.files.list(undefined, { path: "../outside", recursive: false });
    await client.workspace.search("validated query", { query: "overridden" });
    await client.ui.open("dohc://atom/safe", { target: "https://evil.test" });
    await client.collections.list("safe-collection", { name: "overridden" });

    expect(calls).toContainEqual({
      method: "files.list",
      params: { path: "safe", recursive: true },
    });
    expect(calls).toContainEqual({
      method: "files.list",
      params: { recursive: false },
    });
    expect(calls).toContainEqual({
      method: "workspace.search",
      params: { query: "validated query" },
    });
    expect(calls).toContainEqual({
      method: "ui.open",
      params: { target: "dohc://atom/safe" },
    });
    expect(calls).toContainEqual({
      method: "collections.list",
      params: { name: "safe-collection" },
    });
  });

  it("cancels a cold caller without canceling shared capability discovery", async () => {
    let resolveCapabilities!: (value: unknown) => void;
    const capabilities = new Promise<unknown>((resolve) => {
      resolveCapabilities = resolve;
    });
    const calls: string[] = [];
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          calls.push(method);
          if (method === "capabilities") return capabilities;
          return { text: String((params as { path: string }).path), truncated: false };
        },
      },
    });
    const controller = new AbortController();

    const canceled = client.files.read("notes/canceled.txt", { signal: controller.signal });
    const surviving = client.files.read("notes/surviving.txt");
    controller.abort();

    await expect(canceled).rejects.toMatchObject({ code: DohcSdkErrorCodes.aborted });
    expect(calls).toEqual(["capabilities"]);

    resolveCapabilities({
      files: { read: true, write: true },
      collections: { read: false },
      provenance: { record: false },
    });
    await expect(surviving).resolves.toBe("notes/surviving.txt");
    expect(calls).toEqual(["capabilities", "files.read"]);
  });

  it("times out and validates typed request options during cold capability discovery", async () => {
    let resolveCapabilities!: (value: unknown) => void;
    const capabilities = new Promise<unknown>((resolve) => {
      resolveCapabilities = resolve;
    });
    const calls: string[] = [];
    const client = createDohcClient({
      transport: {
        async request(method) {
          calls.push(method);
          if (method === "capabilities") return capabilities;
          return { text: "ready", truncated: false };
        },
      },
    });

    await expect(
      client.files.read("notes/invalid.txt", { timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: DohcSdkErrorCodes.invalidInput });
    expect(calls).toEqual([]);

    await expect(
      client.files.read("notes/timeout.txt", { timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: DohcSdkErrorCodes.hostTimeout });
    expect(calls).toEqual(["capabilities"]);

    resolveCapabilities({
      files: { read: true, write: true },
      collections: { read: false },
      provenance: { record: false },
    });
    await expect(client.files.read("notes/after-timeout.txt")).resolves.toBe("ready");
    expect(calls).toEqual(["capabilities", "files.read"]);
  });

  it("rejects database edit batches before contacting the host", async () => {
    const calls: string[] = [];
    const client = createDohcClient({
      transport: {
        async request(method) {
          calls.push(method);
          return { databases: { edit: true } };
        },
      },
    });
    const legacyBatch = {
      path: "data/tasks.sqlite",
      operations: [{ op: "update" }, { op: "delete" }],
    } as unknown as DohcDatabaseEditRequest;

    await expect(client.databases.edit(legacyBatch)).rejects.toMatchObject({
      code: DohcSdkErrorCodes.invalidInput,
      message: expect.stringMatching(/exactly one operation/i),
    });
    expect(calls).toEqual([]);
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

  it("delivers subscription events that arrive before the subscribe response", async () => {
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
      type: "event",
      subscriptionId: "sub_race",
      event: "changed",
      data: { path: "notes/early.md" },
    });
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: subscribeRequest.id,
      ok: true,
      result: { subscriptionId: "sub_race" },
    });
    const unsubscribe = await pendingSubscription;

    expect(events).toEqual([{
      event: "changed",
      data: { path: "notes/early.md" },
    }]);

    const pendingUnsubscribe = unsubscribe();
    const unsubscribeRequest = harness.messages.at(-1) as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: unsubscribeRequest.id,
      ok: true,
      result: { ok: true },
    });
    await pendingUnsubscribe;
  });

  it("delivers exactly 200 early subscription events in order", async () => {
    const harness = createWindowHarness();
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 1000,
    });
    const events: number[] = [];
    const pendingSubscription = transport.subscribe!(
      "files.watch",
      { path: "notes" },
      (event) => events.push(event.data as number),
    );
    const subscribeRequest = harness.messages[0] as { id: string };

    for (let index = 0; index < 200; index += 1) {
      harness.dispatch({
        protocol: DOHC_SDK_PROTOCOL,
        type: "event",
        subscriptionId: "sub_boundary",
        event: "changed",
        data: index,
      });
    }
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: subscribeRequest.id,
      ok: true,
      result: { subscriptionId: "sub_boundary" },
    });
    const unsubscribe = await pendingSubscription;

    expect(events).toEqual(Array.from({ length: 200 }, (_, index) => index));

    const pendingUnsubscribe = unsubscribe();
    const unsubscribeRequest = harness.messages.at(-1) as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: unsubscribeRequest.id,
      ok: true,
      result: { ok: true },
    });
    await pendingUnsubscribe;
  });

  it("rejects and closes a subscription when its early-event buffer exceeds 200 events", async () => {
    const harness = createWindowHarness();
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 1000,
    });
    const listener = vi.fn();
    const pendingSubscription = transport.subscribe!(
      "files.watch",
      { path: "notes" },
      listener,
    );
    const subscribeRequest = harness.messages[0] as { id: string };

    for (let index = 0; index < 201; index += 1) {
      harness.dispatch({
        protocol: DOHC_SDK_PROTOCOL,
        type: "event",
        subscriptionId: "sub_overflow",
        event: "changed",
        data: index,
      });
    }
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: subscribeRequest.id,
      ok: true,
      result: { subscriptionId: "sub_overflow" },
    });

    await expect(pendingSubscription).rejects.toMatchObject({
      name: "DohcSdkError",
      code: DohcSdkErrorCodes.earlyEventBufferOverflow,
      message: expect.stringMatching(/200 events per subscription/),
    });
    expect(listener).not.toHaveBeenCalled();
    const unsubscribeRequest = harness.messages.at(-1) as {
      id: string;
      method: string;
      params: unknown;
    };
    expect(unsubscribeRequest).toMatchObject({
      method: "subscriptions.unsubscribe",
      params: { subscriptionId: "sub_overflow" },
    });

    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      type: "event",
      subscriptionId: "sub_overflow",
      event: "changed",
      data: 202,
    });
    expect(listener).not.toHaveBeenCalled();

    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: unsubscribeRequest.id,
      ok: true,
      result: { ok: true },
    });
    expect(harness.listeners.size).toBe(0);
  });

  it("closes a subscription when its listener throws during early-event replay", async () => {
    const harness = createWindowHarness();
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 1000,
    });
    const listenerError = new Error("listener rejected the replay");
    const listener = vi.fn(() => {
      throw listenerError;
    });
    const pendingSubscription = transport.subscribe!(
      "files.watch",
      { path: "notes" },
      listener,
    );
    const subscribeRequest = harness.messages[0] as { id: string };

    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      type: "event",
      subscriptionId: "sub_throw",
      event: "changed",
      data: { path: "notes/early.md" },
    });
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: subscribeRequest.id,
      ok: true,
      result: { subscriptionId: "sub_throw" },
    });

    await expect(pendingSubscription).rejects.toBe(listenerError);
    expect(listener).toHaveBeenCalledOnce();
    const unsubscribeRequest = harness.messages.at(-1) as {
      id: string;
      method: string;
      params: unknown;
    };
    expect(unsubscribeRequest).toMatchObject({
      method: "subscriptions.unsubscribe",
      params: { subscriptionId: "sub_throw" },
    });
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: unsubscribeRequest.id,
      ok: true,
      result: { ok: true },
    });

    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      type: "event",
      subscriptionId: "sub_throw",
      event: "changed",
      data: { path: "notes/late.md" },
    });
    expect(listener).toHaveBeenCalledOnce();

    const laterEvents: unknown[] = [];
    const laterSubscription = transport.subscribe!(
      "files.watch",
      { path: "notes" },
      (event) => laterEvents.push(event),
    );
    const laterRequest = harness.messages.at(-1) as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: laterRequest.id,
      ok: true,
      result: { subscriptionId: "sub_throw" },
    });
    const laterUnsubscribe = await laterSubscription;
    expect(laterEvents).toEqual([]);

    const pendingLaterUnsubscribe = laterUnsubscribe();
    const laterUnsubscribeRequest = harness.messages.at(-1) as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: laterUnsubscribeRequest.id,
      ok: true,
      result: { ok: true },
    });
    await pendingLaterUnsubscribe;
  });

  it("does not replay an orphaned subscription event once nothing is retaining the listener", async () => {
    const harness = createWindowHarness();
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 1000,
    });

    // The host's event for "sub_orphan" arrives before this call's own
    // subscribe request settles, then that request fails — so this call
    // never learns "sub_orphan" and its early-arrived event is orphaned in
    // the queue once this call releases.
    const firstEvents: unknown[] = [];
    const firstSubscription = transport.subscribe!(
      "files.watch",
      { path: "notes" },
      (event) => firstEvents.push(event),
    );
    const firstRequest = harness.messages[0] as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      type: "event",
      subscriptionId: "sub_orphan",
      event: "changed",
      data: { path: "notes/orphan.md" },
    });
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: firstRequest.id,
      ok: false,
      error: { code: "TIMEOUT", message: "no answer" },
    });
    await expect(firstSubscription).rejects.toMatchObject({ code: "TIMEOUT" });

    // A second, unrelated subscribe is assigned the same id. If the orphaned
    // queue leaked past the point where nothing was retaining the listener,
    // registering "sub_orphan" here would replay the stale event immediately.
    const secondEvents: unknown[] = [];
    const secondSubscription = transport.subscribe!(
      "files.watch",
      { path: "notes" },
      (event) => secondEvents.push(event),
    );
    const secondRequest = harness.messages.at(-1) as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: secondRequest.id,
      ok: true,
      result: { subscriptionId: "sub_orphan" },
    });
    await secondSubscription;

    expect(secondEvents).toEqual([]);
  });

  it("collects an orphaned queue while another subscription stays active", async () => {
    const harness = createWindowHarness();
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 1000,
    });
    const activeEvents: unknown[] = [];
    const activeSubscription = transport.subscribe!(
      "files.watch",
      { path: "active" },
      (event) => activeEvents.push(event),
    );
    const activeRequest = harness.messages[0] as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: activeRequest.id,
      ok: true,
      result: { subscriptionId: "sub_active" },
    });
    const unsubscribeActive = await activeSubscription;

    const failedSubscription = transport.subscribe!(
      "files.watch",
      { path: "failed" },
      () => undefined,
    );
    const failedRequest = harness.messages.at(-1) as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      type: "event",
      subscriptionId: "sub_reused",
      event: "changed",
      data: { path: "failed/orphan.md" },
    });
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: failedRequest.id,
      ok: false,
      error: { code: "TIMEOUT", message: "no answer" },
    });
    await expect(failedSubscription).rejects.toMatchObject({ code: "TIMEOUT" });

    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      type: "event",
      subscriptionId: "sub_active",
      event: "changed",
      data: { path: "active/still-watched.md" },
    });
    expect(activeEvents).toEqual([{
      event: "changed",
      data: { path: "active/still-watched.md" },
    }]);

    const reusedEvents: unknown[] = [];
    const reusedSubscription = transport.subscribe!(
      "files.watch",
      { path: "reused" },
      (event) => reusedEvents.push(event),
    );
    const reusedRequest = harness.messages.at(-1) as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: reusedRequest.id,
      ok: true,
      result: { subscriptionId: "sub_reused" },
    });
    const unsubscribeReused = await reusedSubscription;

    expect(reusedEvents).toEqual([]);

    const pendingActiveUnsubscribe = unsubscribeActive();
    const activeUnsubscribeRequest = harness.messages.at(-1) as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: activeUnsubscribeRequest.id,
      ok: true,
      result: { ok: true },
    });
    await pendingActiveUnsubscribe;

    const pendingReusedUnsubscribe = unsubscribeReused();
    const reusedUnsubscribeRequest = harness.messages.at(-1) as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: reusedUnsubscribeRequest.id,
      ok: true,
      result: { ok: true },
    });
    await pendingReusedUnsubscribe;
  });

  it("delivers an early event and a following burst to one listener in order", async () => {
    const harness = createWindowHarness();
    const transport = createPostMessageTransport({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      timeoutMs: 1000,
    });
    const events: unknown[] = [];
    const pendingSubscription = transport.subscribe!(
      "files.watch",
      { path: "." },
      (event) => events.push(event.data),
    );
    const subscribeRequest = harness.messages[0] as { id: string };

    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      type: "event",
      subscriptionId: "sub_refresh",
      event: "changed",
      data: { path: "early.md" },
    });
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: subscribeRequest.id,
      ok: true,
      result: { subscriptionId: "sub_refresh" },
    });
    const unsubscribe = await pendingSubscription;

    for (const path of ["one.md", "two.md"]) {
      harness.dispatch({
        protocol: DOHC_SDK_PROTOCOL,
        type: "event",
        subscriptionId: "sub_refresh",
        event: "changed",
        data: { path },
      });
    }

    expect(events).toEqual([
      { path: "early.md" },
      { path: "one.md" },
      { path: "two.md" },
    ]);

    const pendingUnsubscribe = unsubscribe();
    const unsubscribeRequest = harness.messages.at(-1) as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: unsubscribeRequest.id,
      ok: true,
      result: { ok: true },
    });
    await pendingUnsubscribe;
  });

  it("retries a failed remote unsubscribe while detaching locally only once", async () => {
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
      result: { subscriptionId: "sub_retry" },
    });
    const unsubscribe = await pendingSubscription;

    const firstAttempt = unsubscribe();
    const firstRequest = harness.messages.at(-1) as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: firstRequest.id,
      ok: false,
      error: { code: "TEMPORARY", message: "try again" },
    });
    await expect(firstAttempt).rejects.toMatchObject({ code: "TEMPORARY" });

    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      type: "event",
      subscriptionId: "sub_retry",
      event: "changed",
      data: { path: "notes/ignored.md" },
    });
    expect(events).toEqual([]);

    const messagesBeforeRetry = harness.messages.length;
    const retry = unsubscribe();
    const concurrentRetry = unsubscribe();
    expect(harness.messages).toHaveLength(messagesBeforeRetry + 1);
    const retryRequest = harness.messages.at(-1) as { id: string };
    harness.dispatch({
      protocol: DOHC_SDK_PROTOCOL,
      id: retryRequest.id,
      ok: true,
      result: { ok: true },
    });
    await expect(Promise.all([retry, concurrentRetry])).resolves.toEqual([undefined, undefined]);

    await unsubscribe();
    expect(harness.messages).toHaveLength(messagesBeforeRetry + 1);
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

interface FakeRoot {
  element: HTMLElement;
  properties: Record<string, string>;
  dataset: Record<string, string>;
}

function createFakeRoot(): FakeRoot {
  const properties: Record<string, string> = {};
  const dataset: Record<string, string> = {};
  const element = {
    style: {
      setProperty(name: string, value: string) {
        properties[name] = value;
      },
    },
    dataset,
  } as unknown as HTMLElement;
  return { element, properties, dataset };
}

const LIGHT: DohcTheme = {
  mode: "light",
  density: "comfortable",
  reduceMotion: false,
  tokens: { "--dohc-ink": "#1c1b18", "--font-sans": "InterVariable" },
};

const DARK: DohcTheme = {
  mode: "dark",
  density: "compact",
  reduceMotion: true,
  tokens: { "--dohc-ink": "#f6f4ee", "--font-sans": "InterVariable" },
};

describe("dohc theme", () => {
  it("writes tokens and the attributes dohc's own stylesheet switches on", () => {
    const root = createFakeRoot();
    applyDohcTheme(DARK, root.element);
    expect(root.properties["--dohc-ink"]).toBe("#f6f4ee");
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.density).toBe("compact");
    expect(root.dataset.reduceMotion).toBe("true");
  });

  // Token names are written into a style declaration, so a name that is not
  // a custom property must never get that far.
  it("refuses a payload whose token name is not a custom property", () => {
    expect(isDohcTheme({ ...LIGHT, tokens: { "--dohc-ink": "#000" } })).toBe(true);
    expect(isDohcTheme({ ...LIGHT, tokens: { color: "red" } })).toBe(false);
    expect(
      isDohcTheme({ ...LIGHT, tokens: { "--x: red; background": "url(x)" } }),
    ).toBe(false);
    expect(isDohcTheme({ ...LIGHT, tokens: { "--dohc-ink": 1 } })).toBe(false);
    expect(isDohcTheme({ ...LIGHT, mode: "sepia" })).toBe(false);
    expect(isDohcThemeMessage({ protocol: "dohc:sdk:v1", theme: LIGHT })).toBe(
      false,
    );
    expect(
      isDohcThemeMessage({ protocol: DOHC_THEME_PROTOCOL, theme: LIGHT }),
    ).toBe(true);
  });

  it("reads the current theme without asking for a capability", async () => {
    const calls: string[] = [];
    const client = createDohcClient({
      transport: {
        async request(method) {
          calls.push(method);
          return LIGHT;
        },
      },
    });
    await expect(client.ui.theme()).resolves.toEqual(LIGHT);
    // Styling data grants nothing, so it must not be gated behind one.
    expect(calls).toEqual(["ui.theme"]);
  });

  it("rejects a theme response that is not a theme", async () => {
    const client = createDohcClient({
      transport: {
        async request() {
          return { mode: "light" };
        },
      },
    });
    await expect(client.ui.theme()).rejects.toMatchObject({
      code: DohcSdkErrorCodes.badResponse,
    });
  });

  it("applies the current theme and then follows the user's changes", async () => {
    const harness = createWindowHarness();
    const root = createFakeRoot();
    const client = createDohcClient({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      transport: {
        async request() {
          return LIGHT;
        },
      },
    });

    const stop = await client.ui.applyTheme({ root: root.element });
    expect(root.dataset.theme).toBe("light");
    expect(root.properties["--dohc-ink"]).toBe("#1c1b18");

    harness.dispatch({ protocol: DOHC_THEME_PROTOCOL, theme: DARK });
    expect(root.dataset.theme).toBe("dark");
    expect(root.properties["--dohc-ink"]).toBe("#f6f4ee");

    // A push from anywhere but the host is not a theme change.
    harness.dispatch(
      { protocol: DOHC_THEME_PROTOCOL, theme: LIGHT },
      { origin: "https://evil.test" },
    );
    expect(root.dataset.theme).toBe("dark");

    stop();
    harness.dispatch({ protocol: DOHC_THEME_PROTOCOL, theme: LIGHT });
    expect(root.dataset.theme).toBe("dark");
  });

  // The listener goes on before the read, so the answer to "what is the
  // theme now" cannot arrive late and undo a change that already landed.
  it("keeps a change that lands while the first read is still running", async () => {
    const harness = createWindowHarness();
    const root = createFakeRoot();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = createDohcClient({
      currentWindow: harness.currentWindow,
      targetWindow: harness.targetWindow,
      transport: {
        async request() {
          await pending;
          return LIGHT;
        },
      },
    });

    const applying = client.ui.applyTheme({ root: root.element });
    harness.dispatch({ protocol: DOHC_THEME_PROTOCOL, theme: DARK });
    expect(root.dataset.theme).toBe("dark");
    release();
    await applying;
    expect(root.dataset.theme).toBe("dark");
  });
});
