import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createEngineClient, encodeFrame, FrameDecoder } from "./engineClient";

const spawning = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawning }));
afterEach(() => {
  spawning.mockReset();
  vi.unstubAllEnvs();
});

function child({ exitsWhenInputCloses = true } = {}) {
  const value = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
  });
  const decoder = new FrameDecoder(1024 * 1024);
  value.stdin.on("data", (bytes) => {
    for (const frame of decoder.push(bytes))
      if (frame.kind === "control") {
        const envelope = JSON.parse(frame.payload.toString("utf8"));
        if (envelope.type === "hello")
          queueMicrotask(() =>
            value.stdout.write(
              encodeFrame(
                1,
                0,
                Buffer.from(
                  JSON.stringify({
                    type: "helloAck",
                    protocolVersion: 2,
                    sessionGeneration: 1,
                    capabilities: ["core", "blobs"],
                    limits: {
                      maxFrameBytes: 1024 * 1024,
                      maxBlobChunkBytes: 64 * 1024,
                      maxStringBytes: 64 * 1024,
                      maxCollectionLen: 1024,
                      maxBatchLen: 64,
                      maxJsonDepth: 32,
                    },
                  }),
                ),
                1024 * 1024,
              ),
            ),
          );
      }
  });
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    value.exitCode = code;
    value.signalCode = signal;
    value.stdout.end();
    value.stderr.end();
    value.emit("exit", code, signal);
    value.emit("close", code, signal);
  };
  value.kill.mockImplementation((signal: NodeJS.Signals = "SIGTERM") => {
    if (signal === "SIGKILL") exit(null, signal);
  });
  if (exitsWhenInputCloses) value.stdin.on("finish", () => exit(0, null));
  return value;
}

it.each([undefined, "explicit-host.json"])(
  "passes only explicit native host configuration: %s",
  async (config) => {
    vi.stubEnv("DOHC_ENGINE_LIVE_HOST_CONFIG", "foreign-session.json");
    spawning.mockImplementation(child);
    const client = await createEngineClient({
      command: "owned-engine",
      authToken: "owned-token",
      protocolVersion: 2,
      capabilities: ["core", "blobs"],
      env: config ? { DOHC_ENGINE_LIVE_HOST_CONFIG: config } : {},
      privateLiveApplication: { aggregateBytes: 200_000_000, maxUploads: 1 },
    });
    try {
      expect(spawning.mock.calls[0]![2].env.DOHC_ENGINE_LIVE_HOST_CONFIG).toBe(config);
    } finally {
      client.close();
      await client.waitForExit();
    }
  },
);

it("starts the engine in its own process group when asked", async () => {
  spawning.mockImplementation(child);
  const client = await createEngineClient({
    command: "owned-engine",
    authToken: "owned-token",
    protocolVersion: 2,
    capabilities: ["core", "blobs"],
    ownProcessGroup: true,
  });
  try {
    expect(spawning.mock.calls[0]![2].detached).toBe(true);
  } finally {
    client.close();
    await client.waitForExit();
  }
});

it.each([false, undefined])(
  "keeps the engine in its owner's process group otherwise: %s",
  async (ownProcessGroup) => {
    spawning.mockImplementation(child);
    const client = await createEngineClient({
      command: "owned-engine",
      authToken: "owned-token",
      protocolVersion: 2,
      capabilities: ["core", "blobs"],
      ...(ownProcessGroup === undefined ? {} : { ownProcessGroup }),
    });
    try {
      expect(spawning.mock.calls[0]![2]).not.toHaveProperty("detached");
    } finally {
      client.close();
      await client.waitForExit();
    }
  },
);

it("rejects invalid private upload budgets before creating a process", async () => {
  await expect(
    createEngineClient({
      command: "owned-engine",
      authToken: "owned-token",
      protocolVersion: 2,
      capabilities: ["core"],
      privateLiveApplication: { aggregateBytes: -1, maxUploads: 1 },
    }),
  ).rejects.toThrow();
  expect(spawning).not.toHaveBeenCalled();
});

it.each([
  undefined,
  '{"node":"/operator/node","bundle":"/operator/reader.cjs","manifest":"/operator/manifest.json"}',
])("passes only explicit reader startup configuration: %s", async (config) => {
  vi.stubEnv("DOHC_ENGINE_READER_CONFIG", "foreign-reader");
  spawning.mockImplementation(child);
  const client = await createEngineClient({
    command: "owned-engine",
    authToken: "owned-token",
    protocolVersion: 2,
    capabilities: ["core", "blobs"],
    env: config ? { DOHC_ENGINE_READER_CONFIG: config } : {},
  });
  try {
    expect(spawning.mock.calls[0]![2].env.DOHC_ENGINE_READER_CONFIG).toBe(config);
  } finally {
    client.close();
    await client.waitForExit();
  }
});

it("kills an engine that is still running 2 seconds after its input closes", async () => {
  const engine = child({ exitsWhenInputCloses: false });
  spawning.mockReturnValue(engine);
  const client = await createEngineClient({
    command: "owned-engine",
    authToken: "owned-token",
    protocolVersion: 2,
    capabilities: ["core", "blobs"],
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    client.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(engine.kill.mock.calls).toEqual([["SIGKILL"]]);
    await client.waitForExit();
  } finally {
    vi.useRealTimers();
  }
});
