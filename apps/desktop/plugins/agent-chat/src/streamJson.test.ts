import type { PluginChildProcessCommandHandle } from "@dohc/sdk/node";
import { describe, expect, it } from "vitest";
import { ClaudeStream } from "./streamJson.ts";

/** A command child, reduced to what the stream uses. */
function fakeChild(): {
  handle: PluginChildProcessCommandHandle;
  emit(stream: "stdout" | "stderr", text: string): void;
  exit(): void;
  written: string[];
  terminated: () => number;
  failWrites(): void;
} {
  let listener: ((output: { sequence: number; stream: "stdout" | "stderr"; text: string }) => void) | null =
    null;
  let settleExit: (() => void) | null = null;
  let terminateCount = 0;
  let writesFail = false;
  const written: string[] = [];
  const exited = new Promise<{ code: number | null; reason: "exited" }>((resolve) => {
    settleExit = () => resolve({ code: 0, reason: "exited" });
  });
  const handle: PluginChildProcessCommandHandle = {
    id: "fake-child",
    pid: 4242,
    onOutput: (next) => {
      listener = next;
      return Promise.resolve(() => {
        listener = null;
        return Promise.resolve();
      });
    },
    logs: () => Promise.resolve([]),
    wait: () => exited,
    terminate: () => {
      terminateCount += 1;
      settleExit?.();
      return Promise.resolve({ code: 0, reason: "terminated" as const });
    },
    write: (data) => {
      if (writesFail) return Promise.reject(new Error("the pipe is closed"));
      written.push(data);
      return Promise.resolve();
    },
    endInput: () => Promise.resolve(),
  };
  return {
    handle,
    emit: (stream, text) => listener?.({ sequence: 0, stream, text }),
    exit: () => settleExit?.(),
    written,
    terminated: () => terminateCount,
    failWrites: () => {
      writesFail = true;
    },
  };
}

describe("the conversation on a child's streams", () => {
  it("reports each whole message, and each stderr line", async () => {
    const child = fakeChild();
    const messages: unknown[] = [];
    const errors: string[] = [];
    await ClaudeStream.attach(child.handle, {
      onMessage: (message) => messages.push(message),
      onStderr: (line) => errors.push(line),
    });

    child.emit("stdout", '{"type":"result","is_er');
    child.emit("stdout", 'ror":false}\n');
    child.emit("stderr", "a warning\n");

    expect(messages).toEqual([{ type: "result", is_error: false }]);
    expect(errors).toEqual(["a warning"]);
  });

  it("reports a line that is not a message rather than losing it", async () => {
    const child = fakeChild();
    const messages: unknown[] = [];
    const errors: string[] = [];
    await ClaudeStream.attach(child.handle, {
      onMessage: (message) => messages.push(message),
      onStderr: (line) => errors.push(line),
    });

    child.emit("stdout", "not json at all\n");

    expect(messages).toEqual([]);
    expect(errors).toEqual(["Invalid stream-json line: not json at all"]);
  });

  it("writes one line per message", async () => {
    const child = fakeChild();
    const stream = await ClaudeStream.attach(child.handle, { onMessage: () => {} });

    await expect(stream.send({ type: "user", text: "hello" })).resolves.toBe(true);

    expect(child.written).toEqual(['{"type":"user","text":"hello"}\n']);
  });

  it("refuses to write to a process that has exited", async () => {
    const child = fakeChild();
    let exits = 0;
    const stream = await ClaudeStream.attach(child.handle, {
      onMessage: () => {},
      onExit: () => {
        exits += 1;
      },
    });

    child.exit();
    await until(() => exits === 1);

    // The process that owed the answer is gone; a write that reported success
    // would be a message nobody will ever read.
    await expect(stream.send({ type: "user" })).resolves.toBe(false);
    expect(child.written).toEqual([]);
  });

  it("refuses to write once the stream is disposed", async () => {
    const child = fakeChild();
    const stream = await ClaudeStream.attach(child.handle, { onMessage: () => {} });

    await stream.dispose();

    await expect(stream.send({ type: "user" })).resolves.toBe(false);
    expect(child.terminated()).toBe(1);
  });

  it("closes itself when a write fails", async () => {
    const child = fakeChild();
    const stream = await ClaudeStream.attach(child.handle, { onMessage: () => {} });

    child.failWrites();
    await expect(stream.send({ type: "user" })).resolves.toBe(false);
    // Closed, not merely failed once: the pipe does not come back.
    await expect(stream.send({ type: "user" })).resolves.toBe(false);
  });
});

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((settle) => setTimeout(settle, 5));
  }
  throw new Error("Timed out.");
}

