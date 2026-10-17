import { DatabaseSync } from "node:sqlite";
import { openRelayDeployment } from "./relayDeployment";

const [configPath, boundary] = process.argv.slice(2);
if (boundary === "contender") {
  try { openRelayDeployment(configPath!); } catch (error) {
    if (error instanceof Error && "errcode" in error && error.errcode === 5 && error.message === "database is locked") {
      process.exit(0);
    }
    throw error;
  }
  throw new Error("A competing process acquired the live deployment.");
}
const exec = DatabaseSync.prototype.exec;
const prepare = DatabaseSync.prototype.prepare;
function installCrash() {
  DatabaseSync.prototype.prepare = function(sql: string) {
    if (sql === "PRAGMA wal_checkpoint(FULL)" && boundary === "before-checkpoint" && prepare.call(this, "SELECT 1 FROM sqlite_schema WHERE name='sync_relay_continuity'").get()) process.exit(83);
    return prepare.call(this, sql);
  };
  DatabaseSync.prototype.exec = function(sql: string) {
    if (sql === "BEGIN IMMEDIATE" && boundary === "after-checkpoint" && this.prepare("SELECT 1 FROM sqlite_schema WHERE name='continuity'").get()) process.exit(84);
    const relay = sql === "COMMIT" && this.prepare("SELECT 1 FROM sqlite_schema WHERE name='sync_relay_continuity'").get();
    const side = sql === "COMMIT" && this.prepare("SELECT 1 FROM sqlite_schema WHERE name='continuity'").get();
    if (relay && boundary === "before-commit") process.exit(81);
    if (side && boundary === "before-settlement-commit") process.exit(85);
    const result = exec.call(this, sql);
    if (relay && boundary === "after-commit") process.exit(82);
    if (side && boundary === "after-settlement-commit") process.exit(86);
    return result;
  };
}
if (boundary !== "before-commit" && boundary !== "after-commit") installCrash();
const { storage } = openRelayDeployment(configPath!);
if (boundary === "before-commit" || boundary === "after-commit") installCrash();
storage.claimWorkspace({ workspaceId: "interrupted", ownerUserId: "owner", createdAtMs: 1 });
throw new Error("The selected interruption boundary was not reached.");
