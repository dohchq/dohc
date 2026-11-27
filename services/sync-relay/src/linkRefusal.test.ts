import { expect, it } from "vitest";
import { LINK_REFUSALS, linkRefusalBody } from "@dohc/security-contract/link-refusal";
import { liveNoteStanding, normalizeLinkRefusal } from "./linkRefusal";

it.each([401, 403, 404])("hides non-contract %s bodies", async (status) => {
  const result = await normalizeLinkRefusal(
    Response.json({ error: "private path" }, { status }),
    "/sync/link/share",
  );
  expect(result.status).toBe(404);
  expect(await result.json()).toEqual({ ok: false, error: "not found" });
});

it.each([500, 502, 503])("keeps %s outages retryable without exposing details", async (status) => {
  const result = await normalizeLinkRefusal(
    Response.json({ error: "private path" }, { status }),
    "/sync/link/share",
  );
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual(linkRefusalBody("link_unavailable"));
});

// Only the relay's own verified answer passes, and only on a live route.
it.each(["link_live_stopped", "link_live_starting"] as const)(
  "lets a live route say why editing is not live: %s",
  async (code) => {
    const answer = () =>
      Response.json(linkRefusalBody(code), { status: LINK_REFUSALS[code].status });
    const live = await normalizeLinkRefusal(answer(), "/sync/live/link-tickets", true);
    expect([live.status, await live.json()]).toEqual([503, linkRefusalBody(code)]);
    const other = await normalizeLinkRefusal(answer(), "/sync/link/share");
    expect([other.status, await other.json()]).toEqual([503, linkRefusalBody("link_unavailable")]);
    const forged = await normalizeLinkRefusal(
      Response.json({ ...linkRefusalBody(code), detail: "private host" }, { status: 503 }),
      "/sync/live/link-tickets",
      true,
    );
    expect(await forged.json()).toEqual(linkRefusalBody("link_live_unavailable"));
  },
);

it.each([500, 502, 503])("uses live-editing words only for live routes on %s", async (status) => {
  const result = await normalizeLinkRefusal(
    Response.json({ error: "private host" }, { status }),
    "/sync/live/link-document",
    true,
  );
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual(linkRefusalBody("link_live_unavailable"));
});

it("preserves app backend conflicts and verified rate limits", async () => {
  for (const [status, body] of [
    [409, { ok: false, code: "app_backend_conflict" }],
    [429, linkRefusalBody("link_read_rate_limited")],
  ] as const) {
    const result = await normalizeLinkRefusal(Response.json(body, { status }), "/sync/link/share");
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual(body);
  }
});

it.each([
  ["/sync/link/collection-writes", 403, "share_op_rejected", 403],
  ["/sync/%6cink/collection-writes", 403, "share_op_rejected", 403],
  ["/%73ync/link/%63ollection-writes", 403, "share_op_rejected", 403],
  ["/sync//link/collection-writes/", 403, "share_op_rejected", 403],
  ["/sync/link/share", 403, "share_op_rejected", 404],
  ["/sync/link/collection-writes/extra", 403, "share_op_rejected", 403],
  ["/sync/link/collection-writes", 401, "share_op_rejected", 404],
  ["/sync/link/collection-writes", 404, "share_op_rejected", 404],
  ["/sync/link/collection-writes", 403, "share_read_only", 404],
])("normalizes %s status %s code %s to %s", async (path, status, code, expected) => {
  const body = { ok: false, code, error: "write refused" };
  const result = await normalizeLinkRefusal(Response.json(body, { status }), path);
  expect(result.status).toBe(expected);
  expect(await result.json()).toEqual(expected === 403 ? body : { ok: false, error: "not found" });
});

it.each(["link", "link-lane-owner", "linkx", "link-refresh", "link-handoff", "link-redeem"])(
  "preserves a missing key envelope response for workspace %s",
  async (workspaceId) => {
    const body = { ok: false, code: "key_envelope_not_found", error: "key envelope not found" };
    const response = Response.json(body, {
      status: 404,
      headers: { "x-workspace-test": "preserved" },
    });
    const result = await normalizeLinkRefusal(response, `/sync/${workspaceId}/keys`);
    expect(result).toBe(response);
    expect(result.headers.get("x-workspace-test")).toBe("preserved");
    expect(await result.json()).toEqual(body);
  },
);

// A note live on its record is still starting until its host serves it. One its host refused waits for its owner.
it.each([
  ["live", { status: "ready" }, undefined],
  ["live", { status: "preparing" }, "starting"],
  ["live", { status: "unavailable", reason: "live-start-failing" }, "starting"],
  ["live", { status: "unavailable" }, undefined],
  ["live", { status: "unavailable", reason: "note-format-off" }, undefined],
  ["live", { status: "unavailable", reason: "session-host-refused" }, "off"],
  ["starting", { status: "unavailable", reason: "live-document-without-lineage" }, "off"],
  ["starting", { status: "unavailable" }, "starting"],
  ["stopping", { status: "ready" }, "off"],
] as const)("answers a %s note whose readiness is %o with %s", (state, readiness, standing) => {
  expect(liveNoteStanding(state, () => readiness)).toBe(standing);
});

// A note with no record may never get one, so only a record that says starting or off answers.
it.each([
  [undefined, undefined],
  ["live", undefined],
  ["starting", "starting"],
  ["off", "off"],
  ["stopping", "off"],
] as const)("answers from a note record in state %s with %s", (state, standing) => {
  expect(liveNoteStanding(state)).toBe(standing);
});
