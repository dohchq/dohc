import {
  accountDeletionKey,
  ACCOUNT_DELETION_PATH,
  ACCOUNT_DELETION_KEY_HEADER,
} from "@dohc/security-contract/account-deletion";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { realDaemonReaderConfig } from "../../../apps/desktop/src/testing/realDaemonWorkspaceSessions";
import { initializeRelayDeployment } from "./relayDeployment";
import { RELAY_API_VERSIONS } from "./apiVersion";
import { relayProcessFixture, projectionEngine, productionEnv } from "./mainProcessTestSupport";

const { tempRoot, spawnRunningRelay, spawnRelayExpectExit } = relayProcessFixture();

describe("sync relay startup guards", () => {
  it.each(["short"])(
    "does not mount account deletion with test auth and a short secret: %s",
    async (secret) => {
      const root = await tempRoot("deletion-short-secret");
      const relay = await spawnRunningRelay(join(root, "relay.sqlite"), {
        BETTER_AUTH_SECRET: secret,
      });
      const response = await fetch(relay.baseUrl + ACCOUNT_DELETION_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [ACCOUNT_DELETION_KEY_HEADER]: accountDeletionKey(secret),
        },
        body: JSON.stringify({
          operation: "purge",
          userId: "person",
          email: "person@example.test",
        }),
      });
      expect(response.status).toBe(404);
    },
  );

  it("starts an empty self-host deployment with supported live defaults and reports readiness", async () => {
    const root = await tempRoot("self-host-ready"),
      configPath = join(root, "deployment.json"),
      relayPath = join(root, "relay", "relay.sqlite");
    initializeRelayDeployment({
      configPath,
      relayPath,
      continuityDirectory: join(root, "continuity"),
    });
    const relay = await spawnRunningRelay(relayPath, {
      DOHC_SELF_HOST_LIVE: "1",
      SYNC_RELAY_DB_PATH: undefined,
      DOHC_RELAY_DEPLOYMENT_CONFIG: configPath,
      DOHC_RELAY_SERVICE_HOST_ROOT: root,
      DOHC_RELAY_ENGINE_EXECUTABLE: projectionEngine.require(),
      DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION: "1",
      DOHC_RELAY_PUBLIC_ORIGIN: "https://relay.example.test",
      DOHC_RELAY_SHARE_WEB_ORIGIN: "https://share.example.test",
      DOHC_RELAY_SHARE_WEB_URL: "http://share-web:1790",
      DOHC_RELAY_NAMED_LIVE_HOSTS: "relay.example.test",
      DOHC_RELAY_EXCHANGE_KEY: "x".repeat(32),
      DOHC_RELAY_LINK_KEY: "y".repeat(32),
      DOHC_ENGINE_READER_CONFIG: realDaemonReaderConfig(),
    });
    expect(relay.stderr()).toContain("WARNING: DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION=1");
    // The empty deployment must complete its engine handshake and first pass.
    await vi.waitFor(
      async () => {
        const response = await fetch(`${relay.baseUrl}/ready`);
        expect(response.status, `relay stayed unready\nstderr:\n${relay.stderr()}`).toBe(200);
        // The self-host profile runs automations by default.
        expect(await response.json()).toEqual({
          ok: true,
          service: "sync-relay",
          selfHostedLive: true,
          apiVersions: RELAY_API_VERSIONS,
          automations: "on",
        });
      },
      { timeout: 10_000 },
    );
    expect((await fetch(`${relay.baseUrl}/sync/workspace/live-host`)).status).toBe(404);
  });

  it.each(["production"])(
    "refuses the projection development flag outside development/test: %s",
    async (nodeEnv) => {
      for (const flag of ["1"]) {
        const root = await tempRoot("projection-production-opt-in");
        const configPath = join(root, "deployment.json"),
          relayPath = join(root, "relay", "relay.sqlite");
        initializeRelayDeployment({
          configPath,
          relayPath,
          continuityDirectory: join(root, "continuity"),
        });
        const { code, stderr } = await spawnRelayExpectExit(
          {
            ...productionEnv,
            NODE_ENV: nodeEnv,
            SYNC_RELAY_DB_PATH: undefined,
            DOHC_RELAY_DEPLOYMENT_CONFIG: configPath,
            DOHC_RELAY_ENGINE_EXECUTABLE: process.execPath,
            DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION: flag,
          },
          { projectionHandshake: true },
        );
        expect(code).toBe(1);
        expect(stderr).toContain(
          "DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION is allowed only in development/test.",
        );
        const database = new DatabaseSync(relayPath, { readOnly: true });
        try {
          expect(
            database
              .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
              .all(),
          ).toEqual([{ name: "sync_relay_continuity" }]);
        } finally {
          database.close();
        }
      }
    },
  );

  it.each([
    {
      executable: process.execPath,
      reason:
        process.platform === "linux"
          ? "Projection engine did not pass startup probes:"
          : "Document projection requires Linux memory isolation",
    },
  ])(
    "refuses production projection startup for $executable: $reason",
    async ({ executable, reason }) => {
      const root = await tempRoot("projection-startup");
      const configPath = join(root, "deployment.json"),
        relayPath = join(root, "relay", "relay.sqlite");
      initializeRelayDeployment({
        configPath,
        relayPath,
        continuityDirectory: join(root, "continuity"),
      });
      const { code, stderr } = await spawnRelayExpectExit({
        ...productionEnv,
        SYNC_RELAY_DB_PATH: undefined,
        DOHC_RELAY_DEPLOYMENT_CONFIG: configPath,
        DOHC_RELAY_ENGINE_EXECUTABLE: executable,
      });
      expect(code).toBe(1);
      expect(stderr).toContain(reason);
    },
  );
});
