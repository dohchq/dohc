import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  IllFormedUtf16EditError,
  RemoteYdocApplyError,
  YdocLiveAdapter,
} from "./ydocLiveAdapter";
import { YdocLoopbackEngine } from "./ydocLoopbackEngine";
import { openEngineYdocProviderSession } from "./ydocProviderSession";
import { YDOC_EVENT, YDOC_METHOD } from "./ydocWireContract";

const WORKSPACE = "workspace-handle-1";
const VERSION = "version-1";
const PATH = "notes/live.txt";

function seedPlaintextEngine(markdown = ""): YdocLoopbackEngine {
  const engine = new YdocLoopbackEngine();
  engine.seedFile({
    workspace: WORKSPACE,
    versionId: VERSION,
    path: PATH,
    markdown,
    contentKind: "plaintext",
  });
  return engine;
}

function plaintextUpdate(
  initialUpdate: Uint8Array,
  edit: (text: Y.Text) => void,
): Uint8Array {
  const mirror = new Y.Doc();
  mirror.getMap("frontmatter");
  mirror.getMap("meta");
  mirror.getXmlFragment("body");
  const text = mirror.getText("plainText");
  Y.applyUpdate(mirror, initialUpdate);
  const before = Y.encodeStateVector(mirror);
  edit(text);
  return Y.encodeStateAsUpdate(mirror, before);
}

function findPartiallyAppliedMalformedUpdate(fullUpdate: Uint8Array): Uint8Array {
  for (let cut = 1; cut < fullUpdate.byteLength; cut += 1) {
    const candidate = fullUpdate.slice(0, cut);
    const scratch = new Y.Doc();
    const text = scratch.getText("plainText");
    try {
      Y.applyUpdate(scratch, candidate);
    } catch {
      if (text.length > 0) return candidate;
    }
  }
  throw new Error("The fixture did not expose a non-atomic Yjs apply prefix.");
}

describe("YdocLiveAdapter", () => {
  it("rejects ill-formed live UTF-16 before journaling", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(() =>
      session.applyLocalEdit((doc) => {
        doc.getText("plainText").insert(0, "\ud800");
      }),
    ).toThrow(IllFormedUtf16EditError);
    expect(engine.recordedUpdates).toHaveLength(0);
    expect(engine.requests.map((request) => request.method)).not.toContain(
      YDOC_METHOD.recordUpdate,
    );
    const text = session.doc.getText("plainText").toString();
    expect(text.charCodeAt(0)).toBe(0xd800);

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("treats a failed remote apply prefix as authoritative and converges on full delivery", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    const source = new Y.Doc();
    const sourceText = source.getText("plainText");
    for (let index = 0; index < 400; index += 1) {
      sourceText.insert(sourceText.length, `${index.toString(16)}·`);
    }
    const fullUpdate = Y.encodeStateAsUpdate(source);
    const malformed = findPartiallyAppliedMalformedUpdate(fullUpdate);
    const surfacedErrors: RemoteYdocApplyError[] = [];
    session.onRemoteApplyError((error) => {
      surfacedErrors.push(error);
    });

    engine.emitRemoteUpdate(session.sessionId, malformed);

    const surfaced = surfacedErrors[0];
    expect(surfaced).toBeInstanceOf(RemoteYdocApplyError);
    expect(session.doc.getText("plainText").length).toBeGreaterThan(0);
    expect(Array.from(surfaced?.postAttemptStateUpdate ?? [])).toEqual(
      Array.from(session.currentStateUpdate()),
    );

    engine.applyRemoteUpdate(session.sessionId, fullUpdate);

    expect(session.doc.getText("plainText").toString()).toBe(
      sourceText.toString(),
    );
    expect(Array.from(Y.encodeStateVector(session.doc))).toEqual(
      Array.from(Y.encodeStateVector(source)),
    );

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("round-trips CJK, astral emoji, and RTL text without UTF-16 drift", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    const content = "漢字かな交じり文 · emoji 🧭👩🏽‍🚀 · العربية שלום";
    const update = plaintextUpdate(session.initialUpdate, (text) => {
      text.insert(0, content);
    });

    await session.applyLocalUpdate(update);
    const settled = await session.settle();

    expect(session.doc.getText("plainText").toString()).toBe(content);
    expect(engine.sessionText(session.sessionId)).toBe(content);
    expect(settled.markdown).toBe(content);
    expect([...settled.markdown]).toEqual([...content]);

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("round-trips the full provider lifecycle through typed R03 requests, responses, and events", async () => {
    const engine = seedPlaintextEngine("seed");
    const remoteUpdates: Uint8Array[] = [];
    const provider = await openEngineYdocProviderSession({
      transport: engine,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: (update) => remoteUpdates.push(update),
      scheduleSettle: () => () => undefined,
    });
    const update = plaintextUpdate(provider.initialUpdate, (text) => {
      text.insert(text.length, " local");
    });

    provider.applyLocalUpdate(update);
    const settled = await provider.settleNow({ summary: "manual settle" });
    const external = await provider.applyExternalMarkdownEdit("external edit");
    await provider.close({ settle: false });

    expect(settled.markdown).toBe("seed local");
    expect(settled.projection).toEqual({
      contentKind: "plaintext",
      sourceStateVectorSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      destructive: false,
    });
    expect(external).toEqual({ kind: "merged", markdown: "external edit" });
    expect(provider.doc.getText("plainText").toString()).toBe("external edit");
    expect(remoteUpdates).toHaveLength(1);
    expect(engine.activeSessionIds()).toHaveLength(0);

    expect(engine.requests.map((request) => request.method)).toEqual([
      YDOC_METHOD.open,
      YDOC_METHOD.recordUpdate,
      YDOC_METHOD.settle,
      YDOC_METHOD.applyExternalMarkdownEdit,
      YDOC_METHOD.close,
    ]);
    expect(engine.responses.map((response) => response.id)).toEqual(
      engine.requests.map((request) => request.id),
    );
    expect(engine.requests[0]).toMatchObject({
      id: 1,
      method: YDOC_METHOD.open,
      workspace: WORKSPACE,
      params: { versionId: VERSION, path: PATH, contentKind: "plaintext" },
    });
    expect(engine.requests[1]?.params).toMatchObject({
      sessionId: "session-1",
      updateBase64: expect.any(String),
    });
    expect(engine.requests[2]?.params).toEqual({
      sessionId: "session-1",
      summary: "manual settle",
    });
    expect(engine.requests[3]?.params).toEqual({
      sessionId: "session-1",
      markdown: "external edit",
    });
    expect(engine.requests[4]?.params).toEqual({
      sessionId: "session-1",
      settle: false,
    });
    expect(engine.events[0]).toMatchObject({
      seq: 1,
      sessionGeneration: 1,
      name: YDOC_EVENT.remoteUpdate,
      payload: {
        sessionId: "session-1",
        updateBase64: expect.any(String),
      },
    });
  });
});
