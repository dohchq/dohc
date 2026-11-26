import { expect, test, type Locator, type Page } from "@playwright/test";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { activityPin, settingsNavPin, settingsSectionPin } from "../src/testPins";
import { waitForVisibleAnimations } from "./helpers/animations";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import {
  openAppFromFolderLink,
  sharedDatasetViewerOrigin,
  startSharedDatasetBrowser,
} from "./helpers/sharedDatasetBrowser";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openExplorerHome,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

const SECRET = "phx_e2e_shared_outside_call_secret_9191";
const OWNER = "app-external-shared-owner";

const manifest = JSON.stringify({
  entryPath: "main.ts",
  inputs: ["main.ts"],
  packageMap: {},
  external: {
    recentEvents: {
      method: "GET",
      url: "https://us.posthog.com/api/projects/{{project}}/events/",
      params: { project: { type: "integer", min: 1, max: 99999 } },
      secret: { name: "POSTHOG_KEY", header: "Authorization", prefix: "Bearer " },
      access: "viewers",
    },
    deleteProject: {
      method: "POST",
      url: "https://us.posthog.com/api/projects/{{project}}/delete/",
      params: { project: { type: "integer", min: 1, max: 99999 } },
      secret: { name: "POSTHOG_KEY", header: "Authorization", prefix: "Bearer " },
    },
  },
});

const main = `
const out = document.createElement("pre");
out.id = "out";
document.body.append(out);
const results: Record<string, unknown> = {};
let port: MessagePort | undefined;
const call = (id: string, body: Record<string, unknown>) => port!.postMessage({ id, ...body });
addEventListener("message", (event) => {
  if (port || event.source !== parent || event.data?.kind !== "dohc-app-channel") return;
  port = event.ports[0]!;
  port.onmessage = (message) => {
    const data = message.data as { id?: string };
    if (!data.id) return;
    results[data.id] = data;
    out.textContent = JSON.stringify(results, null, 2);
  };
  port.start();
  call("events", { op: "backend.external", operation: "recentEvents", input: { project: 42 } });
  call("ownerOnly", { op: "backend.external", operation: "deleteProject", input: { project: 42 } });
});
`;

type Received = { method: string; path: string; headers: IncomingHttpHeaders };

async function startService() {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    received.push({ method: request.method!, path: request.url!, headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: [{ event: "signup", count: 3 }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function themed(page: Page, target: Locator, path: (theme: string) => string) {
  await page.mouse.move(0, 0);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await waitForVisibleAnimations(page);
    await target.screenshot({ path: path(theme) });
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
}

test("@app-external-shared a share-link visitor runs the app's approved outside call on the server", async ({}, info) => {
  test.setTimeout(240_000);
  const service = await startService();
  const workspace = await createTempWorkspace(),
    workspaceId = randomUUID();
  const exchangeKey = randomBytes(32).toString("base64url");
  let desktop: LaunchedDesktopApp | null = null;
  let relay: SyncRelayHandle | null = null;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | null = null;
  try {
    relay = await spawnSyncRelay({
      dbPath: join(workspace.baseDir, "relay", "relay.sqlite"),
      appPublications: true,
      linkBoundary: {
        linkKey: randomBytes(32).toString("base64url"),
        relayExchangeKey: exchangeKey,
        publicViewerOrigin: sharedDatasetViewerOrigin,
      },
      env: { DOHC_TEST_APP_EXTERNAL_ORIGIN: service.origin },
    });
    const claim = await fetch(`${relay.baseUrl}/sync/workspaces`, {
      method: "POST",
      headers: { authorization: `Bearer test:${OWNER}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    expect(claim.ok).toBe(true);
    await writeWorkspaceFiles(workspace, [
      { path: "stats/app.publish.json", contents: manifest },
      { path: "stats/main.ts", contents: main },
    ]);
    await seedWorkspaceManifest(workspace, workspaceId);
    await seedWorkspaceRegistry(workspace, [
      {
        workspaceId,
        rootPath: workspace.rootPath,
        remote: { serverUrl: relay.baseUrl, ownerUserId: OWNER },
      },
    ]);
    await seedCloudCredentials(workspace, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      userId: OWNER,
      token: `test:${OWNER}`,
    });
    shared = await startSharedDatasetBrowser({ relayUrl: relay.baseUrl, exchangeKey });
    desktop = await launchDesktopApp({
      workspace,
      env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" },
    });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, workspace);
    await waitForWorkspaceFile(page, workspaceId, "stats/app.publish.json");

    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("secrets")).click();
    const secrets = page.getByTestId(settingsSectionPin("secrets"));
    await secrets.getByTestId("workspace-secrets-add").click();
    const editor = page.getByTestId("workspace-secret-editor-dialog");
    await editor.getByTestId("workspace-secret-name-input").fill("POSTHOG_KEY");
    await editor.getByTestId("workspace-secret-hosts-input").fill("us.posthog.com");
    await editor.getByTestId("workspace-secret-value-input").fill(SECRET);
    await editor.getByTestId("workspace-secret-save").click();
    await expect(secrets.getByTestId("workspace-secret-row-POSTHOG_KEY")).toBeVisible();
    await page.keyboard.press("Escape");

    const review = async () => {
      await openExplorerHome(page);
      await page.locator('[data-testid="sites-row"][data-root="stats"]').click();
      await page
        .getByTestId("site-preview-page")
        .getByRole("button", { name: "Review and open app", exact: true })
        .click();
    };
    await review();
    const publication = page.getByTestId("app-publication-dialog");
    await publication.getByRole("button", { name: "Publish on a link", exact: true }).click();
    await publication.getByRole("button", { name: "Share app folder", exact: true }).click();
    const share = page.getByTestId("share-dialog");
    await share.getByRole("button", { name: "Create link", exact: true }).click();
    await share.getByRole("button", { name: "Link details", exact: true }).click();
    const linkUrl = (await share.getByTestId("share-link-url").textContent())!;
    expect(new URL(linkUrl).origin).toBe(sharedDatasetViewerOrigin);
    await share.getByRole("button", { name: "Close", exact: true }).click();
    if (!(await publication.isVisible())) await review();
    await publication.getByRole("button", { name: "Publish on a link", exact: true }).click();
    const shareLink = publication.getByRole("combobox", { name: "Publication share link" });
    await shareLink.selectOption({ index: 2 });
    await publication.getByRole("button", { name: "Prepare app", exact: true }).click();
    const calls = publication.getByTestId("app-publication-external");
    const row = (name: string) =>
      calls.getByTestId("app-access-external").filter({ hasText: name });
    await expect(row("recentEvents")).toContainText("GET /api/projects/{project}/events/");
    await expect(row("recentEvents")).toContainText("Anyone who can open the app");
    await expect(row("recentEvents")).toContainText("Your dohc server");
    await expect(row("deleteProject")).toContainText("Only you");
    await expect(calls).not.toContainText(SECRET);
    await themed(page, publication, (theme) =>
      info.outputPath(`shared-outside-call-review-${theme}.png`),
    );
    await publication.getByRole("button", { name: "Publish this revision", exact: true }).click();
    await expect(
      publication.getByRole("status").filter({ hasText: "App published on the selected link." }),
    ).toBeVisible();
    await publication.getByRole("button", { name: "Close", exact: true }).click();

    const guest = await shared.browser.newPage();
    guest.on("pageerror", (error) => shared!.failures.push(error.message));
    const bodies: string[] = [];
    guest.on("response", async (response) => {
      try {
        bodies.push(await response.text());
      } catch {}
    });
    await guest.goto(linkUrl);
    await openAppFromFolderLink(guest);
    const out = guest.frameLocator("iframe").locator("#out");
    await expect
      .poll(async () => Object.keys(JSON.parse((await out.textContent()) || "{}")).length, {
        timeout: 30_000,
      })
      .toBe(2);
    const results = JSON.parse((await out.textContent())!) as Record<string, unknown>;
    expect(results.events).toMatchObject({
      ok: true,
      value: { status: 200, data: { results: [{ event: "signup", count: 3 }] } },
    });
    expect(results.ownerOnly).toMatchObject({
      ok: false,
      error: { code: "external_not_approved" },
    });
    await guest.screenshot({ path: info.outputPath("shared-outside-call-visitor.png") });
    expect(service.received).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/api/projects/42/events/",
        headers: expect.objectContaining({
          authorization: `Bearer ${SECRET}`,
          "x-dohc-test-host": "us.posthog.com",
        }),
      }),
    ]);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toContain(SECRET);
    expect(shared.failures).toEqual([]);

    await review();
    const local = publication.getByTestId("app-access-external");
    await expect(local.filter({ hasText: "recentEvents" })).toContainText("Your dohc server");
    await themed(page, publication.getByTestId("app-access"), (theme) =>
      info.outputPath(`synced-outside-call-review-${theme}.png`),
    );
    await publication.getByTestId("app-publication-approve").click();
    await expect(publication).toBeHidden();
    await expect(page.getByTestId("app-view-webview")).toBeVisible({ timeout: 20_000 });
    const owned = desktop;
    await expect
      .poll(
        async () =>
          owned.app.evaluate(async ({ webContents }) => {
            const view = webContents
              .getAllWebContents()
              .find(
                (contents) =>
                  contents.getType() === "webview" &&
                  /^http:\/\/127\.0\.0\.1:\d+\/bootstrap(?:#|$)/.test(contents.getURL()),
              );
            const frame = view?.mainFrame.framesInSubtree.find(
              (entry) => entry.url === "about:srcdoc",
            );
            if (!frame) return {};
            return JSON.parse(
              (await frame.executeJavaScript(
                "document.getElementById('out')?.textContent || '{}'",
                true,
              )) as string,
            ) as Record<string, unknown>;
          }),
        { timeout: 30_000 },
      )
      .toMatchObject({
        events: { ok: true, value: { status: 200 } },
        ownerOnly: { ok: true, value: { status: 200 } },
      });
    await page.screenshot({ path: info.outputPath("synced-outside-call-app.png") });
    expect(service.received.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          path: "/api/projects/42/delete/",
          headers: expect.objectContaining({ authorization: `Bearer ${SECRET}` }),
        }),
      ]),
    );
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    try {
      await shared?.close();
    } finally {
      try {
        await relay?.stop();
      } finally {
        await cleanupDesktopWorkspace(desktop, workspace);
        await service.close();
      }
    }
  }
});
