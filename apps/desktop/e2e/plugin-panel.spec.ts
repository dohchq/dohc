import { expect, test } from "@playwright/test";
import { cp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  seedWorkspaceSettings,
} from "./helpers/workspace";

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
    };
    close(): void;
  };
};

interface PluginWriteMoment {
  text: string;
  authorJson: string;
}

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/hello-plugin/", import.meta.url),
);
const pluginRoot = "plugins/hello-plugin";
const outputPath = "hello-plugin-panel-output.txt";

function readPluginWriteMoment(
  workspaceRoot: string,
): PluginWriteMoment | null {
  let database: InstanceType<typeof DatabaseSync>;
  try {
    database = new DatabaseSync(
      join(workspaceRoot, ".dohc/engine/engine.db"),
      { readOnly: true },
    );
  } catch {
    return null;
  }
  try {
    const row = database
      .prepare(
        `SELECT b.text AS text, m.author_json AS authorJson
         FROM moments m
         JOIN blobs b ON b.sha256 = m.payload_after_blob_sha256
         WHERE m.path = ? AND m.operation = 'write'
         ORDER BY m.moment_order DESC
         LIMIT 1`,
      )
      .get(outputPath);
    return row &&
      typeof row.text === "string" &&
      typeof row.authorJson === "string"
      ? { text: row.text, authorJson: row.authorJson }
      : null;
  } finally {
    database.close();
  }
}

test("plugin panel crosses the utility process, iframe SDK, and attributed write boundaries", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, "plugin-panel-e2e");
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await cp(fixtureRoot, join(temp.rootPath, pluginRoot), { recursive: true });

    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;

    const opened = await page.evaluate(
      async ({ workspaceId, root }) => {
        const api = (window as unknown as {
          dohcDesktop: {
            openPluginPanel(payload: {
              workspaceId: string;
              pluginRoot: string;
              pluginId: string;
              panelId: string;
            }): Promise<{ pluginId: string; panelId: string }>;
          };
        }).dohcDesktop;
        return api.openPluginPanel({
          workspaceId,
          pluginRoot: root,
          pluginId: "hello-plugin",
          panelId: "main",
        });
      },
      { workspaceId: workspace.workspaceId, root: pluginRoot },
    );
    expect(opened).toEqual({ pluginId: "hello-plugin", panelId: "main" });

    await expect
      .poll(() =>
        desktop!.app.evaluate(({ app }) =>
          app
            .getAppMetrics()
            .find((metric) => metric.name === "dohc-plugin-host") ?? null,
        ),
      )
      .not.toBeNull();
    const utilityMetrics = await desktop.app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .filter((metric) => metric.name === "dohc-plugin-host")
        .map(({ name, pid, type }) => ({ name, pid, type })),
    );
    expect(utilityMetrics).toHaveLength(1);
    expect(utilityMetrics[0]).toMatchObject({
      name: "dohc-plugin-host",
      type: "Utility",
    });
    expect(utilityMetrics[0]?.pid).not.toBe(desktop.app.process().pid);

    const tab = page.getByTestId("tab-dohc://plugin-panel/hello-plugin/main");
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute("data-active", "true");

    const panel = page.frameLocator('[data-testid="plugin-panel-frame"]');
    await expect(
      panel.getByRole("heading", { name: "Hello Plugin" }),
    ).toBeVisible();
    await expect(panel.getByTestId("sdk-capabilities")).toContainText(
      '"write":true',
    );
    await expect(panel.getByTestId("sdk-write-result")).toHaveText(
      JSON.stringify({ path: outputPath }),
    );
    await expect(panel.getByTestId("sdk-error")).toHaveCount(1);
    await expect(panel.getByTestId("sdk-error")).toBeHidden();

    await expect
      .poll(() =>
        readFile(join(temp.rootPath, outputPath), "utf8").catch(() => null),
      )
      .toBe("Hello from the plugin panel\n");
    await expect
      .poll(() => readPluginWriteMoment(temp.rootPath))
      .not.toBeNull();
    const moment = readPluginWriteMoment(temp.rootPath);
    expect(moment?.text).toBe("Hello from the plugin panel\n");
    const author = JSON.parse(moment?.authorJson ?? "null") as {
      kind?: unknown;
      agentId?: unknown;
      onBehalfOf?: unknown;
      agentRunId?: unknown;
    } | null;
    expect(author).toMatchObject({
      kind: "agent",
      agentId: "plugin:hello-plugin",
      onBehalfOf: "local",
    });
    expect(author?.agentRunId).toEqual(expect.any(String));
    expect((author?.agentRunId as string).length).toBeGreaterThan(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
