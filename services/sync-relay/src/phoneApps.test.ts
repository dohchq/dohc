import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { AccountSessions } from "@dohc/workspace-auth/session";
import type { AppBackendAuth } from "./appBackendAuthority";
import type { RelayDatasetHost } from "./datasetHost";
import type { StorageContext } from "./storage/context";
import {
  claimWorkspace,
  closeTestStorages,
  createShare,
  jsonBody,
  request,
  resolveTestAccountSession,
  SHARE_WEB_ORIGIN,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

const EXCHANGE_KEY = "k".repeat(32);
const limits = { maxFiles: 10, maxMetadataBytes: 16_384, maxBundleBytes: 4096 };
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const record = (domain: string, value: unknown) => digest(JSON.stringify([domain, value]));
const source = Buffer.from("document.body.textContent='Trip';");
const OPERATION = "00000000-0000-4000-8000-000000000001";
/** The one transactional Collection the app reads and writes. */
const capability = {
  kind: "dataset" as const,
  datasetId: "00000000-0000-4000-8000-000000000000",
  revision: 1,
  revisionSha256: "e".repeat(64),
  operationIds: [OPERATION],
  name: "Registrations",
  operations: [
    {
      operationId: OPERATION,
      name: "registrations.add",
      access: "owner" as const,
      readOnly: false,
    },
  ],
};
const invokeBody = {
  authorityRevision: 1,
  operation: "registrations.add",
  idempotencyKey: "add-1",
  input: {},
};
/** An operation's answer, typed only as far as these tests read it. */
interface Answer {
  result: {
    grant: string;
    approvalId: string;
    apps: Array<{ approved: boolean }>;
    [key: string]: unknown;
  };
}

function candidate(
  capabilities: AppPublicationCandidate["capabilities"] = [capability],
): AppPublicationCandidate {
  // The bundle's bytes are the entry's, so the relay holds the entry's source and not the other input's.
  const inputs = [
    { path: "docs/app/index.ts", sha256: digest(source), byteLength: source.byteLength },
    { path: "docs/app/lost.ts", sha256: "9".repeat(64), byteLength: 3 },
  ];
  const files = [
    {
      path: "bundle.js",
      sha256: digest(source),
      byteLength: source.byteLength,
      contentType: "text/javascript; charset=utf-8",
    },
  ];
  const compilerIdentity = {
    recipe: "closed-esbuild",
    version: "0.28.1",
    binarySha256: "3".repeat(64),
  };
  const sourceDigest = record("dohc-app-source-v2", {
    entry: "docs/app/index.ts",
    files: inputs,
    packages: [],
  });
  const dependencyLockDigest = record("dohc-app-dependencies-v1", inputs),
    bundleDigest = record("dohc-app-bundle-v1", files);
  return {
    versionId: "main",
    appRoot: "docs/app",
    entryPath: "docs/app/index.ts",
    packageMap: {},
    sourceRevision: "1".repeat(64),
    sourceDigest,
    dependencyLockDigest,
    bundleDigest,
    buildDigest: record("dohc-app-build-v1", {
      sourceDigest,
      dependencyLockDigest,
      compiler: compilerIdentity,
      bundleDigest,
    }),
    compilerIdentity,
    inputs,
    dependencies: inputs.map((file) => file.path),
    files,
    capabilities,
  };
}

async function relay() {
  const storage = await testStorage();
  let now = 2_000;
  const revoked = new Set<string>();
  const ended: string[] = [];
  const hostCalls: AppBackendAuth[] = [];
  let local = false,
    commits = 0,
    worker = Promise.resolve(),
    reached = () => {};
  const sessions: AccountSessions = {
    list: async () => [],
    revoke: async ({ sessionId }) => {
      revoked.add(sessionId);
      return Number.MAX_SAFE_INTEGER;
    },
    phoneSessionIsCurrent: async ({ sessionId }) => !revoked.has(sessionId),
    read: async () => new Map(),
  };
  // The app backend as far as a launch reaches it. Like the real host, it serves an app with a dataset
  // capability whose Collection is installed here, or one that requests nothing. Like the supervisor, it
  // waits for the launch's pre-commit check after the worker returns, runs its in-commit check, and only
  // then commits.
  const datasetHost = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "servedPublication"
          ? (auth: AppBackendAuth, publicationId: string) => {
              hostCalls.push(auth);
              const row = storage.readAppPublication({
                workspaceId: "trip",
                publicationId,
                ownerUserId: "ana",
                limits,
              });
              const dataset = row.candidate.capabilities[0];
              if (dataset && dataset.kind !== "dataset") return null;
              if (dataset && dataset.datasetId !== capability.datasetId)
                throw new Error("You do not have access to this Collection.");
              return {
                authority: { principalKey: "owner", caller: { kind: "owner" } },
                workspaceId: "trip",
                datasetId: dataset?.datasetId ?? null,
                authorityRevision: row.authorityRevision,
                capability: dataset ?? null,
                candidate: row.candidate,
                local,
              };
            }
          : key === "invoke"
            ? async (auth: AppBackendAuth) => {
                reached();
                await worker;
                if (auth.kind === "named") {
                  await auth.launch?.recheck();
                  auth.launch?.authorizeOperation();
                }
                commits++;
                return { result: { added: true }, revision: 1, replayed: false };
              }
            : undefined,
    },
  ) as unknown as RelayDatasetHost;
  const h = testHandler(storage, {
    nowMs: () => now,
    resolvePhoneCapableAccountSession: resolveTestAccountSession,
    accountSessions: sessions,
    appPublicationLimits: limits,
    relayExchangeKey: EXCHANGE_KEY,
    datasetHost,
    endShareWebAppLaunches: (hashes) => ended.push(...hashes),
  });
  await claimWorkspace(h, "ana", "trip");
  await claimWorkspace(h, "bob", "camp");
  const shareId = await createShare(h, "ana", "trip", { paths: ["docs"], recipientUserId: "bob" });
  const grant = (storage as StorageContext).db
    .prepare("SELECT grant_id, generation FROM sync_relay_share_grants WHERE share_id = ?")
    .get(shareId)!;
  const publish = (capabilities?: AppPublicationCandidate["capabilities"]) =>
    storage.publishAppPublication({
      workspaceId: "trip",
      ownerUserId: "ana",
      shareId,
      grantId: String(grant.grant_id),
      generation: Number(grant.generation),
      candidate: candidate(capabilities),
      blobs: [{ sha256: digest(source), bytes: source }],
      limits,
      nowMs: 2_000,
    }).publicationId;
  const publicationId = publish();
  // The phone can't open an app over a document Collection yet, even before its owner approves it.
  const collectionApp = publish([
    {
      kind: "collection-create",
      collectionPath: "responses",
      schemaSha256: "f".repeat(64),
      allowedFields: ["name"],
      requiredFields: ["name"],
      readFields: ["name"],
    },
  ]);
  // Nor one whose Collection isn't installed on this relay.
  const strayApp = publish([{ ...capability, datasetId: "00000000-0000-4000-8000-000000000002" }]);
  const op = async (who: string, operation: string, args: unknown, workspace = "trip") => {
    const response = await h(
      request(null, `/sync/${workspace}/ops/${operation}`, {
        ...jsonBody(args),
        headers: { "content-type": "application/json", authorization: `Bearer ${who}` },
      }),
    );
    return { status: response.status, body: (await response.json()) as Answer };
  };
  // Share-web, as the relay sees it: the viewer origin and the exchange key, and nobody's sign-in.
  const shareWeb = (
    path: string,
    init: {
      body?: unknown;
      launchId?: string;
      stream?: ReadableStream<Uint8Array>;
      app?: string;
    } = {},
  ) => {
    const post = init.body !== undefined || init.stream !== undefined;
    const app = init.app ?? publicationId;
    return h(
      new Request(`http://relay.test/sync/trip/app-publications/${app}/backend/${path}`, {
        method: post ? "POST" : "GET",
        headers: {
          origin: SHARE_WEB_ORIGIN,
          "x-dohc-relay-exchange-key": EXCHANGE_KEY,
          ...(post ? { "content-type": "application/json" } : {}),
          ...(init.launchId ? { "x-dohc-app-launch": init.launchId } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(init.stream === undefined ? {} : { body: init.stream, duplex: "half" }),
      } as RequestInit),
    );
  };
  const approve = (revision = 1, app = publicationId) =>
    op("phone:ana", "appApprove", { publicationId: app, authorityRevision: revision });
  const grantFor = async (revision = 1, app = publicationId) =>
    (await op("phone:ana", "appLaunch", { publicationId: app, authorityRevision: revision })).body
      .result.grant;
  const redeem = async (grantValue: string, app = publicationId) => {
    const response = await shareWeb("redeem", {
      body: { grant: grantValue, launchHost: `${"a".repeat(48)}.apps.test` },
      app,
    });
    return response.ok ? ((await response.json()) as { launchId: string }).launchId : null;
  };
  const launch = async (app = publicationId) => {
    await approve(1, app);
    return (await redeem(await grantFor(1, app), app))!;
  };
  const descriptor = async (launchId: string, app = publicationId) =>
    (await shareWeb("descriptor", { launchId, app })).status;
  return {
    h,
    storage,
    publicationId,
    publish,
    collectionApp,
    strayApp,
    op,
    shareWeb,
    approve,
    grantFor,
    redeem,
    launch,
    descriptor,
    revoked,
    ended,
    hostCalls,
    commits: () => commits,
    tick: (ms: number) => (now += ms),
    setLocal: (value: boolean) => (local = value),
    /** Holds the backend's next invoke until `release`, and resolves `reached` once it is held. */
    holdWorker() {
      let release = () => {};
      worker = new Promise<void>((resolve) => (release = resolve));
      const held = new Promise<void>((resolve) => (reached = resolve));
      return { reached: held, release: () => release() };
    },
  };
}

it("lists, reviews and shows the source of the owner's published apps, and nothing else", async () => {
  const r = await relay();
  const apps = await r.op("phone:ana", "apps", {});
  expect(apps.body.result).toEqual({
    apps: [
      {
        publicationId: r.publicationId,
        authorityRevision: 1,
        appRoot: "docs/app",
        sourceRevision: "1".repeat(64),
        approved: false,
      },
    ],
    nextCursor: null,
  });
  const review = await r.op("user:ana", "appReview", { publicationId: r.publicationId });
  expect(review.body.result).toMatchObject({
    authorityRevision: 1,
    capabilities: [capability],
    approval: null,
    sources: [
      { path: "docs/app/index.ts", byteLength: source.byteLength },
      { path: "docs/app/lost.ts", byteLength: 3 },
    ],
  });
  const read = (path: string) =>
    r.op("phone:ana", "appSource", { publicationId: r.publicationId, path });
  expect((await read("docs/app/index.ts")).body.result).toEqual({
    path: "docs/app/index.ts",
    available: true,
    text: source.toString(),
  });
  // The relay holds no bytes that match this input's hash, so its source is unavailable, never current text.
  expect((await read("docs/app/lost.ts")).body.result).toEqual({
    path: "docs/app/lost.ts",
    available: false,
  });
  // Publishing refuses a hidden path, so asking for one answers as an absent file does.
  const absent = await read("docs/app/absent.ts");
  expect(absent.status).toBe(404);
  expect(await read("docs/app/.env")).toEqual(absent);
  // An id with no publication row, as an app approved only on a computer has, is absent.
  const unpublished = { publicationId: "b".repeat(64) };
  const notFound = await r.op("phone:ana", "appReview", unpublished);
  expect(notFound.status).toBe(404);
  // An app over a document Collection, and one whose Collection isn't installed on this relay, are
  // left out of the catalog above and refused like a missing one.
  for (const publicationId of [r.collectionApp, r.strayApp])
    for (const [operation, args] of [
      ["appReview", { publicationId }],
      ["appSource", { publicationId, path: "docs/app/index.ts" }],
      ["appApprove", { publicationId, authorityRevision: 1 }],
      ["appLaunch", { publicationId, authorityRevision: 1 }],
    ] as const)
      expect(await r.op("phone:ana", operation, args), operation).toEqual(notFound);
  // Another account's workspace answers as a missing one.
  const missing = await r.op("phone:bob", "apps", {}, "nowhere");
  expect(await r.op("phone:bob", "apps", {})).toEqual(missing);
  expect(await r.op("phone:bob", "appReview", { publicationId: r.publicationId })).toEqual(missing);
  // So does a workspace hidden from the phone.
  await r.h(
    request(null, "/sync/account/workspaces/trip", {
      method: "PATCH",
      headers: { authorization: "Bearer phone:ana", "content-type": "application/json" },
      body: JSON.stringify({ showOnPhone: false }),
    }),
  );
  for (const [operation, args] of [
    ["apps", {}],
    ["appReview", { publicationId: r.publicationId }],
    ["appSource", { publicationId: r.publicationId, path: "docs/app/index.ts" }],
  ] as const)
    expect((await r.op("phone:ana", operation, args)).status, operation).toBe(404);
});

it("lists and launches an app that requests nothing in the workspace, and serves it only its files", async () => {
  const r = await relay();
  const app = r.publish([]);
  const listed = (await r.op("phone:ana", "apps", {})).body.result.apps;
  expect(listed).toHaveLength(2);
  expect(listed).toContainEqual({
    publicationId: app,
    authorityRevision: 1,
    appRoot: "docs/app",
    sourceRevision: "1".repeat(64),
    approved: false,
  });
  expect((await r.op("phone:ana", "appReview", { publicationId: app })).body.result).toMatchObject({
    authorityRevision: 1,
    capabilities: [],
    approval: null,
  });
  const launchId = await r.launch(app);
  const described = await r.shareWeb("descriptor", { launchId, app });
  expect(described.status).toBe(200);
  expect(await described.json()).toEqual({
    publicationId: app,
    authorityRevision: 1,
    files: [expect.objectContaining({ path: "bundle.js", sha256: digest(source) })],
  });
  const blob = (revision: number) =>
    r.shareWeb(`blobs/${digest(source)}?authorityRevision=${revision}`, { launchId, app });
  const bytes = await blob(1);
  expect(bytes.status).toBe(200);
  expect(Buffer.from(await bytes.arrayBuffer())).toEqual(source);
  expect((await blob(2)).status).toBe(404);
  // It has no dataset, so no backend operation reaches anything.
  for (const action of ["invoke", "upload", "file", "attempt"])
    expect((await r.shareWeb(action, { launchId, app, body: invokeBody })).status, action).toBe(
      404,
    );
  expect(r.commits()).toBe(0);
  // Another account can't see it.
  expect((await r.op("phone:bob", "appReview", { publicationId: app })).status).toBe(404);
  // Nor can the phone while the workspace is hidden from it.
  r.storage.setShowOnPhone({ ownerUserId: "ana", workspaceId: "trip", showOnPhone: false });
  expect(await r.descriptor(launchId, app)).toBe(404);
  r.storage.setShowOnPhone({ ownerUserId: "ana", workspaceId: "trip", showOnPhone: true });
  expect(await r.descriptor(launchId, app)).toBe(200);
  // Nor once the operator takes it down.
  r.storage.disableAppPublication({
    publicationId: app,
    reason: "Confirmed malware",
    nowMs: 3_000,
  });
  expect(await r.descriptor(launchId, app)).toBe(404);
  expect((await r.op("phone:ana", "appReview", { publicationId: app })).status).toBe(404);
  expect((await r.op("phone:ana", "apps", {})).body.result.apps).toHaveLength(1);
});

it("takes approval only from a phone, for one revision, and needs it again after a change", async () => {
  const r = await relay();
  expect((await r.approve()).status).toBe(200);
  expect(
    (await r.op("user:ana", "appApprove", { publicationId: r.publicationId, authorityRevision: 1 }))
      .status,
  ).toBe(404);
  const first = (await r.approve()).body.result;
  // A retry returns the same approval.
  expect((await r.approve()).body.result).toEqual(first);
  expect((await r.op("phone:ana", "apps", {})).body.result.apps[0]?.approved).toBe(true);
  const owner = (action: string, revision: number) =>
    r.h(
      request(
        "ana",
        `/sync/trip/app-publications/${r.publicationId}/${action}`,
        jsonBody({ expectedAuthorityRevision: revision }),
      ),
    );
  expect((await owner("withdraw", 1)).status).toBe(200);
  expect((await r.op("phone:ana", "apps", {})).body.result.apps).toEqual([]);
  expect(
    (await r.op("phone:ana", "appLaunch", { publicationId: r.publicationId, authorityRevision: 2 }))
      .status,
  ).toBe(404);
  expect((await owner("reactivate", 2)).status).toBe(200);
  // Reactivating moved the revision, so the old approval no longer covers the app.
  expect((await r.op("phone:ana", "apps", {})).body.result.apps[0]).toMatchObject({
    authorityRevision: 3,
    approved: false,
  });
  expect((await r.approve(1)).status).toBe(409);
  expect(
    (await r.op("phone:ana", "appLaunch", { publicationId: r.publicationId, authorityRevision: 3 }))
      .status,
  ).toBe(409);
  const again = (await r.approve(3)).body.result;
  expect(again.approvalId).not.toBe(first.approvalId);
  expect(
    (await r.op("phone:ana", "appRevoke", { publicationId: r.publicationId })).body.result,
  ).toEqual({ revoked: true });
  expect((await r.op("phone:ana", "apps", {})).body.result.apps[0]?.approved).toBe(false);
});

it("redeems a grant once, within 30 seconds, for its own publication and a current phone sign-in", async () => {
  const r = await relay();
  await r.approve();
  // A computer's or a browser's sign-in can't ask for a phone's grant.
  expect(
    (await r.op("user:ana", "appLaunch", { publicationId: r.publicationId, authorityRevision: 1 }))
      .status,
  ).toBe(404);
  const grant = await r.grantFor();
  // Without the exchange key, or with a person's sign-in, share-web's route answers as a missing one.
  const body = JSON.stringify({ grant, launchHost: `${"a".repeat(48)}.apps.test` });
  const refused: Record<string, string>[] = [
    { origin: SHARE_WEB_ORIGIN, "content-type": "application/json" },
    {
      origin: SHARE_WEB_ORIGIN,
      "x-dohc-relay-exchange-key": EXCHANGE_KEY,
      "content-type": "application/json",
      authorization: "Bearer phone:ana",
    },
  ];
  for (const headers of refused)
    expect(
      (
        await r.h(
          new Request(
            `http://relay.test/sync/trip/app-publications/${r.publicationId}/backend/redeem`,
            { method: "POST", headers, body },
          ),
        )
      ).status,
    ).toBe(404);
  expect(await r.redeem(grant)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await r.redeem(grant)).toBeNull();
  // Expired.
  const late = await r.grantFor();
  r.tick(30_000);
  expect(await r.redeem(late)).toBeNull();
  // Presented for another publication: consumed and refused, so it can't be used for its own either.
  const other = await r.grantFor();
  const elsewhere = await r.h(
    new Request(`http://relay.test/sync/trip/app-publications/${"c".repeat(64)}/backend/redeem`, {
      method: "POST",
      headers: {
        origin: SHARE_WEB_ORIGIN,
        "x-dohc-relay-exchange-key": EXCHANGE_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ grant: other, launchHost: `${"b".repeat(48)}.apps.test` }),
    }),
  );
  expect(elsewhere.status).toBe(404);
  expect(await r.redeem(other)).toBeNull();
  // A revoked sign-in.
  const revoked = await r.grantFor();
  r.revoked.add("phone-session-ana");
  expect(await r.redeem(revoked)).toBeNull();
});

it("accepts a launch ID only on its publication's app paths while everything it is bound to holds", async () => {
  const r = await relay();
  const launchId = await r.launch();
  expect(await r.descriptor(launchId)).toBe(200);
  // The backend acts for the account, with no agent, and carries the launch's guard. The eligibility
  // checks call the host too, without a guard, so this picks the descriptor's own call.
  const auth = r.hostCalls.filter((call) => call.kind === "named" && call.launch).at(-1);
  expect(auth).toMatchObject({ kind: "named", workspaceId: "trip", userId: "ana" });
  expect(auth && Object.keys(auth).sort()).toEqual(["kind", "launch", "userId", "workspaceId"]);
  for (const path of ["activate", "summary"])
    expect(
      (await r.shareWeb(path, { launchId, ...(path === "activate" ? { body: {} } : {}) })).status,
      path,
    ).toBe(404);
  const elsewhere = await r.h(
    new Request(
      `http://relay.test/sync/trip/app-publications/${"c".repeat(64)}/backend/descriptor`,
      {
        headers: {
          origin: SHARE_WEB_ORIGIN,
          "x-dohc-relay-exchange-key": EXCHANGE_KEY,
          "x-dohc-app-launch": launchId,
        },
      },
    ),
  );
  expect(elsewhere.status).toBe(404);
  // An app the owner approved only on a computer never runs from a phone launch.
  r.setLocal(true);
  expect(await r.descriptor(launchId)).toBe(404);
  r.setLocal(false);
  // It expires 10.5 minutes after redemption, however often it is used.
  r.tick(600_000);
  expect(await r.descriptor(launchId)).toBe(200);
  r.tick(30_000);
  expect(await r.descriptor(launchId)).toBe(404);
});

it("ends a launch, on the relay and in share-web, at each way its reach ends", async () => {
  const r = await relay();
  const ends: Array<[string, () => Promise<unknown>]> = [
    ["approval revoked", () => r.op("phone:ana", "appRevoke", { publicationId: r.publicationId })],
    [
      "session revoked",
      () =>
        r.h(
          request(null, "/sync/account/sessions/phone-session-ana/revoke", {
            method: "POST",
            headers: { authorization: "Bearer user:ana" },
          }),
        ),
    ],
    [
      "Show on phone turned off",
      () =>
        r.h(
          request(null, "/sync/account/workspaces/trip", {
            method: "PATCH",
            headers: { authorization: "Bearer user:ana", "content-type": "application/json" },
            body: JSON.stringify({ showOnPhone: false }),
          }),
        ),
    ],
  ];
  for (const [label, action] of ends) {
    r.revoked.clear();
    r.storage.setShowOnPhone({ ownerUserId: "ana", workspaceId: "trip", showOnPhone: true });
    const launchId = await r.launch();
    expect(await r.descriptor(launchId), label).toBe(200);
    r.ended.length = 0;
    await action();
    // Share-web hears exactly the launch the relay ended, so a late purge can't end a newer one.
    expect(r.ended, label).toEqual([digest(launchId)]);
    expect(await r.descriptor(launchId), label).toBe(404);
  }
  // Nothing open, nothing sent.
  r.storage.setShowOnPhone({ ownerUserId: "ana", workspaceId: "trip", showOnPhone: true });
  r.ended.length = 0;
  expect(
    (await r.op("phone:ana", "appRevoke", { publicationId: r.publicationId })).body.result,
  ).toEqual({ revoked: true });
  expect(r.ended).toEqual([]);
  // Withdrawing moves the revision, so the launch's approval no longer covers the app.
  r.storage.setShowOnPhone({ ownerUserId: "ana", workspaceId: "trip", showOnPhone: true });
  const launchId = await r.launch();
  r.ended.length = 0;
  await r.h(
    request(
      "ana",
      `/sync/trip/app-publications/${r.publicationId}/withdraw`,
      jsonBody({ expectedAuthorityRevision: 1 }),
    ),
  );
  expect(r.ended).toEqual([digest(launchId)]);
  expect(await r.descriptor(launchId)).toBe(404);
  // Revoking and approving the same version again doesn't revive an old launch.
  await r.h(
    request(
      "ana",
      `/sync/trip/app-publications/${r.publicationId}/reactivate`,
      jsonBody({ expectedAuthorityRevision: 2 }),
    ),
  );
  await r.approve(3);
  const before = (await r.redeem(await r.grantFor(3)))!;
  await r.op("phone:ana", "appRevoke", { publicationId: r.publicationId });
  await r.approve(3);
  expect(await r.descriptor(before)).toBe(404);
});

it("keeps a launch's reach through its backend work, so revoking while it waits commits nothing", async () => {
  const r = await relay();
  // An invoke runs and commits while everything holds.
  const launchId = await r.launch();
  expect((await r.shareWeb("invoke", { launchId, body: invokeBody })).status).toBe(200);
  expect(r.commits()).toBe(1);
  // The approval is revoked while the invoke's body is still arriving.
  let send = (_chunk: Uint8Array) => {},
    reading = () => {};
  const read = new Promise<void>((resolve) => (reading = resolve));
  const stream = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        send = (chunk) => {
          controller.enqueue(chunk);
          controller.close();
        };
      },
      pull: () => reading(),
    },
    { highWaterMark: 0 },
  );
  const waiting = r.shareWeb("invoke", { launchId, stream });
  await read;
  await r.op("phone:ana", "appRevoke", { publicationId: r.publicationId });
  send(new TextEncoder().encode(JSON.stringify(invokeBody)));
  expect((await waiting).status).toBe(404);
  expect(r.commits()).toBe(1);
  // The workspace is hidden from the phone while the invoke waits in the worker.
  const held = await r.launch();
  const worker = r.holdWorker();
  const running = r.shareWeb("invoke", { launchId: held, body: invokeBody });
  await worker.reached;
  r.storage.setShowOnPhone({ ownerUserId: "ana", workspaceId: "trip", showOnPhone: false });
  worker.release();
  expect((await running).status).toBe(404);
  expect(r.commits()).toBe(1);
});

it("commits nothing once the phone's sign-in ends while the worker runs", async () => {
  const r = await relay();
  const launchId = await r.launch();
  const worker = r.holdWorker();
  const running = r.shareWeb("invoke", { launchId, body: invokeBody });
  await worker.reached;
  // Signed out somewhere the relay doesn't hear about: only the session table knows.
  r.revoked.add("phone-session-ana");
  worker.release();
  expect((await running).status).toBe(404);
  // The pre-commit check read the session table after the worker returned.
  expect(r.commits()).toBe(0);
});
