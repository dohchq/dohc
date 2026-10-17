// Bundled by drill.docker.test.mjs and run inside the release image while the relay is stopped.
// Writes go through relay storage, so each one advances continuity like a real request.
import { createHash } from "node:crypto";
import { openRelayDeployment } from "../../services/sync-relay/src/relayDeployment.ts";

const workspaceId = "drill-workspace", text = "# Packing list\n";
const sha256 = createHash("sha256").update(text).digest("hex");
const action = process.argv[2];
if (action !== "seed" && action !== "verify") throw new Error("Use seed or verify.");
const { storage } = openRelayDeployment(process.env.DOHC_RELAY_DEPLOYMENT_CONFIG);
try {
  if (action === "seed") {
    storage.claimWorkspace({ workspaceId, ownerUserId: "drill-owner", createdAtMs: 1 });
    storage.putBlob({ workspaceId, sha256, content: Buffer.from(text), createdAtMs: 1 });
    storage.appendLogBatch({ workspaceId, originId: "drill-origin", ops: [{ originSeq: 0, opKind: "moment.append", recordedAtMs: 1,
      payloadJson: JSON.stringify({ momentId: "drill-moment", versionId: "main", objectId: "drill-object", path: "packing.md",
        recordedAtMs: 1, operation: "write", payloadBeforeBlobSha256: null, payloadBeforePath: null,
        payloadAfterBlobSha256: sha256, payloadAfterPath: "packing.md", metadata: { origin: "user" }, beforePresent: "null" }) }] });
    storage.createShare({
      share: { shareId: "drill-share", workspaceId, granterUserId: "drill-owner", selectorJson: JSON.stringify({ paths: ["packing.md"], versionId: null }), createdAtMs: 2 },
      grant: { grantId: "drill-grant", shareId: "drill-share", principalKind: "user", principalUserId: "drill-reader", principalEmail: null,
        access: "view", generation: 1, status: "active", createdAtMs: 2, revokedAtMs: null, parentGrantId: null },
    });
  }
  const blob = storage.getBlob(workspaceId, sha256);
  console.log(JSON.stringify({
    files: storage.readCurrentFileState({ workspaceId, versionId: "main", selectorPaths: [], limit: 10 }).files.map(file => file.path),
    blob: blob ? Buffer.from(blob).toString("utf8") : null,
    share: storage.getShare("drill-share")?.workspaceId ?? null,
    grant: storage.getShareGrant("drill-grant")?.principalUserId ?? null,
  }));
} finally { storage.close(); }
