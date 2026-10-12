import {expect, it, vi} from "vitest";
import {createNamedRelayCalls} from "./namedRelayCalls";

it("refuses an already aborted call at once and keeps its slot until the work ends", async () => {
  const calls = createNamedRelayCalls({maxPending: 1, timeoutMs: 1000, unrefDeadline: false,
    refuse: () => new Response(null, {status: 404}), fetchRelay: async () => new Response(null)});
  let release!: () => void, observed: AbortSignal | undefined;
  const released = new Promise<void>(resolve => {release = resolve;});
  const controller = new AbortController(); controller.abort();
  const result = calls.run(new Request("https://share.example.test/", {signal: controller.signal}), async signal => {
    observed = signal;
    await released;
    return new Response(null, {status: 200});
  });
  expect((await result).status).toBe(404);
  expect(observed?.aborted).toBe(true);
  expect(calls.full).toBe(true);
  release();
  await vi.waitFor(() => expect(calls.full).toBe(false));
});
