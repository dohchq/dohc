import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./launch";

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

test("agent panel exposes drivers, MCP config, and persisted local run controls", async () => {
  const { home, root } = await seedWorkspace("agent-panel-ws");
  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  const page = await app.firstWindow();

  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toHaveAttribute("data-ready", "true");

  await page.getByTestId("activity-agent").click();
  await expect(page.getByTestId("agent-panel")).toBeVisible();
  await expect(page.getByTestId("agent-panel-status")).toHaveAttribute(
    "data-state",
    "stopped",
  );

  const driverIds = await page
    .getByTestId("agent-driver-row")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-driver-id")));
  expect(driverIds).toEqual(["codex-app-server", "claude-acp", "generic-acp"]);

  const snippet = page.getByTestId("agent-mcp-config");
  await expect(snippet).toContainText("--workspace");
  await expect(snippet).toContainText(root);
  await expect(snippet).toContainText("--home");
  await expect(snippet).toContainText(home);

  await page.getByTestId("agent-run-toggle").click();
  await expect(page.getByTestId("agent-panel-status")).toHaveAttribute(
    "data-state",
    "running",
  );
  await expect(page.getByTestId("agent-run-indicator")).toBeVisible();
  await expect
    .poll(() => existsSync(join(root, ".dohc", "agent-runs.json")), { timeout: 10_000 })
    .toBe(true);

  const runningRuns = JSON.parse(readFileSync(join(root, ".dohc", "agent-runs.json"), "utf8"));
  const runId = runningRuns.at(-1)?.id;
  expect(runningRuns.at(-1)).toMatchObject({ status: "running", agentId: "dohc-mcp" });

  await page.getByTestId("agent-run-toggle").click();
  await expect(page.getByTestId("agent-panel-status")).toHaveAttribute(
    "data-state",
    "stopped",
  );
  await expect(page.getByTestId("agent-run-indicator")).toHaveCount(0);
  await expect
    .poll(() => {
      const runs = JSON.parse(readFileSync(join(root, ".dohc", "agent-runs.json"), "utf8"));
      return runs.find((run: { id?: string }) => run.id === runId)?.status;
    })
    .toBe("complete");

  await app.close();
});
