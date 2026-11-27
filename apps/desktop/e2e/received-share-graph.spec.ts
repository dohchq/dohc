import { expect, test, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { RelayFilePeer } from "../src/testing/relayFilePeer";
import { activityPin } from "../src/testPins";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import { runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import { claimRelayWorkspace, relayJson } from "./helpers/relayPeer";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import { createTempWorkspace, seedCloudCredentials } from "./helpers/workspace";

const OWNER = "test:e2e-graph-granter";
const RECIPIENT = "test:e2e-graph-recipient";
const record = (id: string, title: string) => `---\nid: ${id}\nTitle: ${title}\n---\n`;
const TASKS = `name: Tasks
fields:
  Title:
    type: text
  Owner:
    type: relation
    collection: trip/People
    many: false
  Vault:
    type: relation
    collection: private/Vault
    many: false
`;

type Bridge = { dohcDesktop: DohcDesktopBridge };

function connections(page: Page, workspaceId: string) {
  return page.evaluate(
    (workspaceId) => (window as unknown as Bridge).dohcDesktop.linksConnections({ workspaceId }),
    workspaceId,
  );
}

async function mcpConnections(configArgs: string[]): Promise<unknown> {
  const server = spawn(
    process.execPath,
    [
      join(desktopRoot, "../../packages/mcp/bin/dohc-mcp.js"),
      ...configArgs.slice(configArgs.indexOf("--workspace")),
    ],
    { stdio: ["pipe", "pipe", "inherit"], windowsHide: true },
  );
  const lines = createInterface({ input: server.stdout });
  const replies = new Map<number, (value: { result?: unknown; error?: unknown }) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
    if (message.id !== undefined) replies.get(message.id)?.(message);
  });
  let next = 0;
  const send = (method: string, params: object) => {
    const id = ++next;
    const reply = new Promise<{ result?: unknown; error?: unknown }>((resolve) =>
      replies.set(id, resolve),
    );
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return reply;
  };
  try {
    await send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "received-share-graph", version: "1" },
    });
    server.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const called = await send("tools/call", { name: "dohc_links_connections", arguments: {} });
    expect(called.error).toBeUndefined();
    return (called.result as { structuredContent: unknown }).structuredContent;
  } finally {
    server.kill();
  }
}

test("a standalone received share's Graph shows its Collections and Relations at every door", async () => {
  test.setTimeout(300_000);
  const temp = await createTempWorkspace();
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const ownerId = "received-share-graph-owner";
  try {
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay", "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: OWNER, workspaceId: ownerId });
    const peer = new RelayFilePeer({
      baseUrl: relay.baseUrl,
      token: OWNER,
      workspaceId: ownerId,
      originId: "owner",
    });
    await peer.writeTextFiles([
      { path: "trip/Tasks/collection.yaml", text: TASKS },
      {
        path: "trip/Tasks/first.md",
        text: record("rec_aaaaaaaaaaaaaaaaaaaaaaaaaa", "Book flights"),
      },
      {
        path: "trip/Tasks/automations.yaml",
        text: "version: 1\nautomations:\n  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - set:\n          Title: Ran\n",
      },
      {
        path: "trip/People/collection.yaml",
        text: "name: People\nfields:\n  Title:\n    type: text\n",
      },
      { path: "trip/People/ana.md", text: record("rec_bbbbbbbbbbbbbbbbbbbbbbbbbb", "Ana") },
      {
        path: "private/Vault/collection.yaml",
        text: "name: Vault\nfields:\n  Title:\n    type: text\n",
      },
      { path: "private/Vault/secret.md", text: record("rec_cccccccccccccccccccccccccc", "Hidden") },
    ]);
    const shared = await relayJson(relay.baseUrl, OWNER, `/sync/${ownerId}/shares`, {
      method: "POST",
      body: JSON.stringify({
        paths: ["trip"],
        recipientEmail: "e2e-graph-recipient@dohc.test",
        access: "view",
      }),
    });
    expect(shared.status, shared.body).toBe(200);
    const { shareId } = JSON.parse(shared.body) as { shareId: string };
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: "e2e-graph-recipient@dohc.test",
      userId: "e2e-graph-recipient",
      token: RECIPIENT,
    });
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await page.getByTestId("first-run-open-share").click();
    await page.getByTestId("open-share-code").fill(`dohc-share:${shareId}:${relay.baseUrl}`);
    await page.getByTestId("open-share-choose-folder").click();
    await page.getByTestId("open-share-start").click();
    await expect(page.getByTestId("shared-view-banner")).toBeVisible({ timeout: 120_000 });
    const share = await page.evaluate(
      async () =>
        (await (window as unknown as Bridge).dohcDesktop.getWorkspaceRegistry()).workspaces[0]!,
    );

    await expect
      .poll(async () => (await connections(page, share.workspaceId)).nodes.length, {
        timeout: 120_000,
      })
      .toBe(2);
    const desktopAnswer = await connections(page, share.workspaceId);
    expect(desktopAnswer).toEqual({
      scope: "workspace",
      nodes: [
        {
          id: "collection:trip/People",
          kind: "document-collection",
          path: "trip/People",
          title: "People",
          recordCount: 1,
        },
        {
          id: "collection:trip/Tasks",
          kind: "document-collection",
          path: "trip/Tasks",
          title: "Tasks",
          recordCount: 1,
        },
      ],
      edges: [
        { source: "collection:trip/Tasks", target: "collection:trip/People", kind: "relation" },
      ],
      records: [
        { collection: "collection:trip/People", paths: ["trip/People/ana.md"] },
        { collection: "collection:trip/Tasks", paths: ["trip/Tasks/first.md"] },
      ],
      complete: true,
      mountsCovered: true,
    });
    expect(JSON.stringify(desktopAnswer)).not.toMatch(/private|vault|secret|stamp/i);

    await waitForCliEndpoint(temp.homeDir);
    const cli = JSON.parse(
      (
        await runDohcCli({ homeDir: temp.homeDir, rootPath: share.rootPath }, [
          "--json",
          "links",
          "connections",
        ])
      ).stdout,
    );
    expect(cli).toMatchObject(desktopAnswer);
    const mcp = await page.evaluate(
      (workspaceId) => (window as unknown as Bridge).dohcDesktop.getMcpConfig({ workspaceId }),
      share.workspaceId,
    );
    if ("unavailable" in mcp) throw new Error(mcp.message);
    expect(mcp.args.join(" ")).toContain("--share-access view");
    expect(await mcpConnections(mcp.args)).toEqual(desktopAnswer);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByTestId(activityPin("graph")).click();
    const row = (path: string) =>
      page.locator(`[data-testid="graph-file-row"][data-path="${path}"]`);
    await expect(row("collection:trip/Tasks")).toBeVisible({ timeout: 60_000 });
    await expect(row("collection:trip/People")).toBeVisible();
    await expect(row("trip/Tasks/first.md")).toBeVisible();
    await expect(row("trip/People/ana.md")).toBeVisible();
    await expect(page.getByTestId("graph-rows")).not.toContainText(/vault|secret|stamp/i);
    await page.screenshot({ path: test.info().outputPath("graph-panel.png") });

    await row("collection:trip/Tasks").click();
    await expect(page.getByTestId("collection-page")).toContainText("Book flights", {
      timeout: 60_000,
    });
    await expect(row("collection:trip/Tasks")).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("graph-local-badge")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("graph-local-collection.png") });

    await page.getByTestId("graph-open-tab").click();
    await expect(page.getByTestId("graph-doc-count").filter({ hasText: "2 items" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("graph-link-count").filter({ hasText: "1 link" })).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.screenshot({ path: test.info().outputPath(`graph-page-${theme}.png`) });
    }

    await peer.writeTextFiles([
      {
        path: "trip/People/collection.yaml",
        text: "name: Travellers\nfields:\n  Title:\n    type: text\n",
      },
    ]);
    await expect(async () => {
      await page.getByTestId("shared-view-refresh").click();
      await expect(row("collection:trip/People")).toContainText("Travellers", { timeout: 5_000 });
    }).toPass({ timeout: 60_000 });

    const revoke = await relayJson(relay.baseUrl, OWNER, `/sync/shares/${shareId}/revoke`, {
      method: "POST",
    });
    expect(revoke.status).toBe(200);
    await page.evaluate(
      (workspaceId) => (window as unknown as Bridge).dohcDesktop.refreshSharedView({ workspaceId }),
      share.workspaceId,
    );
    await expect(page.getByTestId("shared-view-banner")).toContainText("This share was ended", {
      timeout: 60_000,
    });
    expect(await connections(page, share.workspaceId)).toMatchObject({
      scope: "share-omitted",
      nodes: [],
      edges: [],
      records: [],
    });
    await expect(row("collection:trip/Tasks")).toHaveCount(0, { timeout: 60_000 });
    await expect(row("collection:trip/People")).toHaveCount(0);
  } finally {
    await desktop?.close();
    await relay?.stop();
    await temp.cleanup();
  }
});
