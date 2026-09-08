import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { guardRelayResponses } from "./relayResponseStanding";

describe("relay response cancellation lifetime", () => {
  it.each(["empty", "complete", "cancel", "throw", "read-error"] as const)(
    "releases source listeners after %s responses", async terminal => {
      const owner = new AbortController();
      const storage = { unavailable: owner.signal, captureStanding: () => () => {} };
      const handler = guardRelayResponses(storage, async () => {
        if (terminal === "throw") throw new Error("handler failed");
        if (terminal === "empty") return new Response(null, { status: 204 });
        if (terminal === "read-error") return new Response(new ReadableStream({
          pull(controller) { controller.error(new Error("body failed")); },
        }));
        return new Response("value");
      });
      for (let index = 0; index < 32; index++) {
        const request = new Request("https://relay.test/share");
        const before = getEventListeners(request.signal, "abort").length;
        if (terminal === "throw") await expect(handler(request)).rejects.toThrow("handler failed");
        else {
          const response = await handler(request);
          if (terminal === "cancel") await response.body!.cancel();
          else if (terminal === "read-error") await expect(response.text()).rejects.toThrow("body failed");
          else await response.text();
        }
        expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
        expect(getEventListeners(request.signal, "abort")).toHaveLength(before);
      }
    },
  );

  it.each(["request", "owner"] as const)("forwards %s cancellation while a response is active", async source => {
    const owner = new AbortController(), caller = new AbortController();
    let forwarded: AbortSignal | undefined;
    let cancelled = false;
    const handler = guardRelayResponses({ unavailable: owner.signal, captureStanding: () => () => {} }, async request => {
      forwarded = request.signal;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    });
    const request = new Request("https://relay.test/share", { signal: caller.signal });
    const response = await handler(request);
    const read = response.body!.getReader().read();
    const reason = new Error("cancelled by source");
    (source === "owner" ? owner : caller).abort(reason);
    await expect(read).rejects.toThrow("Relay response is unavailable");
    expect(forwarded!.reason).toBe(reason);
    expect(cancelled).toBe(true);
    expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
  });
});
