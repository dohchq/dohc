import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
  type WorkspaceFileWrite,
} from "./helpers/workspace";

function siteWorkspaceFixtures(viteBin: string, sdkEntry: string): WorkspaceFileWrite[] {
  return [
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
            vite: "*",
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
          devDependencies: { vite: "*" },
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
        "  const address = server.address();",
        "  if (!address || typeof address === 'string') throw new Error('server did not bind');",
        "  const { port } = address;",
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
  ];
}

function sdkBoundaryFixtures(viteBin: string, sdkEntry: string): WorkspaceFileWrite[] {
  return [
    {
      path: "boundary-site/package.json",
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
            vite: "*",
          },
        },
        null,
        2,
      ),
    },
    {
      path: "boundary-site/vite.config.mjs",
      contents: `export default { resolve: { alias: { "@dohc/sdk": ${JSON.stringify(sdkEntry)} } } };\n`,
    },
    {
      path: "boundary-site/dohc.json",
      contents: JSON.stringify(
        {
          type: "site",
          title: "Boundary Site",
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
      path: "boundary-site/index.html",
      contents:
        '<!doctype html><html><body><h1>Boundary Site</h1><p id="sdk-output">Loading</p><script type="module" src="/src/main.ts"></script></body></html>',
    },
    {
      path: "boundary-site/src/main.ts",
      contents: [
        'import { dohc } from "@dohc/sdk";',
        'const output = document.getElementById("sdk-output");',
        "try {",
        '  const text = await dohc.files.read("leak.md");',
        '  if (output) output.textContent = `SDK leaked: ${text}`;',
        "} catch (error) {",
        '  if (output) output.textContent = `SDK denied: ${error instanceof Error ? error.message : String(error)}`;',
        "}",
      ].join("\n"),
    },
  ];
}

function failingSiteFixtures(): WorkspaceFileWrite[] {
  return [
    {
      path: "broken-site/package.json",
      contents: JSON.stringify(
        {
          private: true,
          type: "module",
          scripts: {
            dev: "node dev-server.mjs",
            build: "node build.mjs",
          },
        },
        null,
        2,
      ),
    },
    {
      path: "broken-site/dohc.json",
      contents: JSON.stringify({ type: "site", title: "Broken Site" }, null, 2),
    },
    {
      path: "broken-site/dev-server.mjs",
      contents: "console.error('dev failed intentionally'); process.exit(2);\n",
    },
    {
      path: "broken-site/build.mjs",
      contents: "console.error('build failed intentionally'); process.exit(3);\n",
    },
  ];
}

function siteRuntimePaths(): { viteBin: string; sdkEntry: string } {
  const repoRoot = resolve(desktopRoot, "../..");
  // Resolve vite from the desktop package, which declares it — the repo-root
  // node_modules only contains vite under hoisting layouts pnpm does not
  // guarantee (and does not produce on a fresh Windows install).
  const viteBin = resolve(desktopRoot, "node_modules/vite/bin/vite.js");
  const sdkEntry = resolve(repoRoot, "packages/sdk/src/index.ts");
  if (!existsSync(viteBin)) throw new Error(`Vite binary not found: ${viteBin}`);
  if (!existsSync(sdkEntry)) throw new Error(`SDK entry not found: ${sdkEntry}`);
  return { viteBin, sdkEntry };
}

test("@sites detects agent-created websites and previews static, dev, and build modes", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    const { viteBin, sdkEntry } = siteRuntimePaths();

    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);

    await writeWorkspaceFiles(temp, siteWorkspaceFixtures(viteBin, sdkEntry));

    await Promise.all([
      waitForWorkspaceFile(desktop.page, workspace.workspaceId, "agent-site/package.json"),
      waitForWorkspaceFile(desktop.page, workspace.workspaceId, "sdk-site/package.json"),
      waitForWorkspaceFile(desktop.page, workspace.workspaceId, "static-report/index.html"),
    ]);
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

    const sdkRow = desktop.page.getByTestId("sites-row").filter({ hasText: "SDK Site" });
    await expect(sdkRow).toBeVisible();
    await sdkRow.click();
    await desktop.page.getByTestId("site-preview-dev").click();
    await expect(
      desktop.page.frameLocator('[data-testid="site-preview-frame"]').getByText("SDK says: Local data from dohc"),
    ).toBeVisible();

    await desktop.page.getByTestId("site-preview-stop").click();
    await expect(desktop.page.getByTestId("site-preview-frame")).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("@sites SDK respects workspace boundaries", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    const { viteBin, sdkEntry } = siteRuntimePaths();
    const outsideFile = resolve(temp.baseDir, "outside-secret.md");
    await writeFile(outsideFile, "outside workspace secret");
    try {
      await symlink(outsideFile, resolve(temp.rootPath, "leak.md"), "file");
    } catch (error) {
      test.skip(
        true,
        `symlink creation failed; this platform may require elevated privileges: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);

    await writeWorkspaceFiles(temp, sdkBoundaryFixtures(viteBin, sdkEntry));
    await waitForWorkspaceFile(desktop.page, workspace.workspaceId, "boundary-site/package.json");
    await desktop.page.getByTestId("activity-sites").click();

    const boundaryRow = desktop.page.getByTestId("sites-row").filter({ hasText: "Boundary Site" });
    await expect(boundaryRow).toBeVisible();
    await boundaryRow.click();
    await desktop.page.getByTestId("site-preview-dev").click();

    const output = desktop.page.frameLocator('[data-testid="site-preview-frame"]').locator("#sdk-output");
    await expect(output).toContainText(/SDK denied: .*?escapes workspace/i);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("@sites surfaces dev and build preview failures", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);

    await writeWorkspaceFiles(temp, failingSiteFixtures());
    await waitForWorkspaceFile(desktop.page, workspace.workspaceId, "broken-site/package.json");
    await desktop.page.getByTestId("activity-sites").click();

    const brokenRow = desktop.page.getByTestId("sites-row").filter({ hasText: "Broken Site" });
    await expect(brokenRow).toBeVisible();
    await brokenRow.click();

    await desktop.page.getByTestId("site-preview-dev").click();
    const previewError = desktop.page.getByTestId("site-preview-error");
    await expect(previewError).toContainText("exited before it was ready");
    await expect(previewError).toContainText("code=2");

    await desktop.page.getByTestId("site-preview-build").click();
    await expect(previewError).toContainText("Site build failed");
    await expect(previewError).toContainText("build failed intentionally");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
