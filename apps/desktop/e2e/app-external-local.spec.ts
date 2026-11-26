import { expect, test, type Locator, type Page } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import type { OwnerAppPublicationRequest } from "@dohc/cli/app-publication";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activityPin, desktopPins, settingsNavPin, settingsSectionPin } from "../src/testPins";
import { waitForVisibleAnimations } from "./helpers/animations";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openExplorerHome,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

const SECRET = "phx_e2e_outside_call_secret_4242";
const SHOT_DIR = process.env.DOHC_PROOF_SCREENSHOT_DIR ?? "";

const manifest = (path: string) =>
  JSON.stringify({
    entryPath: "main.ts",
    inputs: ["main.ts"],
    packageMap: {},
    external: {
      recentEvents: {
        method: "GET",
        url: `https://us.posthog.com/api/projects/{{project}}/${path}/`,
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
    out.textContent = JSON.stringify(results);
  };
  port.start();
  call("events", { op: "backend.external", operation: "recentEvents", input: { project: 42 } });
  call("undeclared", { op: "backend.external", operation: "deleteProject", input: {} });
  call("badInput", { op: "backend.external", operation: "recentEvents", input: { project: "42/../admin" } });
  call("extraKey", {
    op: "backend.external",
    operation: "recentEvents",
    input: { project: 42 },
    url: "https://evil.example/",
  });
});
`;

type Received = { method: string; path: string; headers: IncomingHttpHeaders };

async function startService() {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    received.push({ method: request.method!, path: request.url!, headers: request.headers });
    response.writeHead(request.url === "/api/projects/42/events/" ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(
      request.url === "/api/projects/42/events/"
        ? JSON.stringify({ results: [{ event: "signup", count: 3 }] })
        : JSON.stringify({ detail: "Not found" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const publish = (page: Page, request: OwnerAppPublicationRequest) =>
  page.evaluate((input) => window.dohcDesktop!.publishOwnerApp(input), request);

async function shoot(page: Page, target: Locator, name: string) {
  if (!SHOT_DIR) return;
  await mkdir(SHOT_DIR, { recursive: true });
  await page.mouse.move(0, 0);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await waitForVisibleAnimations(page);
    await target.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
}

async function runApp(page: Page, url: string, bodies: string[]) {
  page.on("response", async (response) => {
    try {
      bodies.push(await response.text());
    } catch {}
  });
  await page.goto(url);
  const out = page.frameLocator("iframe").locator("#out");
  await expect
    .poll(async () => Object.keys(JSON.parse((await out.textContent()) || "{}")).length, {
      timeout: 30_000,
    })
    .toBe(4);
  return JSON.parse((await out.textContent())!) as Record<
    string,
    { ok: boolean; status?: number; value?: unknown; error?: { code: string } }
  >;
}

test("@app-external-local an approved app calls its declared service with a secret it never sees", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const service = await startService();
  const workspace = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  const context = await browser.newContext();
  try {
    await writeWorkspaceFiles(workspace, [
      { path: "stats/app.publish.json", contents: manifest("events") },
      { path: "stats/main.ts", contents: main },
    ]);
    desktop = await launchDesktopApp({
      workspace,
      env: { DOHC_TEST_APP_EXTERNAL_ORIGIN: service.origin },
    });
    const { page } = desktop;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, workspace);
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
    await expect(page.getByTestId(desktopPins.settingsDialog)).toHaveCount(0);

    const agent = sendCliRequest(
      {
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "appPublication",
        args: {
          cwd: workspace.rootPath,
          actor: "agent",
          request: { action: "prepareLocal", workspaceId, appRoot: "stats" },
        },
      },
      { stateDir: workspace.homeDir },
    );
    await expect(agent).rejects.toThrow("Approve it in the dohc window");

    await openExplorerHome(page);
    await page.locator('[data-testid="sites-row"][data-root="stats"]').click();
    await page
      .getByTestId("site-preview-page")
      .getByRole("button", { name: "Review and open app", exact: true })
      .click();
    const dialog = page.getByTestId("app-publication-dialog");
    const call = dialog.getByTestId("app-access-external");
    await expect(call).toContainText("us.posthog.com");
    await expect(call).toContainText("GET /api/projects/{project}/events/");
    await expect(call).toContainText("POSTHOG_KEY");
    await expect(call).toContainText("Only you");
    await expect(call).toContainText("This computer");
    await expect(dialog.getByTestId("app-access")).not.toContainText(SECRET);
    await shoot(page, dialog.getByTestId("app-access"), "outside-call-review");
    await dialog.getByTestId("app-publication-approve").click();
    await expect(dialog).toBeHidden();

    const listed = await publish(page, { action: "listLocal", workspaceId, appRoot: "stats" });
    if (listed.kind !== "localListed") throw new Error("Expected the approved app.");
    const publicationId = listed.publications[0]!.publicationId;
    const launch = async () => {
      const launched = await publish(page, { action: "launchLocal", workspaceId, publicationId });
      if (launched.kind !== "localLaunched") throw new Error("Expected a loopback launch.");
      return launched.url;
    };

    const bodies: string[] = [];
    const results = await runApp(await context.newPage(), await launch(), bodies);
    expect(results.events).toMatchObject({
      ok: true,
      value: { status: 200, data: { results: [{ event: "signup", count: 3 }] } },
    });
    expect(results.undeclared).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "external_not_approved" },
    });
    expect(results.badInput).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "external_input" },
    });
    expect(results.extraKey).toMatchObject({ ok: false, status: 400 });
    const declared = expect.objectContaining({
      method: "GET",
      path: "/api/projects/42/events/",
      headers: expect.objectContaining({
        authorization: `Bearer ${SECRET}`,
        "x-dohc-test-host": "us.posthog.com",
      }),
    });
    expect(service.received.length).toBeGreaterThan(0);
    expect(service.received).toEqual(service.received.map(() => declared));
    const before = service.received.length;
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toContain(SECRET);

    await writeFile(join(workspace.rootPath, "stats/app.publish.json"), manifest("persons"));
    await expect
      .poll(async () => {
        const checked = await publish(page, {
          action: "checkLocal",
          workspaceId,
          appRoot: "stats",
        });
        return checked.kind === "localChecked" ? checked.sourceRevision : null;
      })
      .not.toBe(listed.publications[0]!.sourceRevision);
    await runApp(await context.newPage(), await launch(), bodies);
    expect(service.received.length).toBeGreaterThan(before);
    expect(service.received).toEqual(service.received.map(() => declared));

    await page.getByTestId("app-view-review").filter({ visible: true }).click();
    await expect(dialog.getByTestId("app-access-external")).toContainText("Changed");
    await expect(dialog.getByTestId("app-access-external")).toContainText(
      "GET /api/projects/{project}/persons/",
    );
    await shoot(page, dialog.getByTestId("app-access"), "outside-call-changed");
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await context.close();
    await cleanupDesktopWorkspace(desktop, workspace);
    await service.close();
  }
});
