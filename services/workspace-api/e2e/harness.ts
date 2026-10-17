import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { applyMigrations } from "../../../scripts/lib/apply-migrations.mjs";
import { startSmtpCapture } from "./smtpCapture";

export const ACCOUNT_TEST_SECRET = "disposable-account-browser-acceptance-secret-0123456789";

// The relay and the account server read every migration's tables, such as account
// deletion's jobs. Parallel account servers share a database, so all migrations
// run under one session lock, on the client that holds it.
async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('dohc_migrations'))");
    try { await applyMigrations(client); }
    finally { await client.query("select pg_advisory_unlock(hashtext('dohc_migrations'))"); }
  } finally { client.release(); }
}

export async function startAccountServer(options: { relayUrl?: string; shareUrl?: string; port?: number; publicOrigin?: string; signal?: AbortSignal } = {}) {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString || process.env.DOHC_REQUIRE_POSTGRES !== "1") {
    throw new Error("Account browser acceptance requires an explicit disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.");
  }
  // Under the full JS gate a 2 s connect bound timed out against a healthy
  // database; a refused connection still fails at once.
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 30_000 });
  await migrate(pool);
  const port = options.port ?? await availablePort();
  const listenOrigin = `http://127.0.0.1:${port}`;
  const origin = options.publicOrigin ?? listenOrigin;
  const mail = await startSmtpCapture();
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: "production",
      DOHC_TEST_AUTH: undefined,
      BETTER_AUTH_SECRET: ACCOUNT_TEST_SECRET,
      WORKSPACE_API_PORT: String(port),
      WORKSPACE_API_BASE_URL: origin,
      DOHC_SERVER_RELAY_URL: options.relayUrl ?? origin,
      DOHC_WEB_ORIGIN: options.shareUrl ?? origin,
      DOHC_SMTP_HOST: "127.0.0.1",
      DOHC_SMTP_PORT: String(mail.port),
      DOHC_SMTP_SECURE: "false",
      DOHC_SMTP_USER: undefined,
      DOHC_SMTP_PASSWORD: undefined,
      DOHC_SMTP_FROM: "dohc <noreply@example.test>",
      DOHC_AUTH_TRUSTED_PROXIES: undefined,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs = (logs + String(chunk)).slice(-16_384); });
  child.stderr.on("data", chunk => { logs = (logs + String(chunk)).slice(-16_384); });
  let exited = false;
  const killOnExit = () => { child.kill(); };
  process.once("exit", killOnExit);
  const exit = new Promise<void>(resolve => child.once("close", () => {
    exited = true;
    process.off("exit", killOnExit);
    resolve();
  }));
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let lastReadyBody = "No HTTP response.";
  let childError: Error | undefined;
  const onError = (error: Error) => { childError = error; controller.abort(error); };
  const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => controller.abort(new Error(`Account server exited before readiness (code ${code}, signal ${exitSignal}).`));
  child.on("error", onError);
  child.once("exit", onExit);
  try {
    while (true) {
      signal.throwIfAborted();
      try {
        const response = await fetch(`${listenOrigin}/ready`, { signal });
        lastReadyBody = await response.text();
        const report: { ok?: unknown } | null = JSON.parse(lastReadyBody);
        signal.throwIfAborted();
        if (response.ok && report?.ok === true) break;
      } catch {
        signal.throwIfAborted();
      }
      await delay(100, undefined, { signal });
    }
  } catch (error) {
    if (!exited) child.kill();
    await exit;
    await mail.close();
    await pool.end();
    const failure = signal.aborted ? signal.reason : error;
    const reason = failure instanceof Error ? failure.message : String(failure);
    throw new Error(`Account server startup failed: ${reason}\nLast /ready body: ${lastReadyBody}\nLogs:\n${logs}`, { cause: failure });
  } finally {
    child.off("exit", onExit);
  }
  return {
    origin, listenOrigin, mail, pool, pid: child.pid,
    logs: () => logs,
    async close() {
      try {
        if (!exited) child.kill();
        if (childError) throw childError;
        if (!exited) await once(child, "close");
      } finally {
        await mail.close();
        await pool.end();
      }
    },
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No account server port.");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
