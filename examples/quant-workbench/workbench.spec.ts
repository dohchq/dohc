import { cp } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { OwnerAppPublicationRequest } from "../../packages/cli/src/appPublication";
import type { DatasetRequest } from "../../packages/cli/src/dataset";
import { launchDesktopApp } from "../../apps/desktop/e2e/helpers/desktopApp";
import {
  sharedDatasetViewerOrigin,
  startSharedDatasetBrowser,
} from "../../apps/desktop/e2e/helpers/sharedDatasetBrowser";
import { spawnSyncRelay } from "../../apps/desktop/e2e/helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  waitForWorkspaceFile,
} from "../../apps/desktop/e2e/helpers/workspace";
import { importObservations } from "./ingest";

const appRoot = "quant-workbench";
const descriptorPath = appRoot + "/data/dataset.json";
const reportRoot = appRoot + "/report";
const publish = (page: Page, request: OwnerAppPublicationRequest) =>
  page.evaluate((input) => window.dohcDesktop!.publishOwnerApp(input), request);
const dataset = (page: Page, request: DatasetRequest) =>
  page.evaluate((input) => window.dohcDesktop!.dataset(input), request);

async function copyApp(root: string) {
  const source = fileURLToPath(new URL(".", import.meta.url));
  await cp(source, join(root, appRoot), {
    recursive: true,
    filter: (path) => !/(?:\.test|\.spec|\.config)\.ts$|README\.md$/.test(path),
  });
}

async function activate(page: Page, workspaceId: string) {
  for (const path of [
    "app.publish.json",
    "index.tsx",
    "workbench.tsx",
    "charts.tsx",
    "ingest.ts",
    "theme.css",
    "data/dataset.json",
    "data/schema.sql",
    "data/operations.js",
    "report/app.publish.json",
    "report/index.tsx",
  ]) {
    await waitForWorkspaceFile(page, workspaceId, appRoot + "/" + path);
  }
  const prepared = await dataset(page, { action: "prepare", workspaceId, descriptorPath });
  if (prepared.kind !== "prepared") throw new Error("Expected a prepared Collection.");
  const approved = await dataset(page, {
    action: "approve",
    workspaceId,
    preparationId: prepared.preparationId,
    revisionSha256: prepared.revision.revisionSha256,
  });
  if (approved.kind !== "approved") throw new Error("Expected an approved Collection.");
  return approved.revision;
}

async function localUrl(page: Page, workspaceId: string) {
  const prepared = await publish(page, { action: "prepareLocal", workspaceId, appRoot });
  if (prepared.kind !== "prepared") throw new Error("Expected a local app review.");
  const approved = await publish(page, {
    action: "approve",
    workspaceId,
    approvalId: prepared.approvalId,
    candidateDigest: prepared.candidateDigest,
  });
  if (approved.kind !== "published") throw new Error("Expected a local publication.");
  const launched = await publish(page, {
    action: "launchLocal",
    workspaceId,
    publicationId: approved.publicationId,
  });
  if (launched.kind !== "localLaunched") throw new Error("Expected a local app URL.");
  return launched.url;
}

test("SignalBook verifies offline and imports, charts, and saves a snapshot in the real app", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1180 },
    colorScheme: "light",
  });
  try {
    await copyApp(workspace.rootPath);
    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, workspace);
    await activate(page, workspaceId);
    for (const [root, heading, operation] of [
      [appRoot, "SignalBook", "overview"],
      [reportRoot, "SignalBook", "publishedReport"],
    ]) {
      const result = await publish(page, {
        action: "verifyFrontend",
        workspaceId,
        appRoot: root,
        timeoutMs: 30_000,
        expectStartupBackend: [{ op: "backend.invoke", operation, status: 200 }],
        steps: [{ kind: "waitFor", selector: "h1", textIncludes: heading }],
      });
      expect(result, `${root}: ${JSON.stringify(result)}`).toMatchObject({
        kind: "frontendVerified",
        ok: true,
      });
    }

    const workbench = await context.newPage();
    const errors: string[] = [];
    workbench.on("pageerror", (error) => errors.push(error.message));
    await workbench.goto(await localUrl(page, workspaceId));
    const frame = workbench.frameLocator("iframe");
    await expect(frame.locator("#observation-count")).toHaveText("23,360");
    const trend = frame.getByRole("group", { name: /Time series. Move/ });
    await expect(trend).toBeVisible();
    await frame.getByLabel("Left axis").selectOption("sample-steps");
    await expect(frame.locator(".chart-legend")).toContainText("Step count (steps)", {
      timeout: 5000,
    });
    await frame.getByLabel("Left axis").selectOption("sample-sleep-hours");
    await frame.getByLabel("Right series lag").selectOption("2");
    await expect(frame.getByText("88 paired days")).toBeVisible();
    await expect(
      frame.getByRole("img", { name: "Scatter plot of paired daily means" }),
    ).toBeVisible();
    await trend.focus();
    await trend.press("ArrowRight");
    await expect(frame.getByRole("tooltip")).toContainText("Sleep duration");
    await expect(frame.locator(".bucket-details")).toContainText("Sleep duration");
    await trend.press("Escape");
    await frame.getByRole("heading", { name: "Time series", exact: true }).click();
    await workbench.screenshot({
      path: info.outputPath("signalbook-light.png"),
      animations: "disabled",
    });
    await workbench.emulateMedia({ colorScheme: "dark" });
    await workbench.screenshot({
      path: info.outputPath("signalbook-dark.png"),
      animations: "disabled",
    });
    const bounds = (await trend.boundingBox())!;
    await workbench.mouse.move(bounds.x + bounds.width * 0.28, bounds.y + bounds.height / 2);
    await workbench.mouse.down();
    await workbench.mouse.move(bounds.x + bounds.width * 0.68, bounds.y + bounds.height / 2, {
      steps: 5,
    });
    await workbench.mouse.up();
    await expect(frame.getByRole("button", { name: "90D" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(frame.locator(".chart-date")).not.toHaveText("2025-10-03 / 2025-12-31");
    await frame.getByLabel("Title").fill("Lagged relationships");
    await frame
      .getByLabel("Note", { exact: true })
      .fill("Sleep duration and heart rate, shifted two days.");
    await frame.getByRole("button", { name: "Save snapshot" }).click();
    await expect(frame.getByRole("heading", { name: "Lagged relationships" })).toBeVisible();
    await frame.getByRole("button", { name: "Import CSV" }).click();
    const file = {
      name: "sleep.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "series,observed_at,value,name,unit,domain\nsleep-hours,2025-12-31,6,My sleep,h,Health",
      ),
    };
    await frame.getByLabel("CSV file").setInputFiles(file);
    await expect(frame.locator("#observation-count")).toHaveText("23,361");
    await frame.getByLabel("CSV file").setInputFiles(file);
    await expect(
      frame.getByRole("status").filter({ hasText: "CSV already imported" }),
    ).toBeVisible();
    await expect(frame.locator("#observation-count")).toHaveText("23,361");
    await frame.getByRole("button", { name: "90D" }).click();
    await frame.getByLabel("Left axis").selectOption("sleep-hours");
    await frame.getByLabel("Right axis").selectOption("");
    await expect(frame.locator(".chart-legend")).toContainText("My sleep (h)");
    await expect(frame.locator(".chart-legend")).not.toContainText("Resting heart rate");
    await trend.press("ArrowRight");
    await expect(frame.getByRole("tooltip")).toContainText("My sleep 6 h");
    await expect(frame.locator(".bucket-details")).toContainText("n 1");
    await frame.getByLabel("CSV file").setInputFiles({
      ...file,
      buffer: Buffer.from(file.buffer.toString().replace(",6,", ",8,")),
    });
    await expect(frame.locator("#observation-count")).toHaveText("23,362");
    await trend.press("ArrowRight");
    await expect(frame.getByRole("tooltip")).toContainText("My sleep 7 h");
    await expect(frame.locator(".bucket-details")).toContainText("n 2");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});

test("a view link opens the selected SignalBook report through the relay", async ({}, info) => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  const workspaceId = randomUUID();
  const userId = "signalbook-owner";
  const exchangeKey = randomBytes(32).toString("base64url");
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let relay: Awaited<ReturnType<typeof spawnSyncRelay>> | null = null;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | null = null;
  try {
    await copyApp(workspace.rootPath);
    relay = await spawnSyncRelay({
      dbPath: join(workspace.baseDir, "relay", "relay.sqlite"),
      appPublications: true,
      linkBoundary: {
        linkKey: randomBytes(32).toString("base64url"),
        relayExchangeKey: exchangeKey,
        publicViewerOrigin: sharedDatasetViewerOrigin,
      },
    });
    const claimed = await fetch(`${relay.baseUrl}/sync/workspaces`, {
      method: "POST",
      headers: { authorization: `Bearer test:${userId}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    expect(claimed.ok).toBe(true);
    await seedWorkspaceManifest(workspace, workspaceId);
    await seedWorkspaceRegistry(workspace, [
      {
        workspaceId,
        rootPath: workspace.rootPath,
        remote: { serverUrl: relay.baseUrl, ownerUserId: userId },
      },
    ]);
    await seedCloudCredentials(workspace, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      userId,
      token: `test:${userId}`,
    });
    shared = await startSharedDatasetBrowser({ relayUrl: relay.baseUrl, exchangeKey });
    desktop = await launchDesktopApp({ workspace, env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150" } });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, workspace);
    const revision = await activate(page, workspaceId);
    async function invoke(
      operation: string,
      input: Extract<DatasetRequest, { action: "invoke" }>["input"],
    ) {
      const result = await dataset(page, {
        action: "invoke",
        workspaceId,
        datasetPath: descriptorPath,
        revision: revision.revision,
        revisionSha256: revision.revisionSha256,
        idempotencyKey: randomUUID(),
        input,
        operationId: revision.definition.operations.find((item) => item.name === operation)!
          .operationId,
      });
      if (result.kind !== "invoked") throw new Error(`Expected ${operation} to run.`);
      return result.result;
    }
    const csv = [
      "series,observed_at,value,name,unit,tags_json",
      'temperature,2025-01-01,4,Temperature,C,"{""secret"":""private raw tag""}"',
      'temperature,2025-02-01,18,Temperature,C,"{""secret"":""private raw tag""}"',
    ].join("\n");
    await importObservations(
      "fixture.csv",
      new TextEncoder().encode(csv).buffer,
      async (batch) =>
        (await invoke("importChunk", batch)) as {
          received: number;
          complete: boolean;
          inserted: number;
        },
    );
    const range = { start: "2025-01-01", end: "2025-02-01", ids: ["temperature"], grain: "day" };
    const { id } = (await invoke("saveNote", {
      ...range,
      title: "Local temperature",
      body: "February was warmer.",
    })) as { id: string };
    await invoke("saveNote", { ...range, title: "Private note", body: "Private context" });

    const link = await publish(page, {
      action: "createLink",
      workspaceId,
      appRoot: reportRoot,
      access: "view",
      operationId: randomUUID(),
    });
    if (link.kind !== "linkCreated") throw new Error("Expected a report link.");
    await invoke("setReportLink", { id, grant: link.grantId });
    const prepared = await publish(page, {
      action: "prepare",
      workspaceId,
      appRoot: reportRoot,
      shareId: link.shareId,
      grantId: link.grantId,
    });
    if (prepared.kind !== "prepared") throw new Error("Expected the shared app review.");
    const approved = await publish(page, {
      action: "approve",
      workspaceId,
      approvalId: prepared.approvalId,
      candidateDigest: prepared.candidateDigest,
    });
    if (approved.kind !== "published" || !approved.appQuery)
      throw new Error("Expected a published report.");
    const url = new URL(link.url);
    url.search = approved.appQuery;
    const guest = await shared.browser.newPage({ viewport: { width: 1280, height: 800 } });
    await guest.goto(url.href);
    await guest.getByRole("button", { name: "Open app", exact: true }).click();
    const frame = guest.frameLocator("iframe");
    await expect(frame.getByRole("heading", { name: "Local temperature" })).toBeVisible();
    await expect(frame.getByText("February was warmer.")).toBeVisible();
    await expect(frame.getByText(/Private context|private raw tag/)).toHaveCount(0);
    await expect(frame.getByRole("button", { name: /Import|Save snapshot/ })).toHaveCount(0);
    await expect(frame.getByLabel("Temperature rollups")).toBeVisible();
    await frame.getByRole("button", { name: "30D" }).click();
    await expect(frame.getByRole("button", { name: "30D" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await guest.screenshot({ path: info.outputPath("signalbook-report.png"), fullPage: true });
    await invoke("setReportLink", { id, grant: null });
    await guest.goto(url.href);
    await guest.getByRole("button", { name: "Open app", exact: true }).click();
    await expect(frame.getByText("No report is linked", { exact: true })).toBeVisible();
    expect(shared.failures).toEqual([]);
  } finally {
    await shared?.close();
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
