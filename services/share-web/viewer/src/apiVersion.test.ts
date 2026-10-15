import {afterEach, expect, it, vi} from "vitest";
import {SHARE_WEB_API_VERSION, SHARE_WEB_API_VERSION_HEADER, RELAY_API_VERSION_HEADER} from "@dohc/workspace-contracts/relay-values";
import {fetchShareWeb} from "./apiVersion";
afterEach(() => vi.unstubAllGlobals());
it("stamps the compiled viewer version while preserving credentials, body, cancellation and headers", async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {status: 204}));
  vi.stubGlobal("fetch", send);
  const controller = new AbortController();
  const headers = new Headers({"content-type": "application/json", "x-dohc-link-session": "session"});
  const init = {method: "POST", credentials: "same-origin" as const, signal: controller.signal, body: "{}", headers};
  await fetchShareWeb("/api/view/collection-writes", init);
  const [, sent] = send.mock.calls[0]!;
  expect(sent).toMatchObject({method: "POST", credentials: "same-origin", signal: controller.signal, body: "{}"});
  const actual = new Headers(sent?.headers);
  expect(actual.get(SHARE_WEB_API_VERSION_HEADER)).toBe(String(SHARE_WEB_API_VERSION));
  expect(actual.get("x-dohc-link-session")).toBe("session");
  expect(actual.has(RELAY_API_VERSION_HEADER)).toBe(false);
  expect(headers.has(SHARE_WEB_API_VERSION_HEADER)).toBe(false);
});
