import { describe, expect, it } from "vitest";
import { guardedByteResponse } from "./linkResponseStreams";

describe("guardedByteResponse", () => {
  it("sends no chunk after a change that commits once its guard has passed", async () => {
    let visible = true;
    // Whether access held when each chunk was cut, just before it went out.
    const sent: boolean[] = [];
    class Watched extends Uint8Array {
      override subarray(start?: number, end?: number): Uint8Array<ArrayBuffer> {
        sent.push(visible);
        return super.subarray(start, end);
      }
    }
    let refreshes = 0;
    const response = guardedByteResponse(
      new Watched(10),
      {},
      {
        register: () => () => undefined,
        release: () => undefined,
        terminatedMessage: "ended",
        refresh: async () => {
          refreshes++;
        },
        guard: () => {
          if (!visible) throw new Error("hidden");
          // A rule or membership change commits at the first chance after the check.
          queueMicrotask(() => (visible = false));
        },
      },
    );
    const reader = response.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBe(10);
    await expect(reader.read()).rejects.toThrow("hidden");
    expect(sent).toEqual([true]);
    expect(refreshes).toBe(2);
  });

  it("ends the stream when the refresh fails, before any chunk", async () => {
    const response = guardedByteResponse(
      new Uint8Array(10),
      {},
      {
        register: () => () => undefined,
        release: () => undefined,
        terminatedMessage: "ended",
        refresh: async () => {
          throw new Error("fenced");
        },
      },
    );
    await expect(response.body!.getReader().read()).rejects.toThrow("fenced");
  });
});
