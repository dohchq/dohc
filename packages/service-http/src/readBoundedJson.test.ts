import { describe, expect, it } from "vitest";
import { readBoundedJson } from "./readBoundedJson";

describe("bounded JSON stream", () => {
  it("counts UTF-8 bytes and refuses an oversized stream before reading its remainder", async () => {
    const bytes = Buffer.from('{"text":"é"}');
    expect(await readBoundedJson(new Response(bytes), bytes.length, new AbortController().signal)).toEqual({ text: "é" });
    await expect(readBoundedJson(new Response(bytes), bytes.length - 1, new AbortController().signal)).rejects.toThrow(/limit/);
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("x".repeat(9))); }, cancel() { cancelled = true; } });
    await expect(readBoundedJson(new Response(body), 8, new AbortController().signal)).rejects.toThrow(/limit/);
    expect(cancelled).toBe(true);
  });

  it("rejects invalid UTF-8 and aborts a pending body read", async () => {
    await expect(readBoundedJson(new Response(Uint8Array.from([34, 255, 34])), 8, new AbortController().signal)).rejects.toMatchObject({ code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
    const controller = new AbortController();
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const pending = readBoundedJson(response, 8, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });

  it("rejects invalid limits before consuming a body", async () => {
    for (const limit of [NaN, Infinity, -1, 1.5]) {
      const response = new Response("{}");
      await expect(readBoundedJson(response, limit, new AbortController().signal)).rejects.toThrow("Invalid JSON body limit.");
      expect(response.bodyUsed).toBe(false);
    }
  });
});
