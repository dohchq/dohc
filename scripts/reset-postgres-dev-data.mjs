import pg from "pg";
import { applyMigrations } from "./lib/apply-migrations.mjs";

const url =
  process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc";

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  // Ensure the auth schema is present before truncating it.
  await applyMigrations(client);
  await client.query(`
    truncate table
      "account",
      "session",
      "verification",
      "member",
      "invitation",
      "organization",
      "deviceCode",
      "user"
    restart identity cascade
  `);
} finally {
  await client.end();
}
