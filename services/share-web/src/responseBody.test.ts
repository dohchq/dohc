import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { pipeResponseBody } from "./responseBody";

class ControlledResponse extends EventEmitter {
  destroyed = false;
  writableFinished = false;
  readonly writes: Uint8Array[] = [];

  write(chunk: Uint8Array): boolean {
    this.writes.push(chunk);
    return false;
  }

  end(): void {
    this.writableFinished = true;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function response(value: ControlledResponse): ServerResponse {
  return value as unknown as ServerResponse;
}

describe("share-web response body pipe", () => {
  it("waits for drain before pulling more and cancels the upstream body on close", async () => {
    let cancelled = false;
    let pulls = 0;
    const chunks = [Uint8Array.of(1), Uint8Array.of(2)] as const;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          const chunk = chunks[pulls - 1];
          if (chunk) controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const outgoing = new ControlledResponse();
    const piping = pipeResponseBody(body, response(outgoing), false);

    await vi.waitFor(() => expect(outgoing.writes).toHaveLength(1));
    await Promise.resolve();
    expect(pulls).toBe(1);
    expect(outgoing.writes[0]).toBe(chunks[0]);

    outgoing.emit("drain");
    await vi.waitFor(() => expect(outgoing.writes).toHaveLength(2));
    expect(pulls).toBe(2);
    expect(outgoing.writes[1]).toBe(chunks[1]);

    outgoing.emit("close");
    await piping;
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
    expect(outgoing.writes).toHaveLength(2);
  });
});
