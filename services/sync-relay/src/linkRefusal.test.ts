import {expect, it} from "vitest";
import {linkRefusalBody} from "@dohc/security-contract/link-refusal";
import {normalizeLinkRefusal} from "./linkRefusal";

it.each([401, 403, 404])("hides non-contract %s bodies", async status => {
  const result = await normalizeLinkRefusal(Response.json({error: "private path"}, {status}));
  expect(result.status).toBe(404);
  expect(await result.json()).toEqual({ok: false, error: "not found"});
});

it.each([500, 502, 503])("keeps %s outages retryable without exposing details", async status => {
  const result = await normalizeLinkRefusal(Response.json({error: "private path"}, {status}));
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual(linkRefusalBody("link_live_unavailable"));
});

it("preserves app backend conflicts and verified rate limits", async () => {
  for (const [status, body] of [[409, {ok: false, code: "app_backend_conflict"}], [429, linkRefusalBody("link_read_rate_limited")]] as const) {
    const result = await normalizeLinkRefusal(Response.json(body, {status}));
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual(body);
  }
});
