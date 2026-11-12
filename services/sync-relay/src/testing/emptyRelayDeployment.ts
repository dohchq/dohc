import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeRelayDeployment, openRelayDeployment } from "../relayDeployment";

type Paths = Parameters<typeof initializeRelayDeployment>[0];
const databasePaths = (paths: Paths) => [paths.relayPath, join(paths.continuityDirectory, "lock.sqlite"), join(paths.continuityDirectory, "continuity.sqlite")];
let emptyImages: Buffer[] | undefined;

/** Copies one closed deployment schema, with independent files and continuity identity. */
export function openEmptyRelayTestDeployment(paths: Paths) {
  if (!emptyImages) {
    const root = mkdtempSync(join(tmpdir(), "dohc-empty-deployment-"));
    const seed = { configPath: join(root, "deployment.json"), relayPath: join(root, "relay", "relay.sqlite"), continuityDirectory: join(root, "continuity") };
    try {
      initializeRelayDeployment(seed);
      openRelayDeployment(seed.configPath).storage.close();
      emptyImages = databasePaths(seed).map(path => readFileSync(path));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  mkdirSync(dirname(paths.relayPath), { recursive: true });
  mkdirSync(dirname(paths.configPath), { recursive: true });
  mkdirSync(paths.continuityDirectory, { mode: 0o700 });
  databasePaths(paths).forEach((path, index) => writeFileSync(path, emptyImages![index]!, { flag: "wx" }));
  const namespace = randomUUID(), nonce = randomUUID();
  const updates = [
    [paths.relayPath, "UPDATE sync_relay_continuity SET namespace=?,nonce=?", [namespace, nonce]],
    [join(paths.continuityDirectory, "lock.sqlite"), "UPDATE deployment SET namespace=?", [namespace]],
    [join(paths.continuityDirectory, "continuity.sqlite"), "UPDATE continuity SET namespace=?,confirmed_nonce=?", [namespace, nonce]],
  ] as const;
  for (const [path, sql, values] of updates) {
    const db = new DatabaseSync(path);
    try { db.prepare(sql).run(...values); } finally { db.close(); }
  }
  writeFileSync(paths.configPath, JSON.stringify({ version: 1, generation: 1, namespace, relayPath: paths.relayPath, continuityDirectory: paths.continuityDirectory }) + "\n", { flag: "wx", mode: 0o600, flush: true });
  return openRelayDeployment(paths.configPath);
}
