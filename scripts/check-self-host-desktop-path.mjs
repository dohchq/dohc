import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Proves the DESKTOP can connect to a local self-host/cloud endpoint by
// exercising the exact surfaces apps/desktop/src/workspaces/cloudLogin.ts
// uses: GET /health, then the device-authorization flow
// (POST /api/auth/device/code with client_id "dohc-desktop", and one
// authorization-pending poll of POST /api/auth/device/token).
//
// Endpoint selection:
//   1. DOHC_CLOUD_URL, if set (e.g. the compose stack on :1786) — reused.
//   2. http://localhost:1786 if already healthy (pnpm dev:cloud) — reused.
//   3. Otherwise boots its own workspace-api on :17897 the same way
//      e2e/cloudLogin.spec.ts does (NODE_ENV=test + DOHC_TEST_AUTH=1, which
//      binds loopback only) against the dev Postgres (pnpm dev:postgres).
//
// Cleanup touches ONLY the child this script spawned: kill -TERM by exact
// pid via the handle. Never a pattern kill (WSL safety).

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF_BOOT_PORT = 17897;
const HEALTH_TIMEOUT_MS = 30_000;
const CLIENT_ID = "dohc-desktop";

let child = null;
let childLog = "";

function fail(blocker) {
  console.error(`\nBLOCKER: ${blocker}`);
  if (childLog.trim()) {
    console.error("--- workspace-api output (last 2000 chars) ---");
    console.error(childLog.slice(-2000));
  }
  process.exitCode = 1;
}

function ok(name, detail) {
  console.log(`[ok] ${name}${detail ? ` - ${detail}` : ""}`);
}

async function healthy(base) {
  try {
    const response = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

function bootWorkspaceApi() {
  const tsxCli = join(ROOT, "node_modules/tsx/dist/cli.mjs");
  if (!existsSync(tsxCli)) {
    throw new Error("node_modules/tsx is missing — run pnpm install first.");
  }
  const proc = spawn(process.execPath, [tsxCli, "src/main.ts"], {
    cwd: join(ROOT, "services/workspace-api"),
    env: {
      ...process.env,
      // Same boot the desktop E2E uses: the fail-closed test seam requires
      // NODE_ENV dev/test and makes BETTER_AUTH_SECRET optional; the server
      // then binds 127.0.0.1 only.
      NODE_ENV: "test",
      DOHC_TEST_AUTH: "1",
      WORKSPACE_API_PORT: String(SELF_BOOT_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (chunk) => (childLog += chunk));
  proc.stderr.on("data", (chunk) => (childLog += chunk));
  return proc;
}

async function stopChild() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM"); // exact pid we spawned; never a pattern kill
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
}

async function resolveEndpoint() {
  if (process.env.DOHC_CLOUD_URL) {
    const base = process.env.DOHC_CLOUD_URL.replace(/\/+$/, "");
    if (!(await healthy(base))) {
      throw new Error(
        `DOHC_CLOUD_URL=${base} is not healthy. Start the stack first ` +
          "(pnpm dev:cloud, or pnpm check:self-host -- --start).",
      );
    }
    ok("endpoint", `${base} (DOHC_CLOUD_URL, reused)`);
    return base;
  }

  const devCloud = "http://localhost:1786";
  if (await healthy(devCloud)) {
    ok("endpoint", `${devCloud} (already running, reused)`);
    return devCloud;
  }

  const base = `http://localhost:${SELF_BOOT_PORT}`;
  console.log(`booting workspace-api on :${SELF_BOOT_PORT} (NODE_ENV=test)…`);
  child = bootWorkspaceApi();
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `workspace-api exited with code ${child.exitCode} during boot. ` +
          "Is the dev Postgres up? (pnpm dev:postgres)",
      );
    }
    if (await healthy(base)) {
      ok("endpoint", `${base} (booted by this script, pid ${child.pid})`);
      return base;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `workspace-api did not become healthy on :${SELF_BOOT_PORT} within ` +
      `${HEALTH_TIMEOUT_MS / 1000}s. Is the dev Postgres up? (pnpm dev:postgres)`,
  );
}

async function checkDeviceFlow(base) {
  // Step 1 of the desktop login: request a device code.
  const codeResponse = await fetch(`${base}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(10_000),
  });
  const codeBody = await codeResponse.json().catch(() => null);
  if (!codeResponse.ok || !codeBody?.device_code || !codeBody?.user_code) {
    throw new Error(
      `POST /api/auth/device/code failed (${codeResponse.status}): ` +
        `${JSON.stringify(codeBody)}. If this is a 500, the Better Auth ` +
        "tables are likely missing — apply " +
        "packages/workspace-postgres/src/db/migrations/0002_better_auth.sql.",
    );
  }
  ok(
    "device flow: code issued",
    `user_code ${codeBody.user_code}, verification_uri ${codeBody.verification_uri}`,
  );

  // Step 2 of the desktop login: poll for the token. Unapproved must read as
  // authorization_pending — the same signal the desktop's poll loop handles.
  const tokenResponse = await fetch(`${base}/api/auth/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: codeBody.device_code,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const tokenBody = await tokenResponse.json().catch(() => null);
  if (tokenBody?.error !== "authorization_pending" && tokenBody?.error !== "slow_down") {
    throw new Error(
      `POST /api/auth/device/token did not report authorization_pending for ` +
        `an unapproved code (${tokenResponse.status}): ${JSON.stringify(tokenBody)}`,
    );
  }
  ok("device flow: token poll", `unapproved code reports ${tokenBody.error}`);
}

try {
  const base = await resolveEndpoint();
  await checkDeviceFlow(base);
  console.log(
    "\nSelf-host desktop path OK: the auth surface the desktop needs is live.",
  );
  console.log(`Connect a desktop with: DOHC_CLOUD_URL=${base} pnpm dev:desktop`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await stopChild();
}
