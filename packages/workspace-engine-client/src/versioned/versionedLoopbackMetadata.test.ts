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
