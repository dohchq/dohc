import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test, type Page } from "@playwright/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { chromium, type Browser, type ElectronApplication } from "playwright";
import { launchApp, openInTree } from "./launch";

// Phase 18: the final product readiness matrix as ONE sequential journey over
// the real product — desktop first-run with no account, real files on disk,
// agent batches in history, CSV→SQLite→app, persistence across relaunch,
// cloud sync to the real Postgres server, the web client reading the synced
// workspace, a shared workspace with a real second user syncing without
// ceremony, a boundary crossing that demands confirmation, a real offline
// conflict rescued without Git markers, and MCP reporting the workspace state.
// Requires live Postgres (pnpm dev:postgres); boots workspace-api + web vite.

test.describe.configure({ mode: "serial" });

const API_PORT = 17901;
const WEB_PORT = 17907;
const API_URL = `http://localhost:${API_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;
const PG_URL = "postgres://dohc:dohc@localhost:54329/dohc_v2";
const SHOT_DIR = "test-results/screenshots/phase-18";

// Unique identities per run: the seam (/test/device/approve) signs up any
// email it is handed, always with this fixed dev/test password — which is what
// lets the WEB client later sign in as the SAME user the desktop connected.
const OWNER_EMAIL = `p18-owner-${Date.now()}@dohc.test`;
const COLLAB_EMAIL = `p18-collab-${Date.now()}@dohc.test`;
const SEAM_PASSWORD = "e2e-test-password-123";

const JOURNAL_BODY =
  "# Journal\n\nSynced to the cloud by dohc.\nUpdated by the local agent.\n";
const LOCAL_CONFLICT_BODY = "# Journal\n\nEdited offline on this device.\n";
const REMOTE_CONFLICT_BODY =
  "# Journal\n\nEdited in the cloud while the desktop was offline.\n";

// --- shared run state (serial tests, one journey) ---------------------------
let api: ChildProcess;
let webServer: ChildProcess | null = null;
let browser: Browser | null = null;
let app: ElectronApplication | null = null; // the primary desktop client
let appA: ElectronApplication | null = null; // shared-workspace owner client
let appB: ElectronApplication | null = null; // shared-workspace collaborator
let testHome: string;
let primaryRoot: string;
let wsId: string; // primary workspace id (first-run generated UUID)
let ownerToken: string;
let sharedWsId: string;
let sharedA: { home: string; root: string };
let sharedB: { home: string; root: string };

// --- helpers -----------------------------------------------------------------

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`not healthy: ${url} (run pnpm dev:postgres?)`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Direct Postgres access for the two seams the product has no UI for yet:
// granting a second user membership in a workspace, and asserting the shares
// table stayed empty. Runs through a node -e child so the e2e adds no deps.
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
        env: { ...process.env, PG_URL, PG_SQL: sql, PG_PARAMS: JSON.stringify(params) },
      },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout || "[]")),
    );
  });
}

// Device-flow connect inside an open cloud panel, approving as `email`
// through the server's double-gated test seam.
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

// A session token for server-side assertions, minted through the same device
// flow + seam the app uses — for the given user, so membership matches.
async function mintToken(email: string): Promise<string> {
  const code = (await (
    await fetch(`${API_URL}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "dohc-e2e" }),
    })
  ).json()) as { device_code: string; user_code: string };
  await fetch(`${API_URL}/test/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode: code.user_code, email }),
  });
  await new Promise((r) => setTimeout(r, 3200)); // respect the 3s poll interval
  const token = (await (
    await fetch(`${API_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: "dohc-e2e",
      }),
    })
  ).json()) as { access_token?: string };
  if (!token.access_token) throw new Error(`could not mint e2e token for ${email}`);
  return token.access_token;
}

async function serverFiles(token: string, workspaceId: string): Promise<Set<string>> {
  const data = (await (
    await fetch(`${API_URL}/workspaces/${workspaceId}/files`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as { files?: Array<{ path: string }> };
  return new Set((data.files ?? []).map((f) => f.path));
}

async function serverRead(
  token: string,
  workspaceId: string,
  path: string,
): Promise<{ body?: string; revision: string }> {
  const data = (await (
    await fetch(`${API_URL}/workspaces/${workspaceId}/files/${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as { file: { body?: string; revision: string } };
  return data.file;
}

// Every real user file on disk (what the sync engine is expected to push).
// SQLite WAL/journal sidecars are transient and intentionally never sync.
async function localUserFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true })) {
    const rel = entry.split(sep).join("/");
    if (rel === ".dohc" || rel.startsWith(".dohc/")) continue;
    if (/-(wal|shm|journal)$/.test(rel)) continue;
    if ((await stat(join(root, entry))).isFile()) out.push(rel);
  }
  return out.sort();
}

// The real stdio MCP server, scoped exactly as a user's AI tool would scope it.
async function mcpConnect(root: string, home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
      join(process.cwd(), "packages/mcp/src/server.ts"),
      "--workspace",
      root,
      "--home",
      home,
    ],
  });
  const client = new Client({ name: "dohc-e2e-readiness", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function mcpCall(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
  };
  return JSON.parse(res.content[0].text);
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
}

// SEAM: no product surface creates a shared workspace yet (first-run and
// attach both produce kind "personal"; the IPC contract accepts "shared" but
// nothing sends it). The manifest is hand-seeded here — in the product's own
// default mode for shared workspaces — and adopted via "Open an existing
// folder". Tracked in the readiness review's gaps list.
async function seedSharedClient(workspaceId: string): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-p18-shared-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-p18-shared-")), "workspace");
  await mkdir(join(root, "notes"), { recursive: true });
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId, kind: "shared", mode: "cloud-first-local-copy" }),
  );
  await writeFile(join(root, "notes", "doc.md"), "# Team doc\n");
  return { home, root };
}

// --- lifecycle ---------------------------------------------------------------

test.beforeAll(async () => {
  api = spawn(
    process.execPath,
    [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "src/main.ts"],
    {
      cwd: join(process.cwd(), "services/workspace-api"),
      env: {
        ...process.env,
        DOHC_TEST_AUTH: "1",
        NODE_ENV: "test",
        WORKSPACE_API_PORT: String(API_PORT),
        // Enables CORS + Better Auth origin trust for the web client step.
        DOHC_WEB_ORIGIN: WEB_URL,
      },
      stdio: "ignore",
    },
  );
  await waitForHttp(`${API_URL}/health`);
});

test.afterAll(async () => {
  // Only handles we spawned/launched this run — never pattern kills.
  for (const handle of [app, appA, appB]) {
    await handle?.close().catch(() => undefined);
  }
  await browser?.close().catch(() => undefined);
  webServer?.kill("SIGTERM");
  api?.kill("SIGTERM");
});

// --- the journey -------------------------------------------------------------

test("steps 1-3: first run creates a real local-only workspace with no account", async () => {
  test.setTimeout(120_000);
  testHome = await mkdtemp(join(tmpdir(), "dohc-p18-home-"));
  // Deliberately NO DOHC_CLOUD_URL on first launch: local-only means local-only.
  app = await launchApp({ DOHC_TEST_HOME: testHome });
  const page = await app.firstWindow();

  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
  await expect(page.getByText(/cloud sync is optional/i)).toBeVisible();
  // No account gate anywhere on first run.
  await expect(page.getByRole("button", { name: /sign in|log in|sign up/i })).toHaveCount(0);
  await shot(page, "01-first-run");

  await page.getByRole("button", { name: /create workspace/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();

  primaryRoot = join(testHome, "dohc", "personal");
  expect(existsSync(join(primaryRoot, ".dohc", "manifest.json"))).toBe(true);
  const manifest = JSON.parse(readFileSync(join(primaryRoot, ".dohc", "manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ version: 1, kind: "personal", mode: "local-first" });
  wsId = manifest.workspaceId;
  expect(wsId).toBeTruthy();
  await shot(page, "02-workspace-shell");
});

test("step 4: markdown, CSV, image, audio, PDF, SQLite, and app files become real workspace files", async () => {
  test.setTimeout(120_000);
  const page = await app!.firstWindow();

  // Markdown through the app's own new-file flow + editor (the UI path)…
  await page.keyboard.press("ControlOrMeta+n");
  const nameInput = page.getByRole("textbox", { name: /file name/i });
  await nameInput.fill("notes/plan.md");
  await nameInput.press("Enter");
  await openInTree(page, "notes/plan.md");
  await page.getByTestId("markdown-edit-toggle").click();
  await page.getByTestId("markdown-editor").fill("# Plan\n\nDrafted in dohc desktop.\n");
  await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved", {
    timeout: 10_000,
  });
  await page.getByTestId("markdown-edit-toggle").click(); // Done
  await expect(page.getByTestId("view-markdown").locator("h1")).toHaveText("Plan");
  expect(readFileSync(join(primaryRoot, "notes", "plan.md"), "utf8")).toContain(
    "Drafted in dohc desktop.",
  );

  // …and every other fixture as DIRECT fs writes (equally real product paths —
  // the watcher records both). Bytes are real where realness matters.
  await mkdir(join(primaryRoot, "finance"), { recursive: true });
  await mkdir(join(primaryRoot, "uploads"), { recursive: true });
  await writeFile(
    join(primaryRoot, "finance", "transactions.csv"),
    "id,amount,category\ntxn_001,42,Food\ntxn_002,10,Transport\n",
  );
  // A visible 32x32 solid-blue PNG so the image actually renders.
  await writeFile(
    join(primaryRoot, "uploads", "receipt.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOklEQVR42u3OMQEAAAgDoJnc6BpjDyRgcrU1qQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBjwUVDQABkrM5SwAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  await writeFile(join(primaryRoot, "uploads", "voice.m4a"), Buffer.from([0, 0, 0, 24]));
  await writeFile(join(primaryRoot, "uploads", "contract.pdf"), "%PDF-1.4\n%minimal\n");
  // A REAL SQLite database, not just plausible bytes.
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(join(primaryRoot, "finance", "wallet.sqlite"));
  db.exec("CREATE TABLE transactions (id TEXT PRIMARY KEY, amount INTEGER)");
  db.prepare("INSERT INTO transactions VALUES ('txn_001', 42)").run();
  db.close();
  // The finance-tracker app as a visible .apps source folder (Phase 7 shape).
  const ledgerSrc = join(primaryRoot, "finance", ".apps", "ledger", "src");
  await mkdir(ledgerSrc, { recursive: true });
  await writeFile(
    join(primaryRoot, "finance", ".apps", "ledger", "app.json"),
    JSON.stringify({ title: "Ledger", write: ["transactions/**"] }),
  );
  await writeFile(
    join(ledgerSrc, "App.tsx"),
    [
      "import { dohc } from '@dohc/app'",
      "export default function App(){",
      "  return (",
      "    <main>",
      "      <h1>Ledger</h1>",
      "      <button onClick={() => dohc.collection('transactions').insert({ id: 'x' })}>",
      "        Add transaction",
      "      </button>",
      "    </main>",
      "  )",
      "}",
    ].join("\n"),
  );

  // The watcher reflects every direct write into the live file tree
  // (revealed in the nested tree without opening each file).
  for (const path of [
    "finance/transactions.csv",
    "uploads/receipt.png",
    "uploads/voice.m4a",
    "uploads/contract.pdf",
    "finance/wallet.sqlite",
    "finance/.apps/ledger/app.json",
  ]) {
    await openInTree(page, path, { click: false });
  }
  await shot(page, "03-real-files");
});

test("steps 5-6: a local agent's multi-file batch lands as ONE attributed change set", async () => {
  test.setTimeout(120_000);
  const page = await app!.firstWindow();

  // The user opts the agent in via Settings — this starts a real, recorded
  // agent run, so the next settled batch is attributed to the agent.
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await page.getByTestId("mcp-enable-toggle").click();
  await expect(page.getByTestId("mcp-status")).toHaveAttribute("data-state", "running");
  await expect
    .poll(() => existsSync(join(primaryRoot, ".dohc", "agent-runs.json")), { timeout: 10_000 })
    .toBe(true);

  // The "agent": three direct disk writes in one burst (create, create, modify).
  await writeFile(join(primaryRoot, "notes", "agenda.md"), "# Agenda\n\n- review budget\n");
  await writeFile(join(primaryRoot, "finance", "budget-2026.md"), "# Budget 2026\n");
  await writeFile(join(primaryRoot, "notes", "journal.md"), JOURNAL_BODY);

  // ONE change set for the whole batch, attributed to the agent — and the
  // watcher never records its own .dohc bookkeeping. (The settle window may
  // legitimately fold a trailing fs event from the previous step into the same
  // batch, so the count is asserted from the durable record, not hardcoded.)
  const timeline = page.getByTestId("history-timeline");
  await expect(timeline).toContainText(/agent ran an agent over \d+ files/i, { timeout: 15_000 });
  await expect(timeline).not.toContainText(".dohc");
  const historyDir = join(primaryRoot, ".dohc", "history");
  const records = (await readdir(historyDir))
    .filter((name) => name.endsWith(".json") && name !== "index.json")
    .map((name) => JSON.parse(readFileSync(join(historyDir, name), "utf8")));
  const agentRuns = records.filter((record) => record.author?.kind === "agent");
  expect(agentRuns).toHaveLength(1); // the burst landed as ONE change set
  const agentPaths = agentRuns[0].files.map((file: { path: string }) => file.path);
  for (const path of ["notes/agenda.md", "finance/budget-2026.md", "notes/journal.md"]) {
    expect(agentPaths).toContain(path);
  }

  // Run ends; the persisted record closes out.
  await page.getByTestId("mcp-enable-toggle").click();
  await expect(page.getByTestId("mcp-status")).toHaveAttribute("data-state", "stopped");
  const runs = JSON.parse(readFileSync(join(primaryRoot, ".dohc", "agent-runs.json"), "utf8"));
  expect(runs.at(-1)).toMatchObject({ status: "complete" });
  await page.mouse.click(8, 8); // close settings overlay
  await expect(page.getByTestId("settings-panel")).toHaveCount(0);
  await shot(page, "04-agent-history");
});

test("steps 7-8: finance tracker — CSV imports to visible SQLite, cell edits stick, AppTester gates the app", async () => {
  test.setTimeout(180_000);
  const page = await app!.firstWindow();
  // Import the CSV into a sibling .sqlite through the inspector's real flow.
  await openInTree(page, "finance/transactions.csv");
  await expect(page.getByTestId("view-csv")).toBeVisible();
  await page.getByTestId("csv-import-sqlite").click();
  await expect(page.getByTestId("view-database")).toBeVisible();
  await expect(page.getByTestId("db-cell-category-txn_001")).toHaveText("Food");
  await openInTree(page, "finance/transactions.sqlite", { click: false });

  // Edit a cell in the studio — this is the edit step 9 must survive.
  await page.getByTestId("db-cell-category-txn_001").click();
  const cellInput = page.getByTestId("db-cell-input");
  await cellInput.fill("Groceries");
  await cellInput.press("Enter");
  await expect(page.getByTestId("db-cell-category-txn_001")).toHaveText("Groceries");
  await shot(page, "05-database-studio");

  // The app package view + the AppTester static gate, then explicit trust.
  await openInTree(page, "finance/.apps/ledger/app.json");
  await expect(page.getByTestId("view-app")).toBeVisible();
  await expect(page.getByTestId("app-readiness")).toHaveAttribute(
    "data-readiness",
    "needs-testing",
  );
  await page.getByTestId("run-app-tester").click();
  await expect(page.getByTestId("app-readiness")).toHaveAttribute("data-readiness", "ready", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("app-test-checks")).toContainText(/compile/i);
  await page.getByTestId("trust-app").click();
  await expect(page.getByTestId("view-app")).toContainText("Trusted");
  await shot(page, "06-app-ready");
});

test("step 9: relaunch — the workspace, files, and the database edit persist", async () => {
  test.setTimeout(120_000);
  await app!.close();

  // Same DOHC_TEST_HOME; DOHC_CLOUD_URL now points at the dev server for the
  // cloud steps that follow (cloud stays opt-in — nothing connects by itself).
  app = await launchApp({ DOHC_TEST_HOME: testHome, DOHC_CLOUD_URL: API_URL });
  const page = await app.firstWindow();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await expect(page.getByRole("button", { name: /create workspace/i })).toHaveCount(0);

  await openInTree(page, "notes/plan.md", { click: false });
  await openInTree(page, "finance/transactions.sqlite");
  await expect(page.getByTestId("view-database")).toBeVisible();
  // The on-disk SQLite file is canonical: the studio edit survived the restart.
  await expect(page.getByTestId("db-cell-category-txn_001")).toHaveText("Groceries");
});

test("steps 10-11: cloud connect + enable sync — the whole workspace lands in Postgres", async () => {
  test.setTimeout(180_000);
  const page = await app!.firstWindow();

  await connectCloud(page, OWNER_EMAIL);
  await shot(page, "07-cloud-connected");
  await enableSyncAndCloseOverlay(page);

  // Server-side proof with an independently minted session for the same user:
  // EVERY visible local file (markdown, CSV, PNG, audio, PDF, both SQLite
  // databases, app sources) reaches the server.
  ownerToken = await mintToken(OWNER_EMAIL);
  const expected = await localUserFiles(primaryRoot);
  expect(expected).toContain("notes/journal.md");
  expect(expected).toContain("finance/transactions.sqlite");
  await expect
    .poll(
      async () => {
        const remote = await serverFiles(ownerToken, wsId);
        return expected.filter((path) => !remote.has(path));
      },
      { timeout: 45_000 },
    )
    .toEqual([]);
  // Byte-honest for the file the web step reads next.
  const remoteJournal = await serverRead(ownerToken, wsId, "notes/journal.md");
  expect(remoteJournal.body).toBe(JOURNAL_BODY);
});

test("step 12: the web client signs in as the same user and reads the synced file", async () => {
  test.setTimeout(240_000);

  // The repositioned web app: vite dev on a high port, pointed at the API.
  webServer = spawn(
    process.execPath,
    [
      join(process.cwd(), "node_modules/vite/bin/vite.js"),
      "dev",
      "--port",
      String(WEB_PORT),
      "--strictPort",
    ],
    {
      cwd: join(process.cwd(), "apps/web"),
      env: { ...process.env, VITE_DOHC_CLOUD_URL: API_URL },
      stdio: "ignore",
    },
  );
  await waitForHttp(WEB_URL, 120_000);

  const args = process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1" ? ["--no-sandbox"] : [];
  browser = await chromium.launch({ args });
  const webPage = await browser.newPage();
  await webPage.goto(WEB_URL);

  // Better Auth email+password sign-in as the user the desktop device flow
  // created (the seam's known dev/test password).
  await expect(webPage.getByTestId("sign-in-form")).toBeVisible({ timeout: 30_000 });
  await webPage.getByTestId("sign-in-email").fill(OWNER_EMAIL);
  await webPage.getByTestId("sign-in-password").fill(SEAM_PASSWORD);
  await webPage.getByTestId("sign-in-submit").click();

  // Fresh user ⇒ exactly the one workspace the desktop synced.
  await expect(webPage.getByRole("heading", { name: /your workspaces/i })).toBeVisible({
    timeout: 30_000,
  });
  const links = webPage.getByTestId("workspace-link");
  await expect(links).toHaveCount(1);
  await expect(links.first()).toContainText(wsId);
  await links.first().click();

  // The cloud shell shows the synced tree; the agent-written body renders.
  await expect(webPage.getByTestId("cloud-file-tree")).toBeVisible({ timeout: 30_000 });
  await webPage.locator('[data-testid="tree-file"][data-path="notes/journal.md"]').click();
  await expect(webPage.getByTestId("file-body")).toContainText("Updated by the local agent", {
    timeout: 30_000,
  });
  await expect(webPage.getByTestId("file-body").locator("h1")).toHaveText("Journal");
  await mkdir(SHOT_DIR, { recursive: true });
  await webPage.screenshot({ path: `${SHOT_DIR}/08-web-cloud.png` });

  await browser.close();
  browser = null;
});

test("steps 13-14: a real second user syncs a normal edit into the shared workspace with zero ceremony", async () => {
  test.setTimeout(300_000);
  sharedWsId = `p18-shared-${Date.now()}`;
  sharedA = await seedSharedClient(sharedWsId);
  sharedB = await seedSharedClient(sharedWsId);
  const envFor = (s: { home: string; root: string }) => ({
    DOHC_TEST_HOME: s.home,
    DOHC_TEST_PICK_PATH: s.root,
    DOHC_CLOUD_URL: API_URL,
    // Distinct userData so multiple Electron instances coexist.
    DOHC_TEST_USER_DATA: s.home,
  });

  // Owner claims the shared workspace on the server.
  appA = await launchApp(envFor(sharedA));
  const pageA = await appA.firstWindow();
  await pageA.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(pageA.getByTestId("workspace-shell")).toBeVisible();
  await connectCloud(pageA, OWNER_EMAIL);
  await enableSyncAndCloseOverlay(pageA);

  // Collaborator: a DIFFERENT user. Sign in first (the seam mints the user),
  // then grant membership — the product seam a future invite flow will own.
  appB = await launchApp(envFor(sharedB));
  const pageB = await appB.firstWindow();
  await pageB.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(pageB.getByTestId("workspace-shell")).toBeVisible();
  await connectCloud(pageB, COLLAB_EMAIL);
  const users = await pgQuery('select id from "user" where email = $1', [COLLAB_EMAIL]);
  expect(users).toHaveLength(1);
  await pgQuery(
    "insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')",
    [randomUUID(), sharedWsId, users[0].id],
  );
  await enableSyncAndCloseOverlay(pageB); // member re-claim, not forbidden

  // The collaborator makes a NORMAL edit — it must flow with no approval
  // prompt, no confirmation surface, nothing to click.
  await writeFile(
    join(sharedB.root, "notes", "standup.md"),
    "# Standup\n\nCollaborator update — synced freely.\n",
  );
  const collabToken = await mintToken(COLLAB_EMAIL);
  await expect
    .poll(async () => (await serverFiles(collabToken, sharedWsId)).has("notes/standup.md"), {
      timeout: 30_000,
    })
    .toBe(true);
  await expect(pageB.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", {
    timeout: 30_000,
  });
  // Honest absence: no approval/confirmation surface ever appeared.
  await expect(pageB.getByText(/approval|confirm/i)).toHaveCount(0);

  // The owner pulls it on next engine start (relaunch) — also approval-free.
  await appA.close();
  appA = await launchApp(envFor(sharedA));
  const pageA2 = await appA.firstWindow();
  await expect(pageA2.getByTestId("workspace-shell")).toBeVisible();
  await openInTree(pageA2, "notes/standup.md", { click: false, timeout: 30_000 });
  expect(readFileSync(join(sharedA.root, "notes", "standup.md"), "utf8")).toContain(
    "Collaborator update — synced freely.",
  );
  await expect(pageA2.getByText(/approval|confirm/i)).toHaveCount(0);
  await shot(pageA2, "09-shared-collab");

  await appA.close();
  appA = null;
  await appB.close();
  appB = null;
});

test("step 15: a boundary crossing (sharing) demands explicit confirmation — never auto-applies", async () => {
  test.setTimeout(60_000);
  // The REAL boundary surface is the MCP dohc_share tool: it routes through
  // the liberal collaboration policy and must come back needs-confirmation.
  const client = await mcpConnect(sharedB.root, sharedB.home);
  try {
    const result = await mcpCall(client, "dohc_share", {
      path: "notes/doc.md",
      scope: "public",
    });
    expect(result).toMatchObject({
      ok: true,
      status: "needs-confirmation",
      boundaryCrossing: "public-share",
    });
    expect(String(result.reason)).toMatch(/explicit ok/i);
  } finally {
    await client.close();
  }
  // Nothing was auto-applied: the shares table stayed empty for this workspace.
  const shares = await pgQuery(
    "select count(*)::int as count from shares where workspace_id = $1 and deleted_at is null",
    [sharedWsId],
  );
  expect(shares[0].count).toBe(0);
});

test("step 16: an offline both-sides conflict is rescued with both versions and zero Git markers", async () => {
  test.setTimeout(180_000);
  // Go offline (close the app), edit the same file on both sides.
  await app!.close();
  await writeFile(join(primaryRoot, "notes", "journal.md"), LOCAL_CONFLICT_BODY);
  const current = await serverRead(ownerToken, wsId, "notes/journal.md");
  const remoteWrite = await fetch(`${API_URL}/workspaces/${wsId}/files/notes/journal.md`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ body: REMOTE_CONFLICT_BODY, expectedRevision: current.revision }),
  });
  expect(remoteWrite.ok).toBe(true);

  // Relaunch: the pull lands the remote version BESIDE the local edit.
  app = await launchApp({ DOHC_TEST_HOME: testHome, DOHC_CLOUD_URL: API_URL });
  const page = await app.firstWindow();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await openInTree(page, "notes/journal.md.conflict", { click: false, timeout: 30_000 });
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "conflict", {
    timeout: 30_000,
  });

  // BOTH versions survive, in plain readable files — never Git markers.
  const local = readFileSync(join(primaryRoot, "notes", "journal.md"), "utf8");
  const rescued = readFileSync(join(primaryRoot, "notes", "journal.md.conflict"), "utf8");
  expect(local).toBe(LOCAL_CONFLICT_BODY);
  expect(rescued).toBe(REMOTE_CONFLICT_BODY);
  expect(local).not.toMatch(/<<<<<<<|>>>>>>>/);
  expect(rescued).not.toMatch(/<<<<<<<|>>>>>>>/);
  await shot(page, "10-conflict");
});

test("step 17: MCP reports the workspace cloud-synced and clean after the conflict is resolved", async () => {
  test.setTimeout(120_000);
  const client = await mcpConnect(primaryRoot, testHome);
  try {
    // The conservative merge surface is honest about overlapping edits: it
    // keeps both for a human instead of inventing a merge.
    const merge = await mcpCall(client, "dohc_resolve_conflict", {
      base: JOURNAL_BODY,
      local: LOCAL_CONFLICT_BODY,
      remote: REMOTE_CONFLICT_BODY,
    });
    expect(merge).toMatchObject({ resolved: false });

    // The human resolves: keep the local version, discard the rescued copy.
    // Cursors anchor to the store's own records (ids + stamps via
    // dohc_sync_now), never this process's Date.now(): WSL2's wall clock can
    // step backwards mid-run (observed: the rm's record landed stamped ~1.2s
    // before the rm itself), which blinds a cross-process epoch cursor.
    const allRecords = async () =>
      (await mcpCall(client, "dohc_sync_now", { sinceMs: 0 })).pending as Array<{
        id: string;
        recordedAtMs: number;
      }>;
    const before = new Set((await allRecords()).map((record) => record.id));
    await rm(join(primaryRoot, "notes", "journal.md.conflict"));
    // MCP sees the resolution land as a recorded change set…
    await expect
      .poll(async () => (await allRecords()).filter((record) => !before.has(record.id)).length, {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(1);
    // …and after a quiet period, nothing is pending past the store's own
    // latest stamp.
    await new Promise((r) => setTimeout(r, 2000));
    const cursor = Math.max(...(await allRecords()).map((record) => record.recordedAtMs));
    expect(await mcpCall(client, "dohc_sync_now", { sinceMs: cursor })).toMatchObject({
      clean: true,
      pendingChangeCount: 0,
    });

    // The workspace is honestly reported as cloud-synced to OUR server, and
    // the registry the desktop maintains lists it.
    expect(await mcpCall(client, "dohc_workspace_status")).toMatchObject({
      synced: true,
      scope: "cloud",
      serverUrl: API_URL,
      workspaceId: wsId,
    });
    const listed = (await mcpCall(client, "dohc_list_workspaces")) as {
      workspaces: Array<{ workspaceId: string; rootPath: string }>;
    };
    expect(listed.workspaces).toContainEqual(
      expect.objectContaining({ workspaceId: wsId, rootPath: primaryRoot }),
    );
  } finally {
    await client.close();
  }
  await app!.close();
  app = null;
});
