import { request as httpRequest } from "node:http";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LINK_EXCHANGE_BUCKET_CAPACITY } from "./linkSecurity";
import { RELAY_API_VERSIONS } from "./apiVersion";
import { RELAY_API_VERSION_HEADER } from "@dohc/workspace-contracts/relay-values";
import { relayProcessFixture, loopbackListenDenied, WORKSPACE_ID, USER_ID, TEST_SHUTDOWN_GRACE_PERIOD_MS, SHUTDOWN_EXIT_WAIT_MS } from "./mainProcessTestSupport";

const { tempRoot, spawnRelay, spawnRunningRelay, authHeaders, postJson, exchangeLink, postJsonAs, putBytes, sha256, settleWithin, waitForExit, sendTerminationSignal, sendDoubleTerminationSignal } = relayProcessFixture();

describe.skipIf(loopbackListenDenied)("sync relay main process", () => {
  it("starts the development source entry and reports readiness", async () => {
    const root = await tempRoot("source-entry");
    const relay = await spawnRunningRelay(join(root, "relay.sqlite"), {}, { sourceEntry: true });
    const response = await fetch(`${relay.baseUrl}/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "sync-relay", selfHostedLive: false, apiVersions: RELAY_API_VERSIONS, automations: "off" });
  });

  it.each([undefined, "0", "2"])("wires app publication and collection approval opt-ins with quota %s", async (quota) => {
    const root = await tempRoot("app-publication-config");
    const disabled = await spawnRelay(join(root, "disabled.sqlite"));
    expect((await postJson(disabled, "/sync/workspaces", {workspaceId: WORKSPACE_ID})).status).toBe(200);
    expect((await fetch(`${disabled}/sync/${WORKSPACE_ID}/app-publications`, {headers: authHeaders()})).status).toBe(404);

    const enabled = await spawnRelay(join(root, "enabled.sqlite"), {DOHC_RELAY_APP_PUBLICATIONS: "1", DOHC_RELAY_APP_COLLECTION_MAX_CREATES_PER_GRANT: quota});
    expect((await postJson(enabled, "/sync/workspaces", {workspaceId: WORKSPACE_ID})).status).toBe(200);
    const path = `/sync/${WORKSPACE_ID}/app-publications`;
    expect((await fetch(`${enabled}${path}`, {headers: authHeaders()})).status).toBe(200);
    expect((await fetch(`${enabled}${path}`)).status).toBe(404);
    expect((await fetch(`${enabled}${path}`, {headers: {authorization: "Bearer test:other-owner"}})).status).toBe(404);
    const shareResponse = await postJson(enabled, `/sync/${WORKSPACE_ID}/shares`, {recipientUserId: "recipient", paths: ["app"], access: "view"});
    expect(shareResponse.status).toBe(200);
    const share = await shareResponse.json() as {shareId: string; grantId: string; generation: number};
    const script = Buffer.from("document.body.textContent='Trip poll';");
    const scriptHash = sha256(script);
    expect((await putBytes(enabled, `/sync/${WORKSPACE_ID}/blobs/${scriptHash}`, script)).status).toBe(200);
    const digest = (domain: string, value: unknown) => sha256(Buffer.from(JSON.stringify([domain, value])));
    const inputs = [{path: "app/main.js", sha256: "4".repeat(64), byteLength: 20}];
    const files = [{path: "bundle.js", sha256: scriptHash, byteLength: script.byteLength, contentType: "text/javascript; charset=utf-8"}];
    const compiler = {recipe: "closed-esbuild", version: "0.28.1", binarySha256: "3".repeat(64)};
    const sourceDigest = digest("dohc-app-source-v2", {entry: "app/main.js", files: inputs, packages: []});
    const dependencyLockDigest = digest("dohc-app-dependencies-v1", inputs);
    const bundleDigest = digest("dohc-app-bundle-v1", files);
    const candidate = {versionId: "main", appRoot: "app", entryPath: "app/main.js", packageMap: {}, sourceRevision: "1".repeat(64),
      sourceDigest, dependencyLockDigest, bundleDigest,
      buildDigest: digest("dohc-app-build-v1", {sourceDigest, dependencyLockDigest, compiler, bundleDigest}),
      compilerIdentity: compiler, inputs, dependencies: ["app/main.js"], files, capabilities: []};
    const publishedResponse = await postJson(enabled, path, {shareId: share.shareId, grantId: share.grantId,
      expectedGrantGeneration: share.generation, candidate});
    expect(publishedResponse.status, await publishedResponse.clone().text()).toBe(200);
    const published = await publishedResponse.json() as {publicationId: string; authorityRevision: number};
    const approvalPath = `${path}/${published.publicationId}/collection-approval`;
    expect((await postJson(enabled, approvalPath, {
      expectedAuthorityRevision: published.authorityRevision, capability: {},
    })).status).toBe(quota === "2" ? 400 : 404);
    const approval = await postJson(enabled, approvalPath, {
      expectedAuthorityRevision: published.authorityRevision, capability: null,
    });
    expect(approval.status).toBe(200);
    const approved = await approval.json() as {authorityRevision: number; capability: null};
    expect(approved.capability).toBeNull();
    expect(approved.authorityRevision).toBe(published.authorityRevision + 1);
    published.authorityRevision = approved.authorityRevision;
    const read = await fetch(`${enabled}${path}/${published.publicationId}`, {headers: authHeaders()});
    expect(read.status).toBe(200);
    expect((await read.json() as {active: boolean}).active).toBe(true);
    expect((await postJson(enabled, `${path}/${published.publicationId}/withdraw`, {expectedAuthorityRevision: published.authorityRevision})).status).toBe(200);
    const withdrawn = await fetch(`${enabled}${path}/${published.publicationId}`, {headers: authHeaders()});
    expect((await withdrawn.json() as {active: boolean}).active).toBe(false);
    // Deployment opt-in alone grants neither collection authority nor public Edit.
    const collectionRefusal = await postJson(enabled, `/sync/link/app-publications/${published.publicationId}/collection`, {fields: {destination: "Tokyo"}});
    expect(collectionRefusal.status).toBe(404);
    expect(await collectionRefusal.json()).toEqual({ok: false, error: "not found"});
    expect((await postJson(enabled, "/sync/live/link-tickets", {})).status).toBe(404);
  });

  it("keeps the missing key envelope code through HTTP normalization for link-prefixed workspaces", async () => {
    const relay = await spawnRelay(join(await tempRoot("link-prefixed-workspaces"), "relay.sqlite"));
    for (const workspaceId of ["link-lane-owner", "linkx", "link-exchange-owner", "link-refresh", "link-handoff", "link-redeem"]) {
      expect((await postJson(relay, "/sync/workspaces", {workspaceId})).status).toBe(200);
      const missing = await fetch(`${relay}/sync/${workspaceId}/keys`, {headers: authHeaders()});
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({code: "key_envelope_not_found"});
    }
  });

  it("refuses a relay API version it does not serve before it reads the credential", async () => {
    const relay = await spawnRelay(join(await tempRoot("api-version"), "relay.sqlite"));
    const ready = await (await fetch(`${relay}/ready`)).json() as {apiVersions: unknown};
    expect(ready.apiVersions).toEqual(RELAY_API_VERSIONS);
    const newer = String(RELAY_API_VERSIONS.max + 1);
    for (const headers of [new Headers({[RELAY_API_VERSION_HEADER]: newer}), authHeaders({[RELAY_API_VERSION_HEADER]: newer})]) {
      const refused = await fetch(`${relay}/sync/${WORKSPACE_ID}/log`, {headers});
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ok: false, code: "api_version_too_new", error: "this relay is older than the dohc that sent the request"});
    }
    const current = authHeaders({[RELAY_API_VERSION_HEADER]: String(RELAY_API_VERSIONS.max), "content-type": "application/json"});
    expect((await fetch(`${relay}/sync/workspaces`, {method: "POST", headers: current,
      body: JSON.stringify({workspaceId: WORKSPACE_ID})})).status).toBe(200);
  });

  it("ignores inherited device-delivery config in an isolated relay child", async () => {
    vi.stubEnv("DOHC_RELAY_DEVICE_DELIVERY_CONFIG", "inherited-device-delivery-must-not-open.json");
    try {
      const root = await tempRoot("inherited-device-delivery");
      const relay = await spawnRunningRelay(join(root, "relay.sqlite"));
      expect(relay.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    } finally { vi.unstubAllEnvs(); }
  });

  it("shuts down promptly when no responses are active", async () => {
    const relayRoot = await tempRoot("relay-quiet-shutdown");
    const relay = await spawnRunningRelay(join(relayRoot, "relay.sqlite"), {
      SYNC_RELAY_TEST_SHUTDOWN_GRACE_PERIOD_MS: String(
        TEST_SHUTDOWN_GRACE_PERIOD_MS,
      ),
    });
    const exited = waitForExit(relay.child);

    sendTerminationSignal(relay.child);

    expect(
      await settleWithin(exited, SHUTDOWN_EXIT_WAIT_MS),
      `quiet sync relay did not exit promptly\n${relay.stderr()}`,
    ).toEqual({
      kind: "settled",
      value: { code: 0, signal: null },
    });
  });

  it("ignores a second SIGTERM while shutdown is in progress", async () => {
    const relayRoot = await tempRoot("relay-double-sigterm");
    const relay = await spawnRunningRelay(join(relayRoot, "relay.sqlite"), {
      SYNC_RELAY_TEST_AUTH: "0",
      SYNC_RELAY_BIND: "127.0.0.1",
      BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
      POSTGRES_URL: "postgres://dohc:dohc@127.0.0.1:1/dohc",
      SYNC_RELAY_TEST_SHUTDOWN_GRACE_PERIOD_MS: String(TEST_SHUTDOWN_GRACE_PERIOD_MS),
    }, {emptyDeletionJobs: true});
    const exited = waitForExit(relay.child);

    sendDoubleTerminationSignal(relay.child);

    expect(
      await settleWithin(exited, SHUTDOWN_EXIT_WAIT_MS),
      `sync relay did not exit cleanly after duplicate SIGTERM\n${relay.stderr()}`,
    ).toEqual({
      kind: "settled",
      value: { code: 0, signal: null },
    });
  });

  it("exits with code 0 on SIGTERM when the Postgres pool rejects shutdown", async () => {
    const relayRoot = await tempRoot("relay-pool-shutdown-rejection");
    const relay = await spawnRunningRelay(
      join(relayRoot, "relay.sqlite"),
      {
        SYNC_RELAY_TEST_AUTH: "0",
        SYNC_RELAY_BIND: "127.0.0.1",
        BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
        POSTGRES_URL: "postgres://dohc:dohc@127.0.0.1:1/dohc",
        SYNC_RELAY_TEST_SHUTDOWN_GRACE_PERIOD_MS: String(TEST_SHUTDOWN_GRACE_PERIOD_MS),
      },
      { rejectPoolEnd: true, emptyDeletionJobs: true },
    );
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => relay.child.once("close", (code, signal) => resolve({ code, signal })),
    );

    sendTerminationSignal(relay.child);

    expect(
      await settleWithin(closed, SHUTDOWN_EXIT_WAIT_MS),
      `sync relay did not exit cleanly after pool shutdown rejection\n${relay.stderr()}`,
    ).toEqual({
      kind: "settled",
      value: { code: 0, signal: null },
    });
    expect(relay.stderr()).toContain("SYNC_RELAY_TEST_POOL_END_REJECTED\n");
  });

  // WS-MU-C0 over real HTTP: a second authenticated user cannot forge the first
  // user's chat authorship. The relay derives the pusher's identity from the
  // bearer session and rejects any chat op claiming a different author, atomically
  // — the log stays empty. The honest self-authored push is admitted.
  it("rejects forged chat authorship over real HTTP and admits the honest author", async () => {
    const relayRoot = await tempRoot("relay-authorship");
    const baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));

    const alice = "user-alice";
    const mallory = "user-mallory";
    const ws = "workspace-authorship";

    // Alice owns the bucket (claimed under her own authenticated identity).
    const claimed = await postJsonAs(baseUrl, alice, "/sync/workspaces", { workspaceId: ws });
    expect(claimed.status).toBe(200);

    const messageOp = (originSeq: number, authorUserId: string | undefined) => ({
      originSeq,
      opKind: "chat.message.append",
      payload: {
        messageId: `m-${originSeq}`,
        threadId: "t-1",
        authorKind: "human",
        authorDisplayName: "display only",
        ...(authorUserId !== undefined ? { authorUserId } : {}),
        body: "hi over http",
        createdAtMs: 5_000 + originSeq,
      },
      recordedAtMs: 5_000 + originSeq,
    });
    const reactionOp = (originSeq: number, authorId: string) => ({
      originSeq,
      opKind: "chat.reaction.set",
      payload: {
        reactionId: `r-${originSeq}`,
        messageId: "m-0",
        threadId: "t-1",
        emoji: "👍",
        authorId,
        authorKind: "human",
        authorDisplayName: "display only",
        state: "added",
        atMs: 5_000 + originSeq,
      },
      recordedAtMs: 5_000 + originSeq,
    });

    const logOps = async (): Promise<Array<{ payload: Record<string, unknown> }>> => {
      const response = await fetch(`${baseUrl}/sync/${ws}/log?since=0`, {
        headers: { authorization: `Bearer test:${alice}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ops: Array<{ payload: Record<string, unknown> }>;
      };
      return body.ops;
    };
    const logLength = async (): Promise<number> => (await logOps()).length;

    // Alice forging Mallory's authorship on a message → 403, log unchanged.
    const forgedMessage = await postJsonAs(baseUrl, alice, `/sync/${ws}/log`, {
      originId: "origin-alice",
      ops: [messageOp(0, mallory)],
    });
    expect(forgedMessage.status).toBe(403);
    expect((await forgedMessage.json()) as Record<string, unknown>).toMatchObject({
      code: "authorship_mismatch",
    });
    expect(await logLength()).toBe(0);

    // Alice forging Mallory's authorship on a reaction → 403, log unchanged.
    const forgedReaction = await postJsonAs(baseUrl, alice, `/sync/${ws}/log`, {
      originId: "origin-alice",
      ops: [reactionOp(0, mallory)],
    });
    expect(forgedReaction.status).toBe(403);
    expect(await logLength()).toBe(0);

    // A batch mixing Alice's honest op with a forged one is rejected atomically.
    const mixed = await postJsonAs(baseUrl, alice, `/sync/${ws}/log`, {
      originId: "origin-alice",
      ops: [messageOp(0, alice), reactionOp(1, mallory)],
    });
    expect(mixed.status).toBe(403);
    expect(await logLength()).toBe(0);

    // A message created before sign-in has no verified relay author. The
    // workspace route rejects it and leaves the log unchanged.
    const localMessage = await postJsonAs(baseUrl, alice, `/sync/${ws}/log`, {
      originId: "origin-before-sign-in",
      ops: [messageOp(0, undefined)],
    });
    expect(localMessage.status).toBe(403);
    expect((await localMessage.json()) as Record<string, unknown>).toMatchObject({
      code: "authorship_mismatch",
    });
    expect(await logLength()).toBe(0);

    // Alice authoring as HERSELF is admitted.
    const honest = await postJsonAs(baseUrl, alice, `/sync/${ws}/log`, {
      originId: "origin-alice",
      ops: [messageOp(0, alice), reactionOp(1, alice)],
    });
    expect(honest.status).toBe(200);
    expect(await logLength()).toBe(2);
  });

  // Gate finding: the transport must cap request bodies AT the STREAM. A
  // client streaming an oversized body is cut off mid-upload (413 and/or a
  // destroyed socket) instead of being fully buffered, and the server stays
  // healthy afterwards.
  it("rejects an oversized streamed body before buffering it and stays healthy", async () => {
    const relayRoot = await tempRoot("relay-stream-cap");
    const baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    const claim = await postJson(baseUrl, "/sync/workspaces", { workspaceId: WORKSPACE_ID });
    expect(claim.status).toBe(200);

    const chunk = Buffer.alloc(1024 * 1024, 7);
    const totalChunks = 48; // 48MB streamed; the cap is ~11MB.
    const outcome = await new Promise<{ status: number | null; sentAll: boolean }>((resolve) => {
      let sent = 0;
      let settled = false;
      const settle = (status: number | null) => {
        if (settled) return;
        settled = true;
        resolve({ status, sentAll: sent >= totalChunks });
      };
      const clientRequest = httpRequest(
        `${baseUrl}/sync/${encodeURIComponent(WORKSPACE_ID)}/blobs/${"0".repeat(64)}`,
        { method: "PUT", headers: { authorization: `Bearer test:${USER_ID}` } },
        (response) => {
          response.resume();
          settle(response.statusCode ?? null);
        },
      );
      clientRequest.on("error", () => settle(null));
      const writeMore = (): void => {
        while (sent < totalChunks) {
          sent += 1;
          const canContinue = clientRequest.write(chunk);
          if (!canContinue) {
            clientRequest.once("drain", writeMore);
            return;
          }
        }
        clientRequest.end();
      };
      writeMore();
    });

    // The stream was cut off before the client could deliver the full body
    // (pre-fix, the server buffered all 48MB and only then rejected).
    expect(outcome.sentAll).toBe(false);
    if (outcome.status !== null) expect(outcome.status).toBe(413);

    // The server survived: still answering, and a normal-sized blob works.
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    // High bytes on purpose. main.ts hand-rolls the node:http<->fetch adapter
    // because the standard one mishandles raw-byte blob traffic, and the only
    // thing that can catch a regression there is reading a blob back over real
    // HTTP and comparing bytes. `Buffer.from("...")` cannot: every byte of an
    // ASCII string survives a text round trip, so a utf8-decoding adapter would
    // look correct.
    const smallBytes = Uint8Array.from([0, 1, 2, 253, 254, 255, 128, 200]);
    const digest = sha256(smallBytes);
    const put = await putBytes(baseUrl, `/sync/${WORKSPACE_ID}/blobs/${digest}`, smallBytes);
    expect(put.status).toBe(200);

    // Byte-for-byte on the way out, which nothing else in this package checks:
    // every other blob GET goes through createSyncRelayHandler in-process and so
    // never touches main.ts's adapter at all.
    const fetched = await fetch(`${baseUrl}/sync/${WORKSPACE_ID}/blobs/${digest}`, {
      headers: authHeaders(),
    });
    expect(fetched.status).toBe(200);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(smallBytes);

    // And the same layer must still refuse an unauthenticated read: main.ts
    // decides which paths bypass the relay handler, so an in-process suite
    // cannot see a wiring regression here.
    const anonymous = await fetch(`${baseUrl}/sync/${WORKSPACE_ID}/log?since=0`);
    expect(anonymous.status).toBe(401);
  });

  it("caps link exchanges at 4096 bytes before buffering the route body", async () => {
    const relayRoot = await tempRoot("link-exchange-cap");
    const baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"), {
      DOHC_RELAY_LINK_KEY: "integration-link-key-with-at-least-thirty-two-bytes",
      DOHC_RELAY_EXCHANGE_KEY: "integration-relay-exchange-key-at-least-32",
    });

    const workspaceId = "workspace-link-exchange-cap";
    expect((await postJson(baseUrl, "/sync/workspaces", { workspaceId })).status).toBe(200);
    const shareResponse = await postJson(baseUrl, `/sync/${workspaceId}/shares`, {
      recipientUserId: "link-recipient",
      paths: ["docs"],
      access: "view",
    });
    expect(shareResponse.status).toBe(200);
    const share = (await shareResponse.json()) as { shareId: string };
    const linkResponse = await postJson(
      baseUrl,
      `/sync/${workspaceId}/shares/${share.shareId}/links`,
      { access: "view" },
    );
    expect(linkResponse.status).toBe(200);
    const link = (await linkResponse.json()) as { url: string };
    const linkSecret = new URL(link.url).hash.slice(1);

    const missing = await fetch(`${baseUrl}/sync/link-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "g".repeat(43) }),
    });
    expect(missing.status).toBe(404);
    const missingBody = await missing.text();

    const missingWorkloadIdentity = await fetch(`${baseUrl}/sync/link-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: linkSecret }),
    });
    expect(missingWorkloadIdentity.status).toBe(404);
    expect(await missingWorkloadIdentity.text()).toBe(missingBody);

    const emptyPaddingBody = JSON.stringify({ secret: linkSecret, padding: "" });
    const oversizedBody = JSON.stringify({
      secret: linkSecret,
      padding: "x".repeat(4097 - Buffer.byteLength(emptyPaddingBody)),
    });
    expect(Buffer.byteLength(oversizedBody)).toBe(4097);
    const oversized = await fetch(`${baseUrl}/sync/link-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversizedBody,
    });
    expect(oversized.status).toBe(404);
    expect(await oversized.text()).toBe(missingBody);

    const small = await fetch(`${baseUrl}/sync/link-exchange`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dohc-relay-exchange-key": "integration-relay-exchange-key-at-least-32",
      },
      body: JSON.stringify({ secret: linkSecret }),
    });
    expect(small.status).toBe(200);
  });

  it("keeps keyed forwarded client addresses in separate exchange buckets", async () => {
    const relayRoot = await tempRoot("keyed-exchange-buckets");
    const relayExchangeKey = "integration-relay-exchange-key-at-least-32";
    const baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"), {
      DOHC_RELAY_LINK_KEY: "integration-link-key-with-at-least-thirty-two-bytes",
      DOHC_RELAY_EXCHANGE_KEY: relayExchangeKey,
    });

    const secret = "z".repeat(43);
    const firstClientStatuses = await Promise.all(
      Array.from({ length: LINK_EXCHANGE_BUCKET_CAPACITY + 1 }, async () =>
        (
          await exchangeLink(
            baseUrl,
            secret,
            "198.51.100.10",
            relayExchangeKey,
          )
        ).status,
      ),
    );

    // Prove the first address's bucket is exhausted within one batch before
    // asserting the second address succeeds — otherwise one larger shared
    // bucket passes.
    const secondClient = await exchangeLink(
      baseUrl,
      secret,
      "198.51.100.11",
      relayExchangeKey,
    );
    expect({
      firstClientStatuses: [...firstClientStatuses].sort(
        (left: number, right: number) => left - right,
      ),
      secondClientStatus: secondClient.status,
    }).toEqual({
      firstClientStatuses: [
        ...Array.from({ length: LINK_EXCHANGE_BUCKET_CAPACITY }, () => 404),
        429,
      ],
      secondClientStatus: 404,
    });
  });

  it("ignores a forwarded client address when no exchange key is configured", async () => {
    const relayRoot = await tempRoot("unkeyed-exchange-bucket");
    const baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"), {
      DOHC_RELAY_LINK_KEY: "integration-link-key-with-at-least-thirty-two-bytes",
      DOHC_RELAY_EXCHANGE_KEY: undefined,
    });

    const secret = "z".repeat(43);
    const firstClientStatuses = await Promise.all(
      Array.from({ length: LINK_EXCHANGE_BUCKET_CAPACITY + 1 }, async () =>
        (await exchangeLink(baseUrl, secret, "203.0.113.10")).status,
      ),
    );

    // Prove the shared bucket is exhausted within one batch before asserting
    // the spoofed address shares it.
    const spoofedSecondClient = await exchangeLink(baseUrl, secret, "203.0.113.11");
    expect({
      firstClientStatuses: [...firstClientStatuses].sort(
        (left: number, right: number) => left - right,
      ),
      secondClientStatus: spoofedSecondClient.status,
    }).toEqual({
      firstClientStatuses: [
        ...Array.from({ length: LINK_EXCHANGE_BUCKET_CAPACITY }, () => 404),
        429,
      ],
      secondClientStatus: 429,
    });
  });

  it("emits a canonical public URL without writing its bearer to process output", async () => {
    const relayRoot = await tempRoot("share-web-origin-url");
    const relay = await spawnRunningRelay(join(relayRoot, "relay.sqlite"), {
      DOHC_RELAY_LINK_KEY: "integration-link-key-with-at-least-thirty-two-bytes",
      DOHC_RELAY_SHARE_WEB_ORIGIN: "http://127.0.0.1:48123/",
    });

    const workspaceId = "workspace-canonical-share-url";
    expect((await postJson(relay.baseUrl, "/sync/workspaces", { workspaceId })).status).toBe(200);
    const response = await postJson(relay.baseUrl, `/sync/${workspaceId}/shares/links`, {
      paths: ["docs"],
      access: "view",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("secret");
    expect(body.url).toMatch(/^http:\/\/127\.0\.0\.1:48123\/s\/#[-A-Za-z0-9_]{43}$/u);
    const completeUrl = String(body.url);
    const fragment = new URL(completeUrl).hash.slice(1);
    const outputBarrierMarker = await relay.settleOutput();
    expect(relay.stdout()).toContain(outputBarrierMarker);
    expect(relay.stderr()).toContain(outputBarrierMarker);
    expect(relay.stdout()).not.toContain(completeUrl);
    expect(relay.stdout()).not.toContain(fragment);
    expect(relay.stderr()).not.toContain(completeUrl);
    expect(relay.stderr()).not.toContain(fragment);
  });
});
