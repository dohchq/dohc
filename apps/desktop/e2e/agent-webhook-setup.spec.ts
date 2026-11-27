import { expect, test } from "@playwright/test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mintLocalhostCa } from "../../../services/share-web/src/testing/localhostCa";
import { resolveEngineBinary } from "../src/testing/engineBinary";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { DohcCliFailure, runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import { startServerProxy } from "./helpers/selfHostOnboarding";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
} from "./helpers/workspace";

const OWNER = "agent-webhook-e2e-owner";
const WORKSPACE_ID = "ws-agent-webhook-e2e";
const WAITLIST_YAML = `version: 1
name: Waitlist
fields:
  Title:
    type: text
  Status:
    type: select
    options:
      - New
  Source:
    type: select
    options:
      - webhook
  Kind:
    type: select
    options:
      - webhook
  Received:
    type: date
`;

interface Host {
  kind: string;
  generation: number;
  hostInstallId: string | null;
  handoverFrom: string | null;
  computers: { installId: string; kind: string; thisComputer: boolean }[];
}

test("an agent moves automations to the server and creates a webhook with only the dohc CLI", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  let relay: SyncRelayHandle | undefined;
  let proxy: Awaited<ReturnType<typeof startServerProxy>> | undefined;

  try {
    const ca = await mintLocalhostCa(temp.baseDir);
    const trustEnv = {
      NODE_EXTRA_CA_CERTS: ca.caPath,
      DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
      DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath,
      DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0",
    };
    proxy = await startServerProxy(ca);
    relay = await spawnSyncRelay({
      dbPath: join(temp.baseDir, "relay", "relay.sqlite"),
      editLinks: {
        engineExecutable: resolveEngineBinary(),
        publicOrigin: proxy.origin,
        trustEnv,
      },
      linkBoundary: {
        linkKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        relayExchangeKey: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        publicViewerOrigin: "https://share.dohc.test",
      },
    });
    proxy.routeRelayTo(relay.baseUrl);

    await seedWorkspaceManifest(temp, WORKSPACE_ID);
    await seedWorkspaceRegistry(temp, [
      {
        workspaceId: WORKSPACE_ID,
        rootPath: temp.rootPath,
        remote: { serverUrl: proxy.origin, ownerUserId: OWNER },
      },
    ]);
    await seedCloudCredentials(temp, {
      serverUrl: proxy.origin,
      relayUrl: proxy.origin,
      userId: OWNER,
      token: `test:${OWNER}`,
    });

    desktop = await launchDesktopApp({ workspace: temp, env: trustEnv });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await waitForCliEndpoint(temp.homeDir);

    const readHost = async (): Promise<Host> =>
      JSON.parse((await runDohcCli(temp, ["automation", "host", "--json"])).stdout) as Host;
    await expect
      .poll(
        async () => (await readHost().catch(() => null))?.computers.some((c) => c.thisComputer),
        {
          timeout: 60_000,
        },
      )
      .toBe(true);

    const seen = await readHost();
    const thisComputer = seen.computers.find((computer) => computer.thisComputer)!;
    if (seen.hostInstallId !== thisComputer.installId) {
      const chose = await fetch(
        `${relay.baseUrl}/sync/${encodeURIComponent(WORKSPACE_ID)}/automation-host/choose`,
        {
          method: "POST",
          headers: { authorization: `Bearer test:${OWNER}`, "content-type": "application/json" },
          body: JSON.stringify({ installId: thisComputer.installId, generation: seen.generation }),
        },
      );
      expect(chose.status).toBe(200);
    }
    await expect
      .poll(async () => {
        const host = await readHost();
        return host.hostInstallId === thisComputer.installId && host.handoverFrom === null;
      })
      .toBe(true);

    const stale = await runDohcCli(temp, [
      "automation",
      "use-server",
      "--generation",
      String(seen.generation + 1000),
    ]).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(DohcCliFailure);
    expect((stale as DohcCliFailure).stderr).toContain("Read it again with dohc automation host");

    const before = await readHost();
    const moved = await runDohcCli(temp, [
      "automation",
      "use-server",
      "--generation",
      String(before.generation),
    ]);
    expect(moved.stdout).toMatch(/server runs/u);
    await expect
      .poll(
        async () => {
          const host = await readHost();
          return `${host.hostInstallId}:${host.handoverFrom}`;
        },
        { timeout: 60_000 },
      )
      .toBe("server:null");

    await mkdir(join(temp.rootPath, "waitlist", "nested"), { recursive: true });
    await writeFile(join(temp.rootPath, "waitlist", "collection.yaml"), WAITLIST_YAML);

    let endpointUrl = "";
    await expect
      .poll(
        async () => {
          try {
            const created = await runDohcCli(
              { homeDir: temp.homeDir, rootPath: join(temp.rootPath, "waitlist", "nested") },
              ["webhook", "create", "Waitlist", "--collection", "waitlist", "--json"],
            );
            const result = JSON.parse(created.stdout) as { endpointUrl: string; token?: string };
            expect(result).not.toHaveProperty("token");
            endpointUrl = result.endpointUrl;
            return true;
          } catch (error) {
            if (error instanceof DohcCliFailure && /synced|Collection/iu.test(error.stderr))
              return false;
            throw error;
          }
        },
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe(true);
    const token = endpointUrl.split("/sync/hooks/")[1]!;
    expect(token.length).toBeGreaterThanOrEqual(32);

    const listed = await runDohcCli(temp, ["webhook", "list", "--json"]);
    expect(listed.stdout).toContain('"collectionPath": "waitlist"');
    expect(listed.stdout).not.toContain(token);

    const delivered = await fetch(`${relay.baseUrl}/sync/hooks/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://dohc.computer",
      },
      body: "email=ada%40example.com&source=Drive+waitlist",
    });
    expect(delivered.status).toBe(202);
    expect(delivered.headers.get("access-control-allow-origin")).toBe("*");

    await expect
      .poll(
        async () => {
          const names = await readdir(join(temp.rootPath, "waitlist"));
          for (const name of names.filter((entry) => entry.endsWith(".md"))) {
            const text = await readFile(join(temp.rootPath, "waitlist", name), "utf8");
            if (text.includes("ada@example.com")) return text;
          }
          return "";
        },
        { timeout: 90_000, intervals: [500] },
      )
      .toContain("Waitlist: ada@example.com");
  } finally {
    try {
      await desktop?.close();
    } finally {
      await Promise.allSettled([relay?.stop(), proxy?.close()]);
      await temp.cleanup();
    }
  }
});
