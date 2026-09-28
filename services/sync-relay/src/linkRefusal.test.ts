import {expect, it} from "vitest";
import {linkRefusalBody} from "@dohc/security-contract/link-refusal";
import {normalizeLinkRefusal} from "./linkRefusal";

it.each([401, 403, 404])("hides non-contract %s bodies", async status => {
  const result = await normalizeLinkRefusal(Response.json({error: "private path"}, {status}), "/sync/link/share");
  expect(result.status).toBe(404);
  expect(await result.json()).toEqual({ok: false, error: "not found"});
});

it.each([500, 502, 503])("keeps %s outages retryable without exposing details", async status => {
  const result = await normalizeLinkRefusal(Response.json({error: "private path"}, {status}), "/sync/link/share");
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual(linkRefusalBody("link_unavailable"));
});

it.each([500, 502, 503])("uses live-editing words only for live routes on %s", async status => {
  const result = await normalizeLinkRefusal(Response.json({error: "private host"}, {status}), "/sync/live/link-document", true);
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual(linkRefusalBody("link_live_unavailable"));
});

it("preserves app backend conflicts and verified rate limits", async () => {
  for (const [status, body] of [[409, {ok: false, code: "app_backend_conflict"}], [429, linkRefusalBody("link_read_rate_limited")]] as const) {
    const result = await normalizeLinkRefusal(Response.json(body, {status}), "/sync/link/share");
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual(body);
  }
});

it.each([
  ["/sync/link/collection-writes", 403, "share_op_rejected", 403],
  ["/sync/link/share", 403, "share_op_rejected", 404],
  ["/sync/link/collection-writes/extra", 403, "share_op_rejected", 404],
  ["/sync/link/collection-writes", 401, "share_op_rejected", 404],
  ["/sync/link/collection-writes", 404, "share_op_rejected", 404],
  ["/sync/link/collection-writes", 403, "share_read_only", 404],
])("normalizes %s status %s code %s to %s", async (path, status, code, expected) => {
  const body = {ok: false, code, error: "write refused"};
  const result = await normalizeLinkRefusal(Response.json(body, {status}), path);
  expect(result.status).toBe(expected);
  expect(await result.json()).toEqual(expected === 403 ? body : {ok: false, error: "not found"});
});
