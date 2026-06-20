import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import {
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test("@sites detects agent-created websites and previews static, dev, and build modes", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const repoRoot = resolve(desktopRoot, "../..");
  const viteBin = resolve(repoRoot, "node_modules/vite/bin/vite.js");
  const sdkEntry = resolve(repoRoot, "packages/sdk/src/index.ts");

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);

    await writeWorkspaceFiles(temp, [
      {
        path: "notes/today.md",
        contents: "Local data from dohc",
      },
      {
        path: "sdk-site/package.json",
        contents: JSON.stringify(
          {
            private: true,
            type: "module",
            scripts: {
              dev: `node ${JSON.stringify(viteBin)}`,
            },
            dependencies: {
              "@dohc/sdk": "workspace:*",
            },
            devDependencies: {
              vite: "0.0.0",
            },
          },
          null,
          2,
        ),
      },
      {
        path: "sdk-site/vite.config.mjs",
        contents: `export default { resolve: { alias: { "@dohc/sdk": ${JSON.stringify(sdkEntry)} } } };\n`,
      },
      {
        path: "sdk-site/dohc.json",
        contents: JSON.stringify(
          {
            type: "site",
            title: "SDK Site",
            preview: {
              mode: "dev",
              command: `node ${JSON.stringify(viteBin)} --host 127.0.0.1`,
            },
          },
          null,
          2,
        ),
      },
      {
        path: "sdk-site/index.html",
        contents:
          '<!doctype html><html><body><h1>SDK Site</h1><p id="sdk-output">Loading</p><script type="module" src="/src/main.ts"></script></body></html>',
      },
      {
        path: "sdk-site/src/main.ts",
        contents: [
          'import { dohc } from "@dohc/sdk";',
          'const output = document.getElementById("sdk-output");',
          "try {",
          '  const text = await dohc.files.read("notes/today.md");',
          '  if (output) output.textContent = `SDK says: ${text}`;',
          "} catch (error) {",
          '  if (output) output.textContent = `SDK error: ${error instanceof Error ? error.message : String(error)}`;',
          "}",
        ].join("\n"),
      },
      {
        path: "static-report/index.html",
        contents: "<!doctype html><html><body><h1>Static Report</h1></body></html>",
      },
      {
        path: "agent-site/package.json",
        contents: JSON.stringify(
          {
            private: true,
            type: "module",
            scripts: {
              dev: "node dev-server.mjs",
              build: "node build.mjs",
            },
            devDependencies: { vite: "0.0.0" },
          },
          null,
          2,
        ),
      },
      {
        path: "agent-site/dev-server.mjs",
        contents: [
          "import http from 'node:http';",
          "const html = '<!doctype html><html><body><h1>Dev Preview</h1></body></html>';",
          "const server = http.createServer((_req, res) => {",
          "  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
          "  res.end(html);",
          "});",
          "server.listen(0, '127.0.0.1', () => {",
          "  const { port } = server.address();",
          "  console.log(`Local: http://127.0.0.1:${port}/`);",
          "});",
        ].join("\n"),
      },
      {
        path: "agent-site/build.mjs",
        contents: [
          "import { mkdir, writeFile } from 'node:fs/promises';",
          "await mkdir('dist', { recursive: true });",
          "await writeFile('dist/index.html', '<!doctype html><html><body><h1>Built Preview</h1></body></html>');",
          "console.log('built');",
        ].join("\n"),
      },
    ]);

    await waitForWorkspaceFile(desktop.page, workspace.workspaceId, "agent-site/package.json");
    await desktop.page.getByTestId("activity-sites").click();

    const staticRow = desktop.page.getByTestId("sites-row").filter({ hasText: "Static Report" });
    await expect(staticRow).toBeVisible();
    await staticRow.click();
    await desktop.page.getByTestId("site-preview-static").click();
    await expect(
      desktop.page.frameLocator('[data-testid="site-preview-frame"]').getByRole("heading", {
        name: "Static Report",
      }),
    ).toBeVisible();

    const packageRow = desktop.page.getByTestId("sites-row").filter({ hasText: "Agent Site" });
    await expect(packageRow).toBeVisible();
    await packageRow.click();

    await desktop.page.getByTestId("site-preview-dev").click();
    await expect(
      desktop.page.frameLocator('[data-testid="site-preview-frame"]').getByRole("heading", {
        name: "Dev Preview",
      }),
    ).toBeVisible();

    await desktop.page.getByTestId("site-preview-build").click();
    await expect(
      desktop.page.frameLocator('[data-testid="site-preview-frame"]').getByRole("heading", {
        name: "Built Preview",
      }),
    ).toBeVisible();

    const sdkRow = desktop.page.getByTestId("sites-row").filter({ hasText: "Sdk Site" });
    await expect(sdkRow).toBeVisible();
    await sdkRow.click();
    await desktop.page.getByTestId("site-preview-dev").click();
    await expect(
      desktop.page.frameLocator('[data-testid="site-preview-frame"]').getByText("SDK says: Local data from dohc"),
    ).toBeVisible();

    await desktop.page.getByTestId("site-preview-stop").click();
    await expect(desktop.page.getByTestId("site-preview-frame")).toHaveCount(0);
  } finally {
    await desktop?.close();
    await temp.cleanup();
  }
});
