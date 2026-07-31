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
): Promise<Record<string, unknown>> {
  const response = await engine.sendRequest({
    id: `${method}-1`,
    method,
    workspace: WORKSPACE,
    params: params as never,
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
      workspaceId: WORKSPACE,
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
      workspaceId: WORKSPACE,
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
      workspaceId: WORKSPACE,
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
      workspaceId: WORKSPACE,
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
      workspaceId: WORKSPACE,
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
    ).rejects.toThrow(/summary is invalid/);
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
      workspaceId: WORKSPACE,
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
      workspaceId: WORKSPACE,
      versionId,
    });
    const moments = page.moments as Array<Record<string, unknown>>;
    const text = moments.find((moment) => moment.path === "notes.md");
    expect(text).toBeDefined();
    expect(text?.metadataSummary).toBeUndefined();
    expect(text?.metadataCorrelationId).toBeUndefined();
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

  it("refuses bad BYTES before bad metadata, in the daemon's order", async () => {
    // Hoisting the metadata parse to fix the dedup hole first put it above the
    // byte decode, which inverted the refusal precedence: a request with both
    // bad bytes and an over-cap field answered `invalid-metadata` where the
    // daemon answers `invalid-input`. The daemon's order is decode, inband cap,
    // origin, metadata, author (lib.rs versionedBinary.write), so a request that
    // is wrong in two ways must fail on the FIRST one.
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
    ).rejects.toThrow(/invalid-input/);

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
    ).rejects.toThrow(/invalid-metadata/);
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
      workspaceId: WORKSPACE,
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
      workspaceId: WORKSPACE,
      versionId,
    });
    const moments = page.moments as Array<Record<string, unknown>>;
    expect(moments[0].metadataSummary ?? null).toBeNull();
    expect(moments[0].metadataCorrelationId ?? null).toBeNull();
  });
});
