import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { waitForVisibleAnimations } from "./helpers/animations";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  showExplorerFiles,
  writeWorkspaceFiles,
  type TempWorkspace,
} from "./helpers/workspace";

const SHOT_DIR = process.env.PR2_SHOT_DIR ?? "";
const OWNER = "http-step-e2e-owner";
const SYNCED_WORKSPACE_ID = "ws-http-step-synced-e2e";
const COLLECTION_YAML = `name: Tasks
fields:
  Title: {type: text}
  Status: {type: select, options: [Todo, Done]}
  Notify: {type: button}
`;

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, theme);
  await waitForVisibleAnimations(page);
}

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (SHOT_DIR === "") return;
  await mkdir(SHOT_DIR, { recursive: true });
  await page.mouse.move(0, 0);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...(await collectFiles(full)));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

async function assertNotInWorkspaceFolder(rootPath: string, needles: readonly string[]) {
  const files = await collectFiles(rootPath);
  for (const file of files) {
    const bytes = await readFile(file);
    for (const needle of needles) {
      expect(bytes.includes(Buffer.from(needle, "utf8")), `${file} must not contain secret`).toBe(
        false,
      );
    }
  }
}

async function openTasksAutomations(page: Page): Promise<Locator> {
  await showExplorerFiles(page);
  const row = page.locator('[data-testid="tree-row"][data-path="Tasks"]');
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  const actionsButton = page.getByRole("button", { name: "Collection actions", exact: true });
  await expect(actionsButton).toBeVisible({ timeout: 60_000 });
  const directButton = page.getByTestId("collection-automations-button");
  if (await directButton.isVisible()) {
    await directButton.click();
  } else {
    await actionsButton.click();
    await page.getByRole("menuitem", { name: /^Automations\b/ }).click();
  }
  const panel = page.getByTestId("collection-automations-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

async function addHeaderSecret(
  page: Page,
  name: string,
  host: string,
  value: string,
): Promise<void> {
  await page.getByTestId(activityPin("settings")).click();
  await expect(page.getByTestId(desktopPins.settingsDialog)).toBeVisible();
  await page.getByTestId(settingsNavPin("secrets")).click();
  const section = page.getByTestId(settingsSectionPin("secrets"));
  await expect(section).toBeVisible();
  await section.getByTestId("workspace-secrets-add").click();
  const editor = page.getByTestId("workspace-secret-editor-dialog");
  await editor.getByTestId("workspace-secret-name-input").fill(name);
  await editor.getByTestId("workspace-secret-hosts-input").fill(host);
  await editor.getByTestId("workspace-secret-value-input").fill(value);
  await editor.getByTestId("workspace-secret-save").click();
  await expect(editor).toHaveCount(0);
  await expect(section.getByTestId(`workspace-secret-row-${name}`)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(desktopPins.settingsDialog)).toHaveCount(0);
}

test("builds, holds, approves on relay, checks share impact, and preserves outbound webhook approval across restart", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  let relay: SyncRelayHandle | undefined;
  const headerSecretValue = "re_live_http_e2e_secret_777";

  try {
    relay = await spawnSyncRelay({
      dbPath: join(temp.baseDir, "relay", "relay.sqlite"),
      linkBoundary: {
        linkKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        relayExchangeKey: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        publicViewerOrigin: "https://share.dohc.test",
      },
    });
    await writeWorkspaceFiles(temp, [{ path: "Tasks/collection.yaml", contents: COLLECTION_YAML }]);
    await seedWorkspaceManifest(temp, SYNCED_WORKSPACE_ID);
    await seedWorkspaceRegistry(temp, [
      {
        workspaceId: SYNCED_WORKSPACE_ID,
        rootPath: temp.rootPath,
      },
    ]);
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: "http-step-e2e-owner@dohc.test",
      userId: OWNER,
      token: `test:${OWNER}`,
    });

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await page.evaluate(
      async (workspaceId) =>
        (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.cloudEnableSync({
          workspaceId,
        }),
      SYNCED_WORKSPACE_ID,
    );

    await expect
      .poll(
        async () => {
          const response = await fetch(
            `${relay!.baseUrl}/sync/${encodeURIComponent(SYNCED_WORKSPACE_ID)}/secrets`,
            { headers: { authorization: `Bearer test:${OWNER}` } },
          );
          return response.status;
        },
        { timeout: 30_000 },
      )
      .toBe(200);

    const panel = await openTasksAutomations(page);
    await panel.getByRole("button", { name: "New automation" }).click();
    await panel.getByLabel("Name").fill("Notify on new task");
    await panel.getByLabel("Trigger").selectOption("record-added");
    await panel.getByRole("button", { name: "Send a webhook" }).click();

    await panel.getByLabel("Step 2, webhook URL").fill("https://api.resend.com/emails");
    await panel.getByRole("button", { name: "Add header", exact: true }).click();
    await panel.getByLabel("Step 2, header 1 name", { exact: true }).fill("X-Source");
    await panel.getByLabel("Step 2, header 1 value", { exact: true }).fill("dohc");
    await panel.getByRole("button", { name: "Add API key header", exact: true }).click();
    await expect(panel.getByLabel("Step 2, secret header 1 secret", { exact: true })).toHaveValue(
      "",
    );
    await panel.getByRole("button", { name: "New API key", exact: true }).click();
    const editor = page.getByTestId("workspace-secret-editor-dialog");
    await expect(editor.getByTestId("workspace-secret-hosts-input")).toHaveValue("api.resend.com");
    await editor.getByTestId("workspace-secret-name-input").fill("RESEND_API_KEY");
    await editor.getByTestId("workspace-secret-value-input").fill(headerSecretValue);
    await shoot(page, editor, "secrets-add-from-builder");
    await editor.getByTestId("workspace-secret-save").click();
    await expect(editor).toHaveCount(0);
    await expect(panel.getByLabel("Step 2, secret header 1 secret", { exact: true })).toHaveValue(
      "RESEND_API_KEY",
    );
    await expect(panel.getByLabel("Name")).toHaveValue("Notify on new task");
    await panel.getByLabel("Step 2, body type", { exact: true }).selectOption("json");
    await shoot(page, panel, "pr2-http-builder");

    await panel.getByRole("button", { name: "Save", exact: true }).click();
    const row = panel.getByTestId("automation-notify-on-new-task");
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(
      "This step sends a webhook to api.resend.com with secret RESEND_API_KEY in its Authorization header and a JSON body with title. Sent requests cannot be undone. Allow it before dohc sends requests there.",
    );
    await expect(row.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    await shoot(page, panel, "pr2-http-held");

    const yamlText = await readFile(join(temp.rootPath, "Tasks", "automations.yaml"), "utf8");
    expect(yamlText).toContain("https://api.resend.com/emails");
    expect(yamlText).toContain("RESEND_API_KEY");
    expect(yamlText).not.toContain(headerSecretValue);

    await row.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(row.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(row).not.toContainText("Allow it before dohc sends requests there.");

    const db = new DatabaseSync(relay.dbPath, { readOnly: true });
    let approvalDigest = "";
    try {
      const rows = db
        .prepare(
          "SELECT automation_id, step_ordinal, approval_digest FROM sync_relay_http_approvals WHERE workspace_id = ?",
        )
        .all(SYNCED_WORKSPACE_ID) as Array<{
        automation_id: string;
        step_ordinal: number;
        approval_digest: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.automation_id).toContain("notify-on-new-task");
      expect(rows[0]!.step_ordinal).toBe(1);
      expect(rows[0]!.approval_digest).toMatch(/^[0-9a-f]{64}$/u);
      approvalDigest = rows[0]!.approval_digest;
    } finally {
      db.close();
    }

    await assertNotInWorkspaceFolder(temp.rootPath, [headerSecretValue]);
    const workspaceFiles = await collectFiles(temp.rootPath);
    expect(workspaceFiles.some((file) => file.includes("http-approvals"))).toBe(false);
    expect(approvalDigest).toMatch(/^[0-9a-f]{64}$/u);

    const impact = await page.evaluate(
      async (workspaceId) =>
        (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.automationShareImpact(
          {
            workspaceId,
            recipientEmail: "collab@dohc.test",
            paths: ["Tasks"],
            access: "edit",
          },
        ),
      SYNCED_WORKSPACE_ID,
    );
    expect(impact.stops.some((stop) => stop.action === "send-http")).toBe(true);

    await desktop.close();
    desktop = await launchDesktopApp({ workspace: temp });
    const reopened = desktop.page;
    await openWorkspaceFromFirstRun(reopened, temp);
    const reopenedPanel = await openTasksAutomations(reopened);
    const reopenedRow = reopenedPanel.getByTestId("automation-notify-on-new-task");
    await expect(reopenedRow).toBeVisible({ timeout: 30_000 });
    await expect(reopenedRow).not.toContainText("Allow it before dohc sends requests there.");
    await expect(reopenedRow.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0);
  } finally {
    try {
      if (desktop) await desktop.close();
    } finally {
      await relay?.stop();
      await temp.cleanup();
    }
  }
});

test("holds local-only webhook steps, stores approval outside the workspace, and survives restart", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  const localWorkspaceId = "ws-http-step-local-e2e";

  try {
    await seedWorkspaceManifest(temp, localWorkspaceId);
    await writeWorkspaceFiles(temp, [
      { path: "Tasks/collection.yaml", contents: COLLECTION_YAML },
      {
        path: "Tasks/automations.yaml",
        contents: `version: 1
automations:
  - id: ping-hook
    name: Ping hook
    when: record-added
    do:
      - http: https://api.example.com/hook
`,
      },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    const panel = await openTasksAutomations(page);
    const row = panel.getByTestId("automation-ping-hook");
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(
      "This step sends a webhook to api.example.com. Sent requests cannot be undone. Allow it before dohc sends requests there.",
    );
    await row.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(row.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0, {
      timeout: 30_000,
    });

    const approvalFiles = await readdir(join(temp.homeDir, "http-approvals"));
    expect(approvalFiles.some((name) => name.endsWith(".json"))).toBe(true);
    const workspaceFiles = await collectFiles(temp.rootPath);
    expect(workspaceFiles.some((file) => file.includes("http-approvals"))).toBe(false);

    await desktop.close();
    desktop = await launchDesktopApp({ workspace: temp });
    const reopened = desktop.page;
    await openWorkspaceFromFirstRun(reopened, temp);
    const reopenedPanel = await openTasksAutomations(reopened);
    const reopenedRow = reopenedPanel.getByTestId("automation-ping-hook");
    await expect(reopenedRow).toBeVisible({ timeout: 30_000 });
    await expect(reopenedRow).not.toContainText("Allow it before dohc sends requests there.");
    await expect(reopenedRow.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

const FETCH_WORKSPACE_ID = "ws-http-fetch-local-e2e";
const FETCH_TOKEN = "dohc_e2e_bearer_token_4242";
const FETCH_COLLECTION_YAML = `name: Checks
fields:
  Title: {type: text}
  Authenticated: {type: checkbox}
  Token: {type: text}
`;
const fetchAutomations = (mapping: string) => `version: 1
automations:
  - id: pull-bearer
    name: Pull bearer check
    when: record-added
    do:
      - http: https://httpbin.org/bearer
        method: GET
        secret-headers:
          Authorization: { secret: HTTPBIN_TOKEN, prefix: "Bearer " }
        as: check
      - set:
${mapping}
  - id: wrong-host
    name: Wrong host
    when: record-added
    do:
      - http: https://postman-echo.com/get
        method: GET
        secret-headers:
          Authorization: { secret: HTTPBIN_TOKEN, prefix: "Bearer " }
        as: echo
      - set:
          Title: =echo.url
`;
const FETCH_AUTOMATIONS = fetchAutomations(
  "          Authenticated: =check.authenticated\n          Token: =check.token",
);

async function openChecksAutomations(page: Page): Promise<Locator> {
  await showExplorerFiles(page);
  const row = page.locator('[data-testid="tree-row"][data-path="Checks"]');
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  await page.getByTestId("collection-automations-button").click();
  const panel = page.getByTestId("collection-automations-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

async function allowStep(row: Locator): Promise<void> {
  await row.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(row.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
}

async function seedFetchWorkspace(temp: TempWorkspace): Promise<void> {
  await seedWorkspaceManifest(temp, FETCH_WORKSPACE_ID);
  await writeWorkspaceFiles(temp, [
    { path: "Checks/collection.yaml", contents: FETCH_COLLECTION_YAML },
    { path: "Checks/automations.yaml", contents: FETCH_AUTOMATIONS },
  ]);
}

async function checkRecords(page: Page): Promise<Array<Record<string, unknown>>> {
  const { records } = await page.evaluate(
    async (input) =>
      (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.queryCollectionRecords(
        input,
      ),
    { workspaceId: FETCH_WORKSPACE_ID, collectionPath: "Checks" },
  );
  return records.map((record) =>
    Object.fromEntries(record.values.map(({ field, value }) => [field, value])),
  );
}

async function addCheck(page: Page, name: string): Promise<void> {
  await page.evaluate(
    async (input) =>
      (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.createCollectionRecord(
        input,
      ),
    { workspaceId: FETCH_WORKSPACE_ID, collectionPath: "Checks", name },
  );
}

test("holds a GET fetch with plain copy, holds it again after an edit, and keeps the approval across restart", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  try {
    await seedFetchWorkspace(temp);
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await addHeaderSecret(desktop.page, "HTTPBIN_TOKEN", "httpbin.org", FETCH_TOKEN);

    const panel = await openChecksAutomations(desktop.page);
    const row = panel.getByTestId("automation-pull-bearer");
    await expect(row).toContainText(
      "This step fetches data from httpbin.org with secret HTTPBIN_TOKEN in its Authorization header, and saves the answer as check. Later steps write Authenticated and Token from it. Allow it before dohc sends requests there.",
      { timeout: 30_000 },
    );
    await shoot(desktop.page, panel, "fetch-held");
    await allowStep(row);

    await writeFile(
      join(temp.rootPath, "Checks", "automations.yaml"),
      fetchAutomations("          Token: =check.token"),
    );
    await expect(row).toContainText(
      "This step fetches data from httpbin.org with secret HTTPBIN_TOKEN in its Authorization header, and saves the answer as check. Later steps write Token from it. Allow it before dohc sends requests there.",
      { timeout: 30_000 },
    );
    await allowStep(row);

    await assertNotInWorkspaceFolder(temp.rootPath, [FETCH_TOKEN]);
    await desktop.close();
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    const reopened = (await openChecksAutomations(desktop.page)).getByTestId(
      "automation-pull-bearer",
    );
    await expect(reopened).toBeVisible({ timeout: 30_000 });
    await expect(reopened).not.toContainText("Allow it before dohc sends requests there.");

    const builder = desktop.page.getByTestId("collection-automations-panel");
    await builder.getByRole("button", { name: "New automation" }).click();
    await builder.getByLabel("Name").fill("Pull pageviews");
    await builder.getByLabel("Trigger").selectOption("record-added");
    await builder.getByRole("button", { name: "Send a webhook" }).click();
    await builder.getByLabel("Step 2, method", { exact: true }).selectOption("GET");
    await expect(builder.getByLabel("Step 2, body type", { exact: true })).toHaveCount(0);
    await builder.getByLabel("Step 2, webhook URL").fill("https://httpbin.org/bearer");
    await builder.getByRole("button", { name: "Add secret header", exact: true }).click();
    await builder.getByLabel("Step 2, save the answer as", { exact: true }).fill("check");
    await expect(builder).toContainText("Fetch data");
    await shoot(desktop.page, builder, "fetch-builder");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("fetches authenticated JSON from a public API into a Collection with the secret scrubbed", async () => {
  test.skip(
    process.env.DOHC_E2E_PUBLIC_FETCH !== "1",
    "set DOHC_E2E_PUBLIC_FETCH=1 to fetch from httpbin.org and postman-echo.com",
  );
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  try {
    await seedFetchWorkspace(temp);
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await addHeaderSecret(desktop.page, "HTTPBIN_TOKEN", "httpbin.org", FETCH_TOKEN);
    const panel = await openChecksAutomations(desktop.page);
    await allowStep(panel.getByTestId("automation-pull-bearer"));
    await allowStep(panel.getByTestId("automation-wrong-host"));

    await addCheck(desktop.page, "First check");
    await expect
      .poll(() => checkRecords(desktop!.page), { timeout: 60_000 })
      .toEqual([{ Authenticated: true, Token: "[redacted]" }]);

    await waitForCliEndpoint(temp.homeDir);
    const wrongHost = await runDohcCli(temp, [
      "automation",
      "runs",
      "Checks",
      "wrong-host",
      "--json",
    ]);
    expect(wrongHost.stdout).toContain('is not allowed for host \\"postman-echo.com\\"');
    await shoot(desktop.page, panel, "fetch-ran");
    await assertNotInWorkspaceFolder(temp.rootPath, [FETCH_TOKEN]);

    await desktop.close();
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await addCheck(desktop.page, "Second check");
    await expect
      .poll(() => checkRecords(desktop!.page), { timeout: 60_000 })
      .toEqual([
        { Authenticated: true, Token: "[redacted]" },
        { Authenticated: true, Token: "[redacted]" },
      ]);
    await assertNotInWorkspaceFolder(temp.rootPath, [FETCH_TOKEN]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
