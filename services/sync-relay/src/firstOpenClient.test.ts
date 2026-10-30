import {expect, it, vi} from "vitest";
import {firstOpenOutcome, type FirstOpenSourceIdentity} from "@dohc/workspace-contracts/first-open";
import {createFirstOpenClient} from "./firstOpenClient";

const source: FirstOpenSourceIdentity = {workspaceId: "w", objectId: "o", path: "a.md", sourceMomentId: "m", sourceDigest: "a".repeat(64)};
const receipt = {originId: `service-host:first-open:${"b".repeat(64)}`, originSeq: 0 as const, relaySeq: 1};
const outcome = firstOpenOutcome(source, {kind: "published", receipt});
const config = {relay: {baseUrl: "https://relay.test", bearerToken: "dohc-service-v1.secret"}, identity: {replicationEpoch: "epoch", streamIdentity: "stream"}};
const response = (value: unknown) => Response.json(value);

it("sends only the current source and replication identity with the service bearer, no cookies or redirects", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response({ok: true, outcome}));
  const client = createFirstOpenClient({...config, fetch: fetcher});
  expect(await client(source, new AbortController().signal)).toEqual(outcome);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe("https://relay.test/sync/w/hosted/first-open");
  expect(init).toMatchObject({method: "POST", redirect: "error", credentials: "omit", headers: {authorization: "Bearer dohc-service-v1.secret"}});
  expect(JSON.parse(String(init?.body))).toEqual({objectId: "o", path: "a.md", sourceMomentId: "m", sourceDigest: source.sourceDigest, ...config.identity});
});

it.each([
  {ok: true, outcome: {...outcome, extra: true}},
  {ok: true, outcome: {...outcome, recovery: "none"}},
  {ok: true, outcome: {...outcome, source: {...source, workspaceId: "other"}}},
  {ok: true, outcome: {...outcome, source: {...source, objectId: "other"}}},
  {ok: true, outcome: {...outcome, source: {...source, path: "other.md"}}},
  {ok: true, outcome: {...outcome, source: {...source, sourceMomentId: "other"}}},
  {ok: true, outcome: {...outcome, source: {...source, sourceDigest: "c".repeat(64)}}},
  {ok: true, outcome: {...outcome, receipt: {...receipt, originSeq: 1}}},
  {ok: true, outcome: {...outcome, receipt: {...receipt, relaySeq: 0}}},
  {ok: true, outcome: {...outcome, receipt: {...receipt, originId: "device"}}},
  {ok: true, outcome: {...outcome, kind: "refused", reason: "unsupported-source", cause: "invented"}},
  {ok: true, outcome: {...outcome, kind: "unavailable", reason: "build-deadline", retryAfterMs: -1}},
])("rejects a malformed or mismatched reply without poisoning the next request: %j", async bad => {
  let reply = bad as unknown;
  const client = createFirstOpenClient({...config, fetch: async () => response(reply)});
  await expect(client(source, new AbortController().signal)).rejects.toThrow();
  reply = {ok: true, outcome};
  expect(await client(source, new AbortController().signal)).toEqual(outcome);
});

it("bounds actual streamed bytes and cancels an oversized, malformed or aborted body", async () => {
  const cancel = vi.fn();
  let reading!: () => void;
  const started = new Promise<void>(resolve => {reading = resolve;});
  let mode: "oversized" | "malformed" | "pending" = "oversized";
  const client = createFirstOpenClient({...config, maxResponseBytes: 1_024, fetch: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (mode === "oversized") controller.enqueue(new Uint8Array(1_025));
      if (mode === "malformed") {controller.enqueue(new TextEncoder().encode("{")); controller.close();}
    }, pull() {if (mode === "pending") reading();}, cancel,
  }, {highWaterMark: 0}), {headers: {"content-type": "application/json"}})});
  await expect(client(source, new AbortController().signal)).rejects.toThrow();
  expect(cancel).toHaveBeenCalledTimes(1);
  mode = "malformed";
  await expect(client(source, new AbortController().signal)).rejects.toThrow();
  mode = "pending";
  const abort = new AbortController(), pending = client(source, abort.signal);
  await started;
  abort.abort(new Error("departed"));
  await expect(pending).rejects.toThrow("departed");
  expect(cancel).toHaveBeenCalledTimes(2);
});

it("rejects HTTP errors, oversized declarations, invalid JSON media types and invalid UTF-8", async () => {
  for (const reply of [new Response("denied", {status: 403}), new Response("{}", {headers: {"content-type": "text/html"}}),
    new Response("{}", {headers: {"content-type": "application/json", "content-length": "9999999"}}),
    new Response(new Uint8Array([0xff]), {headers: {"content-type": "application/json"}})]) {
    const client = createFirstOpenClient({...config, fetch: async () => reply});
    await expect(client(source, new AbortController().signal)).rejects.toThrow();
  }
});
