import { describe, expect, it } from "vitest";
import type { JsonValue } from "../ydoc/generated/serde_json/JsonValue";
import type { Request } from "../ydoc/generated/Request";
import type { JsonObject } from "../ydoc/ydocWireContract";
import { VersionedLoopbackEngine } from "./versionedLoopbackEngine";
import {
  VERSIONED_METHOD,
  VersionedProtocolShapeError,
  decodeMomentsGetResult,
  decodeMomentsListResult,
  decodeSecretApplyResult,
  decodeSecretCompareResult,
  decodeSecretDeleteResult,
  decodeSecretRestoreResult,
  decodeSecretWriteResult,
  decodeSecretsMomentsGetResult,
  decodeSecretsMomentsListResult,
  decodeVersionRecord,
  decodeVersionedBinaryReadBlobResult,
  decodeVersionedBinaryReadResult,
  decodeVersionedBinaryWriteResult,
  decodeVersionedTextDeleteResult,
  decodeVersionedTextRenameResult,
  decodeVersionedTextRollbackResult,
  decodeVersionedTextReadResult,
  decodeVersionedTextWriteResult,
  decodeVersionsActiveResult,
  decodeVersionsCompareFilesResult,
  type MomentsGetParams,
  type MomentsListParams,
  type SearchEnsureIndexParams,
  type SecretsApplyParams,
  type SecretsCompareParams,
  type SecretsDeleteParams,
  type SecretsForkParams,
  type SecretsMomentsGetParams,
  type SecretsMomentsListParams,
  type SecretsRestoreParams,
  type SecretsWriteParams,
  type VersionedBinaryReadBlobParams,
  type VersionedBinaryReadParams,
  type VersionedBinaryWriteParams,
  type VersionedTextDeleteParams,
  type VersionedTextListParams,
  type VersionedTextRenameParams,
  type VersionedTextRollbackParams,
  type VersionedTextReadParams,
  type VersionedTextWriteParams,
  type VersionsCompareFilesParams,
  type VersionsCompareParams,
  type VersionsCreateNamedParams,
  type VersionsMergeParams,
  type VersionsSetActiveParams,
  type WorkspaceOnlyParams,
} from "./versionedWireContract";

const WORKSPACE = "workspace-loopback";

async function call(
  engine: VersionedLoopbackEngine,
  id: number,
  method: string,
  params: JsonObject,
  idempotencyKey?: string,
): Promise<JsonValue> {
  const request: Request = {
    id,
    method,
    workspace: WORKSPACE,
    params,
  };
  if (idempotencyKey !== undefined) request.idempotencyKey = idempotencyKey;
  return (await engine.sendRequest(request)).result;
}

describe("versioned typed loopback", () => {
  it("reads text writes, binary heads, and absent paths through versionedText.read", async () => {
    const engine = new VersionedLoopbackEngine();
    const textParams: VersionedTextWriteParams = {
      versionId: "main",
      objectId: "read-text-object",
      path: "read.md",
      text: "read body",
      momentId: "read-text-moment",
      origin: "api",
      nowMs: 10,
    };
    await call(engine, 1, VERSIONED_METHOD.textWrite, textParams);
    const readParams: VersionedTextReadParams = {
      versionId: "main",
      path: "read.md",
    };
    expect(
      decodeVersionedTextReadResult(
        await call(engine, 2, VERSIONED_METHOD.textRead, readParams),
      ),
    ).toMatchObject({
      workspaceId: WORKSPACE,
      versionId: "main",
      objectId: "read-text-object",
      path: "read.md",
      contentKind: "text",
      text: "read body",
      byteLength: 9,
      latestMomentId: "read-text-moment",
      metadataOrigin: "api",
    });

    await call(engine, 3, VERSIONED_METHOD.binaryWrite, {
      versionId: "main",
      objectId: "read-binary-object",
      path: "read.bin",
      bytes: [0, 1, 2],
      momentId: "read-binary-moment",
      origin: "api",
      nowMs: 11,
    });
    expect(
      decodeVersionedTextReadResult(
        await call(engine, 4, VERSIONED_METHOD.textRead, {
          versionId: "main",
          path: "read.bin",
        }),
      ),
    ).toMatchObject({
      workspaceId: WORKSPACE,
      versionId: "main",
      objectId: "read-binary-object",
      path: "read.bin",
      contentKind: "binary",
      text: "",
      byteLength: 3,
      latestMomentId: "read-binary-moment",
      metadataOrigin: "api",
    });
    expect(
      decodeVersionedTextReadResult(
        await call(engine, 5, VERSIONED_METHOD.textRead, {
          versionId: "main",
          path: "absent.md",
        }),
      ),
    ).toBeNull();
  });

  it("round-trips text and binary writes, reads, rename, delete, rollback, and list", async () => {
    const engine = new VersionedLoopbackEngine();
    const writeParams: VersionedTextWriteParams = {
      versionId: "main",
      objectId: "object-a",
      path: "a.md",
      text: "alpha",
      momentId: "moment-a",
      origin: "api",
      requestId: "request-a",
      nowMs: 10,
    };
    const written = decodeVersionedTextWriteResult(
      await call(engine, 1, VERSIONED_METHOD.textWrite, writeParams),
    );
    expect(written.snapshot.text).toBe("alpha");
    expect(written.moment.momentId).toBe("moment-a");

    // Daemon parity: overwriting an existing head with a requestId (and no
    // explicit objectId) keeps the file's ORIGINAL object identity — the
    // generated id binds new paths only.
    // MUTATION: apply the requestId-generated object id to existing heads -> fails.
    const overwrite = decodeVersionedTextWriteResult(
      await call(engine, 21, VERSIONED_METHOD.textWrite, {
        versionId: "main",
        path: "a.md",
        text: "alpha-2",
        origin: "api",
        requestId: "request-a-overwrite",
        nowMs: 11,
      }),
    );
    expect(overwrite.object.id).toBe("object-a");
    expect(overwrite.snapshot.objectId).toBe("object-a");
    expect(overwrite.moment.objectId).toBe("object-a");

    const listParams: VersionedTextListParams = { versionId: "main" };
    const listed = await call(engine, 2, VERSIONED_METHOD.textList, listParams);
    expect(listed).toMatchObject({
      files: [{ path: "a.md", contentKind: "text", byteLength: 7 }],
      nextAfterPath: null,
    });

    const renameParams: VersionedTextRenameParams = {
      versionId: "main",
      fromPath: "a.md",
      toPath: "renamed.md",
      origin: "api",
      requestId: "request-rename",
    };
    const renamed = decodeVersionedTextRenameResult(
      await call(engine, 3, VERSIONED_METHOD.textRename, renameParams),
    );
    expect(renamed.before.path).toBe("a.md");
    expect(renamed.after.path).toBe("renamed.md");

    const deleteParams: VersionedTextDeleteParams = {
      versionId: "main",
      path: "renamed.md",
      origin: "api",
      requestId: "request-delete",
    };
    const deleted = decodeVersionedTextDeleteResult(
      await call(engine, 4, VERSIONED_METHOD.textDelete, deleteParams),
    );
    expect(deleted.moment.operation).toBe("delete");

    const rollbackParams: VersionedTextRollbackParams = {
      versionId: "main",
      path: "renamed.md",
      mutationMomentId: deleted.moment.momentId,
      origin: "restore",
      requestId: "request-rollback",
    };
    expect(
      decodeVersionedTextRollbackResult(
        await call(engine, 5, VERSIONED_METHOD.textRollback, rollbackParams),
      ),
    ).toEqual({
      rolledBack: true,
      deduped: false,
      materializeEnqueued: true,
      materialized: true,
      materializeOutcome: "applied",
    });

    const binaryParams: VersionedBinaryWriteParams = {
      versionId: "main",
      path: "asset.bin",
      bytes: [0, 1, 254, 255],
      origin: "api",
      momentId: "moment-binary",
      requestId: "request-binary",
      nowMs: 10,
    };
    const binaryWrite = decodeVersionedBinaryWriteResult(
      await call(engine, 6, VERSIONED_METHOD.binaryWrite, binaryParams),
    );
    // MUTATION: ignore the binary request ledger -> a replay appends another moment.
    const binaryReplay = decodeVersionedBinaryWriteResult(
      await call(engine, 61, VERSIONED_METHOD.binaryWrite, {
        ...binaryParams,
        nowMs: 20,
      }),
    );
    // MUTATION: include nowMs in the binary fingerprint or replay the first materialization result -> fails.
    expect(binaryReplay).toMatchObject({
      deduped: true,
      materializeEnqueued: false,
      materialized: false,
      materializeOutcome: "skipped",
    });
    await expect(
      call(engine, 62, VERSIONED_METHOD.binaryWrite, {
        ...binaryParams,
        bytes: [9, 9, 9],
      }),
    ).rejects.toThrow("idempotency-key-reuse-mismatch");
    const binaryReadParams: VersionedBinaryReadParams = {
      versionId: "main",
      path: "asset.bin",
    };
    const binaryRead = decodeVersionedBinaryReadResult(
      await call(engine, 7, VERSIONED_METHOD.binaryRead, binaryReadParams),
    );
    expect(binaryRead?.bytesBase64).toBe("AAH+/w==");
    const blobParams: VersionedBinaryReadBlobParams = {
      workspaceId: WORKSPACE,
      sha256: binaryWrite.snapshot.sha256,
    };
    expect(
      decodeVersionedBinaryReadBlobResult(
        await call(engine, 8, VERSIONED_METHOD.binaryReadBlob, blobParams),
      ),
    ).toEqual({ bytesBase64: "AAH+/w==" });
  });

  it("round-trips version creation, activation, compare, merge, and compareFiles", async () => {
    const engine = new VersionedLoopbackEngine();
    engine.seedTextFile({ workspace: WORKSPACE, path: "seed.md", text: "main" });
    const activeParams: WorkspaceOnlyParams = { workspaceId: WORKSPACE };
    expect(
      decodeVersionRecord(
        await call(engine, 1, VERSIONED_METHOD.versionsActive, activeParams),
      ).id,
    ).toBe("main");
    expect(
      decodeVersionRecord(
        await call(engine, 2, VERSIONED_METHOD.versionsEnsureMain, activeParams),
      ).kind,
    ).toBe("main");

    const createParams: VersionsCreateNamedParams = {
      workspaceId: WORKSPACE,
      name: "feature",
      fromVersionId: "main",
    };
    const named = decodeVersionRecord(
      await call(engine, 3, VERSIONED_METHOD.versionsCreateNamed, createParams),
    );
    expect(named.forkPoint?.versionId).toBe("main");
    const setActiveParams: VersionsSetActiveParams = {
      workspaceId: WORKSPACE,
      versionId: named.id,
    };
    expect(
      decodeVersionRecord(
        await call(engine, 4, VERSIONED_METHOD.versionsSetActive, setActiveParams),
      ).id,
    ).toBe(named.id);

    engine.seedTextFile({
      workspace: WORKSPACE,
      versionId: named.id,
      path: "seed.md",
      text: "feature",
    });
    const compareParams: VersionsCompareParams = {
      path: "seed.md",
      sourceVersionId: named.id,
      targetVersionId: "main",
    };
    expect(
      await call(engine, 5, VERSIONED_METHOD.versionsCompare, compareParams),
    ).toEqual({ status: "merged" });
    const pageParams: VersionsCompareFilesParams = {
      sourceVersionId: named.id,
      targetVersionId: "main",
    };
    expect(
      decodeVersionsCompareFilesResult(
        await call(engine, 6, VERSIONED_METHOD.versionsCompareFiles, pageParams),
      ).entries,
    ).toEqual([{ path: "seed.md", status: "modified" }]);

    const mergeParams: VersionsMergeParams = {
      path: "seed.md",
      sourceVersionId: named.id,
      targetVersionId: "main",
      origin: "api",
      requestId: "merge-request",
    };
    expect(
      await call(engine, 7, VERSIONED_METHOD.versionsMerge, mergeParams),
    ).toMatchObject({ status: "merged", writeKind: "write", deduped: false });
    expect(
      await call(engine, 8, VERSIONED_METHOD.versionsMerge, mergeParams),
    ).toMatchObject({ status: "merged", writeKind: "write", deduped: true });
  });

  it("round-trips opaque secret write/fork/compare/apply/restore/delete and protected moments", async () => {
    const engine = new VersionedLoopbackEngine();
    const writeMain: SecretsWriteParams = {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
      text: "opaque-ciphertext-A",
      origin: "api",
      momentId: "secret-main",
    };
    expect(
      decodeSecretWriteResult(
        await call(engine, 1, VERSIONED_METHOD.secretsWrite, writeMain),
      ).changed,
    ).toBe(true);
    const createParams: VersionsCreateNamedParams = {
      workspaceId: WORKSPACE,
      name: "feature",
      fromVersionId: "main",
    };
    const named = decodeVersionRecord(
      await call(engine, 2, VERSIONED_METHOD.versionsCreateNamed, createParams),
    );
    const writeFeature: SecretsWriteParams = {
      ...writeMain,
      versionId: named.id,
      text: "opaque-ciphertext-B",
      momentId: "secret-feature",
    };
    decodeSecretWriteResult(
      await call(engine, 3, VERSIONED_METHOD.secretsWrite, writeFeature),
    );

    const compareParams: SecretsCompareParams = {
      workspaceId: WORKSPACE,
      sourceVersionId: named.id,
      targetVersionId: "main",
    };
    expect(
      decodeSecretCompareResult(
        await call(engine, 4, VERSIONED_METHOD.secretsCompare, compareParams),
      ).entries,
    ).toEqual([{ path: ".env", status: "modified" }]);

    await call(engine, 41, VERSIONED_METHOD.versionsSetActive, {
      workspaceId: WORKSPACE,
      versionId: named.id,
    });

    const applyParams: SecretsApplyParams = {
      workspaceId: WORKSPACE,
      path: ".env",
      sourceVersionId: named.id,
      targetVersionId: "main",
      momentId: "secret-apply",
      origin: "api",
      summary: "Updated .env from feature",
      correlationId: "merge-correlation-1",
    };
    const applied = decodeSecretApplyResult(
      await call(engine, 5, VERSIONED_METHOD.secretsApply, applyParams),
    );
    expect(applied.changed).toBe(true);
    // MUTATION: derive the target from the active version -> this moment is not in main.
    expect(applied.moment?.versionId).toBe("main");
    // MUTATION: loopback hardcodes sync or drops apply metadata -> this fails.
    expect(applied.moment?.metadata).toEqual({
      origin: "api",
      summary: "Updated .env from feature",
      correlationId: "merge-correlation-1",
    });
    expect(engine.secretValue(WORKSPACE, "main", ".env")).toBe(
      "opaque-ciphertext-B",
    );
    await call(engine, 42, VERSIONED_METHOD.versionsSetActive, {
      workspaceId: WORKSPACE,
      versionId: "main",
    });

    const restoreParams: SecretsRestoreParams = {
      workspaceId: WORKSPACE,
      path: ".env",
      beforeMomentId: "secret-apply",
      momentId: "secret-restore",
    };
    expect(
      decodeSecretRestoreResult(
        await call(engine, 6, VERSIONED_METHOD.secretsRestore, restoreParams),
      ).restored,
    ).toBe("text");
    expect(engine.secretValue(WORKSPACE, "main", ".env")).toBe(
      "opaque-ciphertext-A",
    );

    const forkParams: SecretsForkParams = {
      workspaceId: WORKSPACE,
      fromVersionId: "main",
      toVersionId: named.id,
    };
    expect(
      await call(engine, 7, VERSIONED_METHOD.secretsFork, forkParams),
    ).toEqual({});
    expect(engine.secretValue(WORKSPACE, named.id, ".env")).toBe(
      "opaque-ciphertext-A",
    );

    const listParams: SecretsMomentsListParams = {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
    };
    const secretMoments = decodeSecretsMomentsListResult(
      await call(engine, 8, VERSIONED_METHOD.secretsMomentsList, listParams),
    );
    expect(secretMoments.moments.every((moment) => moment.protected)).toBe(true);
    const getParams: SecretsMomentsGetParams = {
      workspaceId: WORKSPACE,
      momentId: "secret-main",
    };
    expect(
      decodeSecretsMomentsGetResult(
        await call(engine, 9, VERSIONED_METHOD.secretsMomentsGet, getParams),
      )?.id,
    ).toBe("secret-main");

    const deleteParams: SecretsDeleteParams = {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
      origin: "api",
      momentId: "secret-delete",
    };
    expect(
      decodeSecretDeleteResult(
        await call(engine, 10, VERSIONED_METHOD.secretsDelete, deleteParams),
      ).moment?.operation,
    ).toBe("delete");
  });

  it("round-trips widened moments params/get and search.ensureIndex", async () => {
    const engine = new VersionedLoopbackEngine();
    engine.seedTextFile({
      workspace: WORKSPACE,
      path: "large.md",
      text: "x".repeat(48 * 1024 + 1),
      objectId: "large-object",
      momentId: "large-moment",
    });
    const listParams: MomentsListParams = {
      versionId: "main",
      objectId: "large-object",
      limit: 10,
      beforeMomentOrder: Number.MAX_SAFE_INTEGER,
    };
    const listed = decodeMomentsListResult(
      await call(engine, 1, VERSIONED_METHOD.momentsList, listParams),
    );
    expect(listed.moments[0]).toMatchObject({
      afterText: null,
      afterInbandLimitBytes: 48 * 1024,
    });
    const getParams: MomentsGetParams = { momentId: "large-moment" };
    expect(
      decodeMomentsGetResult(
        await call(engine, 2, VERSIONED_METHOD.momentsGet, getParams),
      )?.afterText,
    ).toBeNull();
    const searchParams: SearchEnsureIndexParams = {
      workspaceId: WORKSPACE,
      versionId: "main",
    };
    expect(
      await call(engine, 3, VERSIONED_METHOD.searchEnsureIndex, searchParams),
    ).toEqual({});
  });
});

describe("loopback contract enforcement", () => {
  it("persists a fresh target merge moment and stamps the merged file head", async () => {
    const engine = new VersionedLoopbackEngine();
    engine.seedTextFile({
      workspace: WORKSPACE,
      versionId: "main",
      path: "merge.md",
      text: "main",
      momentId: "main-before-merge",
    });
    const feature = decodeVersionRecord(
      await call(engine, 1, VERSIONED_METHOD.versionsCreateNamed, {
        workspaceId: WORKSPACE,
        name: "feature",
        fromVersionId: "main",
      }),
    );
    engine.seedTextFile({
      workspace: WORKSPACE,
      versionId: feature.id,
      path: "merge.md",
      text: "feature",
      momentId: "source-before-merge",
    });

    await call(engine, 2, VERSIONED_METHOD.versionsMerge, {
      path: "merge.md",
      sourceVersionId: feature.id,
      targetVersionId: "main",
      origin: "api",
      requestId: "persist-merge",
    });

    const targetHead = decodeVersionedTextReadResult(
      await call(engine, 3, VERSIONED_METHOD.textRead, {
        versionId: "main",
        path: "merge.md",
      }),
    );
    const targetHistory = decodeMomentsListResult(
      await call(engine, 4, VERSIONED_METHOD.momentsList, {
        versionId: "main",
      }),
    );
    expect(targetHistory.moments[0]).toMatchObject({
      versionId: "main",
      path: "merge.md",
      operation: "write",
      metadataOrigin: "api",
    });
    expect(targetHistory.moments[0]?.momentId).not.toBe("source-before-merge");
    expect(targetHead?.latestMomentId).toBe(targetHistory.moments[0]?.momentId);
  });

  it("treats a same-moment same-value secret write retry as an equality no-op", async () => {
    const engine = new VersionedLoopbackEngine();
    const params: SecretsWriteParams = {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
      text: "same secret",
      origin: "api",
      momentId: "same-secret-moment",
    };
    expect(
      decodeSecretWriteResult(
        await call(engine, 1, VERSIONED_METHOD.secretsWrite, params),
      ).changed,
    ).toBe(true);

    expect(
      decodeSecretWriteResult(
        await call(engine, 2, VERSIONED_METHOD.secretsWrite, params),
      ),
    ).toEqual({ changed: false, moment: null });
    expect(
      decodeSecretsMomentsListResult(
        await call(engine, 3, VERSIONED_METHOD.secretsMomentsList, {
          workspaceId: WORKSPACE,
          versionId: "main",
          path: ".env",
        }),
      ).moments.map((moment) => moment.id),
    ).toEqual(["same-secret-moment"]);
  });

  it("rolls a rename back to its source path and removes the mutation moment", async () => {
    const engine = new VersionedLoopbackEngine();
    await call(engine, 1, VERSIONED_METHOD.textWrite, {
      versionId: "main",
      path: "source.md",
      text: "before rename",
      origin: "api",
      momentId: "rename-seed",
    });
    const renamed = decodeVersionedTextRenameResult(
      await call(engine, 2, VERSIONED_METHOD.textRename, {
        versionId: "main",
        fromPath: "source.md",
        toPath: "target.md",
        origin: "api",
      }),
    );

    await call(engine, 3, VERSIONED_METHOD.textRollback, {
      versionId: "main",
      path: "target.md",
      mutationMomentId: renamed.moment.momentId,
      origin: "restore",
    });

    expect(
      decodeVersionedTextReadResult(
        await call(engine, 4, VERSIONED_METHOD.textRead, {
          versionId: "main",
          path: "source.md",
        }),
      )?.text,
    ).toBe("before rename");
    expect(
      decodeVersionedTextReadResult(
        await call(engine, 5, VERSIONED_METHOD.textRead, {
          versionId: "main",
          path: "target.md",
        }),
      ),
    ).toBeNull();
    expect(
      decodeMomentsListResult(
        await call(engine, 6, VERSIONED_METHOD.momentsList, {
          versionId: "main",
        }),
      ).moments.map((moment) => moment.momentId),
    ).toEqual(["rename-seed"]);
  });

  it("keeps target changes when the secret source is unchanged from its fork base", async () => {
    const engine = new VersionedLoopbackEngine();
    await call(engine, 1, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
      text: "base",
      origin: "api",
      momentId: "base-secret",
    });
    const feature = decodeVersionRecord(
      await call(engine, 2, VERSIONED_METHOD.versionsCreateNamed, {
        workspaceId: WORKSPACE,
        fromVersionId: "main",
        name: "feature",
      }),
    );
    await call(engine, 3, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
      text: "target-newer",
      origin: "api",
      momentId: "target-newer-secret",
    });
    // MUTATION: remove the source-vs-fork-base comparison -> target is overwritten.
    expect(
      decodeSecretApplyResult(
        await call(engine, 4, VERSIONED_METHOD.secretsApply, {
          workspaceId: WORKSPACE,
          sourceVersionId: feature.id,
          targetVersionId: "main",
          path: ".env",
          momentId: "unchanged-source-apply",
          origin: "sync",
        }),
      ).changed,
    ).toBe(false);
    expect(engine.secretValue(WORKSPACE, "main", ".env")).toBe("target-newer");
  });

  it("propagates a source secret deletion with sync provenance", async () => {
    const engine = new VersionedLoopbackEngine();
    await call(engine, 1, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
      text: "base",
      origin: "api",
      momentId: "delete-base",
    });
    const feature = decodeVersionRecord(
      await call(engine, 2, VERSIONED_METHOD.versionsCreateNamed, {
        workspaceId: WORKSPACE,
        fromVersionId: "main",
        name: "feature",
      }),
    );
    await call(engine, 3, VERSIONED_METHOD.secretsDelete, {
      workspaceId: WORKSPACE,
      versionId: feature.id,
      path: ".env",
      origin: "api",
      momentId: "feature-delete",
    });
    // MUTATION: restore the absent-source no-op or restore provenance -> assertions fail.
    const applied = decodeSecretApplyResult(
      await call(engine, 4, VERSIONED_METHOD.secretsApply, {
        workspaceId: WORKSPACE,
        sourceVersionId: feature.id,
        targetVersionId: "main",
        path: ".env",
        momentId: "delete-apply",
        origin: "sync",
      }),
    );
    expect(applied.moment).toMatchObject({ operation: "delete", metadata: { origin: "sync" } });
    expect(engine.secretValue(WORKSPACE, "main", ".env")).toBeUndefined();
  });

  it("secret restore equality is a no-op with the original moment id", async () => {
    const engine = new VersionedLoopbackEngine();
    for (const [id, text] of [["restore-a", "A"], ["restore-b", "B"]] as const) {
      await call(engine, engine.requests.length + 1, VERSIONED_METHOD.secretsWrite, {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: ".env",
        text,
        origin: "api",
        momentId: id,
      });
    }
    await call(engine, 3, VERSIONED_METHOD.secretsRestore, {
      workspaceId: WORKSPACE,
      path: ".env",
      beforeMomentId: "restore-b",
      momentId: "restore-first",
    });
    // MUTATION: always append a restore moment even when the protected state is already equal.
    const replay = decodeSecretRestoreResult(
      await call(engine, 4, VERSIONED_METHOD.secretsRestore, {
        workspaceId: WORKSPACE,
        path: ".env",
        beforeMomentId: "restore-b",
        momentId: "restore-equal",
      }),
    );
    expect(replay.restoredMomentId).toBe("restore-b");
    expect(
      decodeSecretsMomentsGetResult(
        await call(engine, 5, VERSIONED_METHOD.secretsMomentsGet, {
          workspaceId: WORKSPACE,
          momentId: "restore-equal",
        }),
      ),
    ).toBeNull();
  });

  it("retries a committed secret delete as a no-op before duplicate-id validation", async () => {
    const engine = new VersionedLoopbackEngine();
    await call(engine, 1, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
      text: "A",
      origin: "api",
      momentId: "delete-retry-seed",
    });
    const params: SecretsDeleteParams = {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
      origin: "api",
      momentId: "delete-retry",
    };
    decodeSecretDeleteResult(await call(engine, 2, VERSIONED_METHOD.secretsDelete, params));

    // MUTATION: check duplicate secret moment ids before desired-state equality -> this throws.
    expect(
      decodeSecretDeleteResult(
        await call(engine, 3, VERSIONED_METHOD.secretsDelete, params),
      ).moment,
    ).toBeNull();
  });

  it("retries a committed secret apply as a no-op before duplicate-id validation", async () => {
    const engine = new VersionedLoopbackEngine();
    await call(engine, 1, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
      text: "A",
      origin: "api",
      momentId: "apply-retry-main",
    });
    const feature = decodeVersionRecord(
      await call(engine, 2, VERSIONED_METHOD.versionsCreateNamed, {
        workspaceId: WORKSPACE,
        fromVersionId: "main",
        name: "apply-retry-feature",
      }),
    );
    await call(engine, 3, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId: feature.id,
      path: ".env",
      text: "B",
      origin: "api",
      momentId: "apply-retry-feature-write",
    });
    const params: SecretsApplyParams = {
      workspaceId: WORKSPACE,
      sourceVersionId: feature.id,
      targetVersionId: "main",
      path: ".env",
      origin: "api",
      momentId: "apply-retry",
    };
    decodeSecretApplyResult(await call(engine, 4, VERSIONED_METHOD.secretsApply, params));

    // MUTATION: check duplicate secret moment ids before desired-state equality -> this throws.
    expect(
      decodeSecretApplyResult(
        await call(engine, 5, VERSIONED_METHOD.secretsApply, params),
      ),
    ).toEqual({ changed: false, moment: null });
  });

  it("retries a committed secret restore as a no-op before duplicate-id validation", async () => {
    const engine = new VersionedLoopbackEngine();
    for (const [id, text] of [["restore-retry-a", "A"], ["restore-retry-b", "B"]] as const) {
      await call(engine, engine.requests.length + 1, VERSIONED_METHOD.secretsWrite, {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: ".env",
        text,
        origin: "api",
        momentId: id,
      });
    }
    const params: SecretsRestoreParams = {
      workspaceId: WORKSPACE,
      path: ".env",
      beforeMomentId: "restore-retry-b",
      momentId: "restore-retry",
    };
    decodeSecretRestoreResult(await call(engine, 3, VERSIONED_METHOD.secretsRestore, params));

    // MUTATION: check duplicate secret moment ids before desired-state equality -> this throws.
    expect(
      decodeSecretRestoreResult(
        await call(engine, 4, VERSIONED_METHOD.secretsRestore, params),
      ).restoredMomentId,
    ).toBe("restore-retry-b");
  });

  it("rejects a secret restore whose requested path differs from the protected moment", async () => {
    const engine = new VersionedLoopbackEngine();
    for (const [id, text] of [["restore-path-a", "A"], ["restore-path-b", "B"]] as const) {
      await call(engine, engine.requests.length + 1, VERSIONED_METHOD.secretsWrite, {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: ".env",
        text,
        origin: "api",
        momentId: id,
      });
    }

    // MUTATION: omit the source moment path check -> the before-state is written to .other.
    await expect(
      call(engine, 3, VERSIONED_METHOD.secretsRestore, {
        workspaceId: WORKSPACE,
        path: ".other",
        beforeMomentId: "restore-path-b",
        momentId: "restore-wrong-path",
      }),
    ).rejects.toThrow("invalid-input");
    expect(engine.secretValue(WORKSPACE, "main", ".other")).toBeUndefined();
  });

  it("restores a secret into the source moment version while another version is active", async () => {
    const engine = new VersionedLoopbackEngine();
    for (const [id, text] of [["main-a", "A"], ["main-b", "B"]] as const) {
      await call(engine, engine.requests.length + 1, VERSIONED_METHOD.secretsWrite, {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: ".env",
        text,
        origin: "api",
        momentId: id,
      });
    }
    const feature = decodeVersionRecord(
      await call(engine, 3, VERSIONED_METHOD.versionsCreateNamed, {
        workspaceId: WORKSPACE,
        name: "feature",
        fromVersionId: "main",
      }),
    );
    await call(engine, 4, VERSIONED_METHOD.versionsSetActive, {
      workspaceId: WORKSPACE,
      versionId: feature.id,
    });

    await call(engine, 5, VERSIONED_METHOD.secretsRestore, {
      workspaceId: WORKSPACE,
      path: ".env",
      beforeMomentId: "main-b",
      momentId: "restore-main",
    });

    expect(engine.secretValue(WORKSPACE, "main", ".env")).toBe("A");
    expect(engine.secretValue(WORKSPACE, feature.id, ".env")).toBe("B");
  });

  it("returns null active version for a fresh workspace", async () => {
    const engine = new VersionedLoopbackEngine();
    // MUTATION: versions.active must not synthesize main before versioning is initialized.
    expect(
      decodeVersionsActiveResult(
        await call(engine, 1, VERSIONED_METHOD.versionsActive, {
          workspaceId: WORKSPACE,
        }),
      ),
    ).toBeNull();
  });

  it("returns null when a binary read points at a text head", async () => {
    const engine = new VersionedLoopbackEngine();
    engine.seedTextFile({ workspace: WORKSPACE, path: "text.md", text: "text" });
    // MUTATION: text heads are an ordinary absent-binary result, not a shape error.
    expect(
      decodeVersionedBinaryReadResult(
        await call(engine, 1, VERSIONED_METHOD.binaryRead, {
          versionId: "main",
          path: "text.md",
        }),
      ),
    ).toBeNull();
  });

  it("rejects duplicate moment ids", async () => {
    const engine = new VersionedLoopbackEngine();
    const first: VersionedTextWriteParams = {
      versionId: "main",
      path: "one.md",
      text: "one",
      origin: "api",
      momentId: "collision",
    };
    const second: VersionedTextWriteParams = {
      ...first,
      path: "two.md",
      text: "two",
    };
    await call(engine, 1, VERSIONED_METHOD.textWrite, first);
    await expect(call(engine, 2, VERSIONED_METHOD.textWrite, second)).rejects.toThrow(
      "duplicate-id",
    );
  });

  it("rejects a secret moment id already owned by text history", async () => {
    // MUTATION: make the secret freshness guard consult only secretMoments -> succeeds.
    const engine = new VersionedLoopbackEngine();
    await call(engine, 1, VERSIONED_METHOD.textWrite, {
      versionId: "main",
      path: "plain.md",
      text: "plaintext owner",
      origin: "api",
      momentId: "cross-table-text-first",
    });
    await expect(
      call(engine, 2, VERSIONED_METHOD.secretsWrite, {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: ".env",
        text: "TOKEN=protected",
        origin: "api",
        momentId: "cross-table-text-first",
      }),
    ).rejects.toThrow("duplicate-id");
  });

  it("rejects a text moment id already owned by secret history", async () => {
    // MUTATION: make the text freshness guard consult only moments -> succeeds.
    const engine = new VersionedLoopbackEngine();
    await call(engine, 1, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
      text: "TOKEN=protected",
      origin: "api",
      momentId: "cross-table-secret-first",
    });
    await expect(
      call(engine, 2, VERSIONED_METHOD.textWrite, {
        versionId: "main",
        path: "plain.md",
        text: "must not shadow protected history",
        origin: "api",
        momentId: "cross-table-secret-first",
      }),
    ).rejects.toThrow("duplicate-id");
  });

  it("replays requestId results with deduped true", async () => {
    const engine = new VersionedLoopbackEngine();
    const params: VersionedTextWriteParams = {
      versionId: "main",
      path: "replay.md",
      text: "stable",
      origin: "api",
      requestId: "stable-request",
      nowMs: 10,
    };
    const first = decodeVersionedTextWriteResult(
      await call(engine, 1, VERSIONED_METHOD.textWrite, params),
    );
    const replay = decodeVersionedTextWriteResult(
      await call(engine, 2, VERSIONED_METHOD.textWrite, { ...params, nowMs: 20 }),
    );
    // MUTATION: include nowMs in the text-write fingerprint -> this retry refuses.
    expect(first.deduped).toBe(false);
    expect(replay).toMatchObject({
      object: first.object,
      snapshot: first.snapshot,
      moment: first.moment,
      deduped: true,
    });
  });

  it("refuses a zero moments.list limit and clamps the secret history to one", async () => {
    const engine = new VersionedLoopbackEngine();
    for (const index of [0, 1]) {
      await call(engine, index + 1, VERSIONED_METHOD.textWrite, {
        versionId: "main",
        path: `limit-${index}.md`,
        text: `${index}`,
        origin: "api",
        momentId: `limit-text-${index}`,
      });
      await call(engine, index + 3, VERSIONED_METHOD.secretsWrite, {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: ".env",
        text: `${index}`,
        origin: "api",
        momentId: `limit-secret-${index}`,
      });
    }

    // Endpoint-specific on purpose: moments.list mirrors the oracle's
    // normalizeMomentListLimit refusal (limit < 1 = invalid-input), while
    // secrets.moments.list — a daemon extension with no oracle limit — clamps
    // to the daemon's floor of 1.
    // MUTATION: clamp moments.list or refuse secrets.moments.list -> fails.
    await expect(
      call(engine, 5, VERSIONED_METHOD.momentsList, { limit: 0 }),
    ).rejects.toThrow("invalid-input");
    const secret = decodeSecretsMomentsListResult(
      await call(engine, 6, VERSIONED_METHOD.secretsMomentsList, {
        workspaceId: WORKSPACE,
        limit: 0,
      }),
    );
    expect(secret.moments).toHaveLength(1);
  });

  it("reports invalid-version for loopback secret apply", async () => {
    const engine = new VersionedLoopbackEngine();
    // MUTATION: retain the loopback's generic version-not-found spelling -> fails.
    await expect(
      call(engine, 1, VERSIONED_METHOD.secretsApply, {
        workspaceId: WORKSPACE,
        sourceVersionId: "missing",
        targetVersionId: "main",
        path: ".env",
        momentId: "missing-apply",
        origin: "sync",
      }),
    ).rejects.toThrow("invalid-version");
  });

  it("rejects requestId reuse with different parameters", async () => {
    const engine = new VersionedLoopbackEngine();
    const params: VersionedTextWriteParams = {
      versionId: "main",
      path: "replay.md",
      text: "first",
      origin: "api",
      requestId: "stable-request",
    };
    await call(engine, 1, VERSIONED_METHOD.textWrite, params);
    await expect(
      call(engine, 2, VERSIONED_METHOD.textWrite, {
        ...params,
        text: "different",
      }),
    ).rejects.toThrow("idempotency-key-reuse-mismatch");
  });

  it.each(["capture", "ydoc"])("rejects the closed-set origin %s", async (origin) => {
    const engine = new VersionedLoopbackEngine();
    const params = {
      versionId: "main",
      path: `${origin}.md`,
      text: "refused",
      origin,
    } as JsonObject;
    await expect(call(engine, 1, VERSIONED_METHOD.textWrite, params)).rejects.toThrow(
      "invalid-metadata",
    );
  });

  it("returns metadata-only readBlob and binary read results over 48 KiB", async () => {
    const engine = new VersionedLoopbackEngine();
    const bytes = Array.from({ length: 48 * 1024 + 1 }, (_, index) => index % 256);
    engine.seedBinaryFile({ workspace: WORKSPACE, path: "large.bin", bytes });
    const readParams: VersionedBinaryReadParams = {
      versionId: "main",
      path: "large.bin",
    };
    const read = decodeVersionedBinaryReadResult(
      await call(engine, 1, VERSIONED_METHOD.binaryRead, readParams),
    );
    expect(read).toMatchObject({
      bytesBase64: null,
      byteLength: bytes.length,
      inbandLimitBytes: 48 * 1024,
    });
    const blobParams: VersionedBinaryReadBlobParams = {
      workspaceId: WORKSPACE,
      // MUTATION: look up the caller's digest verbatim -> uppercase misses the
      // canonical lowercase blob key.
      sha256: (read?.sha256 ?? "").toUpperCase(),
    };
    expect(
      decodeVersionedBinaryReadBlobResult(
        await call(engine, 2, VERSIONED_METHOD.binaryReadBlob, blobParams),
      ),
    ).toEqual({
      bytesBase64: null,
      byteLength: bytes.length,
      inbandLimitBytes: 48 * 1024,
    });
  });

  it("paginates protected secret moments without overlap", async () => {
    const engine = new VersionedLoopbackEngine();
    for (const [index, text] of ["one", "two", "three"].entries()) {
      await call(engine, index + 1, VERSIONED_METHOD.secretsWrite, {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: ".env",
        text,
        origin: "api",
        momentId: `secret-page-${index}`,
      });
    }
    const first = decodeSecretsMomentsListResult(
      await call(engine, 4, VERSIONED_METHOD.secretsMomentsList, {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: ".env",
        limit: 2,
      }),
    );
    // MUTATION: the keyset cursor is the last returned order and pages cannot overlap.
    expect(first.moments).toHaveLength(2);
    expect(first.nextBeforeMomentOrder).toBe(first.moments[1]?.momentOrder);
    const second = decodeSecretsMomentsListResult(
      await call(engine, 5, VERSIONED_METHOD.secretsMomentsList, {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: ".env",
        beforeMomentOrder: first.nextBeforeMomentOrder ?? undefined,
        limit: 2,
      }),
    );
    expect(second.moments).toHaveLength(1);
    expect(second.moments[0]?.id).not.toBe(first.moments[1]?.id);
    expect(second.nextBeforeMomentOrder).toBeNull();
  });

  it("pages version-wide secret moments across paths newest-first", async () => {
    const engine = new VersionedLoopbackEngine();
    await call(engine, 1, VERSIONED_METHOD.versionsEnsureMain, {
      workspaceId: WORKSPACE,
    });
    for (const [index, path] of [".env", ".env.local", ".env"].entries()) {
      await call(engine, index + 2, VERSIONED_METHOD.secretsWrite, {
        workspaceId: WORKSPACE,
        versionId: "main",
        path,
        text: `secret-${index}`,
        origin: "api",
        momentId: `secret-wide-${index}`,
      });
    }
    const first = decodeSecretsMomentsListResult(
      await call(engine, 5, VERSIONED_METHOD.secretsMomentsList, {
        workspaceId: WORKSPACE,
        versionId: "main",
        limit: 2,
      }),
    );
    // MUTATION: require/filter an absent path -> the cross-path history is incomplete.
    expect(first.moments.map((moment) => [moment.id, moment.path])).toEqual([
      ["secret-wide-2", ".env"],
      ["secret-wide-1", ".env.local"],
    ]);
    const second = decodeSecretsMomentsListResult(
      await call(engine, 6, VERSIONED_METHOD.secretsMomentsList, {
        workspaceId: WORKSPACE,
        versionId: "main",
        beforeMomentOrder: first.nextBeforeMomentOrder ?? undefined,
        limit: 2,
      }),
    );
    expect(second.moments.map((moment) => moment.id)).toEqual(["secret-wide-0"]);
    expect(second.nextBeforeMomentOrder).toBeNull();
  });

  it("lists protected history across versions when versionId is omitted", async () => {
    const engine = new VersionedLoopbackEngine();
    await call(engine, 1, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
      text: "main",
      origin: "api",
      momentId: "workspace-secret-main",
    });
    const feature = decodeVersionRecord(
      await call(engine, 2, VERSIONED_METHOD.versionsCreateNamed, {
        workspaceId: WORKSPACE,
        name: "feature",
        fromVersionId: "main",
      }),
    );
    await call(engine, 3, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId: feature.id,
      path: ".env",
      text: "feature",
      origin: "api",
      momentId: "workspace-secret-feature",
    });

    // MUTATION: require/filter by versionId -> the main-version row disappears or the call refuses.
    const history = decodeSecretsMomentsListResult(
      await call(engine, 4, VERSIONED_METHOD.secretsMomentsList, {
        workspaceId: WORKSPACE,
      }),
    );
    expect(history.moments.map((moment) => [moment.id, moment.versionId])).toEqual([
      ["workspace-secret-feature", feature.id],
      ["workspace-secret-main", "main"],
    ]);
  });

  it("paginates compareFiles by afterPath/nextCursor without overlap", async () => {
    const engine = new VersionedLoopbackEngine();
    const named = decodeVersionRecord(
      await call(engine, 1, VERSIONED_METHOD.versionsCreateNamed, {
        workspaceId: WORKSPACE,
        name: "empty-base",
        fromVersionId: "main",
      }),
    );
    for (let index = 0; index < 201; index += 1) {
      engine.seedTextFile({
        workspace: WORKSPACE,
        path: `file-${index.toString().padStart(3, "0")}.md`,
        text: `${index}`,
      });
    }
    const first = decodeVersionsCompareFilesResult(
      await call(engine, 2, VERSIONED_METHOD.versionsCompareFiles, {
        sourceVersionId: "main",
        targetVersionId: named.id,
      }),
    );
    expect(first.entries).toHaveLength(200);
    expect(first.nextCursor).toBe(first.entries.at(-1)?.path);
    const second = decodeVersionsCompareFilesResult(
      await call(engine, 3, VERSIONED_METHOD.versionsCompareFiles, {
        sourceVersionId: "main",
        targetVersionId: named.id,
        afterPath: first.nextCursor ?? undefined,
      }),
    );
    expect(second.entries).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(first.entries.map((entry) => entry.path)).not.toContain(
      second.entries[0]?.path,
    );
  });
});

describe("versioned result decoder rejection", () => {
  it("reports the wrong-typed nested write field path", () => {
    // The snapshot and moment stubs are COMPLETE so validation reaches the
    // one wrong-typed field this test pins: object.createdAtMs.
    const validSnapshot = {
      workspaceId: "w",
      versionId: "main",
      objectId: "o",
      path: "a.md",
      contentKind: "text",
      sha256: "s",
      byteLength: 1,
      updatedAtMs: 1,
      latestMomentId: "m1",
      metadataOrigin: "api",
      text: "a",
      blobSha256: "b",
    };
    const validMoment = {
      momentOrder: 1,
      momentId: "m1",
      versionId: "main",
      objectId: "o",
      path: "a.md",
      recordedAtMs: 1,
      operation: "write",
      afterContentKind: "text",
      afterBlobSha256: "b",
      afterBinarySha256: null,
      beforePresent: false,
      beforeContentKind: "text",
      beforeBlobSha256: null,
      beforeBinarySha256: null,
      beforeLatestMomentId: null,
      metadataOrigin: "api",
      author: null,
      syncRecordOnly: false,
      afterText: "a",
      afterByteLength: 1,
      afterInbandLimitBytes: null,
      beforeText: null,
      beforeByteLength: null,
      beforeInbandLimitBytes: null,
    };
    expect(() =>
      decodeVersionedTextWriteResult({
        object: { id: "o", workspaceId: "w", createdAtMs: "wrong" },
        snapshot: validSnapshot,
        moment: validMoment,
        deduped: false,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<VersionedProtocolShapeError>>({
        name: "VersionedProtocolShapeError",
        message: expect.stringContaining("versionedText.write result.object.createdAtMs"),
      }),
    );
  });

  it("reports the wrong-typed compareFiles entry field path", () => {
    expect(() =>
      decodeVersionsCompareFilesResult({
        entries: [{ path: 7, status: "added" }],
        nextCursor: null,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<VersionedProtocolShapeError>>({
        name: "VersionedProtocolShapeError",
        message: expect.stringContaining("versions.compareFiles result.entries[0].path"),
      }),
    );
  });

  it("rejects invalid discriminants strictly", () => {
    expect(() =>
      decodeVersionsCompareFilesResult({
        entries: [{ path: "x", status: "future" }],
        nextCursor: null,
      }),
    ).toThrow(VersionedProtocolShapeError);
  });
});
