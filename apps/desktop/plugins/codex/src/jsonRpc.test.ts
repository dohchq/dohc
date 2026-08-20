import { describe, expect, it, vi } from "vitest";
import type { PluginChildProcessCommandHandle } from "@dohc/sdk/node";
import { CommandJsonRpc, JsonRpcError } from "./jsonRpc.ts";

/**
 * A brokered command child, as this module sees one: bytes in, bytes out, and
 * an exit that arrives whenever the test says it does.
 */
function fakeChild(): {
  handle: PluginChildProcessCommandHandle;
  emit(stream: "stdout" | "stderr", text: string): void;
  exit(): void;
  written: string[];
  terminated: () => number;
} {
  const listeners: Array<(output: { sequence: number; stream: string; text: string }) => void> = [];
  const written: string[] = [];
  let sequence = 0;
  let terminateCalls = 0;
  let settleExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    settleExit = resolve;
  });

  const handle = {
    id: "child-1",
    pid: 4242,
    async onOutput(listener: (output: { sequence: number; stream: string; text: string }) => void) {
      listeners.push(listener);
      return () => undefined;
    },
    async logs() {
      return [];
    },
    async wait() {
      await exited;
      return { code: 0, reason: "exited" as const };
    },
    async terminate() {
      terminateCalls += 1;
      settleExit();
      return { code: null, reason: "terminated" as const };
    },
    async write(data: string) {
      written.push(data);
    },
    async endInput() {},
  } as unknown as PluginChildProcessCommandHandle;

  return {
    handle,
    emit(stream, text) {
      sequence += 1;
      for (const listener of [...listeners]) listener({ sequence, stream, text });
    },
    exit: () => settleExit(),
    written,
    terminated: () => terminateCalls,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function sent(written: string[]): unknown[] {
  return written.map((line) => JSON.parse(line) as unknown);
}

describe("JSON-RPC over a brokered child's streams", () => {
  it("reads one message that arrived in pieces", async () => {
    const child = fakeChild();
    const onNotification = vi.fn();
    await CommandJsonRpc.attach(child.handle, { label: "Codex", onNotification });

    child.emit("stdout", '{"jsonrpc":"2.0","method":"thread/');
    expect(onNotification).not.toHaveBeenCalled();
    child.emit("stdout", 'started","params":{"id":1}}\n');

    expect(onNotification).toHaveBeenCalledWith("thread/started", { id: 1 });
  });

  it("reads several messages that arrived together", async () => {
    const child = fakeChild();
    const onNotification = vi.fn();
    await CommandJsonRpc.attach(child.handle, { label: "Codex", onNotification });

    child.emit(
      "stdout",
      '{"jsonrpc":"2.0","method":"one"}\n{"jsonrpc":"2.0","method":"two"}\n',
    );

    expect(onNotification.mock.calls.map((call) => call[0])).toEqual(["one", "two"]);
  });

  it("reads lines a harness ended the Windows way", async () => {
    const child = fakeChild();
    const onNotification = vi.fn();
    await CommandJsonRpc.attach(child.handle, { label: "Codex", onNotification });

    child.emit("stdout", '{"jsonrpc":"2.0","method":"one"}\r\n');

    expect(onNotification).toHaveBeenCalledWith("one", undefined);
  });

  it("answers the request that asked, not another in flight", async () => {
    const child = fakeChild();
    const transport = await CommandJsonRpc.attach(child.handle, { label: "Codex" });

    const first = transport.request("initialize");
    const second = transport.request("thread/start");
    await flush();

    child.emit("stdout", '{"jsonrpc":"2.0","id":2,"result":{"thread":"t"}}\n');
    await expect(second).resolves.toEqual({ thread: "t" });

    child.emit("stdout", '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    await expect(first).resolves.toEqual({ ok: true });
  });

  it("rejects with the code and message the harness sent", async () => {
    const child = fakeChild();
    const transport = await CommandJsonRpc.attach(child.handle, { label: "Codex" });

    const pending = transport.request("thread/start");
    await flush();
    child.emit(
      "stdout",
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"thread failed"}}\n',
    );

    await expect(pending).rejects.toMatchObject({
      name: "JsonRpcError",
      code: -32000,
      message: "thread failed",
    });
  });

  it("answers a request from the harness with the handler's result", async () => {
    const child = fakeChild();
    await CommandJsonRpc.attach(child.handle, {
      label: "Codex",
      onRequest: (method) => ({ answered: method }),
    });

    child.emit("stdout", '{"jsonrpc":"2.0","id":7,"method":"item/approve"}\n');
    await flush();

    expect(sent(child.written)).toEqual([
      { jsonrpc: "2.0", id: 7, result: { answered: "item/approve" } },
    ]);
  });

  it("refuses a method no handler claims, with the code that says so", async () => {
    const child = fakeChild();
    await CommandJsonRpc.attach(child.handle, {
      label: "Codex",
      onRequest: (method) => {
        throw new JsonRpcError(-32601, `Method not found: ${method}`);
      },
    });

    child.emit("stdout", '{"jsonrpc":"2.0","id":7,"method":"surprise"}\n');
    await flush();

    expect(sent(child.written)).toEqual([
      {
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32601, message: "Method not found: surprise" },
      },
    ]);
  });

  it("reports a handler that failed for another reason as an internal error", async () => {
    const child = fakeChild();
    await CommandJsonRpc.attach(child.handle, {
      label: "Codex",
      onRequest: () => {
        throw new Error("the session is not ready");
      },
    });

    child.emit("stdout", '{"jsonrpc":"2.0","id":7,"method":"item/approve"}\n');
    await flush();

    expect(sent(child.written)).toEqual([
      {
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32603, message: "the session is not ready" },
      },
    ]);
  });

  it("keeps the harness's diagnostics off the protocol", async () => {
    const child = fakeChild();
    const onNotification = vi.fn();
    const onStderr = vi.fn();
    await CommandJsonRpc.attach(child.handle, { label: "Codex", onNotification, onStderr });

    child.emit("stderr", "ERROR models cache is missing a field\n");

    expect(onStderr).toHaveBeenCalledWith("ERROR models cache is missing a field");
    expect(onNotification).not.toHaveBeenCalled();
  });

  it("reports a line that is not JSON rather than failing on it", async () => {
    const child = fakeChild();
    const onStderr = vi.fn();
    const transport = await CommandJsonRpc.attach(child.handle, { label: "Codex", onStderr });

    child.emit("stdout", "Codex is starting up\n");
    const pending = transport.request("initialize");
    await flush();
    child.emit("stdout", '{"jsonrpc":"2.0","id":1,"result":{}}\n');

    expect(onStderr).toHaveBeenCalledWith("Invalid JSON-RPC line: Codex is starting up");
    await expect(pending).resolves.toEqual({});
  });

  it("fails everything still waiting when the harness exits", async () => {
    const child = fakeChild();
    const onExit = vi.fn();
    const transport = await CommandJsonRpc.attach(child.handle, { label: "Codex", onExit });

    const pending = transport.request("thread/start");
    await flush();
    child.exit();

    await expect(pending).rejects.toThrow("Codex exited.");
    expect(onExit).toHaveBeenCalledTimes(1);
    await expect(transport.request("thread/start")).rejects.toThrow("Codex is closed.");
  });

  it("stops the harness when it is disposed", async () => {
    const child = fakeChild();
    const transport = await CommandJsonRpc.attach(child.handle, { label: "Codex" });

    const pending = transport.request("thread/start");
    await flush();
    await transport.dispose();

    await expect(pending).rejects.toThrow("Codex was disposed.");
    expect(child.terminated()).toBe(1);
  });

  it("says nothing more once it is closed", async () => {
    const child = fakeChild();
    const transport = await CommandJsonRpc.attach(child.handle, { label: "Codex" });
    await transport.dispose();
    const before = child.written.length;

    transport.notify("initialized", {});
    await flush();

    expect(child.written.length).toBe(before);
  });
});
