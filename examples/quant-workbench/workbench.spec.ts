import { readFileSync } from "node:fs";
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

function manifestInputs(path: string): string[] {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).inputs;
}

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
    ...manifestInputs("app.publish.json"),
    "report/app.publish.json",
    ...manifestInputs("report/app.publish.json").map((input) => "report/" + input),
    "data/dataset.json",
    "data/schema.sql",
    "data/operations.js",
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
    hasTouch: true,
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
    workbench.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await workbench.goto(await localUrl(page, workspaceId));
    const frame = workbench.frameLocator("iframe");
    await expect(frame.locator("#observation-count")).toHaveText("5,475");
    const trend = frame.getByRole("group", { name: /Time series. Move/ });
    const hud = frame.getByTestId("chart-hud");
    await expect(trend).toBeVisible();
    await frame.getByRole("button", { name: "Left axis: Step count" }).click();
    await expect(hud).toContainText("Step count", { timeout: 5000 });
    await frame.getByRole("button", { name: "Left axis: Sleep duration" }).click();
    await expect(hud).toContainText("Resting heart rate");
    await frame.getByLabel("Right series lag").fill("2");
    await expect(frame.locator(".stats")).toContainText("88 paired days");
    await expect(frame.locator("#ci-note")).toHaveText(
      "The interval allows for each series' day-to-day persistence. This is the strongest lag, so its interval is optimistic.",
    );
    await expect(frame.getByRole("img", { name: /Scatter plot of 88 paired/ })).toBeVisible();
    await trend.focus();
    const hudDate = hud.locator(".sb-hud-date");
    await trend.press("ArrowRight");
    await expect(hud).toHaveAttribute("data-live", "cursor");
    await expect(hudDate).toContainText("Wed, Dec 31, 2025");
    await expect(hud).toContainText("Sleep duration");
    await trend.press("Escape");
    await expect(hud).toHaveAttribute("data-live", "latest");
    await trend.press("ArrowLeft");
    await expect(hudDate).toContainText("Tue, Dec 30, 2025");
    await trend.press("Escape");
    await expect(hud).toHaveAttribute("data-live", "latest");
    await workbench.screenshot({
      path: info.outputPath("signalbook-light.png"),
      animations: "disabled",
    });
    await workbench.emulateMedia({ colorScheme: "dark" });
    await workbench.screenshot({
      path: info.outputPath("signalbook-dark.png"),
      animations: "disabled",
    });
    const outlier = frame.locator("[data-outlier]").first();
    await frame
      .locator("[data-scroll-main]")
      .evaluate((main) => main.scrollTo({ top: main.scrollHeight }));
    await outlier.click();
    await expect(outlier).toHaveAttribute("aria-pressed", "true");
    const toolbar = (await frame.getByRole("toolbar", { name: "Chart" }).boundingBox())!;
    const chart = (await frame.getByRole("region", { name: "Time series" }).boundingBox())!;
    expect(chart.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height - 1);
    const keyed = frame.locator("[data-outlier]").nth(1);
    const keyedAt = await keyed.locator("time").getAttribute("datetime");
    await keyed.focus();
    await keyed.press("Enter");
    await expect(keyed).toHaveAttribute("aria-pressed", "true");
    await expect(trend).toBeFocused();
    await trend.press("ArrowRight");
    const after = new Date(Date.parse(keyedAt!.slice(0, 10)) + 86_400_000);
    await expect(hudDate).toContainText(
      after.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }),
    );
    await trend.press("Escape");
    const bounds = (await trend.boundingBox())!;
    await workbench.mouse.move(bounds.x + bounds.width * 0.28, bounds.y + bounds.height / 2);
    await workbench.mouse.down();
    await workbench.mouse.move(bounds.x + bounds.width * 0.68, bounds.y + bounds.height / 2, {
      steps: 5,
    });
    await workbench.mouse.up();
    await expect(frame.getByRole("button", { name: "90D", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(frame.getByRole("button", { name: /^Back to / })).toBeVisible();
    await frame.getByRole("button", { name: "Notes", exact: true }).click();
    await frame.getByLabel("Title").fill("Lagged relationships");
    await frame
      .getByLabel("Note", { exact: true })
      .fill("Sleep duration and heart rate, shifted two days.");
    await frame.getByRole("button", { name: "Save snapshot" }).click();
    await expect(frame.getByRole("heading", { name: "Lagged relationships" })).toBeVisible();
    await expect(frame.getByText(/r .* at lag \+2 d/)).toBeVisible();
    const drawer = frame.getByRole("dialog", { name: "Research notes" });
    await trend.focus();
    await workbench.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await frame.getByRole("button", { name: "Keyboard shortcuts" }).click();
    await frame.getByLabel("Single-key shortcuts").uncheck();
    await trend.press("n");
    await expect(drawer).toBeHidden();
    await frame.getByLabel("Single-key shortcuts").check();
    await trend.press("n");
    await expect(drawer).toBeVisible();
    await frame.getByRole("button", { name: "Close drawer" }).click();
    await expect(drawer).toBeHidden();
    await frame.getByRole("button", { name: "Share", exact: true }).click();
    await expect(frame.getByRole("dialog", { name: "Share a report" })).toBeVisible();
    await expect(frame.getByRole("heading", { name: "Publish a read-only report" })).toBeFocused();
    await expect(frame.getByRole("button", { name: "Save snapshot" })).toHaveCount(0);
    await workbench.keyboard.press("Escape");
    await expect(frame.getByRole("dialog", { name: "Share a report" })).toBeHidden();
    await frame.getByRole("button", { name: "Import CSV" }).click();
    const file = {
      name: "sleep.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "series,observed_at,value,name,unit,domain\nsleep-hours,2025-12-30,5,My sleep,h,Health\nsleep-hours,2025-12-31,6,My sleep,h,Health",
      ),
    };
    await frame.getByLabel("CSV file").setInputFiles(file);
    await expect(frame.locator("#observation-count")).toHaveText("5,477");
    await frame.getByLabel("CSV file").setInputFiles(file);
    await expect(
      frame.getByRole("status").filter({ hasText: "CSV already imported" }),
    ).toBeVisible();
    await expect(frame.locator("#observation-count")).toHaveText("5,477");
    await frame.getByRole("button", { name: "90D", exact: true }).click();
    await frame.getByRole("button", { name: "Left axis: My sleep" }).click();
    await frame.getByRole("button", { name: /^Right axis: /, pressed: true }).click();
    await expect(hud).toContainText("My sleep");
    await expect(hud).not.toContainText("Resting heart rate");
    await trend.press("ArrowRight");
    await expect(hud).toContainText("6.00 h");
    await expect(hud.locator(".sb-hud-ohlc").first()).not.toContainText("Mean of");
    await frame.getByLabel("CSV file").setInputFiles({
      ...file,
      buffer: Buffer.from("series,observed_at,value\nsleep-hours,2025-12-31,8"),
    });
    await expect(frame.locator("#observation-count")).toHaveText("5,478");
    await trend.press("ArrowRight");
    await expect(hud).toContainText("7.00 h");
    await expect(hud.locator(".sb-hud-ohlc").first()).toContainText(/Mean of\s*2(?!\d)/);
    const extra = hud.locator(".sb-hud-extra").first();
    const settled = await extra.boundingBox();
    await trend.press("ArrowLeft");
    await expect(hud).toContainText("5.00 h");
    await expect(hud.locator(".sb-hud-ohlc").first()).not.toContainText("Mean of");
    expect(await extra.boundingBox()).toEqual(settled);
    await frame.getByRole("button", { name: /^Date range: / }).click();
    await frame.getByLabel("Start date").fill("2025-11-01");
    await expect(
      frame.getByRole("button", { name: "Date range: Nov 1 to Dec 31, 2025" }),
    ).toBeVisible();
    await expect(frame.getByRole("button", { name: /^Back to / })).toBeVisible();
    await expect(trend.locator("text.sb-tick", { hasText: /^Nov \d+$/ }).first()).toBeVisible();
    await workbench.keyboard.press("Escape");
    await expect(frame.getByLabel("Start date")).toBeHidden();

    await workbench.setViewportSize({ width: 390, height: 844 });
    await workbench.reload();
    await expect(frame.locator("#observation-count")).toHaveText("5,478");
    await expect(trend).toBeVisible();
    await expect(frame.getByRole("button", { name: "Left axis: My sleep" })).toBeVisible();
    const overflow = await frame
      .locator("html")
      .evaluate((root) => root.scrollWidth - root.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(hud.locator(".sb-hud-latest")).toBeVisible();
    const hudRows = await hud
      .locator(".sb-hud-name, .sb-hud-mean")
      .evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().top)));
    expect(Math.abs(hudRows[0] - hudRows[1])).toBeLessThan(6);
    expect(Math.abs(hudRows[2] - hudRows[3])).toBeLessThan(6);
    expect(hudRows[2] - hudRows[0]).toBeGreaterThan(12);
    await frame.getByRole("button", { name: "Left axis: My sleep" }).click();
    await expect(hud).toContainText("My sleep");
    await trend.focus();
    await trend.press("End");
    await expect(hud.locator(".sb-hud-ohlc").first()).toContainText(/Mean of\s*2(?!\d)/);
    const stackedMean = hud.locator(".sb-hud-mean").first();
    const stackedAt = await stackedMean.boundingBox();
    await trend.press("ArrowLeft");
    await expect(hud).toContainText("5.00 h");
    expect(await stackedMean.boundingBox()).toEqual(stackedAt);
    await trend.press("Escape");
    await trend.blur();
    await expect(hud.locator(".sb-hud-latest")).toBeVisible();
    const box = (await trend.boundingBox())!;
    const range = await frame.getByRole("button", { name: /^Date range: / }).textContent();
    const finger = await workbench.context().newCDPSession(workbench);
    const touchAt = (type: string, fraction: number) =>
      finger.send("Input.dispatchTouchEvent", {
        type,
        touchPoints:
          type === "touchEnd"
            ? []
            : [{ x: box.x + box.width * fraction, y: box.y + box.height * 0.5 }],
      });
    await touchAt("touchStart", 0.3);
    for (const fraction of [0.35, 0.45, 0.55, 0.65]) await touchAt("touchMove", fraction);
    await touchAt("touchEnd", 0.65);
    await expect(hud.locator(".sb-hud-latest")).toBeHidden();
    await expect(frame.locator(".sb-crosshair line")).toHaveCount(1);
    await expect(frame.getByRole("button", { name: /^Date range: / })).toHaveText(range!);
    await expect(frame.getByRole("button", { name: /^Back to / })).toBeHidden();
    const outsideFirst = (await frame.locator("#observation-count").boundingBox())!;
    await workbench.touchscreen.tap(outsideFirst.x + 4, outsideFirst.y + 4);
    await expect(hud.locator(".sb-hud-latest")).toBeVisible();
    await workbench.touchscreen.tap(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await expect(hud.locator(".sb-hud-latest")).toBeHidden();
    await expect(frame.locator(".sb-crosshair line")).toHaveCount(1);
    await expect(frame.locator(".sb-marker").first()).toBeVisible();
    await workbench.touchscreen.tap(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await expect(hud.locator(".sb-hud-latest")).toBeVisible();
    await workbench.touchscreen.tap(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await expect(hud.locator(".sb-hud-latest")).toBeHidden();
    const outside = (await frame.locator("#observation-count").boundingBox())!;
    await workbench.touchscreen.tap(outside.x + 4, outside.y + 4);
    await expect(hud.locator(".sb-hud-latest")).toBeVisible();
    await frame.getByRole("button", { name: "Right axis: Trading volume" }).click();
    await frame.getByRole("button", { name: "Week", exact: true }).click();
    await frame.getByRole("button", { name: "MA 30" }).click();
    await expect(hud).toContainText("MA30");
    await expect(hud).toContainText("Σ");
    const widest = await frame
      .locator("html")
      .evaluate((root) => root.scrollWidth - root.clientWidth);
    expect(widest).toBeLessThanOrEqual(0);
    const hudBox = (await hud.boundingBox())!;
    expect(hudBox.x + hudBox.width).toBeLessThanOrEqual(390);
    const clipped = await hud
      .locator(".sb-hud-extra, .sb-hud-ohlc, .sb-hud-name span")
      .evaluateAll((cells) =>
        cells.filter((cell) => cell.scrollWidth > cell.clientWidth).map((cell) => cell.textContent),
      );
    expect(clipped).toEqual([]);
    const secondName = hud.locator(".sb-hud-name").nth(1);
    await trend.focus();
    await trend.press("End");
    const filledTop = (await secondName.boundingBox())!.y;
    await trend.press("Home");
    await expect(hud.locator(".sb-hud-mean").first()).toContainText("–");
    expect((await secondName.boundingBox())!.y).toBe(filledTop);
    await trend.press("Escape");
    await trend.blur();
    await frame.getByRole("button", { name: "Notes", exact: true }).click();
    await expect(drawer).toBeVisible();
    await frame.getByRole("button", { name: "Done" }).click();
    await expect(drawer).toBeHidden();
    await workbench.screenshot({
      path: info.outputPath("signalbook-mobile.png"),
      animations: "disabled",
    });
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
    await invoke("setReportLink", { id, grant: link.grantId, version: 0 });
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
    await expect(frame.getByRole("group", { name: /^Temperature rollups/ })).toBeVisible();
    await frame.getByRole("button", { name: "MA 7" }).click();
    await expect(frame.getByRole("button", { name: "MA 7" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(frame.getByRole("table")).toContainText("Temperature");
    await guest.screenshot({ path: info.outputPath("signalbook-report.png"), fullPage: true });
    await invoke("setReportLink", { id, grant: null, version: 1 });
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
