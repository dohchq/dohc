import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDohcMcpServer } from "./server";
import { waitForMessages, type ToolContext } from "./tools";

const connections: Array<{ client: Client; server: ReturnType<typeof createDohcMcpServer> }> = [];
async function connect(ctx: ToolContext) {
  const server = createDohcMcpServer(ctx);
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  connections.push({ client, server });
  return { client, server };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) {
    await server.close();
    await client.close();
  }
});

describe("wait for messages", () => {
  it("forwards narrow filters and the cursor through the desktop agent door", async () => {
    const request = vi.fn<NonNullable<ToolContext["request"]>>(async () => ({ messages: [], cursor: "next" }));
    const { client } = await connect({ root: "/workspace", home: "/state", request });
    const result = await client.callTool({ name: "dohc_wait_for_messages", arguments: { cursor: "previous", group: "general", thread: "th_1", timeoutMs: 0 } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ messages: [], cursor: "next" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ door: "mcp", verb: "watch", args: { cwd: "/workspace", actor: "agent", cursor: "previous", group: "general", thread: "th_1", timeoutMs: 0 } }), { signal: expect.any(AbortSignal) });
  });

  it("offers waits only on the owning workspace and describes the loop", async () => {
    for (const shareAccess of [undefined, "view", "comment", "edit"] as const) {
      const { client } = await connect({ root: "/workspace", home: "/state", shareAccess });
      const tool = (await client.listTools()).tools.find(tool => tool.name === "dohc_wait_for_messages");
      expect(Boolean(tool)).toBe(shareAccess === undefined);
      if (tool) expect(tool.description).toContain("Call in a loop");
    }
    const request = vi.fn();
    expect(await waitForMessages({ root: "/workspace", home: "/state", shareAccess: "view", request }, {})).toMatchObject({ ok: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses waits past the connection limit and releases the slots", async () => {
    const entered = deferred();
    const releases: Array<() => void> = [];
    const request: NonNullable<ToolContext["request"]> = async () => releases.length === 4 ? { messages: [], cursor: "next" } : new Promise(resolve => {
      releases.push(() => resolve({ messages: [], cursor: "next" }));
      if (releases.length === 4) entered.resolve();
    });
    const { client } = await connect({ root: "/workspace", home: "/state", request });
    const pending = Array.from({ length: 4 }, () => client.callTool({ name: "dohc_wait_for_messages", arguments: {} }));
    await entered.promise;
    const refused = await client.callTool({ name: "dohc_wait_for_messages", arguments: {} });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ ok: false, reason: expect.stringContaining("Too many") });
    for (const release of releases) release();
    await Promise.all(pending);
    expect((await client.callTool({ name: "dohc_wait_for_messages", arguments: {} })).isError).not.toBe(true);
  });

  it.each(["request", "disconnect", "shutdown"] as const)("passes %s cancellation to the desktop socket", async kind => {
    const entered = deferred();
    const cancelled = deferred();
    const request: NonNullable<ToolContext["request"]> = async (_request, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => { cancelled.resolve(); reject(new Error("cancelled")); }, { once: true });
      entered.resolve();
    });
    const { client, server } = await connect({ root: "/workspace", home: "/state", request });
    const cancellation = new AbortController();
    const pending = client.callTool({ name: "dohc_wait_for_messages", arguments: {} }, undefined, { signal: cancellation.signal }).catch(() => undefined);
    await entered.promise;
    if (kind === "request") cancellation.abort();
    else if (kind === "disconnect") await client.close();
    else await server.close();
    await cancelled.promise;
    await pending;
  });
});
