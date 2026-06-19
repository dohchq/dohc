import { expect, test, type Page } from "@playwright/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ElectronApplication } from "playwright";
import { launchApp, openInTree, stopChildProcess, tsxChildEnv } from "./launch";

// Multi-user collaboration matrix over the real desktop app, workspace-api,
// Hocuspocus, and Postgres. Keep the broad abuse/stress coverage in lower-level
// tests; this file proves the product paths with distinct users and instances.

test.describe.configure({ mode: "serial" });

const API_PORT = 17923;
const HP_PORT = 12363;
const API_URL = `http://localhost:${API_PORT}`;
const HP_URL = `ws://localhost:${HP_PORT}`;
const JWT_SECRET = "collaboration-matrix-secret-0123456789abcdef";
const PG = "postgres://dohc:dohc@localhost:54329/dohc_v2";
const SERVICE_START_TIMEOUT_MS = 600_000;

let api: ChildProcess;
let hocuspocus: ChildProcess;
let apps: ElectronApplication[] = [];
const serviceOutput = new WeakMap<ChildProcess, string[]>();

type SeededClient = { home: string; root: string };

function spawnService(entry: string, cwd: string, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), entry], {
    cwd: join(process.cwd(), cwd),
    env: { ...process.env, ...tsxChildEnv(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serviceOutput.set(child, []);
  child.stdout?.on("data", (chunk) => captureServiceOutput(child, "stdout", chunk));
  child.stderr?.on("data", (chunk) => captureServiceOutput(child, "stderr", chunk));
  return child;
}

function captureServiceOutput(child: ChildProcess, stream: string, chunk: Buffer) {
  const lines = serviceOutput.get(child) ?? [];
  lines.push(
    ...chunk
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `${stream}: ${line}`),
  );
  serviceOutput.set(child, lines.slice(-40));
}

function childExitMessage(child: ChildProcess, label: string): string {
  return [
    `${label} exited before ready (code ${child.exitCode}, signal ${child.signalCode})`,
    ...((serviceOutput.get(child) ?? []).slice(-12)),
  ].join("\n");
}

async function waitForHttp(url: string, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
  for (;;) {
    if (child && child.exitCode !== null) throw new Error(childExitMessage(child, url));
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not ready
    }
    if (child && child.exitCode !== null) throw new Error(childExitMessage(child, url));
    if (Date.now() > deadline) throw new Error(`not healthy: ${url} (run pnpm dev:postgres?)`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function waitForTcp(port: number, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
  for (;;) {
    if (child && child.exitCode !== null) throw new Error(childExitMessage(child, `:${port}`));
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.setTimeout(500);
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
        socket.once("timeout", () => {
          socket.destroy();
          reject(new Error("tcp wait timed out"));
        });
      });
      return;
    } catch {
      if (child && child.exitCode !== null) throw new Error(childExitMessage(child, `:${port}`));
      if (Date.now() > deadline) throw new Error(`not listening: localhost:${port}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

test.beforeAll(async () => {
  test.setTimeout(SERVICE_START_TIMEOUT_MS);
  api = spawnService("src/main.ts", "services/workspace-api", {
    DOHC_TEST_AUTH: "1",
    NODE_ENV: "test",
    WORKSPACE_API_PORT: String(API_PORT),
    HOCUSPOCUS_JWT_SECRET: JWT_SECRET,
  });
  await waitForHttp(`${API_URL}/health`, api);

  hocuspocus = spawnService("src/server.ts", "services/hocuspocus", {
    HOCUSPOCUS_PORT: String(HP_PORT),
    HOCUSPOCUS_DATABASE_URL: PG,
    HOCUSPOCUS_WORKSPACE_DATABASE_URL: PG,
    HOCUSPOCUS_JWT_SECRET: JWT_SECRET,
    HOCUSPOCUS_ADMIN_TOKEN: "collaboration-matrix-admin",
    HOCUSPOCUS_QUIET: "true",
  });
  await waitForTcp(HP_PORT, hocuspocus);
});

test.afterEach(async () => {
  const closing = apps;
  apps = [];
  await Promise.all(closing.map((app) => app.close().catch(() => undefined)));
});

test.afterAll(async () => {
  await Promise.all([
    stopChildProcess(api),
    stopChildProcess(hocuspocus),
  ]);
});

async function seedSharedClient(
  workspaceId: string,
  files: Record<string, string>,
): Promise<SeededClient> {
  const home = await mkdtemp(join(tmpdir(), "dohc-collab-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-collab-ws-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId, kind: "shared", mode: "cloud-first-local-copy" }),
  );
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
  return { home, root };
}

function envFor(client: SeededClient): Record<string, string> {
  return {
    DOHC_TEST_HOME: client.home,
    DOHC_TEST_PICK_PATH: client.root,
    DOHC_CLOUD_URL: API_URL,
    DOHC_HOCUSPOCUS_URL: HP_URL,
    DOHC_TEST_USER_DATA: client.home,
  };
}

async function pgQuery(
  sql: string,
  params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  const script =
    "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.PG_URL});" +
    "p.query(process.env.PG_SQL,JSON.parse(process.env.PG_PARAMS))" +
    ".then(r=>{console.log(JSON.stringify(r.rows));return p.end()})" +
    ".catch(e=>{console.error(e.message);process.exit(1)});";
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["-e", script],
      {
        cwd: process.cwd(),
        env: { ...process.env, PG_URL: PG, PG_SQL: sql, PG_PARAMS: JSON.stringify(params) },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(JSON.parse(stdout || "[]") as Array<Record<string, unknown>>);
      },
    );
  });
}

async function connectCloud(page: Page, email: string): Promise<void> {
  await page.getByRole("button", { name: /connect dohc cloud/i }).click();
  await page.getByTestId("cloud-connect-start").click();
  const code = (await page.getByTestId("cloud-user-code").textContent({ timeout: 15_000 }))?.trim();
  const approve = await fetch(`${API_URL}/test/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode: code, email }),
  });
  expect(approve.ok).toBe(true);
  await expect(page.getByTestId("cloud-connected-email")).toHaveText(email, { timeout: 20_000 });
}

async function enableSyncAndCloseOverlay(page: Page): Promise<void> {
  await page.getByTestId("cloud-enable-sync").click();
  await expect(page.getByTestId("cloud-workspace-synced")).toBeVisible({ timeout: 30_000 });
  await page.mouse.click(8, 8);
  await expect(page.getByTestId("cloud-sync-panel")).toHaveCount(0);
}

async function addWorkspaceMember(workspaceId: string, email: string): Promise<void> {
  const users = await pgQuery('select id from "user" where email = $1', [email]);
  expect(users).toHaveLength(1);
  await pgQuery(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ($1, $2, $3, 'editor')
     on conflict (workspace_id, user_id)
     do update set role = excluded.role, deleted_at = null, updated_at = now()`,
    [randomUUID(), workspaceId, users[0].id],
  );
}

async function mintToken(email: string): Promise<string> {
  const code = (await (
    await fetch(`${API_URL}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "dohc-collaboration-matrix" }),
    })
  ).json()) as { device_code: string; user_code: string };
  await fetch(`${API_URL}/test/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode: code.user_code, email }),
  });
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const token = (await (
    await fetch(`${API_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: "dohc-collaboration-matrix",
      }),
    })
  ).json()) as { access_token?: string };
  if (!token.access_token) throw new Error(`could not mint token for ${email}`);
  return token.access_token;
}

async function serverFiles(token: string, workspaceId: string): Promise<Set<string>> {
  const data = (await (
    await fetch(`${API_URL}/workspaces/${workspaceId}/files`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as { files?: Array<{ path: string }> };
  return new Set((data.files ?? []).map((file) => file.path));
}

async function serverRead(token: string, workspaceId: string, path: string): Promise<string> {
  const data = (await (
    await fetch(`${API_URL}/workspaces/${workspaceId}/files/${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as { file?: { body?: string } };
  return data.file?.body ?? "";
}

async function launchSharedClient(client: SeededClient, email: string): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const app = await launchApp(envFor(client));
  apps.push(app);
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await connectCloud(page, email);
  return { app, page };
}

async function appendParagraphAfter(
  page: Page,
  editor: ReturnType<Page["getByTestId"]>,
  anchorText: string,
  nextText: string,
): Promise<void> {
  await expect(editor).toContainText(anchorText, { timeout: 20_000 });
  await editor.evaluate((root, text) => {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    while (node) {
      const value = node.textContent ?? "";
      const index = value.indexOf(text);
      if (index !== -1) {
        const range = doc.createRange();
        range.setStart(node, index + text.length);
        range.collapse(true);
        const selection = doc.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        (root as HTMLElement).focus();
        return;
      }
      node = walker.nextNode();
    }
    throw new Error(`Could not place caret after: ${text}`);
  }, anchorText);
  await page.keyboard.press("Enter");
  await page.keyboard.type(nextText);
}

async function replaceCodeMirror(page: Page, editorTestId: string, text: string): Promise<void> {
  const editor = page.getByTestId(editorTestId).locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await page.keyboard.press("ControlOrMeta+s");
}

test("distinct users co-edit a shared markdown doc live, then a rejoined client catches up", async () => {
  test.setTimeout(360_000);
  const runId = `${Date.now()}-${randomUUID()}`;
  const workspaceId = `collab-md-${runId}`;
  const ownerEmail = `collab-owner-${runId}@dohc.test`;
  const memberEmail = `collab-member-${runId}@dohc.test`;
  const owner = await seedSharedClient(workspaceId, {
    "notes/doc.md": "# Shared doc\n\nStart here\n",
  });
  const member = await seedSharedClient(workspaceId, {
    "notes/doc.md": "# Shared doc\n\nStart here\n",
  });

  const ownerClient = await launchSharedClient(owner, ownerEmail);
  await enableSyncAndCloseOverlay(ownerClient.page);
  const ownerToken = await mintToken(ownerEmail);

  const memberClient = await launchSharedClient(member, memberEmail);
  await addWorkspaceMember(workspaceId, memberEmail);
  await enableSyncAndCloseOverlay(memberClient.page);

  await openInTree(ownerClient.page, "notes/doc.md");
  await openInTree(memberClient.page, "notes/doc.md");
  const ownerEditor = ownerClient.page.getByTestId("markdown-editor");
  const memberEditor = memberClient.page.getByTestId("markdown-editor");
  await expect(ownerEditor).toContainText(/Shared doc/, { timeout: 30_000 });
  await expect(memberEditor).toContainText(/Shared doc/, { timeout: 30_000 });
  await expect(ownerClient.page.getByTestId("collab-presence")).toContainText(/editing/i, {
    timeout: 20_000,
  });

  await appendParagraphAfter(ownerClient.page, ownerEditor, "Start here", "Owner live edit.");
  await expect(memberEditor).toContainText(/Owner live edit\./, { timeout: 20_000 });
  await appendParagraphAfter(memberClient.page, memberEditor, "Owner live edit.", "Member live edit.");
  await expect(ownerEditor).toContainText(/Member live edit\./, { timeout: 20_000 });
  await expect
    .poll(async () => serverRead(ownerToken, workspaceId, "notes/doc.md"), {
      timeout: 45_000,
    })
    .toContain("Member live edit.");

  await memberClient.app.close();
  apps = apps.filter((app) => app !== memberClient.app);
  await appendParagraphAfter(ownerClient.page, ownerEditor, "Member live edit.", "Edit while member is away.");
  await expect
    .poll(async () => serverRead(ownerToken, workspaceId, "notes/doc.md"), {
      timeout: 45_000,
    })
    .toContain("Edit while member is away.");
  await expect
    .poll(async () => readFile(join(owner.root, "notes", "doc.md"), "utf8").catch(() => ""), {
      timeout: 30_000,
    })
    .toContain("Edit while member is away.");

  const rejoined = await launchApp(envFor(member));
  apps.push(rejoined);
  const rejoinedPage = await rejoined.firstWindow();
  await expect(rejoinedPage.getByTestId("workspace-shell")).toBeVisible({ timeout: 30_000 });
  await openInTree(rejoinedPage, "notes/doc.md", { timeout: 30_000 });
  await expect(rejoinedPage.getByTestId("markdown-editor")).toContainText(
    /Edit while member is away\./,
    { timeout: 30_000 },
  );
  expect(await rejoinedPage.getByTestId("markdown-editor").textContent()).not.toMatch(
    /<<<<<<<|>>>>>>>/,
  );
});

test("shared source, CSV, rename, and delete changes sync across two desktop users", async () => {
  test.setTimeout(420_000);
  const runId = `${Date.now()}-${randomUUID()}`;
  const workspaceId = `collab-files-${runId}`;
  const ownerEmail = `collab-files-owner-${runId}@dohc.test`;
  const memberEmail = `collab-files-member-${runId}@dohc.test`;
  const seedFiles = {
    "notes/team.txt": "Team scratch\n",
    "data/team.csv": "item,qty\napples,10",
  };
  const owner = await seedSharedClient(workspaceId, seedFiles);
  const member = await seedSharedClient(workspaceId, seedFiles);

  const ownerClient = await launchSharedClient(owner, ownerEmail);
  await enableSyncAndCloseOverlay(ownerClient.page);
  const ownerToken = await mintToken(ownerEmail);

  const memberClient = await launchSharedClient(member, memberEmail);
  await addWorkspaceMember(workspaceId, memberEmail);
  await enableSyncAndCloseOverlay(memberClient.page);

  await openInTree(memberClient.page, "notes/team.txt");
  await replaceCodeMirror(memberClient.page, "view-text-editor", "Team scratch\nmember UI edit\n");
  await expect(memberClient.page.getByTestId("view-text-save-state")).toHaveAttribute(
    "data-state",
    "saved",
    { timeout: 10_000 },
  );
  await expect
    .poll(async () => serverRead(ownerToken, workspaceId, "notes/team.txt"), {
      timeout: 45_000,
    })
    .toContain("member UI edit");

  await ownerClient.app.close();
  apps = apps.filter((app) => app !== ownerClient.app);
  const relaunchedOwner = await launchApp(envFor(owner));
  apps.push(relaunchedOwner);
  const ownerPage = await relaunchedOwner.firstWindow();
  await expect(ownerPage.getByTestId("workspace-shell")).toBeVisible({ timeout: 30_000 });
  await openInTree(ownerPage, "notes/team.txt", { timeout: 30_000 });
  await expect(ownerPage.getByTestId("view-text-editor").locator(".cm-content")).toContainText(
    "member UI edit",
  );

  await openInTree(memberClient.page, "data/team.csv");
  await memberClient.page.getByLabel("Row 1 column 2").fill("12");
  await expect(memberClient.page.getByTestId("csv-save-state")).toHaveAttribute(
    "data-state",
    "saved",
    { timeout: 10_000 },
  );
  await expect
    .poll(async () => serverRead(ownerToken, workspaceId, "data/team.csv"), {
      timeout: 45_000,
    })
    .toBe("item,qty\napples,12");

  await rename(join(member.root, "notes", "team.txt"), join(member.root, "notes", "team-renamed.txt"));
  await expect
    .poll(async () => {
      const files = await serverFiles(ownerToken, workspaceId);
      return {
        oldPath: files.has("notes/team.txt"),
        newPath: files.has("notes/team-renamed.txt"),
      };
    }, { timeout: 45_000 })
    .toEqual({ oldPath: false, newPath: true });

  await rm(join(member.root, "notes", "team-renamed.txt"));
  await expect
    .poll(async () => (await serverFiles(ownerToken, workspaceId)).has("notes/team-renamed.txt"), {
      timeout: 45_000,
    })
    .toBe(false);

  await relaunchedOwner.close();
  apps = apps.filter((app) => app !== relaunchedOwner);
  const finalOwner = await launchApp(envFor(owner));
  apps.push(finalOwner);
  const finalOwnerPage = await finalOwner.firstWindow();
  await expect(finalOwnerPage.getByTestId("workspace-shell")).toBeVisible({ timeout: 30_000 });
  await openInTree(finalOwnerPage, "data/team.csv", { timeout: 30_000 });
  await expect(finalOwnerPage.getByLabel("Row 1 column 2")).toHaveValue("12");
  await expect(
    finalOwnerPage.locator('[data-testid="tree-row"][data-path="notes/team-renamed.txt"]'),
  ).toHaveCount(0);
  expect(await readFile(join(owner.root, "data", "team.csv"), "utf8")).toBe("item,qty\napples,12");
});

test("three desktop users converge through ten deep collaboration events", async () => {
  test.setTimeout(600_000);
  const runId = `${Date.now()}-${randomUUID()}`;
  const workspaceId = `collab-deep-${runId}`;
  const ownerEmail = `collab-deep-owner-${runId}@dohc.test`;
  const editorAEmail = `collab-deep-a-${runId}@dohc.test`;
  const editorBEmail = `collab-deep-b-${runId}@dohc.test`;
  const seedFiles = {
    "docs/war-room.md": "# War room\n\nStart line\n",
    "notes/session.txt": "Session log\n",
    "web/index.html": "<main>\n  <h1>Launch</h1>\n</main>\n",
    "data/inventory.csv": "item,qty\napples,10\noranges,2",
  };
  const owner = await seedSharedClient(workspaceId, seedFiles);
  const editorA = await seedSharedClient(workspaceId, seedFiles);
  const editorB = await seedSharedClient(workspaceId, seedFiles);

  const ownerClient = await launchSharedClient(owner, ownerEmail);
  await enableSyncAndCloseOverlay(ownerClient.page);
  const ownerToken = await mintToken(ownerEmail);

  const editorAClient = await launchSharedClient(editorA, editorAEmail);
  await addWorkspaceMember(workspaceId, editorAEmail);
  await enableSyncAndCloseOverlay(editorAClient.page);

  const editorBClient = await launchSharedClient(editorB, editorBEmail);
  await addWorkspaceMember(workspaceId, editorBEmail);
  await enableSyncAndCloseOverlay(editorBClient.page);

  await openInTree(ownerClient.page, "docs/war-room.md");
  await openInTree(editorAClient.page, "docs/war-room.md");
  await openInTree(editorBClient.page, "docs/war-room.md");
  const ownerEditor = ownerClient.page.getByTestId("markdown-editor");
  const editorAEditor = editorAClient.page.getByTestId("markdown-editor");
  const editorBEditor = editorBClient.page.getByTestId("markdown-editor");
  await expect(ownerEditor).toContainText(/Start line/, { timeout: 30_000 });
  await expect(editorAEditor).toContainText(/Start line/, { timeout: 30_000 });
  await expect(editorBEditor).toContainText(/Start line/, { timeout: 30_000 });

  await appendParagraphAfter(ownerClient.page, ownerEditor, "Start line", "Owner added scope.");
  await expect(editorAEditor).toContainText(/Owner added scope\./, { timeout: 20_000 });
  await expect(editorBEditor).toContainText(/Owner added scope\./, { timeout: 20_000 });

  await appendParagraphAfter(
    editorAClient.page,
    editorAEditor,
    "Owner added scope.",
    "Editor A added risks.",
  );
  await expect(ownerEditor).toContainText(/Editor A added risks\./, { timeout: 20_000 });
  await expect(editorBEditor).toContainText(/Editor A added risks\./, { timeout: 20_000 });

  await appendParagraphAfter(
    editorBClient.page,
    editorBEditor,
    "Editor A added risks.",
    "Editor B added decisions.",
  );
  await expect(ownerEditor).toContainText(/Editor B added decisions\./, { timeout: 20_000 });
  await expect(editorAEditor).toContainText(/Editor B added decisions\./, { timeout: 20_000 });

  await editorBClient.app.close();
  apps = apps.filter((app) => app !== editorBClient.app);

  await appendParagraphAfter(
    ownerClient.page,
    ownerEditor,
    "Editor B added decisions.",
    "Owner edited while B was away.",
  );
  await expect(editorAEditor).toContainText(/Owner edited while B was away\./, {
    timeout: 20_000,
  });
  await expect
    .poll(async () => serverRead(ownerToken, workspaceId, "docs/war-room.md"), {
      timeout: 45_000,
    })
    .toContain("Owner edited while B was away.");

  await openInTree(editorAClient.page, "web/index.html");
  await replaceCodeMirror(
    editorAClient.page,
    "view-text-editor",
    "<main>\n  <h1>Launch</h1>\n  <p>Editor A updated the page.</p>\n</main>\n",
  );
  await expect(editorAClient.page.getByTestId("view-text-save-state")).toHaveAttribute(
    "data-state",
    "saved",
    { timeout: 10_000 },
  );
  await expect
    .poll(async () => serverRead(ownerToken, workspaceId, "web/index.html"), {
      timeout: 45_000,
    })
    .toContain("Editor A updated the page");

  await openInTree(editorAClient.page, "data/inventory.csv");
  await editorAClient.page.getByLabel("Row 1 column 2").fill("11");
  await editorAClient.page.getByTestId("csv-add-row").click();
  await editorAClient.page.getByLabel("Row 3 column 1").fill("bananas");
  await editorAClient.page.getByLabel("Row 3 column 2").fill("7");
  await expect(editorAClient.page.getByTestId("csv-save-state")).toHaveAttribute(
    "data-state",
    "saved",
    { timeout: 10_000 },
  );
  await expect
    .poll(async () => serverRead(ownerToken, workspaceId, "data/inventory.csv"), {
      timeout: 45_000,
    })
    .toBe("item,qty\napples,11\noranges,2\nbananas,7");

  await openInTree(ownerClient.page, "notes/session.txt");
  await replaceCodeMirror(
    ownerClient.page,
    "view-text-editor",
    "Session log\nOwner source note\n",
  );
  await expect(ownerClient.page.getByTestId("view-text-save-state")).toHaveAttribute(
    "data-state",
    "saved",
    { timeout: 10_000 },
  );
  await expect
    .poll(async () => serverRead(ownerToken, workspaceId, "notes/session.txt"), {
      timeout: 45_000,
    })
    .toContain("Owner source note");

  const rejoinedB = await launchApp(envFor(editorB));
  apps.push(rejoinedB);
  const rejoinedBPage = await rejoinedB.firstWindow();
  await expect(rejoinedBPage.getByTestId("workspace-shell")).toBeVisible({ timeout: 30_000 });

  await openInTree(rejoinedBPage, "docs/war-room.md", { timeout: 30_000 });
  const rejoinedMarkdown = rejoinedBPage.getByTestId("markdown-editor");
  await expect(rejoinedMarkdown).toContainText(/Owner added scope\./, { timeout: 30_000 });
  await expect(rejoinedMarkdown).toContainText(/Editor A added risks\./);
  await expect(rejoinedMarkdown).toContainText(/Editor B added decisions\./);
  await expect(rejoinedMarkdown).toContainText(/Owner edited while B was away\./);
  expect(await rejoinedMarkdown.textContent()).not.toMatch(/<<<<<<<|>>>>>>>/);

  await openInTree(rejoinedBPage, "web/index.html", { timeout: 30_000 });
  await expect(rejoinedBPage.getByTestId("view-text-editor").locator(".cm-content")).toContainText(
    "Editor A updated the page",
    { timeout: 30_000 },
  );

  await openInTree(rejoinedBPage, "data/inventory.csv", { timeout: 30_000 });
  await expect(rejoinedBPage.getByLabel("Row 1 column 2")).toHaveValue("11");
  await expect(rejoinedBPage.getByLabel("Row 3 column 1")).toHaveValue("bananas");
  await expect(rejoinedBPage.getByLabel("Row 3 column 2")).toHaveValue("7");

  await openInTree(rejoinedBPage, "notes/session.txt", { timeout: 30_000 });
  await expect(rejoinedBPage.getByTestId("view-text-editor").locator(".cm-content")).toContainText(
    "Owner source note",
    { timeout: 30_000 },
  );
});
