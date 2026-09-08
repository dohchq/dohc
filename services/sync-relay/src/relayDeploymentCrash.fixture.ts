import { DatabaseSync } from "node:sqlite";
import { openRelayDeployment } from "./relayDeployment";

const [configPath, boundary] = process.argv.slice(2);
if (boundary === "contender") {
  try { openRelayDeployment(configPath!); } catch { process.exit(0); }
  throw new Error("A competing process acquired the live deployment.");
}
const { storage } = openRelayDeployment(configPath!);
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql: string) {
  const relay = sql === "COMMIT" && this.prepare("SELECT 1 FROM sqlite_schema WHERE name='sync_relay_continuity'").get();
  if (relay && boundary === "before-commit") process.exit(81);
  const result = exec.call(this, sql);
  if (relay && boundary === "after-commit") process.exit(82);
  return result;
};
storage.claimWorkspace({ workspaceId: "interrupted", ownerUserId: "owner", createdAtMs: 1 });
throw new Error("The selected interruption boundary was not reached.");
