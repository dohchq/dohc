import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VERSIONED_METHOD } from "./versionedWireContract";
import { VersionedLoopbackEngine } from "./versionedLoopbackEngine";

// The loopback is a stand-in for the daemon, so anything the daemon persists and
// returns it must persist and return too — otherwise a loopback-backed test can
// certify behaviour the product does not have. The daemon stores
// metadata_summary / metadata_correlation_id on every moment and emits them as
// metadataSummary / metadataCorrelationId.
//
// This suite exists because the loopback silently dropped both for a while, and
// because the first fix threaded them through the TEXT paths while leaving
// `binaryWrite` behind — the fingerprints already counted them, so a binary
// write's request identity included metadata that its moment then lost.
//
// The same fix skipped the SECRET paths in the same way: `secrets.apply` read
// them, `secrets.write` / `secrets.delete` / `secrets.restore` did not. That
// dropped the summary the desktop pipeline puts on every protected moment
// ("Updated .env" / "Deleted .env" — `metadata_summary` in the daemon), so a
// loopback-backed suite read `undefined` where the product shows a label.
const WORKSPACE = "loopback-metadata-ws";

async function send(
  engine: VersionedLoopbackEngine,
  method: string,
  params: Record<string, unknown>,
  requestFields: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await engine.sendRequest({
    id: `${method}-1`,
    method,
    workspace: WORKSPACE,
    params: params as never,
    ...requestFields,
  } as never);
  const result = (response as { result?: unknown }).result;
  return (result ?? {}) as Record<string, unknown>;
}

async function openWorkspace(engine: VersionedLoopbackEngine): Promise<string> {
  await send(engine, VERSIONED_METHOD.versionsEnsureMain, { workspaceId: WORKSPACE });
  const active = await send(engine, VERSIONED_METHOD.versionsActive, {
    workspaceId: WORKSPACE,
  });
  return String((active.version as { id?: unknown } | undefined)?.id ?? "main");
}

function generatedRequestId(prefix: string, requestId: string, path: string): string {
  const digest = createHash("sha256");
  for (const field of [requestId, path]) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.length));
    digest.update(length);
    digest.update(bytes);
  }
  return `${prefix}-${digest.digest("hex")}`;
}

type MutationRefusalCase = {
  handler: string;
  method: string;
  missingState: Record<string, unknown>;
  missingMain?: Record<string, unknown>;
  validatesAuthor?: boolean;
};

function mutationCaseWithVersion(
  handler: string,
  method: string,
  params: Record<string, unknown>,
  validatesAuthor = false,
): MutationRefusalCase {
  return {
    handler,
    method,
    missingState: { ...params, versionId: "no-such-version" },
    missingMain: { ...params, versionId: "main" },
    validatesAuthor,
  };
}

function mutationCaseWithVersions(
  handler: string,
  method: string,
  params: Record<string, unknown>,
  validatesAuthor = false,
): MutationRefusalCase {
  return {
    handler,
    method,
    missingState: {
      ...params,
      sourceVersionId: "no-such-source",
      targetVersionId: "no-such-target",
    },
    missingMain: { ...params, sourceVersionId: "main", targetVersionId: "main" },
    validatesAuthor,
  };
}

function mutationRefusalCases(): MutationRefusalCase[] {
  const blobBytes = Buffer.from([1, 2, 3]);
  const blobSha256 = createHash("sha256").update(blobBytes).digest("hex");

  return [
    mutationCaseWithVersion(
      "textWrite",
      VERSIONED_METHOD.textWrite,
      { path: "notes.md", text: "hello", origin: "local-file" },
      true,
    ),
    mutationCaseWithVersion(
      "binaryWrite",
      VERSIONED_METHOD.binaryWrite,
      { path: "logo.png", bytes: [1, 2, 3], origin: "local-file" },
      true,
    ),
    {
      handler: "binaryWriteBlob",
      method: VERSIONED_METHOD.binaryWriteBlob,
      missingState: {
        versionId: "no-such-version",
        path: "logo.png",
        sha256: "b".repeat(64),
        origin: "local-file",
      },
      missingMain: {
        versionId: "main",
        path: "logo.png",
        sha256: blobSha256,
        bytesBase64: blobBytes.toString("base64"),
        origin: "local-file",
      },
      validatesAuthor: true,
    },
    mutationCaseWithVersion(
      "textRename",
      VERSIONED_METHOD.textRename,
      {
        fromPath: "before.md",
        toPath: "after.md",
        origin: "local-file",
      },
      true,
    ),
    mutationCaseWithVersion(
      "textDelete",
      VERSIONED_METHOD.textDelete,
      { path: "notes.md", origin: "local-file" },
      true,
    ),
    mutationCaseWithVersions(
      "merge",
      VERSIONED_METHOD.versionsMerge,
      { path: "notes.md", origin: "local-file" },
      true,
    ),
    mutationCaseWithVersion("secretWrite", VERSIONED_METHOD.secretsWrite, {
      path: ".env",
      text: "API_KEY=value\n",
      momentId: "secret-write-refused",
      origin: "local-file",
    }),
    mutationCaseWithVersion("secretDelete", VERSIONED_METHOD.secretsDelete, {
      path: ".env",
      momentId: "secret-delete-refused",
      origin: "local-file",
    }),
    mutationCaseWithVersions("secretApply", VERSIONED_METHOD.secretsApply, {
      path: ".env",
      momentId: "secret-apply-refused",
      origin: "local-file",
    }),
    {
      handler: "secretRestore",
      method: VERSIONED_METHOD.secretsRestore,
      missingState: {
        path: ".env",
        beforeMomentId: "no-such-moment",
        momentId: "secret-restore-refused",
        origin: "restore",
      },
    },
  ];
}

async function expectRefusalWithoutVersion(
  label: string,
  method: string,
  params: Record<string, unknown>,
  error: RegExp,
  requestFields: Record<string, unknown> = {},
): Promise<void> {
  const engine = new VersionedLoopbackEngine();
  await expect(
    send(engine, method, { workspaceId: WORKSPACE, ...params }, requestFields),
    label,
  ).rejects.toThrow(error);
  const listed = await send(engine, VERSIONED_METHOD.versionsList, {});
  expect(listed.versions, `${label}: refusal must not create a version`).toEqual([]);
}

describe("loopback moment metadata", () => {
  it("carries summary and correlationId through a TEXT write into moments.list", async () => {
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: "notes.md",
      text: "hello",
      origin: "local-file",
      summary: "Wrote notes.md",
      correlationId: "corr-text",
    });
    const page = await send(engine, VERSIONED_METHOD.momentsList, {
      versionId,
    });
    const moments = page.moments as Array<Record<string, unknown>>;
    expect(moments).toHaveLength(1);
    expect(moments[0].metadataSummary).toBe("Wrote notes.md");
    expect(moments[0].metadataCorrelationId).toBe("corr-text");
  });

  it("carries them through a BINARY write too", async () => {
    // The regression this file was added for: binaryWrite built its moment
    // without the metadata, so the write wrapper could echo it back while
    // moments.list returned undefined.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await send(engine, VERSIONED_METHOD.binaryWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: "logo.png",
      bytesBase64: Buffer.from([1, 2, 3]).toString("base64"),
      origin: "local-file",
      summary: "Became a binary file",
      correlationId: "corr-binary",
    });
    const page = await send(engine, VERSIONED_METHOD.momentsList, {
      versionId,
    });
    const moments = page.moments as Array<Record<string, unknown>>;
    expect(moments).toHaveLength(1);
    expect(moments[0].metadataSummary).toBe("Became a binary file");
    expect(moments[0].metadataCorrelationId).toBe("corr-binary");
  });

  it("carries them through a SECRET write and the matching delete", async () => {
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    const written = await send(engine, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      text: "API_KEY=x\n",
      origin: "local-file",
      momentId: "secret-write-1",
      summary: "Updated .env",
      correlationId: "corr-secret-write",
    });
    // The write's echoed moment and the moment history must agree: dropping
    // the metadata in only one of them is how the earlier binary regression
    // stayed invisible.
    expect((written.moment as Record<string, unknown>).metadata).toEqual({
      origin: "local-file",
      summary: "Updated .env",
      correlationId: "corr-secret-write",
    });

    const deleted = await send(engine, VERSIONED_METHOD.secretsDelete, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      origin: "local-file",
      momentId: "secret-delete-1",
      summary: "Deleted .env",
      correlationId: "corr-secret-delete",
    });
    expect((deleted.moment as Record<string, unknown>).metadata).toEqual({
      origin: "local-file",
      summary: "Deleted .env",
      correlationId: "corr-secret-delete",
    });

    const page = await send(engine, VERSIONED_METHOD.secretsMomentsList, {
      workspaceId: WORKSPACE,
      versionId,
    });
    const moments = page.moments as Array<Record<string, unknown>>;
    expect(moments.map((moment) => (moment.metadata as { summary?: unknown }).summary)).toEqual([
      "Deleted .env",
      "Updated .env",
    ]);
  });

  it("carries them through a SECRET restore", async () => {
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    for (const [index, text] of ["API_KEY=a\n", "API_KEY=b\n"].entries()) {
      await send(engine, VERSIONED_METHOD.secretsWrite, {
        workspaceId: WORKSPACE,
        versionId,
        path: ".env",
        text,
        origin: "local-file",
        momentId: `secret-write-${index}`,
        summary: "Updated .env",
      });
    }
    const restored = await send(engine, VERSIONED_METHOD.secretsRestore, {
      workspaceId: WORKSPACE,
      path: ".env",
      beforeMomentId: "secret-write-1",
      momentId: "secret-restore-1",
      origin: "restore",
      summary: "Restored .env",
      correlationId: "corr-secret-restore",
    });
    // `secrets.restore` answers with the outcome, not the moment, so read the
    // recorded moment back rather than trusting the reply.
    expect(restored.restoredMomentId).toBe("secret-restore-1");
    const moment = await send(engine, VERSIONED_METHOD.secretsMomentsGet, {
      workspaceId: WORKSPACE,
      momentId: "secret-restore-1",
    });
    expect(moment.metadata).toEqual({
      origin: "restore",
      summary: "Restored .env",
      correlationId: "corr-secret-restore",
    });
  });

  it("normalizes an author to the daemon's output shape", async () => {
    // AgentAuthor is `JsonObject & {...}`, so a caller may pass extension
    // fields. The daemon accepts them and returns only the recognized ones
    // (parsed_moment_author). A loopback that copied the author raw would be
    // STRICTER than the daemon: its own response fails the client's
    // strictObjectValue on the extra key, so a write that works against the
    // engine breaks against the fake.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: "notes.md",
      text: "hello",
      origin: "local-file",
      author: {
        kind: "agent",
        agentId: "agent-1",
        onBehalfOf: "user-1",
        agentRunId: "run-1",
        somethingExtra: "must not survive",
      },
    });
    const page = await send(engine, VERSIONED_METHOD.momentsList, {
      versionId,
    });
    const moments = page.moments as Array<Record<string, unknown>>;
    expect(moments[0].author).toEqual({
      kind: "agent",
      agentId: "agent-1",
      onBehalfOf: "user-1",
      agentRunId: "run-1",
    });
  });

  it("REFUSES a malformed author instead of recording it", async () => {
    // The daemon's write path (`validated_author`) rejects with
    // `invalid-metadata` before any mutation. An earlier draft of this suite
    // expected `{ corrupt: true }` on the recorded moment, mirroring
    // `parsed_moment_author` — but that marker is for READING malformed
    // historical rows, so expecting it here let the fake accept a write
    // production refuses.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await expect(
      send(engine, VERSIONED_METHOD.textWrite, {
        workspaceId: WORKSPACE,
        versionId,
        path: "notes.md",
        text: "hello",
        origin: "local-file",
        author: { kind: "agent", agentId: "", onBehalfOf: "user-1" },
      }),
    ).rejects.toThrow(/invalid-metadata/);

    // And nothing was recorded — a refusal that still mutated would be worse
    // than accepting the author.
    const page = await send(engine, VERSIONED_METHOD.momentsList, {
      versionId,
    });
    expect(page.moments as unknown[]).toHaveLength(0);
  });

  it("REFUSES author and authorJson together, as the daemon does", async () => {
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await expect(
      send(engine, VERSIONED_METHOD.textWrite, {
        workspaceId: WORKSPACE,
        versionId,
        path: "notes.md",
        text: "hello",
        origin: "local-file",
        author: { kind: "agent", agentId: "a", onBehalfOf: "u" },
        authorJson: JSON.stringify({ kind: "agent", agentId: "a", onBehalfOf: "u" }),
      }),
    ).rejects.toThrow(/invalid-metadata/);
  });

  it("omits agentRunId when the caller does not supply it", async () => {
    // Contract field is `agentRunId?: string` — optional, never nullable.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: "notes.md",
      text: "hello",
      origin: "local-file",
      author: { kind: "agent", agentId: "agent-1", onBehalfOf: "user-1" },
    });
    const page = await send(engine, VERSIONED_METHOD.momentsList, {
      versionId,
    });
    const moments = page.moments as Array<Record<string, unknown>>;
    expect(moments[0].author).toEqual({
      kind: "agent",
      agentId: "agent-1",
      onBehalfOf: "user-1",
    });
    expect(Object.keys(moments[0].author as object)).not.toContain("agentRunId");
  });

  it("accepts an explicit null summary, as the daemon does", async () => {
    // The daemon deserializes these as `Option<String>`, where JSON null is the
    // valid absent value. An earlier draft passed null to a string validator, so
    // the fake REJECTED requests production accepts — the opposite error from the
    // no-op hole below, and both were in the same helper.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    const written = await send(engine, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      text: "API_KEY=x\n",
      origin: "local-file",
      momentId: "moment-null-meta",
      summary: null,
      correlationId: null,
    });
    // Assert the RECORDED fields. An earlier version of this test read
    // `moment.metadataSummary` — a key secret moments never carry, since
    // makeSecretMoment nests them under `metadata` — so with `?? null` both reads
    // were undefined and the test passed for every possible engine behaviour,
    // including rejecting null outright.
    expect((written.moment as Record<string, unknown>).metadata).toEqual({
      origin: "local-file",
      summary: null,
      correlationId: null,
    });
  });

  it("refuses malformed restore metadata even when the restore is a no-op", async () => {
    // The daemon deserializes SecretsRestoreParams BEFORE looking at state, so a
    // malformed request that happens to be a no-op is still refused. An earlier
    // draft parsed after the no-op return, which reported success.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await send(engine, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      text: "API_KEY=v1\n",
      origin: "local-file",
      momentId: "moment-restore-base",
    });
    await send(engine, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      text: "API_KEY=v2\n",
      origin: "local-file",
      momentId: "moment-restore-second",
    });
    // Restore once so the secret already equals the selected before-state; the
    // SECOND restore is then the no-op branch. Reaching it needs two writes and
    // two restores — my first draft used one write, whose `before` is undefined,
    // so `prior === sourceMoment.before` was false and it took the MUTATION path.
    // That draft passed and proved nothing; the mutation check is what exposed it.
    await send(engine, VERSIONED_METHOD.secretsRestore, {
      workspaceId: WORKSPACE,
      path: ".env",
      beforeMomentId: "moment-restore-second",
      momentId: "moment-restore-first-pass",
      origin: "restore",
    });
    await expect(
      send(engine, VERSIONED_METHOD.secretsRestore, {
        workspaceId: WORKSPACE,
        path: ".env",
        beforeMomentId: "moment-restore-second",
        momentId: "moment-restore-noop",
        summary: 42,
        origin: "restore",
       }),
    ).rejects.toThrow(/invalid parameters/);
  });

  it("refuses a metadata field over the daemon's 16 KiB cap", async () => {
    // validate_metadata_fields in the daemon rejects either field past 16 KiB.
    // Accepting a longer one let the fake certify a write production refuses —
    // the third way this helper was more permissive than the engine.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    const justOver = "s".repeat(16 * 1024 + 1);
    await expect(
      send(engine, VERSIONED_METHOD.secretsWrite, {
        workspaceId: WORKSPACE,
        versionId,
        path: ".env",
        text: "API_KEY=capped\n",
        origin: "local-file",
        momentId: "moment-capped",
        summary: justOver,
      }),
    ).rejects.toThrow(/invalid-metadata/); // the daemon's own refusal, verbatim

    // Exactly at the cap is accepted — an off-by-one here would reject valid work.
    const atCap = "s".repeat(16 * 1024);
    const ok = await send(engine, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      text: "API_KEY=capped\n",
      origin: "local-file",
      momentId: "moment-at-cap",
      summary: atCap,
    });
    expect((ok.moment as Record<string, unknown>).metadata).toMatchObject({
      summary: atCap,
    });
  });

  it("refuses an over-cap metadata field on a TEXT write too", async () => {
    // The daemon calls validate_metadata_fields from EVERY write handler, not
    // only the secret ones. The cap first landed on the secret path alone, so
    // the text and binary paths still accepted an over-cap summary — the same
    // over-permissive fake, one layer up, and nothing caught it because the
    // only cap test drove a secret write.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await expect(
      send(engine, VERSIONED_METHOD.textWrite, {
        workspaceId: WORKSPACE,
        versionId,
        path: "notes.md",
        text: "hello",
        origin: "local-file",
        correlationId: "c".repeat(16 * 1024 + 1),
      }),
    ).rejects.toThrow(/invalid-metadata/);

    // At the cap the same write is accepted.
    const atCap = "c".repeat(16 * 1024);
    await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: "notes.md",
      text: "hello",
      origin: "local-file",
      correlationId: atCap,
    });
    const page = await send(engine, VERSIONED_METHOD.momentsList, {
      versionId,
    });
    const moments = page.moments as Array<Record<string, unknown>>;
    expect(moments).toHaveLength(1);
    expect(moments[0].metadataCorrelationId).toBe(atCap);
  });

  it("refuses an over-cap field on a DEDUPED binary write, which returned success", async () => {
    // The refusal is the easy half. The half that needed a test: the daemon
    // validates metadata before it reads state, but the fake's content-equality
    // dedup returned `deduped: true` FIRST, so an over-cap field on a repeat
    // write got a success response. Same shape as the no-op holes already fixed
    // on the secret paths, on a path nothing was checking.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    const bytesBase64 = Buffer.from([7, 8, 9]).toString("base64");
    const first = await send(engine, VERSIONED_METHOD.binaryWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: "logo.png",
      bytesBase64,
      origin: "local-file",
    });
    expect(first.deduped).toBeFalsy();

    // The SAME bytes again, which is the dedup path, with an over-cap field.
    await expect(
      send(engine, VERSIONED_METHOD.binaryWrite, {
        workspaceId: WORKSPACE,
        versionId,
        path: "logo.png",
        bytesBase64,
        origin: "local-file",
        summary: "s".repeat(16 * 1024 + 1),
      }),
    ).rejects.toThrow(/invalid-metadata/);

    // And the dedup itself still works when the metadata is fine.
    const deduped = await send(engine, VERSIONED_METHOD.binaryWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: "logo.png",
      bytesBase64,
      origin: "local-file",
      summary: "fine",
    });
    expect(deduped.deduped).toBe(true);
  });

  it("accepts null metadata on a DEDUPED write, which the daemon does too", async () => {
    // These fields deserialize as `Option<String>`, so JSON null is the absent
    // value and the daemon answers normally. Hoisting the parse ahead of the
    // dedup return exposed that `optionalString` threw on null: a same-content
    // write with `summary: null` had never reached the parse before, so moving it
    // made the fake REJECT a request production accepts. The opposite direction
    // from the hole the hoist was fixing, introduced by the fix itself.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    const bytesBase64 = Buffer.from([4, 5, 6]).toString("base64");
    const write = {
      workspaceId: WORKSPACE,
      versionId,
      path: "logo.png",
      bytesBase64,
      origin: "local-file",
      summary: null,
      correlationId: null,
    };
    const first = await send(engine, VERSIONED_METHOD.binaryWrite, write);
    expect(first.deduped).toBeFalsy();
    const second = await send(engine, VERSIONED_METHOD.binaryWrite, write);
    expect(second.deduped).toBe(true);

    // And on a text write, where null must simply be omitted from the moment.
    await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: "notes.md",
      text: "hello",
      origin: "local-file",
      summary: null,
      correlationId: null,
    });
    const page = await send(engine, VERSIONED_METHOD.momentsList, {
      versionId,
    });
    const moments = page.moments as Array<Record<string, unknown>>;
    const text = moments.find((moment) => moment.path === "notes.md");
    expect(text).toBeDefined();
    expect(text?.metadataSummary).toBeUndefined();
    expect(text?.metadataCorrelationId).toBeUndefined();
  });

  it("dedupes equal binary heads before validating an ignored empty object id", async () => {
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    const bytes = [10, 20, 30];
    const first = await send(engine, VERSIONED_METHOD.binaryWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: "raw.bin",
      bytes,
      origin: "local-file",
    });
    const rawDedup = await send(engine, VERSIONED_METHOD.binaryWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: "raw.bin",
      bytes,
      objectId: "",
      origin: "local-file",
    });
    expect(rawDedup.deduped).toBe(true);
    expect((rawDedup.object as { id?: unknown }).id).toBe(
      (first.object as { id?: unknown }).id,
    );
    expect((rawDedup.moment as { id?: unknown }).id).toBe(
      (first.moment as { id?: unknown }).id,
    );

    const blobBytes = Buffer.from([40, 50, 60]);
    const blobSha256 = createHash("sha256").update(blobBytes).digest("hex");
    const blobFirst = await send(engine, VERSIONED_METHOD.binaryWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: "blob.bin",
      bytesBase64: blobBytes.toString("base64"),
      origin: "local-file",
    });
    const blobDedup = await send(engine, VERSIONED_METHOD.binaryWriteBlob, {
      workspaceId: WORKSPACE,
      versionId,
      path: "blob.bin",
      sha256: blobSha256,
      bytesBase64: blobBytes.toString("base64"),
      objectId: "",
      origin: "local-file",
    });
    expect(blobDedup.deduped).toBe(true);
    expect((blobDedup.object as { id?: unknown }).id).toBe(
      (blobFirst.object as { id?: unknown }).id,
    );
    expect((blobDedup.moment as { id?: unknown }).id).toBe(
      (blobFirst.moment as { id?: unknown }).id,
    );
  });

  it("replays an exact TEXT retry that carried an explicit null", async () => {
    // Fixing null on the way IN left the replay comparison re-reading the raw
    // fields, so a fixed-momentId retry of a request the first write had accepted
    // threw instead of answering `deduped: true`. The daemon exact-replays it.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    const write = {
      workspaceId: WORKSPACE,
      versionId,
      path: "notes.md",
      text: "retry me",
      origin: "local-file",
      momentId: "moment-null-retry",
      summary: null,
      correlationId: null,
    };
    const first = await send(engine, VERSIONED_METHOD.textWrite, write);
    expect(first.deduped).toBeFalsy();
    const retry = await send(engine, VERSIONED_METHOD.textWrite, write);
    expect(retry.deduped).toBe(true);
  });

  it("refuses bad METADATA before bad bytes on writeBlob, reversing write's order", async () => {
    // The blob handler validates origin, metadata and author BEFORE decoding or
    // looking up the bytes, the opposite of versionedBinary.write. So the same
    // doubly-invalid request gets a DIFFERENT refusal from each, and a fake that
    // used one order for both would certify the wrong one.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    const overCap = "s".repeat(16 * 1024 + 1);
    await expect(
      send(engine, VERSIONED_METHOD.binaryWriteBlob, {
        workspaceId: WORKSPACE,
        versionId,
        path: "logo.png",
        sha256: "a".repeat(64),
        bytesBase64: "!!!not base64!!!",
        origin: "local-file",
        summary: overCap,
      }),
    ).rejects.toThrow(/invalid-metadata/);

    // ...while the plain write answers for the bytes instead.
    await expect(
      send(engine, VERSIONED_METHOD.binaryWrite, {
        workspaceId: WORKSPACE,
        versionId,
        path: "logo.png",
        bytesBase64: "!!!not base64!!!",
        origin: "local-file",
        summary: overCap,
      }),
    ).rejects.toThrow(/invalid-input/);
  });

  it("deserializes byte arrays and decodes base64 before metadata", async () => {
    // Vec<u8> rejects a bad array while Rust deserializes the params. Base64 is
    // a string field, so the handler rejects its content during the decode.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    const overCap = "s".repeat(16 * 1024 + 1);
    await expect(
      send(engine, VERSIONED_METHOD.binaryWrite, {
        workspaceId: WORKSPACE,
        versionId,
        path: "logo.png",
        bytes: [1, 2, 999], // not a byte
        origin: "local-file",
        summary: overCap,
      }),
    ).rejects.toThrow(/invalid parameters/);

    // Neither spelling of the bytes is a second chance to skip the check.
    await expect(
      send(engine, VERSIONED_METHOD.binaryWrite, {
        workspaceId: WORKSPACE,
        versionId,
        path: "logo.png",
        bytesBase64: "!!!not base64!!!",
        origin: "local-file",
        summary: overCap,
      }),
    ).rejects.toThrow(/invalid-input/);

    // Removed a third sub-assertion that sent a bad origin AND an over-cap field
    // expecting `invalid-metadata`: `requiredOrigin` and the cap check raise the
    // SAME code, so it passed whichever fired first and proved nothing about
    // their order. The two cases above work because bad bytes and bad metadata
    // raise DIFFERENT codes, which is what makes precedence observable at all.
  });

  it("refuses an over-cap field on a secret MERGE", async () => {
    // secrets.apply read summary/correlationId with raw `optionalString`, so the
    // cap landed on write, delete and restore but not on the merge path. The
    // Rust secrets_apply handler calls validate_metadata_fields before applying.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await send(engine, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      text: "API_KEY=source\n",
      origin: "local-file",
      momentId: "moment-merge-source",
    });
    await expect(
      send(engine, VERSIONED_METHOD.secretsApply, {
        workspaceId: WORKSPACE,
        sourceVersionId: versionId,
        targetVersionId: versionId,
        path: ".env",
        momentId: "moment-merge-capped",
        origin: "local-file",
        correlationId: "c".repeat(16 * 1024 + 1),
      }),
    ).rejects.toThrow(/invalid-metadata/);
  });

  it("refuses a malformed AUTHOR on writeBlob before resolving the bytes", async () => {
    // The daemon's blob handler runs origin, metadata, validated_author, and only
    // then the decode/lookup. My preflight did origin and metadata and CLAIMED in
    // its own comment to do the author too, so a malformed author plus a missing
    // blob answered `file-not-found`.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await expect(
      send(engine, VERSIONED_METHOD.binaryWriteBlob, {
        workspaceId: WORKSPACE,
        versionId,
        path: "logo.png",
        sha256: "b".repeat(64), // no such blob
        origin: "local-file",
        author: { kind: "not-a-real-author-kind" },
      }),
    ).rejects.toThrow(/invalid-metadata/);
  });

  it("refuses over-cap APPLY metadata before looking up either version", async () => {
    // secrets_apply validates metadata before its source/target checks, so an
    // over-cap field plus a missing version answers for the metadata.
    const engine = new VersionedLoopbackEngine();
    await openWorkspace(engine);
    await expect(
      send(engine, VERSIONED_METHOD.secretsApply, {
        workspaceId: WORKSPACE,
        sourceVersionId: "no-such-source",
        targetVersionId: "no-such-target",
        path: ".env",
        momentId: "moment-apply-capped",
        origin: "local-file",
        summary: "s".repeat(16 * 1024 + 1),
      }),
    ).rejects.toThrow(/invalid-metadata/);
  });

  it("requires an origin on RESTORE, which the fake used to ignore", async () => {
    // The daemon takes `origin` as a non-Option field on SecretsRestoreParams, so
    // a restore without one is refused. The fake ignored params.origin entirely
    // and hardcoded "restore" on the recorded moment, so it accepted requests
    // production rejects — and several tests in this package were sending exactly
    // those, which is how the gap survived.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await send(engine, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      text: "API_KEY=origin\n",
      origin: "local-file",
      momentId: "moment-origin-required",
    });
    await expect(
      send(engine, VERSIONED_METHOD.secretsRestore, {
        workspaceId: WORKSPACE,
        path: ".env",
        beforeMomentId: "moment-origin-required",
        momentId: "moment-origin-missing",
      }),
    ).rejects.toThrow(/invalid parameters/);
  });

  it("refuses over-cap RENAME and DELETE metadata before resolving the version", async () => {
    // The daemon validates metadata before the actor resolves the version, so an
    // over-cap field plus an unknown versionId answers `invalid-metadata`.
    //
    // The reason this was in doubt: resolving later must not change what a refused
    // request leaves behind. Measured directly against the daemon — a
    // versionedBinary.write with malformed base64 against a workspace with no
    // `main` returns invalid-input and `versions.list` is empty both before and
    // after, so a refusal creates nothing. Recorded on dohc-ai/dohc#439; the Rust
    // test pinning it is not in this branch, so this cites the measurement rather
    // than a test name that does not exist here yet.
    const engine = new VersionedLoopbackEngine();
    await openWorkspace(engine);
    const overCap = "s".repeat(16 * 1024 + 1);
    for (const [method, extra] of [
      [VERSIONED_METHOD.textRename, { fromPath: "a.md", toPath: "b.md" }],
      [VERSIONED_METHOD.textDelete, { path: "a.md" }],
    ] as const) {
      await expect(
        send(engine, method, {
          workspaceId: WORKSPACE,
          versionId: "no-such-version",
          origin: "local-file",
          summary: overCap,
          ...extra,
        }),
      ).rejects.toThrow(/invalid-metadata/);
    }
  });

  it("rejects metadata before state lookup in all ten mutation handlers", async () => {
    const overCap = "s".repeat(16 * 1024 + 1);
    const invalidFields: Array<[string, Record<string, unknown>]> = [
      ["summary", { summary: overCap }],
      ["correlationId", { correlationId: overCap }],
    ];

    for (const testCase of mutationRefusalCases()) {
      const scenarios: Array<[string, Record<string, unknown>]> = [
        ["missing state", testCase.missingState],
      ];
      if (testCase.missingMain) scenarios.push(["missing main", testCase.missingMain]);

      for (const [field, invalidMetadata] of invalidFields) {
        for (const [scenario, params] of scenarios) {
          await expectRefusalWithoutVersion(
            `${testCase.handler}: ${field}, ${scenario}`,
            testCase.method,
            { ...params, ...invalidMetadata },
            /invalid-metadata/,
          );
        }
      }
    }
  });

  it("rejects invalid origins before state lookup in all ten mutation handlers", async () => {
    for (const testCase of mutationRefusalCases()) {
      const scenarios: Array<[string, Record<string, unknown>]> = [
        ["missing state", testCase.missingState],
      ];
      if (testCase.missingMain) scenarios.push(["missing main", testCase.missingMain]);

      for (const [scenario, params] of scenarios) {
        await expectRefusalWithoutVersion(
          `${testCase.handler}: ${scenario}`,
          testCase.method,
          { ...params, origin: "not-an-origin" },
          /invalid-metadata/,
        );
      }
    }
  });

  it("rejects invalid authors before state lookup in all six author handlers", async () => {
    for (const testCase of mutationRefusalCases().filter(
      ({ validatesAuthor }) => validatesAuthor,
    )) {
      const scenarios: Array<[string, Record<string, unknown>]> = [
        ["missing state", testCase.missingState],
      ];
      if (testCase.missingMain) scenarios.push(["missing main", testCase.missingMain]);

      for (const [scenario, params] of scenarios) {
        await expectRefusalWithoutVersion(
          `${testCase.handler}: ${scenario}`,
          testCase.method,
          { ...params, author: { kind: "not-an-author" } },
          /invalid-metadata/,
        );
      }
    }
  });

  it("rejects invalid content before version lookup or main creation", async () => {
    const overCapText = "x".repeat(128 * 1024 + 1);
    const overCapBytes = Array.from({ length: 48 * 1024 + 1 }, () => 1);
    const overCaptureBytes = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    const cases: Array<{
      name: string;
      method: string;
      params: Record<string, unknown>;
      error: RegExp;
    }> = [
      {
        name: "textWrite content cap before protected-path rejection",
        method: VERSIONED_METHOD.textWrite,
        params: {
          versionId: "main",
          path: ".env",
          text: overCapText,
          origin: "local-file",
        },
        error: /content-exceeds-inband-cap/,
      },
      {
        name: "binaryWrite decode before protected-path rejection",
        method: VERSIONED_METHOD.binaryWrite,
        params: {
          versionId: "main",
          path: ".env",
          bytesBase64: "!!!not base64!!!",
          origin: "local-file",
        },
        error: /invalid-input/,
      },
      {
        name: "binaryWrite content cap",
        method: VERSIONED_METHOD.binaryWrite,
        params: {
          versionId: "main",
          path: "logo.png",
          bytes: overCapBytes,
          origin: "local-file",
        },
        error: /content-exceeds-inband-cap/,
      },
      {
        name: "binaryWrite byte validation",
        method: VERSIONED_METHOD.binaryWrite,
        params: {
          versionId: "main",
          path: "logo.png",
          bytes: [256],
          origin: "local-file",
        },
        error: /invalid parameters/,
      },
      {
        name: "binaryWriteBlob digest validation",
        method: VERSIONED_METHOD.binaryWriteBlob,
        params: {
          versionId: "main",
          path: "logo.png",
          sha256: "not-a-digest",
          bytesBase64: Buffer.from([1, 2, 3]).toString("base64"),
          origin: "local-file",
        },
        error: /invalid-input/,
      },
      {
        name: "binaryWriteBlob byte validation",
        method: VERSIONED_METHOD.binaryWriteBlob,
        params: {
          versionId: "main",
          path: "logo.png",
          sha256: "b".repeat(64),
          bytesBase64: "!!!not base64!!!",
          origin: "local-file",
        },
        error: /invalid-input/,
      },
      {
        name: "binaryWriteBlob digest match",
        method: VERSIONED_METHOD.binaryWriteBlob,
        params: {
          versionId: "main",
          path: "logo.png",
          sha256: "b".repeat(64),
          bytesBase64: Buffer.from([1, 2, 3]).toString("base64"),
          origin: "local-file",
        },
        error: /invalid-input/,
      },
      {
        name: "binaryWriteBlob capture cap",
        method: VERSIONED_METHOD.binaryWriteBlob,
        params: {
          versionId: "main",
          path: "logo.png",
          sha256: createHash("sha256").update(overCaptureBytes).digest("hex"),
          bytesBase64: overCaptureBytes.toString("base64"),
          origin: "local-file",
        },
        error: /content-exceeds-capture-cap/,
      },
    ];

    for (const testCase of cases) {
      await expectRefusalWithoutVersion(
        testCase.name,
        testCase.method,
        testCase.params,
        testCase.error,
      );
    }
  });

  it("accepts the text write limit and refuses one extra byte without state", async () => {
    const limit = 128 * 1024;
    const engine = new VersionedLoopbackEngine();
    const written = await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "notes.md",
      text: "x".repeat(limit),
      origin: "local-file",
    });
    expect((written.snapshot as { byteLength?: unknown }).byteLength).toBe(limit);

    await expectRefusalWithoutVersion(
      "textWrite: limit + 1",
      VERSIONED_METHOD.textWrite,
      {
        versionId: "main",
        path: "notes.md",
        text: "x".repeat(limit + 1),
        origin: "local-file",
      },
      /content-exceeds-inband-cap/,
    );
  });

  it("accepts the secret write limit and refuses one extra byte without state", async () => {
    const limit = 1024 * 1024;
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    const written = await send(engine, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      text: "x".repeat(limit),
      momentId: "secret-content-limit",
      origin: "local-file",
    });
    expect(written.changed).toBe(true);
    const listed = await send(engine, VERSIONED_METHOD.secretsList, {
      versionId,
    });
    const secrets = listed.secrets as Array<Record<string, unknown>>;
    expect(secrets).toHaveLength(1);
    expect(secrets[0].byteLength).toBe(limit);

    await expectRefusalWithoutVersion(
      "secretWrite: limit + 1",
      VERSIONED_METHOD.secretsWrite,
      {
        versionId: "main",
        path: ".env",
        text: "x".repeat(limit + 1),
        momentId: "secret-content-refused",
        origin: "local-file",
      },
      /content-exceeds-inband-cap/,
    );
  });

  it("rejects malformed optional write fields before creating main", async () => {
    const handlers: Array<{
      name: string;
      method: string;
      params: Record<string, unknown>;
    }> = [
      {
        name: "textWrite",
        method: VERSIONED_METHOD.textWrite,
        params: {
          versionId: "main",
          path: "notes.md",
          text: "hello",
          origin: "local-file",
        },
      },
      {
        name: "binaryWrite",
        method: VERSIONED_METHOD.binaryWrite,
        params: {
          versionId: "main",
          path: "logo.png",
          bytes: [1, 2, 3],
          origin: "local-file",
        },
      },
      {
        name: "binaryWriteBlob",
        method: VERSIONED_METHOD.binaryWriteBlob,
        params: {
          versionId: "main",
          path: "logo.png",
          sha256: "b".repeat(64),
          origin: "local-file",
        },
      },
    ];
    const malformedFields: Array<[string, unknown]> = [
      ["objectId", 1],
      ["momentId", 1],
      ["requestId", 1],
      ["nowMs", "now"],
      ["metadataOrigin", 1],
      ["authorJson", 1],
    ];

    for (const handler of handlers) {
      for (const [field, value] of malformedFields) {
        await expectRefusalWithoutVersion(
          `${handler.name}: malformed ${field}`,
          handler.method,
          { ...handler.params, [field]: value },
          /invalid parameters/,
        );
      }
      await expectRefusalWithoutVersion(
        `${handler.name}: malformed idempotencyKey`,
        handler.method,
        handler.params,
        /invalid parameters/,
        { idempotencyKey: 1 },
      );
    }
  });

  it("deserializes rename and delete request fields before resolving the version", async () => {
    const handlers = [
      {
        name: "textRename",
        method: VERSIONED_METHOD.textRename,
        params: {
          versionId: "no-such-version",
          fromPath: "before.md",
          toPath: "after.md",
          origin: "local-file",
        },
      },
      {
        name: "textDelete",
        method: VERSIONED_METHOD.textDelete,
        params: {
          versionId: "no-such-version",
          path: "notes.md",
          origin: "local-file",
        },
      },
    ] as const;

    for (const handler of handlers) {
      for (const [field, value] of [
        ["requestId", 1],
        ["nowMs", "now"],
      ] as const) {
        await expectRefusalWithoutVersion(
          `${handler.name}: malformed ${field}`,
          handler.method,
          { ...handler.params, [field]: value },
          /invalid parameters/,
        );
      }
      await expectRefusalWithoutVersion(
        `${handler.name}: malformed idempotencyKey`,
        handler.method,
        handler.params,
        /invalid parameters/,
        { idempotencyKey: 1 },
      );
    }
  });

  it("treats nullable rename and delete request fields as absent", async () => {
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: "before.md",
      text: "hello",
      origin: "local-file",
    });

    const nullableFields = {
      workspaceId: null,
      metadataOrigin: null,
      summary: null,
      correlationId: null,
      author: null,
      authorJson: null,
      requestId: null,
      nowMs: null,
    };
    const renamed = await send(engine, VERSIONED_METHOD.textRename, {
      ...nullableFields,
      versionId,
      fromPath: "before.md",
      toPath: "after.md",
      origin: "local-file",
    });
    expect((renamed.after as { path?: unknown }).path).toBe("after.md");

    const deleted = await send(engine, VERSIONED_METHOD.textDelete, {
      ...nullableFields,
      versionId,
      path: "after.md",
      origin: "local-file",
    });
    expect((deleted.before as { path?: unknown }).path).toBe("after.md");
    await expect(
      send(engine, VERSIONED_METHOD.textRead, {
        versionId,
        path: "after.md",
      }),
    ).resolves.toEqual({});
  });

  it("treats null binary sources as absent", async () => {
    for (const bytes of [
      { bytes: [1], bytesBase64: null },
      { bytes: null, bytesBase64: "AQ==" },
    ]) {
      const engine = new VersionedLoopbackEngine();
      const result = await send(engine, VERSIONED_METHOD.binaryWrite, {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: "logo.png",
        origin: "local-file",
        ...bytes,
      });
      expect((result.snapshot as { byteLength: number }).byteLength).toBe(1);
    }
  });

  it("treats null workspaceId as absent on optional write requests", async () => {
    const blobBytes = Buffer.from([1, 2, 3]);
    const cases = [
      {
        name: "textWrite",
        method: VERSIONED_METHOD.textWrite,
        params: { path: "notes.md", text: "hello", origin: "local-file" },
      },
      {
        name: "binaryWrite",
        method: VERSIONED_METHOD.binaryWrite,
        params: { path: "logo.png", bytes: [1, 2, 3], origin: "local-file" },
      },
      {
        name: "binaryWriteBlob",
        method: VERSIONED_METHOD.binaryWriteBlob,
        params: {
          path: "logo.png",
          sha256: createHash("sha256").update(blobBytes).digest("hex"),
          bytesBase64: blobBytes.toString("base64"),
          origin: "local-file",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const engine = new VersionedLoopbackEngine();
      await expect(
        send(engine, testCase.method, {
          workspaceId: null,
          versionId: "main",
          ...testCase.params,
        }),
        testCase.name,
      ).resolves.toMatchObject({ deduped: false });
      const listed = await send(engine, VERSIONED_METHOD.versionsList, {});
      expect(listed.versions, testCase.name).toHaveLength(1);
    }

    const engine = new VersionedLoopbackEngine();
    await expect(
      send(engine, VERSIONED_METHOD.versionsEnsureMain, { workspaceId: null }),
    ).resolves.toMatchObject({ id: "main" });
  });

  it("deserializes unknown fields before workspace validation", async () => {
    const blobBytes = Buffer.from([1, 2, 3]);
    const cases = [
      {
        name: "textWrite",
        method: VERSIONED_METHOD.textWrite,
        params: { path: "notes.md", text: "hello", origin: "local-file" },
      },
      {
        name: "binaryWrite",
        method: VERSIONED_METHOD.binaryWrite,
        params: { path: "logo.png", bytes: [1], origin: "local-file" },
      },
      {
        name: "binaryWriteBlob",
        method: VERSIONED_METHOD.binaryWriteBlob,
        params: {
          path: "logo.png",
          sha256: createHash("sha256").update(blobBytes).digest("hex"),
          bytesBase64: blobBytes.toString("base64"),
          origin: "local-file",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const engine = new VersionedLoopbackEngine();
      await expect(
        send(engine, testCase.method, {
          workspaceId: "another-workspace",
          versionId: "main",
          ...testCase.params,
          stray: true,
        }),
        testCase.name,
      ).rejects.toThrow(/invalid parameters/);
      const listed = await send(engine, VERSIONED_METHOD.versionsList, {});
      expect(listed.versions, testCase.name).toEqual([]);
    }

    const engine = new VersionedLoopbackEngine();
    await expect(
      send(engine, VERSIONED_METHOD.versionsEnsureMain, {
        workspaceId: "another-workspace",
        stray: true,
      }),
    ).rejects.toThrow(/invalid parameters/);
  });

  it("rejects non-addressable and non-storable paths before version lookup", async () => {
    const blobBytes = Buffer.from([1, 2, 3]);
    const cases = [
      {
        name: "textWrite reserved path",
        method: VERSIONED_METHOD.textWrite,
        params: {
          versionId: "main",
          path: ".dohc/config",
          text: "x",
          origin: "local-file",
        },
      },
      {
        name: "binaryWrite traversal",
        method: VERSIONED_METHOD.binaryWrite,
        params: {
          versionId: "main",
          path: "notes/../logo.png",
          bytes: [1],
          origin: "local-file",
        },
      },
      {
        name: "textWrite raw backslash",
        method: VERSIONED_METHOD.textWrite,
        params: {
          versionId: "main",
          path: "notes\\draft.md",
          text: "x",
          origin: "local-file",
        },
      },
      {
        name: "binaryWrite double-dot substring",
        method: VERSIONED_METHOD.binaryWrite,
        params: {
          versionId: "main",
          path: "notes/v1..draft.png",
          bytes: [1],
          origin: "local-file",
        },
      },
      {
        name: "binaryWriteBlob reserved path",
        method: VERSIONED_METHOD.binaryWriteBlob,
        params: {
          versionId: "main",
          path: ".dohc/logo.png",
          sha256: createHash("sha256").update(blobBytes).digest("hex"),
          bytesBase64: blobBytes.toString("base64"),
          origin: "local-file",
        },
      },
      {
        name: "textRename reserved source",
        method: VERSIONED_METHOD.textRename,
        params: {
          versionId: "main",
          fromPath: ".dohc/before.md",
          toPath: "after.md",
          origin: "local-file",
        },
      },
      {
        name: "textRename secret destination",
        method: VERSIONED_METHOD.textRename,
        params: {
          versionId: "main",
          fromPath: "before.md",
          toPath: ".env",
          origin: "local-file",
        },
      },
      {
        name: "textDelete reserved path",
        method: VERSIONED_METHOD.textDelete,
        params: {
          versionId: "main",
          path: ".dohc/before.md",
          origin: "local-file",
        },
      },
      {
        name: "secretWrite structurally invalid path",
        method: VERSIONED_METHOD.secretsWrite,
        params: {
          versionId: "main",
          path: ".env\\production",
          text: "API_KEY=value\n",
          origin: "local-file",
          momentId: "secret-raw-backslash",
        },
      },
    ] as const;

    for (const testCase of cases) {
      await expectRefusalWithoutVersion(
        testCase.name,
        testCase.method,
        testCase.params,
        /invalid-path/,
      );
    }
  });

  it("rejects invalid merge paths before replay state", async () => {
    const engine = new VersionedLoopbackEngine();
    engine.seedTextFile({
      workspace: WORKSPACE,
      versionId: "main",
      path: "merge-path.md",
      text: "base",
    });
    const named = await send(engine, VERSIONED_METHOD.versionsCreateNamed, {
      workspaceId: WORKSPACE,
      name: "merge-path-validation",
      fromVersionId: "main",
    });
    const sourceVersionId = String(named.id);
    await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: sourceVersionId,
      path: "merge-path.md",
      text: "incoming",
      origin: "api",
    });
    const requestId = "merge-path-request";
    await expect(
      send(engine, VERSIONED_METHOD.versionsMerge, {
        workspaceId: WORKSPACE,
        sourceVersionId,
        targetVersionId: "main",
        path: "notes/../merge-path.md",
        origin: "api",
        requestId,
      }),
    ).rejects.toThrow(/invalid-path/);

    const merged = await send(engine, VERSIONED_METHOD.versionsMerge, {
      workspaceId: WORKSPACE,
      sourceVersionId,
      targetVersionId: "main",
      path: "merge-path.md",
      origin: "api",
      requestId,
    });
    expect(merged).toMatchObject({ status: "merged", deduped: false });
  });

  it("normalizes accepted write and rename paths before storing them", async () => {
    const engine = new VersionedLoopbackEngine();
    const written = await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "notes/./draft.md",
      text: "hello",
      origin: "local-file",
    });
    expect((written.snapshot as { path?: unknown }).path).toBe("notes/draft.md");

    const renamed = await send(engine, VERSIONED_METHOD.textRename, {
      workspaceId: WORKSPACE,
      versionId: "main",
      fromPath: "notes/./draft.md",
      toPath: "notes//final.md",
      origin: "local-file",
    });
    expect((renamed.after as { path?: unknown }).path).toBe("notes/final.md");
  });

  it("derives request-scoped ids from raw paths while storing canonical paths", async () => {
    const engine = new VersionedLoopbackEngine();
    const rawWritePath = "notes/./draft.md";
    const writeRequestId = "raw-write-path";
    const written = await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: rawWritePath,
      text: "hello",
      origin: "local-file",
      requestId: writeRequestId,
    });
    expect((written.object as { id?: unknown }).id).toBe(
      generatedRequestId("object", writeRequestId, rawWritePath),
    );
    expect((written.moment as { momentId?: unknown }).momentId).toBe(
      generatedRequestId("moment", writeRequestId, rawWritePath),
    );
    expect((written.snapshot as { path?: unknown }).path).toBe("notes/draft.md");
    await expect(
      send(engine, VERSIONED_METHOD.textWrite, {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: "notes/draft.md",
        text: "hello",
        origin: "local-file",
        requestId: writeRequestId,
      }),
    ).rejects.toThrow(/idempotency-key-reuse-mismatch/);

    const rawBinaryPath = "images/./icon.bin";
    const binaryRequestId = "raw-binary-path";
    const binary = await send(engine, VERSIONED_METHOD.binaryWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: rawBinaryPath,
      bytes: [1, 2, 3],
      origin: "local-file",
      requestId: binaryRequestId,
    });
    expect((binary.object as { id?: unknown }).id).toBe(
      generatedRequestId("object", binaryRequestId, rawBinaryPath),
    );
    expect((binary.moment as { momentId?: unknown }).momentId).toBe(
      generatedRequestId("moment", binaryRequestId, rawBinaryPath),
    );

    await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "notes/source.md",
      text: "rename",
      origin: "local-file",
      momentId: "raw-rename-seed",
    });
    const rawRenamePath = "notes//renamed.md";
    const renameRequestId = "raw-rename-path";
    const renamed = await send(engine, VERSIONED_METHOD.textRename, {
      workspaceId: WORKSPACE,
      versionId: "main",
      fromPath: "notes/./source.md",
      toPath: rawRenamePath,
      origin: "local-file",
      requestId: renameRequestId,
    });
    expect((renamed.moment as { momentId?: unknown }).momentId).toBe(
      generatedRequestId("moment", renameRequestId, rawRenamePath),
    );

    await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "notes/delete.md",
      text: "delete",
      origin: "local-file",
      momentId: "raw-delete-seed",
    });
    const rawDeletePath = "notes/./delete.md";
    const deleteRequestId = "raw-delete-path";
    const deleted = await send(engine, VERSIONED_METHOD.textDelete, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: rawDeletePath,
      origin: "local-file",
      requestId: deleteRequestId,
    });
    expect((deleted.moment as { momentId?: unknown }).momentId).toBe(
      generatedRequestId("moment", deleteRequestId, rawDeletePath),
    );
  });

  it("normalizes author null and omission to the same replay identity", async () => {
    const engine = new VersionedLoopbackEngine();
    const params = {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "notes.md",
      text: "hello",
      origin: "local-file",
      requestId: "nullable-author-replay",
    };
    const first = await send(engine, VERSIONED_METHOD.textWrite, {
      ...params,
      author: null,
    });
    const replayed = await send(engine, VERSIONED_METHOD.textWrite, params);
    expect(replayed.deduped).toBe(true);
    expect((replayed.moment as { momentId?: unknown }).momentId).toBe(
      (first.moment as { momentId?: unknown }).momentId,
    );
  });

  it("canonicalizes nested author object order for replay identity", async () => {
    const engine = new VersionedLoopbackEngine();
    const params = {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "author-order.md",
      text: "hello",
      origin: "local-file",
      requestId: "author-order-replay",
    };
    const first = await send(engine, VERSIONED_METHOD.textWrite, {
      ...params,
      author: {
        kind: "agent",
        agentId: "agent-1",
        onBehalfOf: "user-1",
        context: { z: 1, nested: { y: 2, x: 3 } },
      },
    });
    const replayed = await send(engine, VERSIONED_METHOD.textWrite, {
      ...params,
      author: {
        context: { nested: { x: 3, y: 2 }, z: 1 },
        onBehalfOf: "user-1",
        agentId: "agent-1",
        kind: "agent",
      },
    });
    expect(replayed.deduped).toBe(true);
    expect((replayed.moment as { momentId?: unknown }).momentId).toBe(
      (first.moment as { momentId?: unknown }).momentId,
    );
  });

  it("canonicalizes rollback aliases, nullable fields, and request-id carriers", async () => {
    const engine = new VersionedLoopbackEngine();
    await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "notes/rollback.md",
      text: "remove me",
      origin: "local-file",
      momentId: "canonical-rollback-mutation",
    });
    const first = await send(
      engine,
      VERSIONED_METHOD.textRollback,
      {
        versionId: "main",
        path: "notes/./rollback.md",
        mutationMomentId: "canonical-rollback-mutation",
        origin: "restore",
      },
      { idempotencyKey: "canonical-rollback-request" },
    );
    const replayed = await send(engine, VERSIONED_METHOD.textRollback, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "notes/rollback.md",
      mutationMomentId: "canonical-rollback-mutation",
      origin: "restore",
      author: null,
      legacyBeforeText: null,
      requestId: "canonical-rollback-request",
    });
    expect(first.deduped).toBe(false);
    expect(replayed.deduped).toBe(true);
  });

  it("uses envelope request ids when rollback and merge requestId is null", async () => {
    const rollbackEngine = new VersionedLoopbackEngine();
    await send(rollbackEngine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "rollback-null.md",
      text: "remove me",
      origin: "local-file",
      momentId: "rollback-null-mutation",
    });
    const rollbackParams = {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "rollback-null.md",
      mutationMomentId: "rollback-null-mutation",
      origin: "restore",
      requestId: null,
    };
    const firstRollback = await send(
      rollbackEngine,
      VERSIONED_METHOD.textRollback,
      rollbackParams,
      { idempotencyKey: "rollback-null-envelope" },
    );
    const replayedRollback = await send(
      rollbackEngine,
      VERSIONED_METHOD.textRollback,
      rollbackParams,
      { idempotencyKey: "rollback-null-envelope" },
    );
    expect(firstRollback.deduped).toBe(false);
    expect(replayedRollback.deduped).toBe(true);

    const mergeEngine = new VersionedLoopbackEngine();
    mergeEngine.seedTextFile({
      workspace: WORKSPACE,
      versionId: "main",
      path: "merge-null.md",
      text: "base",
    });
    const named = await send(mergeEngine, VERSIONED_METHOD.versionsCreateNamed, {
      workspaceId: WORKSPACE,
      name: "null-request-id",
      fromVersionId: "main",
    });
    const sourceVersionId = String(named.id);
    await send(mergeEngine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: sourceVersionId,
      path: "merge-null.md",
      text: "incoming",
      origin: "api",
    });
    const mergeParams = {
      workspaceId: WORKSPACE,
      sourceVersionId,
      targetVersionId: "main",
      path: "merge-null.md",
      origin: "api",
      requestId: null,
    };
    const firstMerge = await send(
      mergeEngine,
      VERSIONED_METHOD.versionsMerge,
      mergeParams,
      { idempotencyKey: "merge-null-envelope" },
    );
    const replayedMerge = await send(
      mergeEngine,
      VERSIONED_METHOD.versionsMerge,
      mergeParams,
      { idempotencyKey: "merge-null-envelope" },
    );
    expect(firstMerge.deduped).toBe(false);
    expect(replayedMerge.deduped).toBe(true);
  });

  it("replays merges when only summary and correlationId change", async () => {
    const engine = new VersionedLoopbackEngine();
    engine.seedTextFile({
      workspace: WORKSPACE,
      versionId: "main",
      path: "merge-metadata.md",
      text: "base",
    });
    const named = await send(engine, VERSIONED_METHOD.versionsCreateNamed, {
      workspaceId: WORKSPACE,
      name: "merge-metadata-replay",
      fromVersionId: "main",
    });
    const sourceVersionId = String(named.id);
    await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: sourceVersionId,
      path: "merge-metadata.md",
      text: "incoming",
      origin: "api",
    });
    const mergeParams = {
      workspaceId: WORKSPACE,
      sourceVersionId,
      targetVersionId: "main",
      path: "merge-metadata.md",
      origin: "api",
      requestId: "merge-metadata-request",
    };
    const first = await send(engine, VERSIONED_METHOD.versionsMerge, {
      ...mergeParams,
      summary: "first summary",
      correlationId: "first-correlation",
    });
    const replayed = await send(engine, VERSIONED_METHOD.versionsMerge, {
      ...mergeParams,
      summary: "changed summary",
      correlationId: "changed-correlation",
    });
    expect(first.deduped).toBe(false);
    expect(replayed.deduped).toBe(true);
    expect((replayed.moment as { momentId?: unknown }).momentId).toBe(
      (first.moment as { momentId?: unknown }).momentId,
    );
    expect(replayed.moment).toMatchObject({
      metadataSummary: "first summary",
      metadataCorrelationId: "first-correlation",
    });
  });

  it("accepts null rollback and merge request ids without opening missing versions", async () => {
    for (const [name, method, params] of [
      [
        "rollback",
        VERSIONED_METHOD.textRollback,
        {
          versionId: "no-such-version",
          path: "missing.md",
          mutationMomentId: "missing-mutation",
          origin: "restore",
          requestId: null,
        },
      ],
      [
        "merge",
        VERSIONED_METHOD.versionsMerge,
        {
          sourceVersionId: "no-such-source",
          targetVersionId: "no-such-target",
          path: "missing.md",
          origin: "api",
          requestId: null,
        },
      ],
    ] as const) {
      const engine = new VersionedLoopbackEngine();
      await expect(send(engine, method, params), name).rejects.toThrow(
        /version-not-found|invalid-version/,
      );
      const listed = await send(engine, VERSIONED_METHOD.versionsList, {});
      expect(listed.versions, name).toEqual([]);
      await expectRefusalWithoutVersion(
        `${name}: malformed envelope request id`,
        method,
        params,
        /invalid parameters/,
        { idempotencyKey: 1 },
      );
    }
  });

  it("checks apply versions before rejecting an empty moment id without changing state", async () => {
    const engine = new VersionedLoopbackEngine();
    await expect(
      send(engine, VERSIONED_METHOD.secretsApply, {
        workspaceId: WORKSPACE,
        sourceVersionId: "missing-source",
        targetVersionId: "missing-target",
        path: ".env",
        momentId: "",
        origin: "api",
      }),
    ).rejects.toThrow(/invalid-version/);
    const listed = await send(engine, VERSIONED_METHOD.versionsList, {});
    expect(listed.versions).toEqual([]);
  });

  it("preserves empty request and envelope idempotency keys", async () => {
    for (const [name, paramsExtra, requestExtra] of [
      ["requestId", { requestId: "" }, {}],
      ["idempotencyKey", {}, { idempotencyKey: "" }],
    ] as const) {
      const engine = new VersionedLoopbackEngine();
      const params = {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: "notes.md",
        text: "hello",
        origin: "local-file",
        ...paramsExtra,
      };
      const first = await send(engine, VERSIONED_METHOD.textWrite, params, requestExtra);
      const replayed = await send(engine, VERSIONED_METHOD.textWrite, params, requestExtra);
      expect(replayed.deduped, name).toBe(true);
      expect((replayed.moment as { momentId?: unknown }).momentId, name).toBe(
        (first.moment as { momentId?: unknown }).momentId,
      );
    }
  });

  it("rejects invalid explicit moment ids without changing state", async () => {
    for (const [name, method, params] of [
      [
        "textWrite empty",
        VERSIONED_METHOD.textWrite,
        { versionId: "main", path: "notes.md", text: "x", origin: "local-file", momentId: "" },
      ],
      [
        "textWrite reserved character",
        VERSIONED_METHOD.textWrite,
        {
          versionId: "main",
          path: "notes.md",
          text: "x",
          origin: "local-file",
          momentId: "bad\u001fid",
        },
      ],
      [
        "binaryWrite empty",
        VERSIONED_METHOD.binaryWrite,
        { versionId: "main", path: "logo.png", bytes: [1], origin: "local-file", momentId: "" },
      ],
      [
        "textWrite empty before secret-path refusal",
        VERSIONED_METHOD.textWrite,
        { versionId: "main", path: ".env", text: "x", origin: "local-file", momentId: "" },
      ],
      [
        "binaryWrite empty before secret-path refusal",
        VERSIONED_METHOD.binaryWrite,
        { versionId: "main", path: ".env", bytes: [1], origin: "local-file", momentId: "" },
      ],
    ] as const) {
      await expectRefusalWithoutVersion(name, method, params, /invalid-input/);
    }

    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await expect(
      send(engine, VERSIONED_METHOD.secretsWrite, {
        workspaceId: WORKSPACE,
        versionId,
        path: ".env",
        text: "API_KEY=value\n",
        origin: "local-file",
        momentId: "",
      }),
    ).rejects.toThrow(/invalid-input/);
    const listed = await send(engine, VERSIONED_METHOD.secretsList, {
      versionId,
    });
    expect(listed.secrets).toEqual([]);
  });

  it("rejects empty explicit object ids without changing state", async () => {
    const blobBytes = Buffer.from([1, 2, 3]);
    const blobSha256 = createHash("sha256").update(blobBytes).digest("hex");
    for (const [name, method, params] of [
      [
        "textWrite",
        VERSIONED_METHOD.textWrite,
        {
          versionId: "main",
          objectId: "",
          path: "notes.md",
          text: "x",
          origin: "local-file",
        },
      ],
      [
        "binaryWrite",
        VERSIONED_METHOD.binaryWrite,
        {
          versionId: "main",
          objectId: "",
          path: "logo.png",
          bytes: [1, 2, 3],
          origin: "local-file",
        },
      ],
      [
        "binaryWriteBlob",
        VERSIONED_METHOD.binaryWriteBlob,
        {
          versionId: "main",
          objectId: "",
          path: "logo.png",
          sha256: blobSha256,
          bytesBase64: blobBytes.toString("base64"),
          origin: "local-file",
        },
      ],
    ] as const) {
      await expectRefusalWithoutVersion(name, method, params, /invalid-input/);
    }
  });

  it("keeps an existing text object's identity when an ignored empty object id is supplied", async () => {
    const engine = new VersionedLoopbackEngine();
    const first = await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "notes.md",
      text: "first",
      origin: "local-file",
    });
    const rewritten = await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      objectId: "",
      path: "notes.md",
      text: "second",
      origin: "local-file",
    });
    expect((rewritten.object as { id?: unknown }).id).toBe(
      (first.object as { id?: unknown }).id,
    );
  });

  it("reconstructs empty-object text retries after rename and delete", async () => {
    const requestEngine = new VersionedLoopbackEngine();
    await send(requestEngine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "request-replay.md",
      text: "first",
      origin: "local-file",
    });
    const requestParams = {
      workspaceId: WORKSPACE,
      versionId: "main",
      objectId: "",
      path: "request-replay.md",
      text: "recorded",
      origin: "local-file",
      requestId: "empty-object-request-replay",
    };
    const requestWrite = await send(
      requestEngine,
      VERSIONED_METHOD.textWrite,
      requestParams,
    );
    await send(requestEngine, VERSIONED_METHOD.textRename, {
      workspaceId: WORKSPACE,
      versionId: "main",
      fromPath: "request-replay.md",
      toPath: "request-replay-moved.md",
      origin: "local-file",
    });
    expect(
      await send(requestEngine, VERSIONED_METHOD.textWrite, requestParams),
    ).toEqual({ ...requestWrite, deduped: true });

    const momentEngine = new VersionedLoopbackEngine();
    await send(momentEngine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "moment-replay.md",
      text: "first",
      origin: "local-file",
    });
    const momentParams = {
      workspaceId: WORKSPACE,
      versionId: "main",
      objectId: "",
      path: "moment-replay.md",
      text: "recorded",
      origin: "local-file",
      momentId: "empty-object-fixed-moment",
    };
    const momentWrite = await send(momentEngine, VERSIONED_METHOD.textWrite, momentParams);
    await send(momentEngine, VERSIONED_METHOD.textDelete, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "moment-replay.md",
      origin: "local-file",
    });
    expect(
      await send(momentEngine, VERSIONED_METHOD.textWrite, momentParams),
    ).toEqual({ ...momentWrite, deduped: true });
  });

  it("accepts wire-representable serde i64 values and rejects both rounded boundaries", async () => {
    const engine = new VersionedLoopbackEngine();
    const accepted = 2 ** 53;
    const result = await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "notes.md",
      text: "hello",
      origin: "local-file",
      nowMs: accepted,
    });
    expect((result.snapshot as { updatedAtMs?: unknown }).updatedAtMs).toBe(accepted);

    await expectRefusalWithoutVersion(
      "nowMs above i64",
      VERSIONED_METHOD.textWrite,
      {
        versionId: "main",
        path: "notes.md",
        text: "hello",
        origin: "local-file",
        nowMs: 2 ** 63,
      },
      /invalid parameters/,
    );
    await expectRefusalWithoutVersion(
      "nowMs below i64 after JSON serialization",
      VERSIONED_METHOD.textWrite,
      {
        versionId: "main",
        path: "notes.md",
        text: "hello",
        origin: "local-file",
        nowMs: -(2 ** 63),
      },
      /invalid parameters/,
    );
  });

  it("deserializes every method's params before requiring a workspace handle", async () => {
    const digest = "a".repeat(64);
    const paramsByMethod: Record<string, Record<string, unknown>> = {
      [VERSIONED_METHOD.textWrite]: {
        versionId: "main", path: "notes.md", text: "x", origin: "local-file",
      },
      [VERSIONED_METHOD.textRead]: { versionId: "main", path: "notes.md" },
      [VERSIONED_METHOD.textReadBlob]: { workspaceId: WORKSPACE, sha256: digest },
      [VERSIONED_METHOD.textRename]: {
        versionId: "main", fromPath: "a.md", toPath: "b.md", origin: "local-file",
      },
      [VERSIONED_METHOD.textDelete]: {
        versionId: "main", path: "notes.md", origin: "local-file",
      },
      [VERSIONED_METHOD.textRollback]: {
        versionId: "main", path: "notes.md", mutationMomentId: "moment-1",
      },
      [VERSIONED_METHOD.textList]: { versionId: "main" },
      [VERSIONED_METHOD.binaryWrite]: {
        versionId: "main", path: "logo.png", bytes: [1], origin: "local-file",
      },
      [VERSIONED_METHOD.binaryWriteBlob]: {
        versionId: "main", path: "logo.png", sha256: digest, origin: "local-file",
      },
      [VERSIONED_METHOD.binaryRead]: { versionId: "main", path: "logo.png" },
      [VERSIONED_METHOD.binaryReadBlob]: { workspaceId: WORKSPACE, sha256: digest },
      [VERSIONED_METHOD.versionsCreateNamed]: {
        workspaceId: WORKSPACE, name: "Draft", fromVersionId: "main",
      },
      [VERSIONED_METHOD.versionsList]: {},
      [VERSIONED_METHOD.versionsSetActive]: { versionId: "main" },
      [VERSIONED_METHOD.versionsEnsureMain]: {},
      [VERSIONED_METHOD.versionsActive]: {},
      [VERSIONED_METHOD.versionsMerge]: {
        path: "notes.md", sourceVersionId: "source", targetVersionId: "target",
      },
      [VERSIONED_METHOD.versionsCompare]: {
        path: "notes.md", sourceVersionId: "source", targetVersionId: "target",
      },
      [VERSIONED_METHOD.versionsCompareFiles]: {
        sourceVersionId: "source", targetVersionId: "target",
      },
      [VERSIONED_METHOD.secretsWrite]: {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: ".env",
        text: "KEY=value",
        origin: "local-file",
        momentId: "secret-write-1",
      },
      [VERSIONED_METHOD.secretsList]: { versionId: "main" },
      [VERSIONED_METHOD.secretsStateExists]: {},
      [VERSIONED_METHOD.secretsMaterialize]: { versionId: "main", path: ".env" },
      [VERSIONED_METHOD.secretsDelete]: {
        workspaceId: WORKSPACE,
        versionId: "main",
        path: ".env",
        origin: "local-file",
        momentId: "secret-delete-1",
      },
      [VERSIONED_METHOD.secretsFork]: {
        workspaceId: WORKSPACE, fromVersionId: "main", toVersionId: "draft",
      },
      [VERSIONED_METHOD.secretsCompare]: {
        workspaceId: WORKSPACE, sourceVersionId: "source", targetVersionId: "target",
      },
      [VERSIONED_METHOD.secretsApply]: {
        workspaceId: WORKSPACE,
        path: ".env",
        sourceVersionId: "source",
        targetVersionId: "target",
        momentId: "secret-apply-1",
        origin: "local-file",
      },
      [VERSIONED_METHOD.secretsRestore]: {
        workspaceId: WORKSPACE,
        path: ".env",
        beforeMomentId: "before-1",
        momentId: "secret-restore-1",
        origin: "local-file",
      },
      [VERSIONED_METHOD.secretsMomentsList]: { workspaceId: WORKSPACE },
      [VERSIONED_METHOD.secretsMomentsGet]: {
        workspaceId: WORKSPACE, momentId: "secret-moment-1",
      },
      [VERSIONED_METHOD.momentsList]: {},
      [VERSIONED_METHOD.momentsGet]: { momentId: "moment-1" },
      [VERSIONED_METHOD.searchEnsureIndex]: {
        workspaceId: WORKSPACE, versionId: "main",
      },
    };
    expect(Object.keys(paramsByMethod).sort()).toEqual(
      Object.values(VERSIONED_METHOD).sort(),
    );

    for (const [method, params] of Object.entries(paramsByMethod)) {
      const engine = new VersionedLoopbackEngine();
      await expect(
        send(engine, method, { ...params, stray: true }, { workspace: null }),
        method,
      ).rejects.toThrow(/invalid parameters/);
      const listed = await send(engine, VERSIONED_METHOD.versionsList, {});
      expect(listed.versions, method).toEqual([]);
    }
  });

  it("runs Rust's semantic preflight before requiring a workspace handle", async () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      [VERSIONED_METHOD.versionsSetActive, { versionId: " main" }, /invalid-version/],
      [
        VERSIONED_METHOD.textReadBlob,
        { workspaceId: WORKSPACE, sha256: "bad" },
        /invalid-input/,
      ],
      [
        VERSIONED_METHOD.binaryReadBlob,
        { workspaceId: WORKSPACE, sha256: "bad" },
        /invalid-input/,
      ],
      [VERSIONED_METHOD.momentsList, { objectId: "" }, /objectId must not be empty/],
      [VERSIONED_METHOD.momentsGet, { momentId: "" }, /momentId must not be empty/],
      [
        VERSIONED_METHOD.secretsApply,
        {
          workspaceId: WORKSPACE,
          path: "notes.md",
          sourceVersionId: "source",
          targetVersionId: "target",
          momentId: "secret-apply-1",
          origin: "local-file",
        },
        /not-secret-path/,
      ],
      [
        VERSIONED_METHOD.secretsMaterialize,
        { versionId: "main", path: "notes.md" },
        /not a secret path/,
      ],
    ];

    for (const [method, params, refusal] of cases) {
      const engine = new VersionedLoopbackEngine();
      await expect(
        send(engine, method, params, { workspace: null }),
        method,
      ).rejects.toThrow(refusal);
    }
  });

  it("rejects unknown fields before creating main", async () => {
    const blobBytes = Buffer.from([1, 2, 3]);
    const blobParams = {
      versionId: "main",
      path: "logo.png",
      sha256: createHash("sha256").update(blobBytes).digest("hex"),
      bytesBase64: blobBytes.toString("base64"),
      origin: "local-file",
    };
    const cases: Array<{
      name: string;
      method: string;
      params: Record<string, unknown>;
    }> = [
      {
        name: "textWrite",
        method: VERSIONED_METHOD.textWrite,
        params: {
          versionId: "main",
          path: "notes.md",
          text: "hello",
          origin: "local-file",
          stray: true,
        },
      },
      {
        name: "binaryWrite",
        method: VERSIONED_METHOD.binaryWrite,
        params: {
          versionId: "main",
          path: "logo.png",
          bytes: [1, 2, 3],
          origin: "local-file",
          stray: true,
        },
      },
      {
        name: "binaryWriteBlob",
        method: VERSIONED_METHOD.binaryWriteBlob,
        params: { ...blobParams, stray: true },
      },
      {
        name: "binaryWriteBlob bytes",
        method: VERSIONED_METHOD.binaryWriteBlob,
        params: { ...blobParams, bytes: null },
      },
      {
        name: "textRename",
        method: VERSIONED_METHOD.textRename,
        params: {
          versionId: "main",
          fromPath: "before.md",
          toPath: "after.md",
          origin: "local-file",
          stray: true,
        },
      },
      {
        name: "textDelete",
        method: VERSIONED_METHOD.textDelete,
        params: {
          versionId: "main",
          path: "notes.md",
          origin: "local-file",
          stray: true,
        },
      },
      {
        name: "secretWrite",
        method: VERSIONED_METHOD.secretsWrite,
        params: {
          versionId: "main",
          path: ".env",
          text: "API_KEY=value\n",
          origin: "local-file",
          momentId: "secret-write-unknown-field",
          stray: true,
        },
      },
      {
        name: "secretDelete",
        method: VERSIONED_METHOD.secretsDelete,
        params: {
          versionId: "main",
          path: ".env",
          origin: "local-file",
          momentId: "secret-delete-unknown-field",
          stray: true,
        },
      },
      {
        name: "secretWrite legacy origin alias",
        method: VERSIONED_METHOD.secretsWrite,
        params: {
          versionId: "main",
          path: ".env",
          text: "API_KEY=value\n",
          metadataOrigin: "local-file",
          momentId: "secret-write-legacy-origin",
        },
      },
      {
        name: "secretDelete legacy origin alias",
        method: VERSIONED_METHOD.secretsDelete,
        params: {
          versionId: "main",
          path: ".env",
          metadataOrigin: "local-file",
          momentId: "secret-delete-legacy-origin",
        },
      },
      {
        name: "versionsEnsureMain",
        method: VERSIONED_METHOD.versionsEnsureMain,
        params: { stray: true },
      },
    ];

    for (const testCase of cases) {
      await expectRefusalWithoutVersion(
        testCase.name,
        testCase.method,
        testCase.params,
        /invalid parameters/,
      );
    }
  });

  it("rejects unknown mutation fields without changing existing state", async () => {
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    for (const path of ["before.md", "delete.md"]) {
      await send(engine, VERSIONED_METHOD.textWrite, {
        workspaceId: WORKSPACE,
        versionId,
        path,
        text: path,
        origin: "local-file",
      });
    }
    await send(engine, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      text: "API_KEY=original\n",
      origin: "local-file",
      momentId: "secret-unknown-field-seed",
    });

    for (const [name, method, params] of [
      [
        "textRename",
        VERSIONED_METHOD.textRename,
        {
          workspaceId: WORKSPACE,
          versionId,
          fromPath: "before.md",
          toPath: "after.md",
          origin: "local-file",
          stray: true,
        },
      ],
      [
        "textDelete",
        VERSIONED_METHOD.textDelete,
        {
          workspaceId: WORKSPACE,
          versionId,
          path: "delete.md",
          origin: "local-file",
          stray: true,
        },
      ],
      [
        "secretWrite",
        VERSIONED_METHOD.secretsWrite,
        {
          workspaceId: WORKSPACE,
          versionId,
          path: ".env",
          text: "API_KEY=changed\n",
          origin: "local-file",
          momentId: "secret-write-unknown-field-existing",
          stray: true,
        },
      ],
      [
        "secretDelete",
        VERSIONED_METHOD.secretsDelete,
        {
          workspaceId: WORKSPACE,
          versionId,
          path: ".env",
          origin: "local-file",
          momentId: "secret-delete-unknown-field-existing",
          stray: true,
        },
      ],
    ] as const) {
      await expect(send(engine, method, params), name).rejects.toThrow(/invalid parameters/);
    }

    for (const path of ["before.md", "delete.md"]) {
      const read = await send(engine, VERSIONED_METHOD.textRead, {
        versionId,
        path,
      });
      expect(read.text, path).toBe(path);
    }
    await expect(
      send(engine, VERSIONED_METHOD.textRead, {
        versionId,
        path: "after.md",
      }),
    ).resolves.toEqual({});
    await expect(
      send(engine, VERSIONED_METHOD.secretsMaterialize, {
        versionId,
        path: ".env",
      }),
    ).resolves.toEqual({ text: "API_KEY=original\n" });
  });

  it("requires every daemon-required secret write and delete field", async () => {
    for (const field of [
      "workspaceId",
      "versionId",
      "path",
      "text",
      "origin",
      "momentId",
    ]) {
      const engine = new VersionedLoopbackEngine();
      const versionId = await openWorkspace(engine);
      const params: Record<string, unknown> = {
        workspaceId: WORKSPACE,
        versionId,
        path: ".env",
        text: "API_KEY=value\n",
        origin: "local-file",
        momentId: `secret-write-missing-${field}`,
      };
      delete params[field];
      await expect(
        send(engine, VERSIONED_METHOD.secretsWrite, params),
        `secretWrite: missing ${field}`,
      ).rejects.toThrow(/invalid parameters/);
      const listed = await send(engine, VERSIONED_METHOD.secretsList, {
        versionId,
      });
      expect(listed.secrets, `secretWrite: missing ${field}`).toEqual([]);
    }

    for (const field of ["workspaceId", "versionId", "path", "origin", "momentId"]) {
      const engine = new VersionedLoopbackEngine();
      const versionId = await openWorkspace(engine);
      await send(engine, VERSIONED_METHOD.secretsWrite, {
        workspaceId: WORKSPACE,
        versionId,
        path: ".env",
        text: "API_KEY=value\n",
        origin: "local-file",
        momentId: `secret-delete-seed-${field}`,
      });
      const params: Record<string, unknown> = {
        workspaceId: WORKSPACE,
        versionId,
        path: ".env",
        origin: "local-file",
        momentId: `secret-delete-missing-${field}`,
      };
      delete params[field];
      await expect(
        send(engine, VERSIONED_METHOD.secretsDelete, params),
        `secretDelete: missing ${field}`,
      ).rejects.toThrow(/invalid parameters/);
      const listed = await send(engine, VERSIONED_METHOD.secretsList, {
        versionId,
      });
      expect(listed.secrets as unknown[], `secretDelete: missing ${field}`).toHaveLength(1);
    }
  });

  it("requires an existing version for secret writes and deletes", async () => {
    for (const [method, extra] of [
      [
        VERSIONED_METHOD.secretsWrite,
        { text: "API_KEY=value\n", momentId: "secret-write-missing-version" },
      ],
      [
        VERSIONED_METHOD.secretsDelete,
        { momentId: "secret-delete-missing-version" },
      ],
    ] as const) {
      for (const versionId of ["main", "no-such-version"]) {
        const engine = new VersionedLoopbackEngine();
        await expect(
          send(engine, method, {
            workspaceId: WORKSPACE,
            versionId,
            path: ".env",
            origin: "local-file",
            ...extra,
          }),
        ).rejects.toThrow(/invalid-version/);
        const listed = await send(engine, VERSIONED_METHOD.versionsList, {});
        expect(listed.versions).toEqual([]);
        const moments = await send(
          engine,
          VERSIONED_METHOD.secretsMomentsList,
          { workspaceId: WORKSPACE },
        );
        expect(moments.moments).toEqual([]);
      }
    }
  });

  it("rejects non-secret paths before version lookup without creating main", async () => {
    for (const [method, extra] of [
      [
        VERSIONED_METHOD.secretsWrite,
        { text: "not secret", momentId: "secret-write-invalid-path" },
      ],
      [
        VERSIONED_METHOD.secretsDelete,
        { momentId: "secret-delete-invalid-path" },
      ],
    ] as const) {
      const engine = new VersionedLoopbackEngine();
      await expect(
        send(engine, method, {
          workspaceId: WORKSPACE,
          versionId: "main",
          path: "notes.md",
          origin: "local-file",
          ...extra,
        }),
      ).rejects.toThrow(/not-secret-path/);
      const listed = await send(engine, VERSIONED_METHOD.versionsList, {});
      expect(listed.versions).toEqual([]);
    }
  });

  it("refuses a RESTORE that only supplies the legacy metadataOrigin", async () => {
    // SecretsRestoreParams requires `origin` and denies unknown fields, so the
    // text-write compatibility fallback to `metadataOrigin` accepts a request the
    // daemon rejects while deserializing. And the recorded moment used to hardcode
    // "restore", which silently discarded any other accepted origin.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await send(engine, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      text: "API_KEY=legacy\n",
      origin: "local-file",
      momentId: "moment-legacy-origin",
    });
    await expect(
      send(engine, VERSIONED_METHOD.secretsRestore, {
        workspaceId: WORKSPACE,
        path: ".env",
        beforeMomentId: "moment-legacy-origin",
        momentId: "moment-legacy-refused",
        metadataOrigin: "restore",
      }),
    ).rejects.toThrow(/invalid parameters/);

    // And an accepted origin other than "restore" is PRESERVED on the moment.
    await send(engine, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      text: "API_KEY=second\n",
      origin: "local-file",
      momentId: "moment-legacy-second",
    });
    await send(engine, VERSIONED_METHOD.secretsRestore, {
      workspaceId: WORKSPACE,
      path: ".env",
      beforeMomentId: "moment-legacy-origin",
      momentId: "moment-origin-preserved",
      origin: "api",
    });
    const moment = await send(engine, VERSIONED_METHOD.secretsMomentsGet, {
      workspaceId: WORKSPACE,
      momentId: "moment-origin-preserved",
    });
    expect((moment.metadata as Record<string, unknown>).origin).toBe("api");
  });

  it("refuses a RESTORE carrying metadataOrigin even alongside a valid origin", async () => {
    // `deny_unknown_fields` on SecretsRestoreParams makes the PRESENCE of
    // metadataOrigin fatal — serde refuses before reading any field — so a request
    // with both is rejected, not silently accepted on the valid one.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await send(engine, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      text: "API_KEY=both\n",
      origin: "local-file",
      momentId: "moment-both-origins",
    });
    await expect(
      send(engine, VERSIONED_METHOD.secretsRestore, {
        workspaceId: WORKSPACE,
        path: ".env",
        beforeMomentId: "moment-both-origins",
        momentId: "moment-both-refused",
        origin: "restore",
        metadataOrigin: "restore",
      }),
    ).rejects.toThrow(/invalid parameters/);
  });

  it("refuses over-cap RESTORE metadata before it looks for the moment", async () => {
    // Fourth handler in this file where the fake read state before validating
    // metadata. The daemon validates origin then metadata immediately after
    // deserialization, before looking up the source moment, so a request that is
    // wrong in BOTH ways must answer for the metadata.
    const engine = new VersionedLoopbackEngine();
    await openWorkspace(engine);
    await expect(
      send(engine, VERSIONED_METHOD.secretsRestore, {
        workspaceId: WORKSPACE,
        path: ".env",
        beforeMomentId: "moment-that-does-not-exist",
        momentId: "moment-restore-capped",
        origin: "restore",
        summary: "s".repeat(16 * 1024 + 1),
      }),
    ).rejects.toThrow(/invalid-metadata/);
  });

  it("refuses malformed secret metadata WITHOUT changing the secret", async () => {
    // The daemon refuses a malformed request atomically, before touching state.
    // An earlier draft of this fix evaluated `optionalString` inside the
    // makeSecretMoment call — AFTER `version.secrets.set` — so a non-string
    // summary left the secret changed, recorded no moment, and still returned a
    // refusal. The refusal is the easy half to get right; not mutating is the
    // half that needs a test.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await send(engine, VERSIONED_METHOD.secretsWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: ".env",
      text: "API_KEY=first\n",
      origin: "local-file",
      momentId: "moment-secret-1",
    });

    await expect(
      send(engine, VERSIONED_METHOD.secretsWrite, {
        workspaceId: WORKSPACE,
        versionId,
        path: ".env",
        text: "API_KEY=second\n",
        origin: "local-file",
        momentId: "moment-secret-2",
        summary: { not: "a string" },
      }),
    ).rejects.toThrow();

    // The secret must still hold the FIRST value: a refused write that mutated
    // would be worse than one that succeeded.
    const listed = await send(engine, VERSIONED_METHOD.secretsList, {
      versionId,
    });
    const secrets = listed.secrets as Array<Record<string, unknown>>;
    expect(secrets).toHaveLength(1);
    // The listing deliberately carries no plaintext, so the stored value is
    // identified by its byte length: 14 for the first value, 15 for the second.
    // If the refused write had mutated, this would read 15.
    expect(secrets[0].byteLength).toBe(Buffer.byteLength("API_KEY=first\n", "utf8"));
  });

  it("leaves both null when the caller supplies neither", async () => {
    // A write without metadata must produce exactly the shape it did before this
    // was threaded through, so no existing consumer changes.
    const engine = new VersionedLoopbackEngine();
    const versionId = await openWorkspace(engine);
    await send(engine, VERSIONED_METHOD.textWrite, {
      workspaceId: WORKSPACE,
      versionId,
      path: "plain.md",
      text: "x",
      origin: "local-file",
    });
    const page = await send(engine, VERSIONED_METHOD.momentsList, {
      versionId,
    });
    const moments = page.moments as Array<Record<string, unknown>>;
    expect(moments[0].metadataSummary ?? null).toBeNull();
    expect(moments[0].metadataCorrelationId ?? null).toBeNull();
  });
});
