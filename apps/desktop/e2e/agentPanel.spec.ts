import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./launch";

const fakeAgent = join(process.cwd(), "apps/desktop/e2e/fixtures/fakeAgentProcess.mjs");

async function seedWorkspace(workspaceId: string): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-agent-panel-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-agent-panel-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId, kind: "personal", mode: "local-first" }),
  );
  await writeFile(join(root, "notes", "brief.md"), "# Brief\n");
  return { home, root };
}

function fakeAgentEnv() {
  return {
    DOHC_AGENT_CODEX_COMMAND: process.execPath,
    DOHC_AGENT_CODEX_ARGS_JSON: JSON.stringify([fakeAgent, "codex"]),
    DOHC_AGENT_GENERIC_ACP_COMMAND: process.execPath,
    DOHC_AGENT_GENERIC_ACP_ARGS_JSON: JSON.stringify([fakeAgent, "acp"]),
  };
}

function historyRecords(root: string): Array<{ author?: { kind?: string }; files?: Array<{ path: string }> }> {
  const historyDir = join(root, ".dohc", "history");
  if (!existsSync(historyDir)) return [];
  return readdirSync(historyDir)
    .filter((name) => name.endsWith(".json") && name !== "index.json")
    .map((name) => JSON.parse(readFileSync(join(historyDir, name), "utf8")));
}

test("agent panel runs fake Codex and ACP sessions with permissions and attributed file writes", async () => {
  test.setTimeout(120_000);
  const { home, root } = await seedWorkspace("agent-panel-ws");
  const app = await launchApp({
    DOHC_TEST_HOME: home,
    DOHC_TEST_PICK_PATH: root,
    ...fakeAgentEnv(),
  });
  const page = await app.firstWindow();

  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toHaveAttribute("data-ready", "true");

  // The activity item is a toggle when Agent is already the active view.
  // Converge on an open panel without toggling during lazy-load.
  if (!(await page.getByTestId("agent-panel").isVisible())) {
    await page.getByTestId("activity-agent").click();
  }
  await expect(page.getByTestId("agent-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-panel-status")).toHaveAttribute(
    "data-state",
    "stopped",
  );
  await expect(page.getByTestId("agent-driver-row")).toHaveCount(3, { timeout: 15_000 });

  const driverIds = await page
    .getByTestId("agent-driver-row")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-driver-id")));
  expect(driverIds).toEqual(["codex-app-server", "claude-acp", "generic-acp"]);
  await expect(page.getByTestId("agent-driver-row").filter({ hasText: "Codex" })).toContainText(
    "fake-codex",
  );
  await expect(
    page.getByTestId("agent-driver-row").filter({ hasText: "Generic ACP" }),
  ).toContainText("fake-acp");

  const snippet = page.getByTestId("agent-mcp-config");
  await expect(snippet).toContainText("--workspace");
  await expect(snippet).toContainText(root);
  await expect(snippet).toContainText("--home");
  await expect(snippet).toContainText(home);

  await page.getByTestId("agent-prompt-input").fill("Create the Codex note");
  await page.getByTestId("agent-run-toggle").click();
  await expect(page.getByTestId("agent-panel-status")).toHaveAttribute(
    "data-state",
    "waiting-permission",
  );
  await expect(page.getByTestId("agent-run-indicator")).toBeVisible();
  await expect(page.getByTestId("agent-permission-request")).toContainText(
    "write notes/codex-output.md",
  );
  await page.getByTestId("agent-permission-allow_once").click();
  await expect(page.getByTestId("agent-panel-status")).toHaveAttribute(
    "data-state",
    "completed",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("agent-stream")).toContainText("Codex fake");
  await expect(page.getByTestId("agent-auth-notice").filter({ hasText: "Codex CLI" })).toBeVisible();
  await expect
    .poll(() => existsSync(join(root, "notes", "codex-output.md")), { timeout: 10_000 })
    .toBe(true);

  await page.getByTestId("agent-driver-picker").selectOption("generic-acp");
  await page.getByTestId("agent-prompt-input").fill("Create the ACP note");
  await page.getByTestId("agent-run-toggle").click();
  await expect(page.getByTestId("agent-panel-status")).toHaveAttribute(
    "data-state",
    "waiting-permission",
  );
  await expect(page.getByTestId("agent-permission-request")).toContainText(
    "Write notes/agent-output.md",
  );
  await page.getByTestId("agent-permission-allow_once").click();
  await expect(page.getByTestId("agent-panel-status")).toHaveAttribute(
    "data-state",
    "completed",
    { timeout: 15_000 },
  );
  await expect
    .poll(() => existsSync(join(root, "notes", "agent-output.md")), { timeout: 10_000 })
    .toBe(true);

  await expect
    .poll(
      () =>
        historyRecords(root)
          .filter((record) => record.author?.kind === "agent")
          .flatMap((record) => record.files?.map((file) => file.path) ?? []),
      { timeout: 20_000 },
    )
    .toEqual(expect.arrayContaining(["notes/codex-output.md", "notes/agent-output.md"]));

  await expect
    .poll(() => {
      const runs = JSON.parse(readFileSync(join(root, ".dohc", "agent-runs.json"), "utf8"));
      return runs.at(-1)?.status;
    })
    .toBe("complete");

  await app.close();
});
