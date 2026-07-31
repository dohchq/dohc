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
