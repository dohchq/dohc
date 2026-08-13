import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DohcSdkError, DohcSdkErrorCodes } from ".";
import { createProcessTransport } from "./node";

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

  it("writes notifications without request ids", async () => {
    const harness = createStdioHarness();

    harness.transport.notify("plugin.log", { level: "info", message: "Ready" });

    await expect(harness.nextLine()).resolves.toBe(
      '{"jsonrpc":"2.0","method":"plugin.log","params":{"level":"info","message":"Ready"}}\n',
    );
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
