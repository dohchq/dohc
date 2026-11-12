import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeRelayDeployment } from "./relayDeployment";
import { relayProcessFixture, loopbackListenDenied, productionEnv } from "./mainProcessTestSupport";

const { tempRoot, spawnRelay, spawnRunningRelay, spawnRelayExpectExit } = relayProcessFixture();

describe("sync relay startup guards", () => {
  const absoluteShareWebOriginReason =
    "FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be an absolute HTTP(S) origin.";

  const invalidShareWebOriginShapeReason =
    "FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be an origin without credentials, a path, a query, or a fragment.";

  const productionHttpsShareWebOriginReason =
    "FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must use HTTPS outside development/test.";

  it.each([
    ["malformed JSON", "{", "SyntaxError"],
    ["wrong version", '{"version":2}', "Public Edit release"],
    ["extra key", '{"version":1,"extra":true}', "Public Edit release"],
  ])("refuses a public Edit release marker in production before storage opens: %s", async (_label, marker, reason) => {
    const dbPath = join(await tempRoot("malformed-public-edit-release"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      ...productionEnv, SYNC_RELAY_DB_PATH: dbPath, DOHC_PUBLIC_EDIT_RELEASE: marker,
    });
    expect(code).toBe(1);
    expect(stderr).toContain(reason);
    await expect(access(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps public Edit routes closed in production without a release marker", async () => {
    const root = await tempRoot("closed-public-edit-release");
    const configPath = join(root, "deployment.json"), relayPath = join(root, "relay", "relay.sqlite");
    initializeRelayDeployment({configPath, relayPath, continuityDirectory: join(root, "continuity")});
    const relay = await spawnRunningRelay(relayPath, {
      ...productionEnv,
      DOHC_RELAY_ENGINE_EXECUTABLE: process.execPath, SYNC_RELAY_DB_PATH: undefined, DOHC_RELAY_DEPLOYMENT_CONFIG: configPath,
      DOHC_PUBLIC_EDIT_RELEASE: undefined, DOHC_RELAY_LINK_LIVE: undefined,
      DOHC_RELAY_NAMED_LIVE_CONFIG: undefined, DOHC_RELAY_NAMED_BROWSER_SESSION_LIMITS: undefined,
    }, {projectionHandshake: true, emptyDeletionJobs: true});
    const baseUrl = relay.baseUrl;
    expect((await fetch(baseUrl + "/health")).status).toBe(200);
    for (const path of ["/sync/live/link-tickets", "/sync/live/link-session", "/sync/live/link-document"]) {
      expect((await fetch(baseUrl + path, {method: "POST"})).status).toBe(404);
    }
  });

  it("refuses a production release marker without a configured live host", async () => {
    const root = await tempRoot("public-edit-release-no-host");
    const configPath = join(root, "deployment.json"), relayPath = join(root, "relay", "relay.sqlite");
    initializeRelayDeployment({configPath, relayPath, continuityDirectory: join(root, "continuity")});
    const {code, stderr} = await spawnRelayExpectExit({
      ...productionEnv, DOHC_RELAY_ENGINE_EXECUTABLE: process.execPath, SYNC_RELAY_DB_PATH: undefined, DOHC_RELAY_DEPLOYMENT_CONFIG: configPath,
      DOHC_PUBLIC_EDIT_RELEASE: '{"version":1}', DOHC_RELAY_LINK_LIVE: undefined,
      DOHC_RELAY_NAMED_LIVE_CONFIG: undefined,
      DOHC_RELAY_NAMED_BROWSER_SESSION_LIMITS: JSON.stringify({maxSessions: 4, retentionMs: 60000,
        maxPendingRequests: 2, maxRequestBytes: 1038, maxResponseBytes: 4152, timeoutMs: 1000}),
    }, {projectionHandshake: true, emptyDeletionJobs: true});
    expect(code).toBe(1);
    expect(stderr).toContain("Public Edit release requires link live routes and the configured service host");
  });

  it("refuses to start in production without a public share-web origin", async () => {
    const dbPath = join(await tempRoot("no-share-web-origin"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      ...productionEnv,
      DOHC_RELAY_SHARE_WEB_ORIGIN: undefined,
      SYNC_RELAY_DB_PATH: dbPath,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("DOHC_RELAY_SHARE_WEB_ORIGIN must be set");
  });

  it.each([
    ["relative", "share.example.test", absoluteShareWebOriginReason],
    [
      "credentials",
      "https://user:pass@share.example.test",
      invalidShareWebOriginShapeReason,
    ],
    [
      "empty credentials",
      "https://@share.example.test",
      invalidShareWebOriginShapeReason,
    ],
    ["path", "https://share.example.test/public", invalidShareWebOriginShapeReason],
    [
      "query",
      "https://share.example.test/?tenant=one",
      invalidShareWebOriginShapeReason,
    ],
    ["empty query", "https://share.example.test/?", invalidShareWebOriginShapeReason],
    [
      "fragment",
      "https://share.example.test/#fragment",
      invalidShareWebOriginShapeReason,
    ],
    ["empty fragment", "https://share.example.test/#", invalidShareWebOriginShapeReason],
    ["non-HTTPS", "http://share.example.test", productionHttpsShareWebOriginReason],
  ])(
    "refuses a %s public share-web origin in production",
    async (label, origin, expectedReason) => {
      const dbPath = join(await tempRoot(`bad-share-web-origin-${label}`), "relay.sqlite");
      const { code, stderr } = await spawnRelayExpectExit({
        ...productionEnv,
        DOHC_RELAY_SHARE_WEB_ORIGIN: origin,
        SYNC_RELAY_DB_PATH: dbPath,
      });
      expect(code).toBe(1);
      expect(stderr).toBe(`${expectedReason}\n`);
    },
  );

  it.each(["test", "development"] as const)(
    "refuses a non-loopback HTTP DNS public origin in %s",
    async (nodeEnv) => {
      const dbPath = join(
        await tempRoot(`non-loopback-dns-share-web-origin-${nodeEnv}`),
        "relay.sqlite",
      );
      const { code, stderr } = await spawnRelayExpectExit({
        NODE_ENV: nodeEnv,
        SYNC_RELAY_TEST_AUTH: "1",
        SYNC_RELAY_PORT: "0",
        SYNC_RELAY_DB_PATH: dbPath,
        DOHC_RELAY_SHARE_WEB_ORIGIN: "http://share.example.test:48123",
        FORCE_COLOR: "0",
      });
      expect(code).toBe(1);
      expect(stderr).toContain("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN");
    },
  );

  describe.each([
    ["localhost", "test", "http://localhost:48123"],
    ["localhost subdomain", "test", "http://viewer.localhost:48123"],
    ["IPv4 loopback", "test", "http://127.0.0.1:48123"],
    ["another IPv4 loopback", "test", "http://127.42.0.9:48123"],
    ["canonicalized IPv4 loopback", "test", "http://127.1:48123"],
    ["IPv6 loopback", "test", "http://[::1]:48123"],
    ["IPv4 loopback", "development", "http://127.0.0.1:48123/"],
  ] as const)(
    "permits an HTTP %s public origin in %s",
    (label, nodeEnv, origin) => {
      it.skipIf(loopbackListenDenied)("starts", async () => {
        const relayRoot = await tempRoot(
          `loopback-share-web-origin-${nodeEnv}-${label.replaceAll(" ", "-")}`,
        );
        expect(
          await spawnRelay(join(relayRoot, "relay.sqlite"), {
            NODE_ENV: nodeEnv,
            DOHC_RELAY_SHARE_WEB_ORIGIN: origin,
          }),
        ).toMatch(/^http:\/\//u);
      });
    },
  );

  it.each([
    ["private-network IPv4", "http://192.168.1.10:48123"],
    ["wildcard IPv4", "http://0.0.0.0:48123"],
    ["non-loopback IPv6", "http://[2001:db8::1]:48123"],
  ] as const)("refuses an HTTP %s public origin in test", async (label, origin) => {
    const dbPath = join(
      await tempRoot(`non-loopback-share-web-origin-${label.replaceAll(" ", "-")}`),
      "relay.sqlite",
    );
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0",
      SYNC_RELAY_DB_PATH: dbPath,
      DOHC_RELAY_SHARE_WEB_ORIGIN: origin,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN");
  });

  it("refuses to start when SYNC_RELAY_PORT is not a number", async () => {
    const dbPath = join(await tempRoot("bad-port"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "not-a-port",
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("SYNC_RELAY_PORT must be an integer");
  });

  it("refuses to start when SYNC_RELAY_WORKSPACE_QUOTA_BYTES is not positive", async () => {
    const dbPath = join(await tempRoot("bad-quota"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0",
      SYNC_RELAY_WORKSPACE_QUOTA_BYTES: "0",
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("SYNC_RELAY_WORKSPACE_QUOTA_BYTES must be a positive integer");
  });

  it("refuses to start in production when POSTGRES_URL is unset", async () => {
    const dbPath = join(await tempRoot("no-pg"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "production",
      SYNC_RELAY_TEST_AUTH: undefined,
      POSTGRES_URL: undefined,
      DOHC_RELAY_SHARE_WEB_ORIGIN: "https://share.example.test",
      SYNC_RELAY_PORT: "0",
      // A valid-length secret so the guard under test is the one that fires.
      BETTER_AUTH_SECRET: "x".repeat(32),
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("POSTGRES_URL must be set");
  });

  it("refuses to start in production when DOHC_RELAY_LINK_KEY is unset", async () => {
    const dbPath = join(await tempRoot("no-link-key"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "production",
      SYNC_RELAY_TEST_AUTH: undefined,
      POSTGRES_URL: "postgres://unused:unused@127.0.0.1:1/unused",
      DOHC_RELAY_LINK_KEY: undefined,
      DOHC_RELAY_EXCHANGE_KEY: "integration-relay-exchange-key-at-least-32",
      DOHC_RELAY_SHARE_WEB_ORIGIN: "https://share.example.test",
      SYNC_RELAY_PORT: "0",
      BETTER_AUTH_SECRET: "x".repeat(32),
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("DOHC_RELAY_LINK_KEY must be set");
  });

  it("refuses to start in production when DOHC_RELAY_EXCHANGE_KEY is unset", async () => {
    const dbPath = join(await tempRoot("no-relay-exchange-key"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "production",
      SYNC_RELAY_TEST_AUTH: undefined,
      POSTGRES_URL: "postgres://unused:unused@127.0.0.1:1/unused",
      DOHC_RELAY_LINK_KEY: "integration-link-key-with-at-least-thirty-two-bytes",
      DOHC_RELAY_EXCHANGE_KEY: undefined,
      DOHC_RELAY_SHARE_WEB_ORIGIN: "https://share.example.test",
      SYNC_RELAY_PORT: "0",
      BETTER_AUTH_SECRET: "x".repeat(32),
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("DOHC_RELAY_EXCHANGE_KEY must be set");
  });

  it("refuses to start when DOHC_RELAY_EXCHANGE_KEY is shorter than 32 characters", async () => {
    const dbPath = join(await tempRoot("short-relay-exchange-key"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      DOHC_RELAY_EXCHANGE_KEY: "x".repeat(31),
      SYNC_RELAY_PORT: "0",
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain(
      "FATAL: DOHC_RELAY_EXCHANGE_KEY must be at least 32 characters.",
    );
  });

  it.skipIf(loopbackListenDenied)("starts in test with a 32-character or unset relay exchange key", async () => {
    for (const [label, relayExchangeKey] of [
      ["minimum-relay-exchange-key", "x".repeat(32)],
      ["unset-relay-exchange-key", undefined],
    ] as const) {
      const relayRoot = await tempRoot(label);
      expect(
        await spawnRelay(join(relayRoot, "relay.sqlite"), {
          DOHC_RELAY_EXCHANGE_KEY: relayExchangeKey,
        }),
      ).toMatch(/^http:\/\//u);
    }
  });
});
