import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { startSmtpCapture } from "./smtpCapture";

export const ACCOUNT_TEST_SECRET = "disposable-account-browser-acceptance-secret-0123456789";

export async function startAccountServer(options: { relayUrl?: string; shareUrl?: string; port?: number; publicOrigin?: string } = {}) {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString || process.env.DOHC_REQUIRE_POSTGRES !== "1") {
    throw new Error("Account browser acceptance requires an explicit disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.");
  }
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 2000 });
  await pool.query(await readFile(new URL("../../../packages/workspace-postgres/src/db/migrations/0001_better_auth.sql", import.meta.url), "utf8"));
  const port = options.port ?? await availablePort();
  const listenOrigin = `http://127.0.0.1:${port}`;
  const origin = options.publicOrigin ?? listenOrigin;
  const mail = await startSmtpCapture();
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: "test",
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
  const exit = new Promise<void>(resolve => child.once("exit", () => { exited = true; resolve(); }));
  const ready = await new Promise<void>((resolve, reject) => {
    const abort = setTimeout(() => reject(new Error("Account server did not start within 20 seconds.")), 20_000);
    child.once("error", error => { clearTimeout(abort); reject(error); });
    child.once("exit", code => { clearTimeout(abort); reject(new Error(`Account server exited before startup (${code}). ${logs}`)); });
    const inspect = () => {
      if (logs.includes("listening on")) { clearTimeout(abort); resolve(); }
    };
    child.stdout.on("data", inspect);
  }).catch(async error => {
    child.kill();
    await mail.close();
    await pool.end();
    throw error;
  });
  void ready;
  return {
    origin, listenOrigin, mail, pool, pid: child.pid,
    logs: () => logs,
    async close() {
      if (!exited) child.kill();
      await exit;
      await mail.close();
      await pool.end();
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
