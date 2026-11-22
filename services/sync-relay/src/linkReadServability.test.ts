import { writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createLinkLiveBrowserResolver } from "./linkLiveBrowserAuth";
import { validateLinkCapability } from "./linkSecurity";
import { DiscussionActivityHub } from "./discussionActivity";
import { hashLinkBearer } from "./linkSecurity";
import {
  closeTestStorages,
  json,
  jsonBody,
  LINK_KEY,
  moment,
  request,
  seedLinkGrant,
  sha256,
  testHandler,
  testStorage,
  type HandlerOverrides,
} from "./testing";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeTestStorages();
});

it.skipIf(process.env.DOHC_LINK_READ_PERF !== "1")(
  "measures the per-read capability check",
  async () => {
    const f = await fixture();
    try {
      const input = {
        storage: f.storage,
        capabilityToken: f.capabilityToken,
        linkKey: LINK_KEY,
        nowMs: 2000,
        publicEditRelease: undefined,
      };
      const methods = [
        "findLinkSessionByCapabilityHash",
        "getShare",
        "getShareGrant",
        "workspaceIsOwnedBy",
        "findChannelCreateKind",
      ] as const;
      const spies = methods.map((method) => vi.spyOn(f.storage, method));
      expect(validateLinkCapability(input)).not.toBeNull();
      const calls = Object.fromEntries(
        methods.map((method, i) => [method, spies[i]!.mock.calls.length]),
      );
      vi.restoreAllMocks();
      for (let i = 0; i < 1000; i++) validateLinkCapability(input);
      const samples = [];
      for (let batch = 0; batch < 9; batch++) {
        const start = performance.now();
        for (let i = 0; i < 2000; i++) validateLinkCapability(input);
        samples.push(((performance.now() - start) * 1000) / 2000);
      }
      if (process.env.DOHC_LINK_PERF_OUTPUT)
        writeFileSync(
          process.env.DOHC_LINK_PERF_OUTPUT,
          JSON.stringify(
            { calls, medianUs: [...samples].sort((a, b) => a - b)[4], samplesUs: samples },
            null,
            2,
          ) + "\n",
        );
    } finally {
      f.dispose();
    }
  },
);

it.each(["view", "comment", "edit", "read-only", "read-write"] as const)(
  "rechecks %s sessions on the next read after release removal",
  async (access) => {
    vi.spyOn(Date, "now").mockReturnValue(2000);
    const f = await fixture(access);
    const closed = testHandler(f.storage, { ...f.options, publicEditRelease: undefined });
    const status = access === "edit" || access === "read-write" ? 404 : 200;
    try {
      f.publish();
      const headers = { authorization: `LinkCapability ${f.capabilityToken}` };
      expect((await f.send("/sync/link/current")).status).toBe(200);
      expect
        .soft((await closed(request(null, "/sync/link/current", { headers }))).status)
        .toBe(status);
      expect
        .soft(
          (await closed(request(null, "/sync/link/log?current=true&since=0", { headers }))).status,
        )
        .toBe(status);
      expect
        .soft(
          (await closed(request(null, `/sync/link/blobs/${sha256("live")}`, { headers }))).status,
        )
        .toBe(status);
      const saved = testHandler(f.storage, {
        ...f.options,
        publicEditRelease: undefined,
      });
      try {
        expect
          .soft((await saved(request(null, "/sync/link/current", { headers }))).status)
          .toBe(status);
      } finally {
        saved.dispose();
      }
      if (status === 404) {
        expect.soft((await closed(request(null, "/sync/link/log", { headers }))).status).toBe(404);
        expect
          .soft(
            (
              await closed(
                request(null, "/sync/link-exchange", {
                  ...jsonBody({ secret: f.secret }),
                  headers: {
                    "content-type": "application/json",
                    "x-dohc-relay-exchange-key": "e".repeat(64),
                  },
                }),
              )
            ).status,
          )
          .toBe(404);
      }
      const input = {
        storage: f.storage,
        capabilityToken: f.capabilityToken,
        linkKey: LINK_KEY,
        nowMs: 2000,
        publicEditRelease: undefined,
      };
      expect(
        validateLinkCapability(
          Object.assign({}, input, { publicEditRelease: { version: 1 as const } }),
        ),
      ).not.toBeNull();
      expect.soft(validateLinkCapability(input) === null).toBe(status === 404);
      const liveRequest = new Request("https://relay.test", {
        headers: {
          authorization: `LinkCapability ${f.capabilityToken}`,
          "x-dohc-link-profile-secret": "p".repeat(43),
        },
      });
      expect
        .soft(
          (await createLinkLiveBrowserResolver({
            storage: f.storage,
            linkKey: LINK_KEY,
            publicEditRelease: undefined,
          }).resolve(liveRequest, "abcdefghijkl", "read")) === null,
        )
        .toBe(status === 404);
      expect(
        await createLinkLiveBrowserResolver({
          storage: f.storage,
          linkKey: LINK_KEY,
          publicEditRelease: { version: 1 },
        }).resolve(liveRequest, "abcdefghijkl", "read"),
      ).not.toBeNull();
    } finally {
      closed.dispose();
      f.dispose();
    }
  },
);

it("refuses a holder's live request that also names an agent's address", async () => {
  // The test relay's clock reads 2000, so the link session is current only then.
  vi.spyOn(Date, "now").mockReturnValue(2000);
  const f = await fixture("edit");
  try {
    const resolver = createLinkLiveBrowserResolver({
      storage: f.storage,
      linkKey: LINK_KEY,
      publicEditRelease: { version: 1 },
    });
    const headers = {
      authorization: `LinkCapability ${f.capabilityToken}`,
      "x-dohc-link-profile-secret": "p".repeat(43),
    };
    expect(
      await resolver.resolve(
        new Request("https://relay.test", {
          headers: { ...headers, "x-dohc-agent-resource": "https://share.example.test/mcp/s/x" },
        }),
        "abcdefghijkl",
      ),
    ).toBeNull();
    expect(
      await resolver.resolve(new Request("https://relay.test", { headers }), "abcdefghijkl"),
    ).not.toBeNull();
  } finally {
    f.dispose();
  }
});

it.each([
  ["edit", "/sync/link/discussion"],
  ["read-write", "/sync/link/chat/channels"],
] as const)("refuses release-off %s sessions through %s", async (access, path) => {
  const f = await fixture(access);
  const closed = testHandler(f.storage, { ...f.options, publicEditRelease: undefined });
  try {
    expect((await f.send(path)).status).toBe(200);
    expect(
      (
        await closed(
          request(null, path, {
            headers: { authorization: `LinkCapability ${f.capabilityToken}` },
          }),
        )
      ).status,
    ).toBe(404);
  } finally {
    closed.dispose();
    f.dispose();
  }
});

async function fixture(access: "view" | "comment" | "edit" | "read-only" | "read-write" = "view") {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner@dohc.test", createdAtMs: 1 });
  storage.claimWorkspaceIdentity({
    workspaceId: "w",
    replicationEpoch: "epoch",
    streamIdentity: "stream",
  });
  const group = access === "read-only" || access === "read-write";
  if (group)
    storage.appendLogBatch({
      workspaceId: "w",
      originId: "owner",
      ops: [
        {
          originSeq: 0,
          opKind: "chat.channel.create",
          recordedAtMs: 1,
          payloadJson: JSON.stringify({
            wireId: "channel",
            channelId: "channel",
            kind: "channel",
            name: "Group",
            slug: "group",
            createdAtMs: 1,
          }),
        },
      ],
    });
  storage.createShare({
    share: {
      shareId: "s",
      workspaceId: "w",
      granterUserId: "owner@dohc.test",
      selectorJson: JSON.stringify(
        group
          ? { kind: "group", channelWireId: "channel", paths: ["private/docs"], versionId: null }
          : { paths: ["docs"], versionId: null },
      ),
      createdAtMs: 1,
    },
    grant: {
      grantId: "named",
      shareId: "s",
      principalKind: "user",
      principalUserId: "reader@dohc.test",
      principalEmail: null,
      access: group ? "read-write" : "edit",
      generation: 1,
      status: "active",
      createdAtMs: 1,
      revokedAtMs: null,
      parentGrantId: null,
    },
  });
  const secret = "a".repeat(43);
  seedLinkGrant(storage, {
    shareId: "s",
    grantId: "link",
    secretHash: hashLinkBearer(secret, LINK_KEY),
    access,
    createdAtMs: 1,
  });
  const options = {
    discussionActivity: new DiscussionActivityHub(),
    publicEditRelease: { version: 1 },
    shareWebOrigin: "https://viewer.dohc.test",
    relayExchangeKey: "e".repeat(64),
    namedBrowserSessionLimits: {
      maxSessions: 8,
      retentionMs: 60_000,
      maxPendingRequests: 4,
      maxRequestBytes: 8192,
      maxResponseBytes: 16384,
      timeoutMs: 1000,
    },
  } as HandlerOverrides;
  const h = testHandler(storage, options);
  const exchanged = await json(
    await h(
      request(null, "/sync/link-exchange", {
        ...jsonBody({ secret }),
        headers: {
          "content-type": "application/json",
          "x-dohc-relay-exchange-key": "e".repeat(64),
        },
      }),
    ),
  );
  expect(exchanged.capabilityToken).toBeTypeOf("string");
  const capabilityToken = String(exchanged.capabilityToken);
  let originSeq = 0;
  return {
    storage,
    options,
    secret,
    capabilityToken,
    send: (path: string) =>
      h(request(null, path, { headers: { authorization: `LinkCapability ${capabilityToken}` } })),
    publish(text = "live") {
      const content = new TextEncoder().encode(text);
      storage.putBlob({ workspaceId: "w", sha256: sha256(content), content, createdAtMs: 1 });
      const op = moment(group ? "private/docs/a.md" : "docs/a.md", text, { originSeq });
      storage.appendLogBatch({
        workspaceId: "w",
        originId: "files",
        ops: [
          {
            originSeq: originSeq++,
            opKind: op.opKind,
            recordedAtMs: op.recordedAtMs,
            payloadJson: JSON.stringify(op.payload),
          },
        ],
      });
    },
    dispose: () => h.dispose(),
  };
}
