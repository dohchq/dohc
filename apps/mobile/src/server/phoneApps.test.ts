import { describe, expect, it } from "vitest";
import { ServerError } from "./client";
import { appOperations } from "./phoneApps";
import {
  A,
  ACTION,
  answerLaunch,
  B,
  GRANT,
  grantAnswer,
  HANDOFF,
  page,
  signedIn,
  TOKEN,
  version,
} from "./testApps";
import { testServer } from "./testServer";

const signal = new AbortController().signal;
function setup() {
  const server = testServer();
  return { server, ops: appOperations(signedIn(server).client, "ws-1", signal) };
}

describe("the phone's app operations", () => {
  it("lists every catalog page", async () => {
    const { server, ops } = setup();
    server.on("POST", "/sync/ws-1/ops/apps", page([version(A, true)], A), page([version(B)]));
    expect(await ops.list()).toEqual([version(A, true), version(B)]);
    expect(server.calls.map((call) => call.body)).toEqual([{}, { cursor: A }]);
  });

  it("fails a read it can't finish or use, never answering part of the catalog", async () => {
    let pages = 0;
    const cases = [
      ["unreadable", [page([{ ...version(A), approved: "yes" } as never])]],
      // The last answer repeats, so the second cursor comes back.
      ["a repeated cursor", [page([version(A)], B), page([], A)]],
      // A new cursor on every page, as a catalog over the limit has.
      ["past the page limit", [() => page([], (++pages).toString(16).padStart(64, "0"))]],
    ] as const;
    for (const [name, answers] of cases) {
      const { server, ops } = setup();
      server.on("POST", "/sync/ws-1/ops/apps", ...answers);
      await expect(ops.list(), name).rejects.toMatchObject({ problem: "invalid" });
    }
    expect(pages).toBe(200);
  });

  it("reads a review's version and reach, and a source file or that it's unavailable", async () => {
    const { server, ops } = setup();
    const review = {
      ...version(A),
      authorityRevision: 2,
      createdAtMs: 1_700_000_000_000,
      publishedByAgent: { kind: "agent", label: "Nova", labelSource: "agent-declared" },
      capabilities: [
        {
          kind: "dataset",
          name: "Registrations",
          operations: [
            {
              name: "registrations.list",
              readOnly: true,
              fields: [{ fieldId: "f", name: "Name" }],
            },
            { name: "registrations.add", readOnly: false },
          ],
        },
      ],
      sources: [{ path: "events/signup/index.ts", byteLength: 12 }],
      approval: null,
    };
    server.on("POST", "/sync/ws-1/ops/appReview", {
      status: 200,
      body: { ok: true, result: review },
    });
    expect(await ops.review(A)).toEqual({
      ...version(A),
      authorityRevision: 2,
      createdAtMs: 1_700_000_000_000,
      agent: { label: "Nova" },
      reach: [
        {
          name: "Registrations",
          operations: [
            { name: "registrations.list", readOnly: true, fields: ["Name"] },
            { name: "registrations.add", readOnly: false, fields: [] },
          ],
        },
      ],
      sources: ["events/signup/index.ts"],
    });
    // An answer for another app, or with a reach the phone can't name, is never shown.
    for (const changed of [
      { ...review, publicationId: B },
      { ...review, capabilities: [{ kind: "collection", name: "Notes", operations: [] }] },
    ]) {
      server.on("POST", "/sync/ws-1/ops/appReview", {
        status: 200,
        body: { ok: true, result: changed },
      });
      await expect(ops.review(A)).rejects.toMatchObject({ problem: "invalid" });
    }
    const path = "events/signup/index.ts";
    server.on(
      "POST",
      "/sync/ws-1/ops/appSource",
      { status: 200, body: { ok: true, result: { path, available: true, text: "export {}" } } },
      { status: 200, body: { ok: true, result: { path, available: false } } },
    );
    expect(await ops.source(A, path)).toEqual({ available: true, text: "export {}" });
    expect(await ops.source(A, path)).toEqual({ available: false });
  });

  it("names a changed app's refusal", async () => {
    const { server, ops } = setup();
    server.on("POST", "/sync/ws-1/ops/appApprove", {
      status: 409,
      body: { ok: false, error: "This app changed. Review it again.", code: "conflict" },
    });
    const error = await ops.approve(version(A)).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ problem: "refused", code: "conflict" });
  });
});

describe("a launch", () => {
  it("sends share-web the grant alone, with no token, cookie or Origin", async () => {
    const { server, ops } = setup();
    answerLaunch(server);
    expect(await ops.launch(server.fetch, version(A, true), signal)).toEqual({
      action: ACTION,
      handoff: HANDOFF,
    });
    const [grant, launch] = server.calls;
    expect(grant!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(grant!.body).toEqual({ publicationId: A, authorityRevision: 1 });
    expect(launch!.path).toBe("/api/apps/phone-launch");
    expect(launch!.body).toEqual({ grant: GRANT, workspaceId: "ws-1", publicationId: A });
    expect(Object.keys(launch!.headers).sort()).toEqual(["accept", "content-type"]);
    expect(JSON.stringify([launch!.path, launch!.headers, launch!.body])).not.toContain(TOKEN);
  });

  it("refuses a bootstrap it can't use, and share-web's refusal", async () => {
    for (const answer of [
      { status: 200, body: { action: ACTION.replace("https:", "http:"), handoff: HANDOFF } },
      { status: 200, body: { action: `${ACTION}?next=1`, handoff: HANDOFF } },
      { status: 200, body: { action: ACTION.replace("/bootstrap", "/"), handoff: HANDOFF } },
      { status: 200, body: { action: "dohc://app-run", handoff: HANDOFF } },
      { status: 200, body: { action: ACTION, handoff: "short" } },
      { status: 404, body: { ok: false } },
    ]) {
      const { server, ops } = setup();
      server.on("POST", "/sync/ws-1/ops/appLaunch", grantAnswer);
      server.on("POST", "/api/apps/phone-launch", answer);
      await expect(ops.launch(server.fetch, version(A, true), signal)).rejects.toBeInstanceOf(
        ServerError,
      );
    }
  });
});
