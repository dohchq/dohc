import {expect, it, vi} from "vitest";
import {readOwnerRestoreResponse} from "./readOwnerRestoreResponse";

vi.mock("@dohc/workspace-engine-client/daemon", () => ({DEFAULT_MAX_BLOB_BYTES: 64}));

it("preserves a retained 409 body for action-specific validation", async () => {
  const body = {status: {}, result: {kind: "review-required"}};
  await expect(readOwnerRestoreResponse(Response.json(body, {status: 409}))).resolves.toEqual(body);
});

it("decodes split UTF-8 bytes without losing review text at the byte ceiling", async () => {
  const value = "🦀" + "a".repeat(58), bytes = new TextEncoder().encode(JSON.stringify(value));
  expect(bytes.byteLength).toBe(64);
  const response = new Response(new ReadableStream({start(controller) {
    controller.enqueue(bytes.slice(0, 3)); controller.enqueue(bytes.slice(3)); controller.close();
  }}));
  await expect(readOwnerRestoreResponse(response)).resolves.toBe(value);
});

it("cancels unread input when cumulative review bytes exceed the ceiling", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({start(controller) {
    controller.enqueue(new Uint8Array(32)); controller.enqueue(new Uint8Array(33));
  }, cancel}));
  await expect(readOwnerRestoreResponse(response)).rejects.toThrow("byte limit");
  expect(cancel).toHaveBeenCalledOnce();
});

it("refuses missing bodies, malformed JSON, and malformed UTF-8", async () => {
  for (const response of [new Response(null), new Response("{"), new Response(Uint8Array.of(0xc3, 0x28))]) {
    await expect(readOwnerRestoreResponse(response)).rejects.toThrow();
  }
});
