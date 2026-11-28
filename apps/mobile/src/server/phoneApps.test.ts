import { describe, expect, it } from "vitest";
import { ServerError } from "./client";
import { appOperations } from "./phoneApps";
import { deferred, type Answer } from "./testServer";
import {
  A,
  appServer,
  ACTION,
  answerLaunch,
  B,
  GRANT,
  memberPage,
  memberVersion,
  grantAnswer,
  HANDOFF,
  page,
  signedIn,
  TOKEN,
  version,
} from "./testApps";

const signal = new AbortController().signal;
function setup() {
  const server = appServer();
  return { server, ops: appOperations(signedIn(server).client, "ws-1", signal) };
}

describe("the phone's app operations", () => {
  it("lists every catalog page, the owner's apps then the Member apps", async () => {
    const { server, ops } = setup();
    const C = "c".repeat(64);
    const phoneOnly = version(B, false, "events/signup", true);
    server.on("POST", "/sync/ws-1/ops/apps", page([version(A, true)], A), page([phoneOnly]));
    server.on("POST", "/sync/ws-1/ops/memberApps", memberPage([memberVersion(C, "changed")]));
    expect(await ops.list()).toEqual([version(A, true), phoneOnly, memberVersion(C, "changed")]);
    expect(server.calls.map((call) => [call.path.split("/").at(-1), call.body])).toEqual(
      expect.arrayContaining([
        ["apps", {}],
        ["apps", { cursor: A }],
        ["memberApps", {}],
      ]),
    );
    expect(server.calls).toHaveLength(3);
    // A Member app with no name, author or allowing state is unreadable, and fails the whole read.
    server.on("POST", "/sync/ws-1/ops/apps", page([]));
    const listed = { ...version(C), member: undefined, name: "tracker", author: { name: "Ana" } };
    for (const broken of [{ consent: "maybe" }, { consent: "none", author: "Ana" }, { name: "" }]) {
      server.on("POST", "/sync/ws-1/ops/memberApps", {
        status: 200,
        body: { ok: true, result: { memberApps: [{ ...listed, ...broken }], nextCursor: null } },
      });
      await expect(ops.list()).rejects.toMatchObject({ problem: "invalid" });
    }
  });

  it("reads the owner's apps and Member apps together, keeping owner apps first", async () => {
    const { server, ops } = setup();
    const C = "c".repeat(64);
    const own = deferred<Answer>();
    const member = deferred<Answer>();
    server.on("POST", "/sync/ws-1/ops/apps", () => own.promise);
    server.on("POST", "/sync/ws-1/ops/memberApps", () => member.promise);
    const listed = ops.list();
    expect(server.paths().map((path) => path.split("/").at(-1))).toEqual(["apps", "memberApps"]);
    member.resolve(memberPage([memberVersion(C, "current", true)]));
    own.resolve(page([version(A, true)]));
    expect(await listed).toEqual([version(A, true), memberVersion(C, "current", true)]);
  });

  it("fails a read it can't finish or use, never answering part of the catalog", async () => {
    let pages = 0;
    const cases = [
      ["unreadable", [page([{ ...version(A), approved: "yes" } as never])]],
      ["an unknown audience", [page([{ ...version(A), audience: "public" } as never])]],
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
      member: undefined,
      author: null,
      consent: null,
      scopeDigest: null,
      revocable: false,
      authorityRevision: 2,
      createdAtMs: 1_700_000_000_000,
      publishedByAgent: { kind: "agent", label: "Nova", labelSource: "agent-declared" },
      capabilities: [
        {
          kind: "dataset",
          datasetId: "registrations-id",
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
          datasetId: "registrations-id",
          name: "Registrations",
          alias: null,
          access: null,
          operations: [
            { name: "registrations.list", readOnly: true, fields: ["Name"] },
            { name: "registrations.add", readOnly: false, fields: [] },
          ],
        },
      ],
      sources: ["events/signup/index.ts"],
      scopeDigest: null,
      revocable: false,
    });
    // An app over several Collections lists each by its ID, with the name it binds it under.
    const bound = (datasetId: string, alias: string) => ({
      ...review.capabilities[0]!,
      datasetId,
      alias,
    });
    server.on("POST", "/sync/ws-1/ops/appReview", {
      status: 200,
      body: {
        ok: true,
        result: { ...review, capabilities: [bound("a-id", "signups"), bound("b-id", "waitlist")] },
      },
    });
    expect(
      (await ops.review(A)).reach.map(({ datasetId, name, alias }) => [datasetId, name, alias]),
    ).toEqual([
      ["a-id", "Registrations", "signups"],
      ["b-id", "Registrations", "waitlist"],
    ]);
    // An app that requests nothing in the workspace reaches nothing there.
    server.on("POST", "/sync/ws-1/ops/appReview", {
      status: 200,
      body: { ok: true, result: { ...review, capabilities: [] } },
    });
    expect(await ops.review(A)).toMatchObject({ reach: [] });
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

  it("reads a Member app's review: who made it, the allowing, and each Collection at its level", async () => {
    const { server, ops } = setup();
    const digest = "d".repeat(64);
    const review = {
      ...version(A),
      member: undefined,
      appRoot: "app",
      createdAtMs: 1_700_000_000_000,
      publishedByAgent: null,
      name: "tracker",
      author: { name: "Ana (ana@dohc.test)" },
      consent: "changed",
      scopeDigest: digest,
      revocable: true,
      capabilities: [
        {
          kind: "dataset",
          datasetId: "registrations-id",
          name: "Registrations",
          access: "view",
          operations: [{ name: "read", readOnly: true }],
        },
      ],
      sources: [{ path: "app/index.ts", byteLength: 3 }],
      approval: null,
    };
    server.on("POST", "/sync/ws-1/ops/appReview", {
      status: 200,
      body: { ok: true, result: review },
    });
    expect(await ops.review(A)).toMatchObject({
      approved: false,
      member: { name: "tracker", author: "Ana (ana@dohc.test)", consent: "changed" },
      scopeDigest: digest,
      revocable: true,
      reach: [{ name: "Registrations", access: "view" }],
    });
    // A Member app's review without the digest it pins can't be allowed, so it's never shown.
    server.on("POST", "/sync/ws-1/ops/appReview", {
      status: 200,
      body: { ok: true, result: { ...review, scopeDigest: null } },
    });
    await expect(ops.review(A)).rejects.toMatchObject({ problem: "invalid" });
    // Allowing sends the digest reviewed; approving the owner's own app sends none.
    server.on("POST", "/sync/ws-1/ops/appApprove", {
      status: 200,
      body: { ok: true, result: { approvalId: "f".repeat(32) } },
    });
    await ops.approve({ publicationId: A, authorityRevision: 1, scopeDigest: digest });
    await ops.approve({ publicationId: B, authorityRevision: 1, scopeDigest: null });
    expect(
      server.calls.filter((call) => call.path.endsWith("appApprove")).map((call) => call.body),
    ).toEqual([
      { publicationId: A, authorityRevision: 1, scopeDigest: digest },
      { publicationId: B, authorityRevision: 1 },
    ]);
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
