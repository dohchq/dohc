import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DohcSdkError, DohcSdkErrorCodes } from ".";
import {
  createPluginChildProcessClient,
  createProcessTransport,
} from "./node";

function createStdioHarness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const queuedLines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  const lines = createInterface({ input: output });
  lines.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(`${line}\n`);
    else queuedLines.push(`${line}\n`);
  });

  return {
    input,
    output,
    transport: createProcessTransport({ input, output }),
    nextLine(): Promise<string> {
      const queued = queuedLines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => waiting.push(resolve));
    },
    send(message: unknown): void {
      input.write(`${JSON.stringify(message)}\n`);
    },
  };
}

function createLinkedTransports() {
  const callerToHandler = new PassThrough();
  const handlerToCaller = new PassThrough();
  return {
    caller: createProcessTransport({
      input: handlerToCaller,
      output: callerToHandler,
    }),
    handler: createProcessTransport({
      input: callerToHandler,
      output: handlerToCaller,
    }),
  };
}

describe("@dohc/sdk/node", () => {
  it("sends nested sdk requests and resolves matching results", async () => {
    const harness = createStdioHarness();
    const pending = harness.transport.request("files.read", { path: "notes/today.md" });

    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":1,"method":"sdk.request","params":{"method":"files.read","params":{"path":"notes/today.md"}}}\n',
    );
    harness.send({ jsonrpc: "2.0", id: 1, result: { text: "today" } });

    await expect(pending).resolves.toEqual({ text: "today" });
  });

  it("surfaces matching host errors as DohcSdkError instances", async () => {
    const harness = createStdioHarness();
    const pending = harness.transport.request("files.read", { path: "secret.md" });
    await harness.nextLine();
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "No access" },
    });

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DohcSdkError);
    expect(error).toMatchObject({ code: "-32000", message: "No access" });
  });

  it("times out and aborts requests", async () => {
    const timeoutHarness = createStdioHarness();
    await expect(
      timeoutHarness.transport.request("slow.method", undefined, { timeoutMs: 5 }),
    ).rejects.toMatchObject({
      code: DohcSdkErrorCodes.hostTimeout,
      message: "dohc host did not answer slow.method within 5ms.",
    });

    const abortHarness = createStdioHarness();
    const controller = new AbortController();
    const pending = abortHarness.transport.request("slow.method", undefined, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: DohcSdkErrorCodes.aborted,
      message: "dohc request slow.method was aborted.",
    });
  });

  it("dispatches incoming requests and returns results and errors", async () => {
    const harness = createStdioHarness();
    harness.transport.onRequest("plugin.activate", async (params) => {
      await Promise.resolve();
      return { commands: [(params as { pluginId: string }).pluginId] };
    });
    harness.transport.onRequest("plugin.fail", () => {
      throw new Error("Activation failed");
    });

    harness.send({
      jsonrpc: "2.0",
      id: "activate-1",
      method: "plugin.activate",
      params: { pluginId: "calendar" },
    });
    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":"activate-1","result":{"commands":["calendar"]}}\n',
    );

    harness.send({
      jsonrpc: "2.0",
      id: "missing-1",
      method: "plugin.missing",
      params: {},
    });
    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":"missing-1","error":{"code":-32601,"message":"Method not found: plugin.missing"}}\n',
    );

    harness.send({
      jsonrpc: "2.0",
      id: "fail-1",
      method: "plugin.fail",
      params: {},
    });
    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":"fail-1","error":{"code":-32603,"message":"Activation failed"}}\n',
    );
  });

  it("returns an RPC error when a request handler result is not serializable", async () => {
    const harness = createLinkedTransports();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    harness.handler.onRequest("sdk.request", () => circular);
    const controller = new AbortController();
    const tooSlow = new Error("Unserializable result waited for the request timeout.");
    let promptTimer: ReturnType<typeof setTimeout> | undefined;

    const pending = harness.caller.request("plugin.circular", undefined, {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    const result = await Promise.race([
      pending.catch((error: unknown) => error),
      new Promise<Error>((resolve) => {
        promptTimer = setTimeout(() => resolve(tooSlow), 250);
      }),
    ]);
    if (promptTimer) clearTimeout(promptTimer);
    if (result === tooSlow) controller.abort();

    expect(result).toBeInstanceOf(DohcSdkError);
    expect(result).toMatchObject({
      code: "-32603",
      message:
        'JSON-RPC method "sdk.request" returned a result that was not serializable.',
    });
  });

  it("normalizes a void stdio handler result to JSON null without timing out", async () => {
    const harness = createLinkedTransports();
    harness.handler.onRequest("sdk.request", () => undefined);

    await expect(
      harness.caller.request("plugin.void", undefined, { timeoutMs: 250 }),
    ).resolves.toBeNull();
  });

  it("writes notifications without request ids", async () => {
    const harness = createStdioHarness();

    harness.transport.notify("plugin.log", { level: "info", message: "Ready" });

    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","method":"plugin.log","params":{"level":"info","message":"Ready"}}\n',
    );
  });

  it("provides brokered child spawn, output, input, logs, wait, and terminate calls", async () => {
    const harness = createStdioHarness();
    const childProcesses = createPluginChildProcessClient(harness.transport);
    const spawned = childProcesses.spawn({
      modulePath: "server.mjs",
      args: ["--port", "0"],
      cwd: "data",
      env: { PORT: "0" },
    });
    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":1,"method":"sdk.request","params":{"method":"childProcesses.spawn","params":{"modulePath":"server.mjs","args":["--port","0"],"cwd":"data","env":{"PORT":"0"}}}}\n',
    );
    harness.send({ jsonrpc: "2.0", id: 1, result: { childId: "child-1", pid: 4242 } });
    const child = await spawned;
    expect(child.pid).toBe(4242);

    const outputs: unknown[] = [];
    const subscribed = child.onOutput((output) => outputs.push(output));
    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":2,"method":"sdk.request","params":{"method":"childProcesses.output.subscribe","params":{"childId":"child-1"}}}\n',
    );
    harness.send({
      jsonrpc: "2.0",
      method: "sdk.event",
      params: {
        subscriptionId: "subscription-1",
        event: "stdout",
        data: { sequence: 1, stream: "stdout", text: "ready\n" },
      },
    });
    harness.send({
      jsonrpc: "2.0",
      id: 2,
      result: { subscriptionId: "subscription-1" },
    });
    const unsubscribe = await subscribed;
    expect(outputs).toEqual([
      { sequence: 1, stream: "stdout", text: "ready\n" },
    ]);

    const sent = child.send({ kind: "ping" });
    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":3,"method":"sdk.request","params":{"method":"childProcesses.send","params":{"childId":"child-1","message":{"kind":"ping"}}}}\n',
    );
    harness.send({ jsonrpc: "2.0", id: 3, result: {} });
    await sent;

    const logs = child.logs();
    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":4,"method":"sdk.request","params":{"method":"childProcesses.logs","params":{"childId":"child-1"}}}\n',
    );
    harness.send({
      jsonrpc: "2.0",
      id: 4,
      result: [{ sequence: 1, stream: "stdout", text: "ready\n" }],
    });
    await expect(logs).resolves.toEqual([
      { sequence: 1, stream: "stdout", text: "ready\n" },
    ]);

    const waited = child.wait();
    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":5,"method":"sdk.request","params":{"method":"childProcesses.wait","params":{"childId":"child-1"}}}\n',
    );
    harness.send({
      jsonrpc: "2.0",
      id: 5,
      result: { code: 0, reason: "exited" },
    });
    await expect(waited).resolves.toEqual({ code: 0, reason: "exited" });

    const terminated = child.terminate();
    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":6,"method":"sdk.request","params":{"method":"childProcesses.terminate","params":{"childId":"child-1"}}}\n',
    );
    harness.send({
      jsonrpc: "2.0",
      id: 6,
      result: { code: null, reason: "terminated" },
    });
    await expect(terminated).resolves.toEqual({
      code: null,
      reason: "terminated",
    });

    const unsubscribed = unsubscribe();
    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":7,"method":"sdk.request","params":{"method":"subscriptions.unsubscribe","params":{"subscriptionId":"subscription-1"}}}\n',
    );
    harness.send({ jsonrpc: "2.0", id: 7, result: {} });
    await unsubscribed;
  });

  it("spawns a command child and writes to its standard input", async () => {
    const harness = createStdioHarness();
    const childProcesses = createPluginChildProcessClient(harness.transport);
    const spawned = childProcesses.spawnCommand({
      command: "claude",
      args: ["--print"],
      cwd: { workspaceRoot: true },
    });
    // The argv array crosses the wire as an array. There is no field a
    // command line could ride in.
    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":1,"method":"sdk.request","params":{"method":"childProcesses.command.spawn","params":{"command":"claude","args":["--print"],"cwd":{"workspaceRoot":true}}}}\n',
    );
    harness.send({ jsonrpc: "2.0", id: 1, result: { childId: "child-9", pid: 77 } });
    const child = await spawned;
    expect(child.pid).toBe(77);

    const written = child.write('{"jsonrpc":"2.0"}\n');
    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":2,"method":"sdk.request","params":{"method":"childProcesses.stdin.write","params":{"childId":"child-9","data":"{\\"jsonrpc\\":\\"2.0\\"}\\n"}}}\n',
    );
    harness.send({ jsonrpc: "2.0", id: 2, result: {} });
    await written;

    const ended = child.endInput();
    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":3,"method":"sdk.request","params":{"method":"childProcesses.stdin.end","params":{"childId":"child-9"}}}\n',
    );
    harness.send({ jsonrpc: "2.0", id: 3, result: {} });
    await ended;
  });

  it("propagates spawn cancellation returned by the host transport", async () => {
    const harness = createStdioHarness();
    const childProcesses = createPluginChildProcessClient(harness.transport);
    const spawned = childProcesses.spawn({ modulePath: "server.mjs" });
    await harness.nextLine();
    harness.send({ jsonrpc: "2.0", id: 1, result: { childId: "child-1", pid: 4242 } });
    const child = await spawned;
    const waiting = child.wait();
    await harness.nextLine();

    harness.send({
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: DohcSdkErrorCodes.aborted,
        message: "The plugin spawn ended before the SDK operation completed.",
      },
    });

    await expect(waiting).rejects.toMatchObject({
      code: DohcSdkErrorCodes.aborted,
      message: "The plugin spawn ended before the SDK operation completed.",
    });
  });

  it("ignores malformed input and continues with later valid lines", async () => {
    const harness = createStdioHarness();
    harness.transport.onRequest("plugin.deactivate", () => ({}));

    harness.input.write("not json\n");
    harness.send({
      jsonrpc: "2.0",
      id: 7,
      method: "plugin.deactivate",
      params: {},
    });

    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","id":7,"result":{}}\n',
    );
  });

  it("reuses a transport for the same explicit stream pair", () => {
    const input = new PassThrough();
    const output = new PassThrough();

    expect(createProcessTransport({ input, output })).toBe(
      createProcessTransport({ input, output }),
    );
  });

  it("creates a transport for the same input and a different output", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const differentOutput = new PassThrough();
    const transport = createProcessTransport({ input, output });
    const differentTransport = createProcessTransport({
      input,
      output: differentOutput,
    });

    expect(differentTransport).not.toBe(transport);

    differentTransport.notify("plugin.log", { output: "different" });

    expect(differentOutput.read()).toEqual(
      Buffer.from(
        '{"jsonrpc":"2.0","method":"plugin.log","params":{"output":"different"}}\n',
      ),
    );
    expect(output.read()).toBeNull();
  });
});
