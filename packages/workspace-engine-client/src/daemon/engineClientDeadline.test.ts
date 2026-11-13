import { afterEach, expect, it } from "vitest";
import { createEngineClient, type EngineClient } from "./engineClient";

// An engine in its own process, so its reply reaches the pipe while this thread is busy. It answers each request at
// once, except a "stall" request, after which it stops reading its input.
const ENGINE = `
let buffered = Buffer.alloc(0), reading = true;
const send = envelope => {
  const payload = Buffer.from(JSON.stringify(envelope), "utf8"), frame = Buffer.alloc(12 + payload.length);
  frame.write("DOP1", 0, "ascii"); frame[4] = 1; frame[5] = 0; frame.writeUInt16LE(0, 6); frame.writeUInt32LE(payload.length, 8);
  payload.copy(frame, 12); process.stdout.write(frame);
};
const limits = {maxFrameBytes: 1048576, maxBlobChunkBytes: 65536, maxStringBytes: 65536, maxCollectionLen: 1024, maxBatchLen: 64, maxJsonDepth: 32};
process.stdin.on("data", bytes => {
  if (!reading) return;
  buffered = Buffer.concat([buffered, bytes]);
  while (buffered.length >= 12 && buffered.length >= 12 + buffered.readUInt32LE(8)) {
    const length = buffered.readUInt32LE(8), envelope = JSON.parse(buffered.subarray(12, 12 + length).toString("utf8"));
    buffered = buffered.subarray(12 + length);
    if (envelope.type === "hello") send({type: "helloAck", protocolVersion: 2, sessionGeneration: 1, capabilities: ["core"], limits});
    else if (envelope.type === "request" && envelope.method === "stall") {reading = false; process.stdin.pause();}
    else if (envelope.type === "request") send({type: "response", id: envelope.id, result: {answered: true}});
  }
});`;

const clients: EngineClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
    await client.waitForExit();
  }
});
async function engine() {
  const client = await createEngineClient({
    command: process.execPath,
    args: ["-e", ENGINE],
    authToken: "token",
    protocolVersion: 2,
    capabilities: ["core"],
    connectTimeoutMs: 10_000,
  });
  clients.push(client);
  return client;
}
// The relay's thread is busy, as during a long synchronous save or validation.
const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* busy */
  }
};
let id = 0;
const ask = (client: EngineClient, method = "answer", deadlineMs = 100) =>
  client.sendRequest({ id: ++id, method, params: {}, deadlineMs });

// Proves: a reply the engine sent inside the deadline is read, though this thread was busy past the deadline and
// its timer is due before the reply is read, whatever kind of callback kept the thread busy.
it.each(["immediate", "timer", "reply"] as const)(
  "takes a reply the engine already sent when the thread was busy in a %s callback",
  async (where) => {
    const client = await engine();
    await ask(client);
    for (let trial = 0; trial < 5; trial++) {
      const { reply } = await new Promise<{ reply: Promise<unknown> }>((resolve) => {
        const run = () => {
          const pending = ask(client);
          pending.catch(() => {});
          busy(250);
          resolve({ reply: pending });
        };
        if (where === "immediate") setImmediate(run);
        else if (where === "timer") setTimeout(run, 0);
        else void ask(client).then(run);
      });
      await expect(reply).resolves.toMatchObject({ result: { answered: true } });
    }
  },
);

// Proves: a request queued behind a write that has not drained, and reached only after its deadline because this
// thread was busy, fails as unsent, and the client keeps serving the next request.
it("fails a request it could not write before its deadline as unsent", async () => {
  const client = await engine();
  await ask(client);
  const { late } = await new Promise<{ late: Promise<unknown> }>((resolve) =>
    setImmediate(() => {
      // Larger than the stream's 16 KB buffer, so the client holds the next request until this write drains.
      const large = client.sendRequest({
        id: ++id,
        method: "answer",
        params: { filler: "x".repeat(40_000) },
        deadlineMs: 10_000,
      });
      large.catch(() => {});
      const pending = ask(client);
      pending.catch(() => {});
      busy(250);
      resolve({ late: pending });
    }),
  );
  await expect(late).rejects.toMatchObject({ name: "EngineRequestDeadlineError", unsent: true });
  await expect(ask(client)).resolves.toMatchObject({ result: { answered: true } });
});

// Proves: a sent request the engine does not answer fails as sent, so the relay still stops that engine.
it("fails a sent request with no reply as sent", async () => {
  const client = await engine();
  await ask(client);
  await expect(ask(client, "stall")).rejects.toMatchObject({
    name: "EngineRequestDeadlineError",
    unsent: false,
  });
});
