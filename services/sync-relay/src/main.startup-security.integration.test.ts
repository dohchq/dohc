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

  it.each([
    ["relative", "share.example.test", absoluteShareWebOriginReason],
    ["credentials", "https://user:pass@share.example.test", invalidShareWebOriginShapeReason],
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

  describe.each([
    ["localhost", "test", "http://localhost:48123"],
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

});
