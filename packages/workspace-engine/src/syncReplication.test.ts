import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceId } from "@dohc/workspace-contracts/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openEngineDb } from "./syncApply";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import { ensureOriginId } from "./syncReplication";

const WORKSPACE_ID = "ws_replication_seam" as WorkspaceId;

describe("ensureOriginId determinism seam", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dohc-replication-seam-"));
  });

  afterEach(async () => {
    closeTrackedEngineDbHandlesForTest();
    await rm(root, { recursive: true, force: true });
  });

  it("uses the injected createId when minting a new origin id", () => {
    const db = openEngineDb(root);
    try {
      const originId = ensureOriginId(db, WORKSPACE_ID, () => "origin_fixed");
      expect(originId).toBe("origin_fixed");
      // Idempotent: the persisted id is returned on subsequent calls, so the
      // injected factory is only consulted when no identity exists yet.
      expect(ensureOriginId(db, WORKSPACE_ID, () => "origin_other")).toBe("origin_fixed");
    } finally {
      db.close();
    }
  });

  it("defaults to a real random origin id when no factory is injected", () => {
    const db = openEngineDb(root);
    try {
      const originId = ensureOriginId(db, WORKSPACE_ID);
      expect(originId).toMatch(/^origin_[0-9a-f-]{36}$/);
    } finally {
      db.close();
    }
  });
});
