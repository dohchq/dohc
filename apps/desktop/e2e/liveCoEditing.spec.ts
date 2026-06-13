import { expect, test, type Page } from "@playwright/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { encodeDocName } from "../../../services/hocuspocus/src/doc-name";
import { launchApp, openInTree } from "./launch";

// Two Electron clients on the SAME shared markdown doc must converge live via
// Hocuspocus. Boots the real workspace-api (Better Auth + collab-token) and a
// real Hocuspocus server with the Postgres ACL, sharing one JWT secret.
// Requires live Postgres (pnpm dev:postgres).

const API_PORT = 17895;
const HP_PORT = 12350;
const API_URL = `http://localhost:${API_PORT}`;
const HP_URL = `ws://localhost:${HP_PORT}`;
const JWT_SECRET = "phase10-coedit-shared-secret-0123456789ab";
const PG = "postgres://dohc:dohc@localhost:54329/dohc_v2";
const SERVICE_START_TIMEOUT_MS = 300_000;

let api: ChildProcess;
let hocuspocus: ChildProcess;

function spawnService(entry: string, cwd: string, env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), entry], {
    cwd: join(process.cwd(), cwd),
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
}

async function waitForHttp(url: string, timeoutMs = SERVICE_START_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error(`not healthy: ${url} (run pnpm dev:postgres?)`);
    await new Promise((r) => setTimeout(r, 500));
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
  hocuspocus = spawnService("src/server.ts", "services/hocuspocus", {
    HOCUSPOCUS_PORT: String(HP_PORT),
    HOCUSPOCUS_DATABASE_URL: PG,
    HOCUSPOCUS_WORKSPACE_DATABASE_URL: PG,
    HOCUSPOCUS_JWT_SECRET: JWT_SECRET,
    HOCUSPOCUS_ADMIN_TOKEN: "coedit-admin",
    HOCUSPOCUS_QUIET: "true",
  });
  await waitForHttp(`${API_URL}/health`);
  // Hocuspocus has no /health; the upgrade endpoint answering (even 4xx) is
  // enough to know it bound the port.
  await new Promise((r) => setTimeout(r, 2500));
});

test.afterAll(() => {
  api?.kill("SIGTERM");
  hocuspocus?.kill("SIGTERM");
});

async function seedShared(workspaceId: string, body: string): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-co-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-co-")), "workspace");
  await mkdir(join(root, "notes"), { recursive: true });
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId, kind: "shared", mode: "local-first" }),
  );
  await writeFile(join(root, "notes", "doc.md"), body);
  return { home, root };
}

async function signInAndEnableSync(page: Page): Promise<void> {
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await page.getByRole("button", { name: /connect dohc cloud/i }).click();
  await page.getByTestId("cloud-connect-start").click();
  const code = (await page.getByTestId("cloud-user-code").textContent({ timeout: 15_000 }))?.trim();
  await fetch(`${API_URL}/test/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode: code }),
  });
  await expect(page.getByTestId("cloud-connected-email")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("cloud-enable-sync").click();
  await expect(page.getByTestId("cloud-workspace-synced")).toBeVisible({ timeout: 30_000 });
  // Close the overlay so it stops covering the file tree.
  await page.mouse.click(8, 8);
  await expect(page.getByTestId("cloud-sync-panel")).toHaveCount(0);
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

function encodePlainTextSnapshot(markdown: string): {
  snapshot: string;
  stateVector: string;
} {
  const doc = new Y.Doc();
  doc.getMap("meta").set("schemaVersion", 1);
  doc.getMap("meta").set("contentKind", "plain-text");
  doc.getText("plainText").insert(0, markdown);
  const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  const stateVector = Buffer.from(Y.encodeStateVector(doc)).toString("base64");
  doc.destroy();
  return { snapshot, stateVector };
}

async function seedPlainTextSnapshot(input: {
  workspaceId: string;
  path: string;
  markdown: string;
}): Promise<void> {
  const atoms = await pgQuery(
    "select id from atoms where workspace_id = $1 and path = $2 and deleted_at is null",
    [input.workspaceId, input.path],
  );
  if (atoms.length !== 1 || typeof atoms[0].id !== "string") {
    throw new Error(`Expected synced atom for ${input.path}`);
  }
  const documentName = encodeDocName({
    workspaceId: input.workspaceId,
    atomId: atoms[0].id,
  });
  const encoded = encodePlainTextSnapshot(input.markdown);
  await pgQuery("delete from hocuspocus_projection_jobs where doc_name = $1", [
    documentName,
  ]);
  await pgQuery("delete from hocuspocus_ydoc_updates where doc_name = $1", [
    documentName,
  ]);
  await pgQuery("delete from hocuspocus_ydoc_snapshots where doc_name = $1", [
    documentName,
  ]);
  await pgQuery("delete from hocuspocus_ydoc_counters where doc_name = $1", [
    documentName,
  ]);
  await pgQuery(
    `insert into hocuspocus_ydoc_snapshots
       (doc_name, snapshot_bytes, state_vector, last_seq)
     values ($1, decode($2, 'base64'), decode($3, 'base64'), 0)`,
    [documentName, encoded.snapshot, encoded.stateVector],
  );
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

test("two clients co-edit a shared markdown doc and converge live", async () => {
  const wsId = `coedit-e2e-${Date.now()}`;
  const a = await seedShared(wsId, "# Shared doc\n\nStart here\n");
  const b = await seedShared(wsId, "# Shared doc\n\nStart here\n");
  const envFor = (s: { home: string; root: string }) => ({
    DOHC_TEST_HOME: s.home,
    DOHC_TEST_PICK_PATH: s.root,
    DOHC_CLOUD_URL: API_URL,
    DOHC_HOCUSPOCUS_URL: HP_URL,
    // Distinct userData per client so both Electron instances run at once
    // (the single-instance lock keys on userData).
    DOHC_TEST_USER_DATA: s.home,
  });

  // Client A: sign in, enable sync (creates the atom on the server), open the
  // doc, and land in a live collab session.
  const appA = await launchApp(envFor(a));
  const pageA = await appA.firstWindow();
  await signInAndEnableSync(pageA);
  await openInTree(pageA, "notes/doc.md");
  const editorA = pageA.getByTestId("markdown-editor");
  await expect(editorA).toBeVisible({ timeout: 30_000 });
  // The bootstrapped content MUST survive — the editor opens with it, never
  // blank. (Regression guard: a wrong-field bind / pre-sync materialize would
  // silently blank "# Shared doc".)
  await expect(editorA).toContainText(/Shared doc/, { timeout: 20_000 });

  // Client B: same remote workspace id; enable-sync pulls (self-heals — same
  // bytes), opens the doc, joins the same shared Y.Doc.
  const appB = await launchApp(envFor(b));
  const pageB = await appB.firstWindow();
  await signInAndEnableSync(pageB);
  await openInTree(pageB, "notes/doc.md");
  const editorB = pageB.getByTestId("markdown-editor");
  await expect(editorB).toBeVisible({ timeout: 30_000 });
  await expect(editorB).toContainText(/Shared doc/, { timeout: 20_000 });

  // Presence: each side sees the other editing.
  await expect(pageA.getByTestId("collab-presence")).toContainText(/editing/i, { timeout: 20_000 });

  // A types; B converges to the same content (no Git markers, ever).
  await appendParagraphAfter(pageA, editorA, "Start here", "Edited by A.");
  await expect(editorB).toContainText(/Edited by A\./, { timeout: 20_000 });

  // B types; A converges too (bidirectional).
  await appendParagraphAfter(pageB, editorB, "Edited by A.", "Edited by B.");
  await expect(editorA).toContainText(/Edited by B\./, { timeout: 20_000 });
  await expect(editorA).toContainText(/Edited by A\./);
  expect(await editorA.textContent()).not.toMatch(/<<<<<<<|>>>>>>>/);

  // The CRDT materializes back to the file on settle: A's disk must converge to
  // the full document — the original header AND both edits — so nothing is lost
  // when the session closes. (Wait for the settle to land.)
  const docPath = join(a.root, "notes", "doc.md");
  await expect
    .poll(async () => readFile(docPath, "utf8").catch(() => ""), { timeout: 30_000 })
    .toMatch(/Edited by A\./);
  const onDisk = await readFile(docPath, "utf8");
  expect(onDisk).toMatch(/# Shared doc/);
  expect(onDisk).not.toMatch(/<<<<<<<|>>>>>>>/);
  expect(existsSync(`${docPath}.conflict`)).toBe(false);

  await appA.close();
  await appB.close();
});

test("plainText hocuspocus markdown docs migrate to rich without losing live text", async () => {
  const wsId = `coedit-migrate-${Date.now()}`;
  const seeded = await seedShared(wsId, "# Migration\n\nBefore projection\n");
  const env = {
    DOHC_TEST_HOME: seeded.home,
    DOHC_TEST_PICK_PATH: seeded.root,
    DOHC_CLOUD_URL: API_URL,
    DOHC_HOCUSPOCUS_URL: HP_URL,
    DOHC_TEST_USER_DATA: seeded.home,
  };

  const app = await launchApp(env);
  const page = await app.firstWindow();
  await signInAndEnableSync(page);
  await expect
    .poll(
      async () =>
        (
          await pgQuery(
            "select id from atoms where workspace_id = $1 and path = 'notes/doc.md' and deleted_at is null",
            [wsId],
          )
        ).length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await seedPlainTextSnapshot({
    workspaceId: wsId,
    path: "notes/doc.md",
    markdown: "# Migration\n\nBefore projection\n\nUnprojected live edit",
  });

  await openInTree(page, "notes/doc.md");
  const editor = page.getByTestId("markdown-editor");
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(editor).toContainText(/Migration/, { timeout: 20_000 });
  await expect(editor).toContainText(/Unprojected live edit/, { timeout: 20_000 });

  const docPath = join(seeded.root, "notes", "doc.md");
  await expect
    .poll(async () => readFile(docPath, "utf8").catch(() => ""), { timeout: 30_000 })
    .toContain("Unprojected live edit");
  expect(existsSync(`${docPath}.conflict`)).toBe(false);
  await app.close();
});

test("a personal local workspace edits fully without any collab server", async () => {
  // Same desktop build, NO cloud / NO hocuspocus URL: markdown stays the plain
  // local editor (collabToken returns available:false). Proves local-first is
  // never gated on the collab stack.
  const home = await mkdtemp(join(tmpdir(), "dohc-co-local-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-co-localws-")), "workspace");
  await mkdir(join(root, "notes"), { recursive: true });
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId: "co-local-ws", kind: "personal", mode: "local-first" }),
  );
  await writeFile(join(root, "notes", "doc.md"), "# Local only\n");

  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await openInTree(page, "notes/doc.md");
  await expect(page.getByTestId("view-markdown")).toBeVisible();
  // The local edit toggle exists; the collab editor never appears.
  await expect(page.getByTestId("markdown-edit-toggle")).toBeVisible();
  await expect(page.getByTestId("collab-editor")).toHaveCount(0);
  await app.close();
});
