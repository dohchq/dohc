import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { sendCliRequest } from "@dohc/cli/client";
import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import { activityPin, settingsNavPin } from "../src/testPins";
import { waitForVisibleAnimations } from "./helpers/animations";
import { createRecord, fieldCells } from "./helpers/dataCollection";
import { launchDesktopApp } from "./helpers/desktopApp";
import { waitForCliEndpoint } from "./helpers/dohcCli";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openExplorerHome,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
} from "./helpers/workspace";

// A syncing workspace's Collections live on its server, and this computer
// keeps a copy of each one it reads. Signed out, by Disconnect or a 401, the
// copy stays and reads read-only. A different account signing in removes it.
const SIGNED_OUT = "Offline copy · Read-only until you connect your server";
const REFUSED =
  "dohc didn't save this change. This Collection is read-only until you connect your server.";

test("@signed-out-copy a Collection reads read-only signed out, and goes when a different account signs in", async () => {
  test.setTimeout(420_000);
  const workspace = await createTempWorkspace(),
    workspaceId = randomUUID(),
    owner = "copy-owner",
    other = "copy-other";
  const env = { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" };
  const copies = join(workspace.rootPath, ".dohc", "local", "dataset-copies");
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  // Quits dohc, and starts it again signed in with `token`, or signed out.
  const restart = async (session?: { userId: string; token: string }) => {
    await desktop?.close();
    desktop = null;
    if (session)
      await seedCloudCredentials(workspace, {
        serverUrl: relay!.baseUrl,
        relayUrl: relay!.baseUrl,
        ...session,
      });
    desktop = await launchDesktopApp({ workspace, env });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    return desktop.page;
  };
  const openCollection = async (page: Page) => {
    await openExplorerHome(page);
    await page
      .getByRole("region", { name: "Collections", exact: true })
      .getByRole("button", { name: "Registrations", exact: true })
      .click();
    return page.getByRole("region", { name: "Registrations", exact: true });
  };
  const cli = (request: Record<string, unknown>) =>
    sendCliRequest(
      {
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "dataset",
        args: {
          cwd: workspace.rootPath,
          actor: "agent",
          // Each request here is a dataset request; the CLI checks it.
          request: { workspaceId, ...request } as never,
        },
      },
      { stateDir: workspace.homeDir },
    );
  // What a person and an agent meet signed out: the kept record, read-only,
  // and a change refused at once with words that say why.
  const readsSignedOut = async (page: Page, shot?: string) => {
    const collection = await openCollection(page);
    await expect(collection.getByText(SIGNED_OUT)).toBeVisible({ timeout: 30_000 });
    await expect(await fieldCells(collection, "Name")).toHaveText("Kept record");
    await expect(collection.getByRole("button", { name: "New record", exact: true })).toHaveCount(
      0,
    );
    await waitForCliEndpoint(workspace.homeDir);
    const listed = JSON.stringify(await cli({ action: "list" }));
    expect(listed).toContain("Registrations");
    const dataset = await page.evaluate(
      async (id) => window.dohcDesktop!.dataset({ workspaceId: id, action: "list" }),
      workspaceId,
    );
    if (dataset.kind !== "list" || !dataset.datasets[0]) throw Error("Expected the kept list.");
    const kept = dataset.datasets[0];
    const pinned = {
      datasetPath: kept.datasetPath!,
      revision: kept.revision,
      revisionSha256: kept.revisionSha256,
    };
    const read = kept.operations.find((operation) => operation.kind === "read")!;
    const read_ = await cli({
      action: "invoke",
      ...pinned,
      operationId: read.operationId,
      input: { limit: 50 },
      idempotencyKey: `signed-out-read-${randomUUID()}`,
    });
    expect(JSON.stringify(read_)).toContain("Kept record");
    const create = kept.operations.find((operation) => operation.kind === "create")!;
    const started = performance.now();
    const refused = await cli({
      action: "invoke",
      ...pinned,
      operationId: create.operationId,
      input: { values: {} },
      idempotencyKey: `signed-out-create-${randomUUID()}`,
    }).then(
      (value) => JSON.stringify(value),
      (error: unknown) => String(error),
    );
    expect(refused).toContain(REFUSED);
    // Refused here, not after a request to the server times out.
    expect(performance.now() - started).toBeLessThan(5_000);
    if (!shot) return;
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(async (value) => {
        document.documentElement.setAttribute("data-theme", value);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, theme);
      await waitForVisibleAnimations(page);
      await test.info().attach(`${shot}-${theme}.png`, {
        body: await collection.screenshot(),
        contentType: "image/png",
      });
    }
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  };

  try {
    relay = await spawnSyncRelay({ dbPath: join(workspace.baseDir, "relay", "relay.sqlite") });
    const claim = await fetch(`${relay.baseUrl}/sync/workspaces`, {
      method: "POST",
      headers: { authorization: `Bearer test:${owner}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    expect(claim.ok).toBe(true);
    await seedWorkspaceManifest(workspace, workspaceId);
    await seedWorkspaceRegistry(workspace, [
      {
        workspaceId,
        rootPath: workspace.rootPath,
        remote: { serverUrl: relay.baseUrl, ownerUserId: owner },
      },
    ]);

    // Signed in, the owner makes a Collection with one record. This computer keeps its copy.
    let page = await restart({ userId: owner, token: `test:${owner}` });
    await page.keyboard.press("ControlOrMeta+k");
    await page
      .getByTestId("command-palette")
      .getByRole("option", { name: "New collection", exact: true })
      .click();
    const create = page.getByTestId("new-collection-dialog");
    await create.getByLabel("Collection name").fill("Registrations");
    await create.getByTestId("new-collection-create").click();
    await expect(create).toBeHidden();
    const collection = page.getByRole("region", { name: "Registrations", exact: true });
    await createRecord(collection, "Kept record");
    await expect(await fieldCells(collection, "Name")).toHaveText("Kept record");
    await expect
      .poll(async () => (await readdir(copies).catch(() => [])).length)
      .toBeGreaterThan(0);

    // Disconnect, as a person does it.
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("cloud")).click();
    await page.getByTestId("cloud-disconnect").click();
    await expect(page.getByTestId("cloud-disconnect")).toHaveCount(0, { timeout: 30_000 });
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    const keptFolders = await readdir(copies);
    expect(keptFolders.length).toBeGreaterThan(0);
    await readsSignedOut(page, "signed-out-collection");

    // A restart while signed out reads the same copy.
    page = await restart();
    await readsSignedOut(page);

    // The owner signs back in: the Collection takes changes again.
    page = await restart({ userId: owner, token: `test:${owner}` });
    const back = await openCollection(page);
    await expect(await fieldCells(back, "Name")).toHaveText("Kept record");
    await expect(back.getByText(SIGNED_OUT)).toHaveCount(0);
    await expect(
      back.getByRole("button", { name: "New record", exact: true }).first(),
    ).toBeVisible();

    // The server refuses the owner's session (401), which signs this computer out.
    page = await restart({ userId: owner, token: "expired" });
    await readsSignedOut(page);

    // A different account signs in: the owner's copies go, and nothing of them shows.
    page = await restart({ userId: other, token: `test:${other}` });
    await expect
      .poll(async () =>
        (await readdir(copies).catch(() => [])).filter((name) => keptFolders.includes(name)),
      )
      .toEqual([]);
    await openExplorerHome(page);
    await expect(page.getByText("Kept record")).toHaveCount(0);
    await expect(page.getByText(SIGNED_OUT)).toHaveCount(0);
  } finally {
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
