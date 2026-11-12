import { expect, it } from "vitest";
import { createLiveValidationExecutor } from "./liveValidation.js";
import { nestedEmphasis, sha256 } from "./liveValidation.fixture.js";

it("keeps a worker thread's stack for deeply nested emphasis", async () => {
  const pool = createLiveValidationExecutor(), { source, checkpoint } = nestedEmphasis(2400);
  try {
    // A child's default stack refuses this witness instead of verifying it.
    expect(await pool.normalizeSettlement({
      document: { workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "lineage" },
      currentPath: "note.md", checkpoint,
    })).toMatchObject({ kind: "accepted", evidence: { projectedMarkdownSha256: sha256(source) } });
  } finally { await pool.close(); }
}, 120_000);
