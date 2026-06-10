import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./launch";

// The full Phase 9 story over real wires: login (device flow), enable sync
// (claims the workspace on the server), local edits PUSH to Postgres, and
// server-side changes PULL into the local folder on next launch — with the
// local workspace's identity, history, and files surviving everything.
// Requires live Postgres (pnpm dev:postgres); the spec boots workspace-api.

const PORT = 17893;
const SERVER_URL = `http://localhost:${PORT}`;
let server: ChildProcess;

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${SERVER_URL}/health`)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`workspace-api not healthy on :${PORT} — run pnpm dev:postgres first`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

test.beforeAll(async () => {
  server = spawn(
    process.execPath,
    [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "src/main.ts"],
    {
      cwd: join(process.cwd(), "services/workspace-api"),
      env: { ...process.env, DOHC_TEST_AUTH: "1", WORKSPACE_API_PORT: String(PORT) },
      stdio: "ignore",
    },
  );
  await waitForHealth();
});

test.afterAll(() => {
  server?.kill("SIGTERM");
});

// A session token for server-side assertions, minted through the same device
// flow + test seam the app uses (same seeded test user => same membership).
async function mintToken(): Promise<string> {
  const code = (await (
    await fetch(`${SERVER_URL}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "dohc-e2e" }),
    })
  ).json()) as { device_code: string; user_code: string };
  await fetch(`${SERVER_URL}/test/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode: code.user_code }),
  });
  await new Promise((r) => setTimeout(r, 3200));
  const token = (await (
    await fetch(`${SERVER_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: "dohc-e2e",
      }),
    })
  ).json()) as { access_token?: string };
  if (!token.access_token) throw new Error("could not mint e2e token");
  return token.access_token;
}

async function serverFiles(token: string, workspaceId: string): Promise<Map<string, string>> {
  const data = (await (
    await fetch(`${SERVER_URL}/workspaces/${workspaceId}/files`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as { files?: Array<{ path: string; revision: string }> };
  return new Map((data.files ?? []).map((f) => [f.path, f.revision]));
}

test("local edits push to the cloud; remote changes pull on relaunch; local survives", async () => {
  // Unique per run: the server claim is permanent in the dev database.
  const wsId = `sync-e2e-${Date.now()}`;
  const home = await mkdtemp(join(tmpdir(), "dohc-sync-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-sync-")), "workspace");
  await mkdir(join(root, "notes"), { recursive: true });
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId: wsId, kind: "personal", mode: "local-first" }),
  );
  await writeFile(join(root, "notes", "first.md"), "# Written before sync");
  const env = { DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root, DOHC_CLOUD_URL: SERVER_URL };

  // --- Login + enable sync ---
  const app = await launchApp(env);
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await page.getByRole("button", { name: /connect dohc cloud/i }).click();
  await page.getByTestId("cloud-connect-start").click();
  const userCode = (await page.getByTestId("cloud-user-code").textContent({ timeout: 15_000 }))
    ?.trim();
  await fetch(`${SERVER_URL}/test/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode }),
  });
  await expect(page.getByTestId("cloud-connected-email")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("cloud-enable-sync").click();
  await expect(page.getByTestId("cloud-workspace-synced")).toBeVisible({ timeout: 30_000 });

  // --- Push: the pre-existing local file lands on the server ---
  const token = await mintToken();
  await expect
    .poll(async () => (await serverFiles(token, wsId)).has("notes/first.md"), {
      timeout: 30_000,
    })
    .toBe(true);

  // --- Push: a NEW local edit flows automatically (watcher -> engine) ---
  await writeFile(join(root, "notes", "second.md"), "# Made after sync enabled");
  await expect
    .poll(async () => (await serverFiles(token, wsId)).has("notes/second.md"), {
      timeout: 30_000,
    })
    .toBe(true);
  await app.close();

  // --- Server-side change while the app is closed ---
  const put = await fetch(`${SERVER_URL}/workspaces/${wsId}/files/notes/from-cloud.md`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ body: "# Hello from the cloud" }),
  });
  expect(put.ok).toBe(true);

  // --- Pull on relaunch: the remote file materializes locally, merged ---
  const second = await launchApp(env);
  const page2 = await second.firstWindow();
  await expect(page2.getByTestId("workspace-shell")).toBeVisible();
  await expect(
    page2.getByTestId("file-tree").getByText("notes/from-cloud.md", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  expect(readFileSync(join(root, "notes", "from-cloud.md"), "utf8")).toBe(
    "# Hello from the cloud",
  );

  // The merge engine never clobbered the living workspace: identity manifest,
  // history, and the original files are intact.
  const identity = JSON.parse(readFileSync(join(root, ".dohc", "manifest.json"), "utf8"));
  expect(identity).toMatchObject({ workspaceId: wsId, kind: "personal", mode: "local-first" });
  expect(existsSync(join(root, ".dohc", "history"))).toBe(true);
  expect(readFileSync(join(root, "notes", "first.md"), "utf8")).toBe("# Written before sync");
  await second.close();
});
