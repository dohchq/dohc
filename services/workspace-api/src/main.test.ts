import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { createWorkspaceAuth } from "@dohc/workspace-auth/betterAuth";
import pg from "pg";
import { afterAll, beforeAll, describe, test } from "vitest";
import { fileURLToPath } from "node:url";

const SERVICE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SECRET = "test-secret-with-at-least-32-characters";

for (const nodeEnv of [undefined, "production", "staging"]) {
  for (const postgresUrl of [undefined, "", "   "]) {
    test(`refuses missing database configuration in ${nodeEnv ?? "unset NODE_ENV"}: ${JSON.stringify(postgresUrl)}`, () => {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: SERVICE_ROOT,
        env: {
          ...process.env,
          NODE_ENV: nodeEnv,
          POSTGRES_URL: postgresUrl,
          BETTER_AUTH_SECRET: SECRET,
          DOHC_TEST_AUTH: undefined,
        },
        encoding: "utf8",
        windowsHide: true,
        // tsx compiles main.ts on startup. A loaded run passed 20 s, so this
        // matches sync-relay's 45 s tsx startup bound, inside the 60 s test.
        timeout: 45_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /POSTGRES_URL must be set outside development\/test/);
      assert.doesNotMatch(result.stdout, /listening/);
    }, 60_000);
  }
}

// Runs against the development Postgres (`pnpm dev:postgres`) in a throwaway
// schema, so signing out unverified accounts cannot touch another suite's.
const POSTGRES_URL = process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc";

async function postgresReachable(): Promise<boolean> {
  const probe = new pg.Client({ connectionString: POSTGRES_URL, connectionTimeoutMillis: 2000 });
  try {
    await probe.connect();
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!(await postgresReachable()))("startup", () => {
  const schema = `workspace_api_startup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaUrl = `${POSTGRES_URL}${POSTGRES_URL.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  let client: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: POSTGRES_URL });
    await client.connect();
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}"`);
    await client.query(
      await readFile(new URL("../../../packages/workspace-postgres/src/db/migrations/0001_better_auth.sql", import.meta.url), "utf8"),
    );
    pool = new pg.Pool({ connectionString: schemaUrl });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await client?.query(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await client?.end().catch(() => undefined);
  });

  /** One verified and one unverified account, each signed in while sign-up was open. */
  async function signedInAccounts(): Promise<{ verified: string; unverified: string }> {
    const auth = createWorkspaceAuth({ pool, baseURL: "http://localhost:1786", secret: SECRET, sendEmail: async () => undefined });
    const signUp = (name: string) =>
      auth.api.signUpEmail({ body: { email: `${name}-${Date.now()}@dohc.test`, password: "a-real-password-123", name } });
    const verified = (await signUp("verified")).user.id;
    const unverified = (await signUp("unverified")).user.id;
    await pool.query('update "user" set "emailVerified" = true where id = $1', [verified]);
    // A desktop sign-in approved before the restart and not yet collected.
    await pool.query(
      `insert into "deviceCode" ("id", "deviceCode", "userCode", "userId", "expiresAt", "status")
       values ($1, $1, $1, $2, now() + interval '10 minutes', 'approved')`,
      [`device-${unverified}`, unverified],
    );
    return { verified, unverified };
  }

  async function signIns(userId: string): Promise<{ sessions: number; deviceCodes: number }> {
    const { rows } = await pool.query<{ sessions: number; deviceCodes: number }>(
      `select (select count(*) from "session" where "userId" = $1)::int as sessions,
              (select count(*) from "deviceCode" where "userId" = $1)::int as "deviceCodes"`,
      [userId],
    );
    return rows[0]!;
  }

  /** Starts workspace-api, waits until it listens, then stops it. */
  async function startServer(signUpEmails: string | null): Promise<void> {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const inherited = Object.entries(process.env).filter(([key]) => !/^(DOHC_|WORKSPACE_API_|BETTER_AUTH_|POSTGRES_)/.test(key));
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: SERVICE_ROOT,
      env: {
        ...Object.fromEntries(inherited),
        NODE_ENV: "test",
        POSTGRES_URL: schemaUrl,
        BETTER_AUTH_SECRET: SECRET,
        WORKSPACE_API_PORT: String(port),
        ...(signUpEmails ? { DOHC_SIGN_UP_EMAILS: signUpEmails, WORKSPACE_API_RELAY_URL: "http://127.0.0.1:9" } : {}),
      },
      windowsHide: true,
    });
    let output = "";
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("listening")) resolve();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.on("exit", (code) => reject(new Error(`workspace-api exited with ${code} before it listened:\n${output}`)));
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, "exit");
      }
    }
  }

  test("with a list, signs out accounts without a verified email before it serves requests", async () => {
    const { verified, unverified } = await signedInAccounts();
    await startServer("listed@dohc.test");
    assert.deepEqual(await signIns(unverified), { sessions: 0, deviceCodes: 0 });
    assert.deepEqual(await signIns(verified), { sessions: 1, deviceCodes: 0 });
  }, 60_000);

  test("with no list, signs nobody out", async () => {
    const { verified, unverified } = await signedInAccounts();
    await startServer(null);
    assert.deepEqual(await signIns(unverified), { sessions: 1, deviceCodes: 1 });
    assert.deepEqual(await signIns(verified), { sessions: 1, deviceCodes: 0 });
  }, 60_000);
});
