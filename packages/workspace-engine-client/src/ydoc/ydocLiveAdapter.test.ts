import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EXCALIDRAW_SCENE_ROOTS } from "@dohc/workspace-contracts/live-documents";
import {
  EngineRequestDeadlineError,
  EngineRequestError,
} from "../daemon/engineClient";
import {
  DaemonRefusalError,
  isYdocUnsettledCloseRefusal,
} from "../live/daemonLiveAdapter";
import type { Request } from "./generated/Request";
import {
  ENGINE_DELIVERED_ORIGIN,
  IllFormedUtf16EditError,
  RemoteYdocApplyError,
  YDOC_OPEN_DEADLINE_MS,
  YdocOpenTimedOutError,
  YdocResyncNeededError,
  YdocSessionQuarantinedError,
  YdocLiveAdapter,
  isWellFormedUtf16,
  type EngineTransport,
} from "./ydocLiveAdapter";
import { YdocLoopbackEngine } from "./ydocLoopbackEngine";
import {
  openEngineYdocProviderSession,
  YdocReleasedWithSettleFailureError,
} from "./ydocProviderSession";
import {
  YDOC_EVENT,
  YDOC_METHOD,
  type YdocSettleResult,
} from "./ydocWireContract";

const WORKSPACE = "workspace-handle-1";
const VERSION = "version-1";
const PATH = "notes/live.txt";

function seedPlaintextEngine(content = ""): YdocLoopbackEngine {
  const engine = new YdocLoopbackEngine();
  engine.seedFile({
    workspace: WORKSPACE,
    versionId: VERSION,
    path: PATH,
    content,
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

function richdocUpdate(initialUpdate: Uint8Array, text: string): Uint8Array {
  const mirror = new Y.Doc();
  mirror.getMap("frontmatter");
  mirror.getMap("meta");
  mirror.getText("plainText");
  const body = mirror.getXmlFragment("body");
  Y.applyUpdate(mirror, initialUpdate);
  const before = Y.encodeStateVector(mirror);
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  body.insert(0, [paragraph]);
  return Y.encodeStateAsUpdate(mirror, before);
}

describe("scene artifact seed admission", () => {
  it("forwards the first-generation intent and disables it for a replay generation", async () => {
    const engine = new YdocLoopbackEngine();
    const adapter = new YdocLiveAdapter(engine);
    const first = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "drawings/board.excalidraw",
      contentKind: "scene",
      seedAbsentLineage: true,
    });
    await first.close({ settle: false });
    const replacement = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "drawings/board.excalidraw",
      contentKind: "scene",
      seedAbsentLineage: false,
    });
    await replacement.close({ settle: false });
    adapter.dispose();

    const opens = engine.requests.filter(
      (request) => request.method === YDOC_METHOD.open,
    );
    expect(opens.map((request) => request.params)).toEqual([
      {
        versionId: VERSION,
        path: "drawings/board.excalidraw",
        contentKind: "scene",
        seedFromArtifact: true,
      },
      {
        versionId: VERSION,
        path: "drawings/board.excalidraw",
        contentKind: "scene",
        seedFromArtifact: false,
      },
    ]);
  });

  it("does not add scene seed admission to text opens", async () => {
    const engine = seedPlaintextEngine("");
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      seedAbsentLineage: true,
    });
    await session.close({ settle: false });
    adapter.dispose();
    expect(engine.requests[0]?.params).not.toHaveProperty("seedFromArtifact");
  });

  it("rejects text seed content for a scene without recording it as Markdown", async () => {
    const engine = new YdocLoopbackEngine();
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "drawings/board.excalidraw",
      content: '{"type":"excalidraw","elements":[]}',
      contentKind: "scene",
    });
    const adapter = new YdocLiveAdapter(engine);

    await expect(
      adapter.openSession({
        workspace: WORKSPACE,
        versionId: VERSION,
        path: "drawings/board.excalidraw",
        contentKind: "scene",
      }),
    ).rejects.toMatchObject({
      name: "YdocAdapterError",
      code: "response-mismatch",
      message:
        "The engine returned text seed content for a scene. The engine must seed scenes in the initial Y.Doc update.",
    });
    expect(engine.recordedUpdates).toHaveLength(0);
    expect(engine.activeSessionIds()).toHaveLength(0);
    adapter.dispose();
  });
});

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

// A stand-in for the settle scheduler the provider builds when the caller does
// not supply one (`setTimeout` + `clearTimeout`). It is faithful on the three
// behaviors the provider depends on: the delay reaches the timer, a canceller
// cancels ONLY the timer it was issued for, and a timer that already fired can
// no longer be cancelled — `fire` removes the entry before running it, exactly
// as the event loop does.
function settleScheduler(): {
  armed: ReadonlyArray<{ fn: () => void; ms: number }>;
  delays: number[];
  schedule: (fn: () => void, ms: number) => () => void;
  fire: () => void;
} {
  const armed: Array<{ fn: () => void; ms: number }> = [];
  const delays: number[] = [];
  return {
    armed,
    delays,
    schedule(fn, ms) {
      const entry = { fn, ms };
      armed.push(entry);
      delays.push(ms);
      return () => {
        const index = armed.indexOf(entry);
        if (index >= 0) armed.splice(index, 1);
      };
    },
    fire() {
      const entry = armed.shift();
      if (entry === undefined) {
        throw new Error("No settle timer is armed.");
      }
      entry.fn();
    },
  };
}

// Drain the microtask queue to quiescence. Draining only until the expected
// thing happened stops one tick before anything that happens AFTER it, which
// is how an assertion about what the provider did NOT do passes without ever
// discriminating.
async function drain(): Promise<void> {
  for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
}

describe("YdocLiveAdapter", () => {
  it("keeps scene roots as Y.Maps across initial and remote updates", async () => {
    const engine = new YdocLoopbackEngine();
    const adapter = new YdocLiveAdapter(engine);
    const first = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "drawing.excalidraw",
      contentKind: "scene",
    });
    await first.applyLocalEdit((doc) => {
      doc.getMap(EXCALIDRAW_SCENE_ROOTS.revisions).set("revision", "one");
      doc.getMap(EXCALIDRAW_SCENE_ROOTS.appState).set("gridSize", "20");
    });
    await first.evict();

    const reopened = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "drawing.excalidraw",
      contentKind: "scene",
    });
    expect(reopened.doc.get(EXCALIDRAW_SCENE_ROOTS.revisions)).toBeInstanceOf(
      Y.Map,
    );
    expect(
      reopened.doc.getMap(EXCALIDRAW_SCENE_ROOTS.revisions).get("revision"),
    ).toBe("one");

    const remote = new Y.Doc();
    remote.getMap(EXCALIDRAW_SCENE_ROOTS.revisions);
    remote.getMap(EXCALIDRAW_SCENE_ROOTS.appState);
    remote.getMap(EXCALIDRAW_SCENE_ROOTS.assets).set("asset", "two");
    engine.applyRemoteUpdate(
      reopened.sessionId,
      Y.encodeStateAsUpdate(remote),
    );
    expect(reopened.doc.get(EXCALIDRAW_SCENE_ROOTS.assets)).toBeInstanceOf(
      Y.Map,
    );
    expect(reopened.doc.getMap(EXCALIDRAW_SCENE_ROOTS.assets).get("asset")).toBe(
      "two",
    );

    await reopened.evict();
    adapter.dispose();
  });

  it("refuses scene settlement and releases the scene on close", async () => {
    const materialized: Array<{ path: string; content: string }> = [];
    const engine = new YdocLoopbackEngine({
      materialize: (input) => materialized.push(input),
    });
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "drawing.excalidraw",
      contentKind: "scene",
    });
    await session.applyLocalEdit((doc) => {
      doc.getMap(EXCALIDRAW_SCENE_ROOTS.revisions).set("revision", "one");
    });

    await expect(session.settle()).rejects.toThrow(
      "The Y.Doc loopback cannot project scene documents. Use the workspace engine to settle scenes.",
    );
    expect(materialized).toHaveLength(0);
    expect(
      engine.responses.some((response) => {
        const result = response.result as Record<string, unknown>;
        return result.materialized === true;
      }),
    ).toBe(false);

    await expect(session.close({ settle: true })).rejects.toThrow(
      "The Y.Doc loopback cannot project scene documents. Use the workspace engine to settle scenes.",
    );
    expect(engine.activeSessionIds()).toHaveLength(1);

    await expect(session.close()).resolves.toBeUndefined();
    expect(engine.activeSessionIds()).toHaveLength(0);

    const reopened = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "drawing.excalidraw",
      contentKind: "scene",
    });
    expect(reopened.lineage).toBe("absent");
    await reopened.close({ settle: false });
    adapter.dispose();
  });

  it("falls back when String.isWellFormed is unavailable at runtime", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      String.prototype,
      "isWellFormed",
    );
    try {
      Object.defineProperty(String.prototype, "isWellFormed", {
        configurable: true,
        value: undefined,
      });
      expect(isWellFormedUtf16("😀")).toBe(true);
      expect(isWellFormedUtf16("\ud800")).toBe(false);
      expect(isWellFormedUtf16("\udc00")).toBe(false);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(String.prototype, "isWellFormed");
      } else {
        Object.defineProperty(String.prototype, "isWellFormed", descriptor);
      }
    }
  });

  it("pins the dormant R13 resync wire method name", () => {
    expect(YDOC_METHOD.resync).toBe("ydoc.resync");
  });

  it("rejects direct seed updates after the loopback seeds absent lineage", async () => {
    const engine = seedPlaintextEngine("captured seed");
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    const seedDoc = new Y.Doc();
    seedDoc.getText("plainText").insert(0, "second seed");

    await expect(
      Promise.resolve().then(() =>
        session.applySeedUpdate(Y.encodeStateAsUpdate(seedDoc)),
      ),
    ).rejects.toMatchObject({
      name: "YdocAdapterError",
      code: "seed-not-permitted",
      message: "The session already has existing lineage.",
    });

    await session.close({ settle: true });
    adapter.dispose();
  });

  it("reserves an absent lineage seed before its first record resolves", async () => {
    const engine = new YdocLoopbackEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(session.lineage).toBe("absent");

    const firstSeed = new Y.Doc();
    firstSeed.getText("plainText").insert(0, "first seed");
    const secondSeed = new Y.Doc();
    secondSeed.getText("plainText").insert(0, "second seed");
    const first = session.applySeedUpdate(Y.encodeStateAsUpdate(firstSeed));
    expect(() =>
      session.applySeedUpdate(Y.encodeStateAsUpdate(secondSeed)),
    ).toThrowError(
      expect.objectContaining({
        name: "YdocAdapterError",
        code: "seed-not-permitted",
      }),
    );
    await first;

    await session.close({ settle: true });
    adapter.dispose();
  });

  it("permits one captured seed, rejects a second seed, and keeps normal edits working", async () => {
    const engine = seedPlaintextEngine("captured seed");
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(engine.recordedUpdates).toHaveLength(1);
    expect(session.doc.getText("plainText").toString()).toBe("captured seed");

    const secondSeed = new Y.Doc();
    secondSeed.getText("plainText").insert(0, "second seed");
    await expect(
      Promise.resolve().then(() =>
        session.applySeedUpdate(Y.encodeStateAsUpdate(secondSeed)),
      ),
    ).rejects.toMatchObject({
      name: "YdocAdapterError",
      code: "seed-not-permitted",
      message: "The session already has existing lineage.",
    });
    expect(session.lineage).toBe("existing");

    await expect(
      session.applyLocalUpdate(
        plaintextUpdate(session.initialUpdate, (text) => {
          text.insert(text.length, " and normal edit");
        }),
      ),
    ).resolves.toMatchObject({ seq: 2 });
    expect(session.doc.getText("plainText").toString()).toBe(
      "captured seed and normal edit",
    );

    await session.close({ settle: true });
    adapter.dispose();
  });

  it("rejects and quarantines an opaque ill-formed edit without wedging Yjs", async () => {
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
    expect(() =>
      session.applyLocalEdit((doc) => {
        doc.getText("plainText").insert(1, "safe");
      }),
    ).toThrow(YdocSessionQuarantinedError);
    expect(engine.recordedUpdates).toHaveLength(0);

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("rejects the R11a surrogate-split lineage before a structured transaction", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    await session.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "😀",
    });

    // This is the exact makeSurrogateProbe lineage asserted by
    // crates/dohc-engine-collab/tests/cross_engine.rs:264.
    expect(() =>
      session.applyLocalTextEdit({
        root: "plainText",
        index: 1,
        insert: "X",
      }),
    ).toThrow(IllFormedUtf16EditError);
    expect(session.doc.getText("plainText").toString()).toBe("😀");
    expect(engine.sessionText(session.sessionId)).toBe("😀");
    expect(engine.recordedUpdates).toHaveLength(1);

    await session.close({ settle: true });
    adapter.dispose();
  });

  it("rejects a split masked behind offsetting U+FFFD deletions (BYPASS-1)", async () => {
    // Reviewer repro: a single raw transaction deletes two pre-existing U+FFFD
    // while a mid-surrogate split adds two, netting to zero. Aggregate counting
    // misses it; deleted-U+FFFD accounting rejects it. Divergence vs the real
    // R11a engine: yrs="😀x" vs editor="�x�"
    // (crates/dohc-engine-collab).
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    // The pre-existing U+FFFD arrives the way a REMOTE update would
    // (ENGINE_DELIVERED_ORIGIN bypasses the local-edit validator below) — a
    // captured file whose OWN bytes hold raw U+FFFD can no longer open as a
    // live session at all: the seed is now a real LOCAL_EDITOR_ORIGIN
    // recordUpdate (#721), and this SAME validator would refuse it before
    // the session ever existed.
    session.doc.transact(() => {
      session.doc.getText("plainText").insert(0, "��😀");
    }, ENGINE_DELIVERED_ORIGIN);

    expect(() =>
      session.applyLocalEdit((doc) => {
        const text = doc.getText("plainText");
        text.delete(0, 2);
        text.insert(1, "x");
      }),
    ).toThrow(IllFormedUtf16EditError);
    expect(engine.recordedUpdates).toHaveLength(0);
    expect(engine.requests.map((request) => request.method)).not.toContain(
      YDOC_METHOD.recordUpdate,
    );

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("allows a clean delete of pre-existing U+FFFD with a clean insert", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    // Pre-existing U+FFFD via a remote-origin update — see BYPASS-1 above.
    session.doc.transact(() => {
      session.doc.getText("plainText").insert(0, "�abc");
    }, ENGINE_DELIVERED_ORIGIN);

    const result = await session.applyLocalEdit((doc) => {
      const text = doc.getText("plainText");
      text.delete(0, 1);
      text.insert(0, "x");
    });
    expect(result?.seq).toBe(1);
    expect(session.doc.getText("plainText").toString()).toBe("xabc");
    expect(engine.recordedUpdates).toHaveLength(1);

    await session.close({ settle: true });
    adapter.dispose();
  });

  it("catches an opaque surrogate split with the net-new replacement backstop", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    await session.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "😀",
    });
    expect(() =>
      session.applyLocalEdit((doc) => {
        doc.getText("plainText").insert(1, "X");
      }),
    ).toThrow(IllFormedUtf16EditError);
    expect(session.doc.getText("plainText").toString()).toBe("�X�");
    expect(engine.recordedUpdates).toHaveLength(1);
    expect(() =>
      session.applyLocalTextEdit({ root: "plainText", index: 0, insert: "Y" }),
    ).toThrow(YdocSessionQuarantinedError);

    await session.close({ settle: true });
    adapter.dispose();
  });

  it("rejects ill-formed text in an undeclared map root", async () => {
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
        doc.getMap("custom").set("k", "\ud800");
      }),
    ).toThrow(IllFormedUtf16EditError);
    expect(engine.recordedUpdates).toHaveLength(0);

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("rejects ill-formed Y.Text attribute keys and values", async () => {
    const attributes = [
      { ["\ud800key"]: "value" },
      { key: "\udc00value" },
    ];
    for (const attribute of attributes) {
      const engine = seedPlaintextEngine();
      const adapter = new YdocLiveAdapter(engine);
      const session = await adapter.openSession({
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH,
        contentKind: "plaintext",
      });
      await session.applyLocalTextEdit({
        root: "plainText",
        index: 0,
        insert: "A",
      });

      expect(() =>
        session.applyLocalEdit((doc) => {
          doc.getText("plainText").format(0, 1, attribute);
        }),
      ).toThrow(IllFormedUtf16EditError);
      expect(engine.recordedUpdates).toHaveLength(1);

      await session.close({ settle: true });
      adapter.dispose();
    }
  });

  it("rejects ill-formed Y.Text embed content", async () => {
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
        doc.getText("plainText").insertEmbed(0, { note: "\ud800" });
      }),
    ).toThrow(IllFormedUtf16EditError);
    expect(engine.recordedUpdates).toHaveLength(0);

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
    session.onRemoteApplyError(() => {
      throw new Error("listener failure");
    });
    session.onRemoteApplyError((error) => {
      surfacedErrors.push(error);
    });

    expect(() => engine.emitRemoteUpdate(session.sessionId, malformed)).not.toThrow();

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

    await session.close({ settle: true });
    adapter.dispose();
  });

  it("contains a throwing remote-update listener and continues delivery", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    const source = new Y.Doc();
    Y.applyUpdate(source, session.initialUpdate);
    const text = source.getText("plainText");
    const beforeFirst = Y.encodeStateVector(source);
    text.insert(0, "A");
    const first = Y.encodeStateAsUpdate(source, beforeFirst);
    const beforeSecond = Y.encodeStateVector(source);
    text.insert(1, "B");
    const second = Y.encodeStateAsUpdate(source, beforeSecond);
    const delivered: string[] = [];
    session.onRemoteUpdate(() => {
      throw new Error("listener failure");
    });
    session.onRemoteUpdate(() => {
      delivered.push(session.doc.getText("plainText").toString());
    });

    expect(() => engine.applyRemoteUpdate(session.sessionId, first)).not.toThrow();
    expect(() => engine.applyRemoteUpdate(session.sessionId, second)).not.toThrow();
    expect(delivered).toEqual(["A", "AB"]);

    await session.close({ settle: true });
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
    expect(settled.content).toBe(content);
    expect([...(settled.content ?? "")]).toEqual([...content]);

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("resyncs and replays a refused update, then journals subsequent edits", async () => {
    const engine = seedPlaintextEngine();
    const recordFailure = new Error("injected one-shot record refusal");
    let refuseNextRecord = true;
    const recordActors: Array<string | undefined> = [];
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate) {
          recordActors.push(
            (request.params as { actorOriginId?: string }).actorOriginId,
          );
          if (refuseNextRecord) {
            refuseNextRecord = false;
            throw recordFailure;
          }
        }
        return engine.sendRequest(request);
      },
    };
    const adapter = new YdocLiveAdapter(transport);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    const first = session.applyLocalUpdate(
      plaintextUpdate(session.initialUpdate, (text) => {
        text.insert(0, "first");
      }),
      { actorOriginId: "actor-first" },
    );
    const second = session.applyLocalTextEdit(
      {
        root: "plainText",
        index: 5,
        insert: " second",
      },
      { actorOriginId: "actor-second" },
    );
    await Promise.all([first, second]);
    const settled = await session.settle();

    expect(settled.content).toBe("first second");
    expect(engine.recordedUpdates).toHaveLength(2);
    expect(recordActors).toEqual([
      "actor-first",
      "actor-first",
      "actor-second",
    ]);
    expect(
      engine.requests.filter((request) => request.method === YDOC_METHOD.resync),
    ).toHaveLength(1);
    await session.close({ settle: false });
    adapter.dispose();
  });

  it("always sends ydoc.close after an unrecoverable poisoned record chain", async () => {
    const engine = seedPlaintextEngine();
    const recordFailure = new Error("injected record refusal");
    const resyncFailure = new Error("injected resync refusal");
    const methods: string[] = [];
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        methods.push(request.method);
        if (request.method === YDOC_METHOD.recordUpdate) throw recordFailure;
        if (request.method === YDOC_METHOD.resync) throw resyncFailure;
        return engine.sendRequest(request);
      },
    };
    const adapter = new YdocLiveAdapter(transport);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    await expect(
      session.applyLocalUpdate(
        plaintextUpdate(session.initialUpdate, (text) => {
          text.insert(0, "refused");
        }),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining(resyncFailure.message),
      cause: recordFailure,
    });
    await expect(session.close({ settle: false })).resolves.toBeUndefined();

    expect(methods.at(-1)).toBe(YDOC_METHOD.close);
    expect(() =>
      session.applyLocalTextEdit({
        root: "plainText",
        index: 0,
        insert: "closed",
      }),
    ).toThrowError(/closed/i);
    adapter.dispose();
  });

  it("journals a pending record before eviction reaches the transport", async () => {
    const engine = seedPlaintextEngine();
    const methods: string[] = [];
    let releaseRecord = (): void => {
      throw new Error("The record gate was not installed.");
    };
    const recordHeld = new Promise<void>((resolve) => {
      releaseRecord = resolve;
    });
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        methods.push(request.method);
        if (request.method === YDOC_METHOD.recordUpdate) {
          await recordHeld;
          return { id: request.id, result: { seq: 1 } };
        }
        return engine.sendRequest(request);
      },
    };
    const adapter = new YdocLiveAdapter(transport);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    methods.length = 0;

    const journaled = session.applyLocalUpdate(
      plaintextUpdate(session.initialUpdate, (text) => {
        text.insert(0, "journal before eviction");
      }),
    );
    const evicted = session.evict();
    await drain();
    releaseRecord();
    await Promise.all([journaled, evicted]);

    // MUTATION: drop the record-chain drain from `evict` -> eviction reaches the transport before the queued record.
    expect(methods).toEqual([YDOC_METHOD.recordUpdate, YDOC_METHOD.evict]);
    adapter.dispose();
  });

  it("preserves reconnect classification when record recovery also loses transport", async () => {
    const engine = seedPlaintextEngine();
    const recordFailure = Object.assign(new Error("record transport restarted"), {
      code: "transport-error",
    });
    const resyncFailure = Object.assign(new Error("resync transport restarted"), {
      code: "transport-error",
    });
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate) throw recordFailure;
        if (request.method === YDOC_METHOD.resync) throw resyncFailure;
        return engine.sendRequest(request);
      },
    };
    const adapter = new YdocLiveAdapter(transport);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    await expect(
      session.applyLocalUpdate(
        plaintextUpdate(session.initialUpdate, (text) => {
          text.insert(0, "survives restart");
        }),
      ),
    ).rejects.toBe(resyncFailure);

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("preserves an original reconnect refusal when recovery fails generically", async () => {
    const engine = seedPlaintextEngine();
    const recordFailure = new DaemonRefusalError(
      {
        code: "INTERNAL",
        message: "workspace binding expired",
        retry: "afterReconnect",
      },
      new Error("daemon response"),
    );
    const resyncFailure = new Error("resync refusal");
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate) throw recordFailure;
        if (request.method === YDOC_METHOD.resync) throw resyncFailure;
        return engine.sendRequest(request);
      },
    };
    const adapter = new YdocLiveAdapter(transport);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    await expect(
      session.applyLocalUpdate(
        plaintextUpdate(session.initialUpdate, (text) => {
          text.insert(0, "survives reconnect");
        }),
      ),
    ).rejects.toBe(recordFailure);

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("reports a DEBOUNCED settle failure to onSettleError, not only to onSessionError", async () => {
    // AUDIT-SILENTSAVE. The debounced settle is the only path that writes the
    // user's edits to their file. Its failure used to go to onSessionError
    // alone, and the desktop wires that to a reconnect handler which returns
    // early for anything that is not a reconnect error — so a refusal was
    // dropped with no log and no UI, and the doc kept reading "Saved" over a
    // file that never received a byte.
    const engine = seedPlaintextEngine();
    const settleFailure = new Error("injected settle refusal");
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.settle) throw settleFailure;
        return engine.sendRequest(request);
      },
    };
    const settleErrors: unknown[] = [];
    const settleStarts: number[] = [];
    const settled: unknown[] = [];
    // Capture the debounced callback so the test drives the REAL debounced
    // path (the one that swallowed the failure) rather than settleNow.
    const scheduler = settleScheduler();
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      settleDebounceMs: 100,
      onRemoteUpdate: () => undefined,
      onSettleStart: () => settleStarts.push(settleStarts.length),
      onSettleError: (error) => settleErrors.push(error),
      onSettled: (result) => {
        settled.push(result);
      },
      scheduleSettle: scheduler.schedule,
    });

    const update = plaintextUpdate(provider.initialUpdate, (text) => {
      text.insert(0, "typed but never saved");
    });
    await provider.applyLocalUpdate(update);

    expect(scheduler.armed).toHaveLength(1);
    scheduler.fire();
    // The debounced settle rejects internally. Drain to QUIESCENCE, not until
    // the error lands: the retry decision happens a microtask AFTER
    // onSettleError, so stopping at the error made the last assertion below
    // pass whether or not the provider re-armed.
    await drain();

    expect(settleErrors[0]).toBe(settleFailure);
    // A settle STARTED, so a caller can show "saving" honestly...
    expect(settleStarts).toHaveLength(1);
    // ...and it never reported success, so nothing may claim the file is saved.
    expect(settled).toEqual([]);
    // An ordinary settle failure is NOT retried: a refusal that trying again
    // cannot help (stale target, invalid input) would only repeat itself.
    expect(scheduler.armed).toHaveLength(0);

    await provider.close({ settle: false });
  });

  // A provider whose settle is refused by a transient blocker until the test
  // clears it, with the settle scheduler captured so the ladder can be driven
  // a rung at a time. Shared by the tests below; each drives it differently,
  // because a debounced settle and an explicit flush are different behaviors.
  //
  // The blocker is a parameter because the two answers must come from the
  // SAME fixture: a copy of it per blocker is where one of the two ladders
  // quietly stops being exercised.
  async function openAgainstABlockedSettle(
    text: string,
    options?: {
      settleDebounceMs?: number;
      blocker?: "file-locked" | "engine-store-busy";
    },
  ) {
    const engine = seedPlaintextEngine();
    const blocked = { held: true };
    const refusal = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: options?.blocker ?? "file-locked",
        retry: "afterBackoff",
      },
      new Error("daemon response"),
    );
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.settle && blocked.held) {
          throw refusal;
        }
        return engine.sendRequest(request);
      },
    };
    const settleErrors: unknown[] = [];
    const settled: unknown[] = [];
    const scheduler = settleScheduler();
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      // Omitted deliberately when the caller wants the DEFAULT debounce: the
      // ladder's first rung is that default, which is the only place the
      // default is observable without a wall clock.
      ...(options?.settleDebounceMs !== undefined
        ? { settleDebounceMs: options.settleDebounceMs }
        : {}),
      onRemoteUpdate: () => undefined,
      onSettleError: (error) => settleErrors.push(error),
      onSettled: (result) => {
        settled.push(result);
      },
      scheduleSettle: scheduler.schedule,
    });
    await provider.applyLocalUpdate(
      plaintextUpdate(provider.initialUpdate, (body) => {
        body.insert(0, text);
      }),
    );
    return {
      engine,
      provider,
      blocked,
      refusal,
      settleErrors,
      settled,
      scheduler,
      delays: scheduler.delays,
    };
  }

  it("retries a file-locked settle on a doubling delay until the lock releases", async () => {
    // #554: a settle refused `file-locked` leaves the write durably pending
    // in the engine — the ONLY missing piece is a later attempt. The provider
    // re-arms itself on a doubling delay, so the save lands when the external
    // handle releases instead of waiting for an unrelated future edit.
    const { provider, blocked, refusal, settleErrors, settled, delays, scheduler } =
      await openAgainstABlockedSettle("typed against a locked file", {
        settleDebounceMs: 100,
      });

    // Fire the armed settle; while the lock holds, every failure re-arms the
    // next attempt itself: debounce, then doubling — 100, 100, 200, 400 —
    // and every failure still reaches onSettleError (nothing goes quiet).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(scheduler.armed).toHaveLength(1);
      scheduler.fire();
      await drain();
    }
    expect(settleErrors).toEqual([refusal, refusal, refusal]);
    expect(delays).toEqual([100, 100, 200, 400]);

    // The lock releases; the pending retry lands the write by itself.
    blocked.held = false;
    scheduler.fire();
    await drain();
    expect(settled).toHaveLength(1);
    // Success re-arms nothing.
    expect(scheduler.armed).toHaveLength(0);

    await provider.close({ settle: false });
  });

  it("retries an engine-store-busy settle until the store frees, then saves", async () => {
    // #658: a busy SQLite handle is dohc's OWN writers meeting, and the store
    // reports itself intact and the operation retryable. It used to reach the
    // caller as INTERNAL / retry "no", so the settle stood down on a condition
    // that clears by waiting and the user's edits reached the file only on
    // some unrelated later settle. The ladder now re-arms on it beside the
    // file lock.
    const { provider, blocked, refusal, settleErrors, settled, delays, scheduler } =
      await openAgainstABlockedSettle("typed while the store was busy", {
        settleDebounceMs: 100,
        blocker: "engine-store-busy",
      });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(scheduler.armed).toHaveLength(1);
      scheduler.fire();
      await drain();
    }
    // Every failure re-armed the next attempt and none went quiet.
    expect(settleErrors).toEqual([refusal, refusal, refusal]);
    expect(settled).toEqual([]);

    // The contention clears; the pending retry lands the write by itself.
    blocked.held = false;
    scheduler.fire();
    await drain();
    expect(settled).toHaveLength(1);
    expect(scheduler.armed).toHaveLength(0);
    // The rungs are the busy store's, capped at 1s rather than the lock's 10s.
    expect(delays).toEqual([100, 100, 200, 400]);

    await provider.close({ settle: false });
  });

  it("caps the busy-store ladder far below the file lock's", async () => {
    // The two waits are for different things. A file lock is held by a
    // program outside dohc and can last as long as that program does; SQLite
    // contention is dohc's own and clears in milliseconds. One shared cap
    // would either hold a document unsettled for ten seconds over a
    // millisecond of contention, or retry a locked file too eagerly to be
    // worth bounding.
    const busy = await openAgainstABlockedSettle("typed while the store was busy", {
      settleDebounceMs: 4000,
      blocker: "engine-store-busy",
    });
    const lockedFile = await openAgainstABlockedSettle("typed against a lock", {
      settleDebounceMs: 4000,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      busy.scheduler.fire();
      await drain();
      lockedFile.scheduler.fire();
      await drain();
    }
    // Both ladders start at the debounce the caller asked for and are then
    // held down to their OWN ceiling.
    expect(busy.delays).toEqual([4000, 1000, 1000, 1000]);
    expect(lockedFile.delays).toEqual([4000, 4000, 8000, 10_000]);

    await busy.provider.close({ settle: false });
    await lockedFile.provider.close({ settle: false });
  });

  // A provider whose JOURNAL write is refused busy `refusals` times before the
  // engine accepts anything. The engine is the real loopback, so a settle can
  // only carry text the engine actually received — which makes "was it
  // resent?" a fact about content rather than a call count.
  //
  // `refusals` counts recordUpdate attempts, and one edit costs TWO of them:
  // the write, then `recoverCanonicalState`'s replay. So 2 is the smallest
  // number that gets past the adapter's own recovery and reaches the ladder.
  async function openAgainstABusyJournal(text: string, refusals: number) {
    const engine = seedPlaintextEngine();
    const busy = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "engine-store-busy",
        retry: "afterBackoff",
      },
      new Error("daemon response"),
    );
    let remaining = refusals;
    const methods: string[] = [];
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        methods.push(request.method);
        if (request.method === YDOC_METHOD.recordUpdate && remaining > 0) {
          remaining -= 1;
          throw busy;
        }
        return engine.sendRequest(request);
      },
    };
    const settled: YdocSettleResult[] = [];
    const scheduler = settleScheduler();
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      settleDebounceMs: 100,
      onRemoteUpdate: () => undefined,
      onSettleError: () => undefined,
      onSettled: (result) => {
        settled.push(result);
      },
      scheduleSettle: scheduler.schedule,
    });
    const update = plaintextUpdate(provider.initialUpdate, (body) => {
      body.insert(0, text);
    });
    const journaled = provider.applyLocalUpdate(update);
    return { provider, busy, settled, scheduler, journaled, methods };
  }

  it("sends the engine the state a busy journal write left it missing", async () => {
    // #658, codex P1. The journal write happens ONCE, at applyLocalUpdate, and
    // its promise is what every later settle awaits. A busy refusal left that
    // promise permanently rejected, so each ladder rung re-awaited the same
    // dead chain and sent nothing.
    //
    // Replaying the refused BYTES is not the fix and is worse than the bug:
    // `applyLocalUpdate` records what a Yjs transaction observes, and applying
    // an update the doc already holds observes nothing — the engine would get
    // an empty delta and the settle behind it would report a save of text the
    // engine never received. The resend asks durable state what is missing.
    const { provider, settled, scheduler, journaled } =
      await openAgainstABusyJournal("typed while the store was busy", 2);

    // The caller still hears the truth about its own update.
    await expect(journaled).rejects.toThrow("engine-store-busy");
    expect(settled).toEqual([]);

    // The ladder's rung: resend, then settle.
    expect(scheduler.armed).toHaveLength(1);
    scheduler.fire();
    await drain();

    expect(settled).toHaveLength(1);
    // THE assertion a call count cannot make.
    expect(settled[0]?.content).toContain("typed while the store was busy");

    await provider.close({ settle: false });
  });

  it("keeps resending while the store stays busy, and never settles without the text", async () => {
    // The poisoned-chain regression, and the ordering guard with it: no settle
    // may commit while the engine is still missing the text.
    // Three refusals: the write, its recovery replay, and rung one's resend.
    // Rung two then finds the store free.
    const { provider, settled, scheduler } = await openAgainstABusyJournal(
      "typed against a stubborn store",
      3,
    );

    expect(scheduler.armed).toHaveLength(1);
    scheduler.fire();
    await drain();
    // Rung one resent and was refused again. Nothing settled behind it.
    expect(settled).toEqual([]);

    // The contention clears; the next rung resends and the settle carries it.
    expect(scheduler.armed).toHaveLength(1);
    scheduler.fire();
    await drain();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.content).toContain("typed against a stubborn store");

    await provider.close({ settle: false });
  });

  it("sends the missing state before an external edit merges against durable state", async () => {
    // #658, codex P1. `applyExternalMarkdownEdit` flushes the adapter's record
    // chain first, so the engine merges the external body against fully
    // recorded state. That flush cannot see what a transient refusal left
    // unsent: the chain is NEUTRALIZED after one, so awaiting it succeeds
    // while the engine is still missing this session's text — and the merge
    // then runs against a document without it.
    //
    // MUTATION: delete the `resendMissingLocalState()` call from
    // `applyExternalMarkdownEdit` -> the merge sees a lineage without
    // "typed before the merge" and the local edit is reordered out.
    const { provider, methods, journaled } = await openAgainstABusyJournal(
      "typed before the merge ",
      2,
    );
    // Settle the refusal BEFORE clearing the log: the journal write is still
    // in flight otherwise, and its own recovery attempt would land in the
    // window this test measures.
    await expect(journaled).rejects.toThrow("engine-store-busy");
    methods.length = 0;

    // The external editor's full body, which the engine merges against
    // whatever the lineage holds.
    const merged = await provider.applyExternalMarkdownEdit(
      "written outside dohc",
    );
    expect(merged.kind).toBe("merged");

    // THE assertion, and it has to be about ORDER at the transport: a settle
    // afterwards would resend the missing state itself and hide the defect.
    // The engine must have received the local text BEFORE it was asked to
    // merge anything against the lineage.
    const resendAt = methods.indexOf(YDOC_METHOD.recordUpdate);
    const mergeAt = methods.indexOf(YDOC_METHOD.applyExternalMarkdownEdit);
    expect(mergeAt).toBeGreaterThanOrEqual(0);
    expect(resendAt).toBeGreaterThanOrEqual(0);
    expect(resendAt).toBeLessThan(mergeAt);

    await provider.close({ settle: false });
  });

  it("refuses to release a session still holding text the engine never got", async () => {
    // #658, codex P1. The pre-close settle is the LAST chance to hand the
    // engine text a transient refusal left unsent, and the doc holding that
    // text goes away with the release. Releasing anyway produced the one
    // outcome nothing downstream can repair: the caller sees a clean
    // "released, settle failed", arms a retry that reopens and settles what
    // the lineage holds, and reports a save of a document missing the edit.
    //
    // So the teardown is REFUSED while local state is unsent, and the close
    // ladder above retries the whole thing.
    //
    // MUTATION: drop the `engineMissingLocalState` guard before the release
    // in `close` -> this rejects with YdocReleasedWithSettleFailureError, the
    // shape that says the session is gone and only the settle failed.
    const { provider, journaled } = await openAgainstABusyJournal(
      "typed and never sent",
      // The write, its recovery replay, and every resend the close attempts.
      99,
    );
    await expect(journaled).rejects.toThrow("engine-store-busy");

    const closeFailure = await provider
      .close()
      .then(() => null)
      .catch((error: unknown) => error);

    expect(closeFailure).not.toBeNull();
    // NOT the released-with-failed-settle shape: the session is still here.
    expect(closeFailure).not.toBeInstanceOf(YdocReleasedWithSettleFailureError);
    expect(String(closeFailure)).toContain("engine-store-busy");
  });

  it("releases once the resend lands, so a close is not blocked for good", async () => {
    // The other half: the refusal above is a WAIT, not a wedge. Once the
    // store frees, the same close hands over the text and completes.
    const { provider, journaled } = await openAgainstABusyJournal(
      "typed and eventually sent",
      2,
    );
    await expect(journaled).rejects.toThrow("engine-store-busy");

    // The store is free by now, so the pre-close settle resends and settles.
    await provider.close();
  });

  it("refuses a settle:false release too, which is the path a vacate takes", async () => {
    // THE substitution-review sequence. A busy journal is absorbed (no
    // rebind), the user's close leaves the entry failing-close with a retry
    // armed, and a rename or version switch inside that window calls
    // `settleAndCloseLiveYDocSessions` — which closes a failing-close entry
    // with `settle: false`.
    //
    // The guard used to hang off the pre-close settle's failure, and
    // `settle: false` runs no settle, so it was skipped entirely: the session
    // released, the canonical doc was discarded, and the edit was gone.
    // `settle: false` declines the ARTIFACT, never the user's text.
    //
    // MUTATION: gate the release refusal on the pre-close settle again (or
    // resend only when `settle !== false`) -> this close resolves and the
    // text is lost.
    const { provider, journaled } = await openAgainstABusyJournal(
      "typed and never sent",
      99,
    );
    await expect(journaled).rejects.toThrow("engine-store-busy");

    const outcome = await provider
      .close({ settle: false })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(outcome).not.toBeNull();
    expect(String(outcome)).toContain("engine-store-busy");
  });

  it("releases a terminal pre-close failure instead of wedging on it", async () => {
    // The narrowness guard for the refusal above. Only a TRANSIENT failure is
    // worth holding the session for, because only that class is retried. A
    // terminal one cannot be waited out, so refusing the teardown would strand
    // the entry forever holding a daemon lease nobody can release — worse than
    // reporting the loss.
    //
    // MUTATION: drop `isTransientEngineRefusal` from the release guard -> this
    // close never completes its release, and the lease leaks.
    const engine = seedPlaintextEngine();
    const busy = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "engine-store-busy",
        retry: "afterBackoff",
      },
      new Error("daemon response"),
    );
    const terminal = new DaemonRefusalError(
      { code: "INVALID_PARAMS", message: "conflict-stale-target", retry: "no" },
      new Error("daemon response"),
    );
    // The journal is refused busy (leaving state unsent); every LATER record
    // is refused terminally, so the close's resend cannot be waited out.
    let records = 0;
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate) {
          records += 1;
          throw records <= 2 ? busy : terminal;
        }
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      onSettleError: () => undefined,
      scheduleSettle: () => () => undefined,
    });
    await provider
      .applyLocalUpdate(
        plaintextUpdate(provider.initialUpdate, (body) => {
          body.insert(0, "typed against a terminal engine");
        }),
      )
      .catch(() => undefined);

    // The release COMPLETES and reports, rather than holding the session.
    const outcome = await provider
      .close()
      .then(() => null)
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(YdocReleasedWithSettleFailureError);
  });

  it("refuses to evict a session the engine is still behind", async () => {
    // #713 review, P1-b. An evict declines the ARTIFACT and the prune. It does
    // not decline the user's text — and a transiently refused `recordUpdate`
    // leaves that text in this doc alone, with the durable lineage behind it.
    // Dropping the session there loses the edit permanently, which is the one
    // thing an evict is supposed to make impossible.
    //
    // `close` already refuses in exactly this state. So does this now: hand
    // the engine what it is missing first, and refuse while the debt is one a
    // retry can still pay.
    //
    // MUTATION: drop the `missingLocalState` guard from `evict` (or its
    // `resendMissingState` call) -> this resolves and "typed and never sent"
    // exists nowhere but a doc about to be discarded.
    const { provider, journaled } = await openAgainstABusyJournal(
      "typed and never sent",
      99,
    );
    await expect(journaled).rejects.toThrow("engine-store-busy");

    const outcome = await provider
      .evict()
      .then(() => null)
      .catch((error: unknown) => error);

    expect(outcome).not.toBeNull();
    expect(String(outcome)).toContain("engine-store-busy");
    // Still the caller's to retry: the refusal kept the session rather than
    // trading the edit for a released lease.
    expect(provider.doc.getText("plainText").toString()).toContain(
      "typed and never sent",
    );
  });

  it("evicts once the resend clears the debt the refusal left", async () => {
    // The narrowness guard for the refusal above. A debt that CAN be paid is
    // paid, and then the evict proceeds — otherwise the orphan this exit
    // exists for would be wedged by a refusal that has already cleared.
    const engine = seedPlaintextEngine();
    const busy = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "engine-store-busy",
        retry: "afterBackoff",
      },
      new Error("daemon response"),
    );
    // Busy until the contention clears, so the debt is still outstanding when
    // the evict runs — a fixed refusal count cannot stage that, because the
    // provider's own ladder may already have paid it.
    let contended = true;
    const methods: string[] = [];
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate && contended) throw busy;
        methods.push(request.method);
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      onSettleError: () => undefined,
      scheduleSettle: () => () => undefined,
    });
    await provider
      .applyLocalUpdate(
        plaintextUpdate(provider.initialUpdate, (body) => {
          body.insert(0, "typed and finally sent");
        }),
      )
      .catch(() => undefined);
    methods.length = 0;
    contended = false;

    await provider.evict();

    // The resend went first, and the evict followed it.
    expect(methods).toEqual([
      YDOC_METHOD.resync,
      YDOC_METHOD.recordUpdate,
      YDOC_METHOD.evict,
    ]);
  });

  it("evicts after a terminal resend failure instead of wedging on it", async () => {
    // MUTATION: widen the evict guard to any resend failure -> the terminal refusal strands the lease.
    const engine = seedPlaintextEngine();
    const busy = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "engine-store-busy",
        retry: "afterBackoff",
      },
      new Error("daemon response"),
    );
    const terminal = new DaemonRefusalError(
      { code: "INVALID_PARAMS", message: "conflict-stale-target", retry: "no" },
      new Error("daemon response"),
    );
    let records = 0;
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate) {
          records += 1;
          throw records <= 2 ? busy : terminal;
        }
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      onSettleError: () => undefined,
      scheduleSettle: () => () => undefined,
    });
    await provider
      .applyLocalUpdate(
        plaintextUpdate(provider.initialUpdate, (body) => {
          body.insert(0, "typed against a terminal engine");
        }),
      )
      .catch(() => undefined);

    await expect(provider.evict()).resolves.toBeUndefined();
  });

  it("releases an orphan that is holding nothing of the user's", async () => {
    // The wedge guard the fold could have introduced: a doc that never took a
    // local edit owes no debt, so nothing may hold up its teardown. Orphans
    // are closed exactly this way (`settle: false, settleOnRefusal: false`).
    const engine = seedPlaintextEngine();
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      sendRequest: (request) => engine.sendRequest(request),
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined,
    });
    await provider.close({ settle: false, settleOnRefusal: false });
  });

  it("keeps the session alive through a busy journal write", async () => {
    // The session used to be QUARANTINED by a busy refusal: `enqueueRecordUpdate`
    // quarantined on any failure of its record chain, so the first contention
    // killed the document for good and every resend above would have been
    // refused by a dead session. Quarantine is for a session whose canonical
    // state is unknowable; a busy engine refused cleanly and changed nothing.
    const { provider, settled, scheduler, journaled } =
      await openAgainstABusyJournal("typed before the session died", 2);
    await expect(journaled).rejects.toThrow("engine-store-busy");

    // THE proof: the session still takes edits.
    const second = plaintextUpdate(provider.initialUpdate, (body) => {
      body.insert(0, "typed after the refusal ");
    });
    await provider.applyLocalUpdate(second);

    scheduler.fire();
    await drain();
    expect(settled).toHaveLength(1);
    // Both edits reached the engine — the refused one via the resend, the
    // later one on its own.
    expect(settled[0]?.content).toContain("typed before the session died");
    expect(settled[0]?.content).toContain("typed after the refusal");

    await provider.close({ settle: false });
  });

  it("resets the ladder once a settle reaches disk, so the next lock starts over", async () => {
    // The reset is what keeps a document that is locked twice in a session
    // from inheriting the first lock's grown delay — the second lock must be
    // retried as promptly as the first, not minutes later.
    const { provider, blocked, settled, delays, scheduler } =
      await openAgainstABlockedSettle("typed against a locked file", {
        settleDebounceMs: 100,
      });

    // Climb two rungs: armed at 100, retry at 100, retry at 200.
    scheduler.fire();
    await drain();
    scheduler.fire();
    await drain();
    expect(delays).toEqual([100, 100, 200]);

    // The lock releases and the pending retry lands the write.
    blocked.held = false;
    scheduler.fire();
    await drain();
    expect(settled).toHaveLength(1);

    // A LATER lock: the next failure must re-arm at the debounce, not at 400.
    blocked.held = true;
    await provider.applyLocalUpdate(
      plaintextUpdate(provider.initialUpdate, (body) => {
        body.insert(0, "typed again");
      }),
    );
    scheduler.fire();
    await drain();
    expect(delays).toEqual([100, 100, 200, 100, 100]);

    await provider.close({ settle: false });
  });

  it("caps the ladder so a long-held lock still retries on a bounded delay", async () => {
    // The cap bounds how long the on-disk artifact stays stale after the lock
    // releases. Without it the delay doubles without limit and a file locked
    // for an afternoon is retried hours after the handle is gone.
    const { provider, delays, scheduler } = await openAgainstABlockedSettle(
      "typed against a long-held lock",
      { settleDebounceMs: 4000 },
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
      scheduler.fire();
      await drain();
    }
    expect(delays).toEqual([4000, 4000, 8000, 10_000, 10_000]);

    await provider.close({ settle: false });
  });

  it("starts the ladder at the DEFAULT debounce when the caller sets none", async () => {
    const { provider, delays, scheduler } = await openAgainstABlockedSettle(
      "typed with the default debounce",
    );

    scheduler.fire();
    await drain();
    expect(delays).toEqual([800, 800]);

    await provider.close({ settle: false });
  });

  it("lets an edit made during the backoff own the timer instead of adding one", async () => {
    // An edit is the strongest retry trigger there is, so the settle it arms
    // supersedes the ladder's. Arming a second timer alongside it would leave
    // the edit's timer orphaned and settle the document twice.
    const { provider, delays, scheduler } = await openAgainstABlockedSettle(
      "typed against a locked file",
      { settleDebounceMs: 100 },
    );

    // Start the settle, then type again while it is still in flight.
    scheduler.fire();
    void provider.applyLocalUpdate(
      plaintextUpdate(provider.initialUpdate, (body) => {
        body.insert(0, "typed during the backoff");
      }),
    );
    await drain();

    // ONE timer: the edit's. The refused settle deferred to it.
    expect(scheduler.armed).toHaveLength(1);
    expect(delays).toEqual([100, 100]);

    await provider.close({ settle: false });
  });

  it("an explicit flush that hits the lock arms the retry too", async () => {
    // settleNow rejects to its caller — a delete or merge must fail loudly —
    // but the write it left pending is the same one, so the background retry
    // is armed as well.
    const { provider, blocked, refusal, settled, scheduler } =
      await openAgainstABlockedSettle("flushed against a locked file", {
        settleDebounceMs: 100,
      });

    await expect(provider.settleNow()).rejects.toBe(refusal);
    await drain();
    // The debounced settle the edit armed was superseded by the explicit
    // flush, so the one armed timer is the flush's own retry.
    expect(scheduler.armed.map((entry) => entry.ms)).toEqual([100]);

    blocked.held = false;
    scheduler.fire();
    await drain();
    expect(settled).toHaveLength(1);

    await provider.close({ settle: false });
  });

  it("debounces on its OWN timers when the caller supplies no scheduler", async () => {
    // Every other provider test in this file replaces the settle scheduler, so
    // this is the one place the provider's own setTimeout/clearTimeout runs. A
    // debounce that never fires never writes the file; a cancel that never
    // clears wakes a released session and reports a failure against a document
    // the user already closed. The clock is driven, not waited on.
    vi.useFakeTimers();
    try {
      const engine = seedPlaintextEngine();
      const settled: unknown[] = [];
      const sessionErrors: unknown[] = [];
      const provider = await openEngineYdocProviderSession({
        transport: engine,
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH,
        contentKind: "plaintext",
        settleDebounceMs: 50,
        onRemoteUpdate: () => undefined,
        onSessionError: (error) => sessionErrors.push(error),
        onSettled: (result) => {
          settled.push(result);
        },
      });

      await provider.applyLocalUpdate(
        plaintextUpdate(provider.initialUpdate, (text) => {
          text.insert(0, "debounced onto the provider's own timer");
        }),
      );
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveLength(1);

      // A second edit arms another timer. `close` runs its cancel before its
      // first await, so the arm and the cancel land in the same tick.
      const pending = provider.applyLocalUpdate(
        plaintextUpdate(provider.initialUpdate, (text) => {
          text.insert(0, "armed then cancelled");
        }),
      );
      await provider.close({ settle: false });
      await pending.catch(() => undefined);
      const settlesAtClose = engine.requests.filter(
        (request) => request.method === YDOC_METHOD.settle,
      ).length;
      await vi.advanceTimersByTimeAsync(500);

      expect(
        engine.requests.filter(
          (request) => request.method === YDOC_METHOD.settle,
        ),
      ).toHaveLength(settlesAtClose);
      expect(sessionErrors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms a settle when the engine delivers a remote update", async () => {
    // An engine-delivered update is content this editor has not written to the
    // artifact yet. Without arming a settle it sits in the session until some
    // unrelated later edit happens to flush it.
    const engine = seedPlaintextEngine("seed");
    const remoteUpdates: Uint8Array[] = [];
    const scheduler = settleScheduler();
    const provider = await openEngineYdocProviderSession({
      transport: engine,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      settleDebounceMs: 100,
      onRemoteUpdate: (update) => remoteUpdates.push(update),
      scheduleSettle: scheduler.schedule,
    });

    expect(scheduler.armed).toHaveLength(0);
    await provider.applyExternalMarkdownEdit("external edit");

    expect(remoteUpdates).toHaveLength(1);
    expect(scheduler.armed.map((entry) => entry.ms)).toEqual([100]);

    await provider.close({ settle: false });
  });

  it("treats an onSettled failure as a settle failure", async () => {
    // onSettled is what lands the .md. When it throws, the bytes never reached
    // the file — a caller told the settle SUCCEEDED would show "Saved" over a
    // stale artifact.
    const engine = seedPlaintextEngine("seed");
    const landingFailure = new Error("injected artifact write failure");
    const settleErrors: unknown[] = [];
    const provider = await openEngineYdocProviderSession({
      transport: engine,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      onSettleError: (error) => settleErrors.push(error),
      onSettled: () => {
        throw landingFailure;
      },
      scheduleSettle: () => () => undefined,
    });
    // A recorded update, so the settle below finds durable state to
    // project instead of hitting the daemon's NoMarker guard.
    provider.applyLocalUpdate(
      plaintextUpdate(provider.initialUpdate, (text) => {
        text.insert(0, "typed");
      }),
    );

    await expect(provider.settleNow()).rejects.toBe(landingFailure);
    expect(settleErrors).toEqual([landingFailure]);

    await provider.close({ settle: false });
  });

  it("aborts a settle after a SYNCHRONOUS local edit failure", async () => {
    // An ill-formed edit throws out of applyLocalUpdate without ever attaching
    // to the journal chain, so the chain the settle awaits resolves clean.
    // Settling anyway would write an artifact missing the edit the user just
    // made, and report success for it.
    const engine = seedPlaintextEngine();
    const settleErrors: unknown[] = [];
    const provider = await openEngineYdocProviderSession({
      transport: engine,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      onSettleError: (error) => settleErrors.push(error),
      scheduleSettle: () => () => undefined,
    });

    expect(() =>
      provider.applyLocalUpdate(
        plaintextUpdate(provider.initialUpdate, (text) => {
          text.insert(0, "\ud800");
        }),
      ),
    ).toThrow(IllFormedUtf16EditError);

    await expect(provider.settleNow()).rejects.toBeInstanceOf(
      IllFormedUtf16EditError,
    );
    expect(settleErrors[0]).toBeInstanceOf(IllFormedUtf16EditError);
    expect(engine.requests.map((request) => request.method)).not.toContain(
      YDOC_METHOD.settle,
    );

    await provider.close({ settle: false });
  });

  it("waits for an in-flight settle before releasing the session", async () => {
    // Releasing while a settle is still at the engine races the write against
    // the lease teardown: close resolves, the capture layer lifts its path
    // guard, and the settle that was still landing the artifact finishes
    // against a session that is already gone.
    const engine = seedPlaintextEngine("seed");
    let releaseSettle!: () => void;
    const settleGate = new Promise<void>((resolve) => {
      releaseSettle = resolve;
    });
    const order: string[] = [];
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.settle) {
          await settleGate;
          order.push("settled");
        }
        if (request.method === YDOC_METHOD.close) order.push("released");
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined,
    });
    // A recorded update, so the settle below finds durable state instead
    // of hitting the daemon's NoMarker guard.
    await provider.applyLocalUpdate(
      plaintextUpdate(provider.initialUpdate, (text) => {
        text.insert(0, "typed");
      }),
    );

    const settling = provider.settleNow();
    const closing = provider.close({ settle: false });
    await drain();
    // The close is parked on the settle chain: nothing has been released.
    expect(order).toEqual([]);

    releaseSettle();
    await settling;
    await closing;

    expect(order).toEqual(["settled", "released"]);
    expect(engine.activeSessionIds()).toHaveLength(0);
  });

  it("ignores a local update that arrives after the session released", async () => {
    // The session and its lease are gone, so there is nothing to journal and
    // nothing to retry: a late keystroke from a torn-down editor must not
    // reject into a caller that has no session left to act on.
    const engine = seedPlaintextEngine();
    const provider = await openEngineYdocProviderSession({
      transport: engine,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined,
    });

    await provider.close({ settle: false });
    await expect(
      provider.applyLocalUpdate(
        plaintextUpdate(provider.initialUpdate, (text) => {
          text.insert(0, "typed after teardown");
        }),
      ),
    ).resolves.toBeUndefined();

    expect(engine.recordedUpdates).toHaveLength(0);
    expect(engine.requests.map((request) => request.method)).toEqual([
      YDOC_METHOD.open,
      YDOC_METHOD.close,
    ]);
  });

  it("announces a settle at the JOURNAL BARRIER, not when it finally runs", async () => {
    // Round 3 (D5). onSettleStart used to fire inside the settle chain, so a
    // settle QUEUED behind an in-flight one announced itself only once the
    // first finished. A caller snapshotting edit progress on that hook then
    // captured a counter that had already advanced past what the settle
    // would carry, and the later success over-claimed those keystrokes.
    // Firing at the barrier makes the snapshot conservative instead.
    const engine = seedPlaintextEngine();
    let releaseFirstSettle!: () => void;
    const firstSettleGate = new Promise<void>((resolve) => {
      releaseFirstSettle = resolve;
    });
    let settles = 0;
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.settle) {
          settles += 1;
          if (settles === 1) await firstSettleGate;
        }
        return engine.sendRequest(request);
      },
    };
    const events: string[] = [];
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      onSettleStart: () => events.push("settling"),
      onSettled: () => {
        events.push("settled");
      },
      scheduleSettle: () => () => undefined,
    });
    // A recorded update, so both settles below find durable state instead
    // of hitting the daemon's NoMarker guard.
    await provider.applyLocalUpdate(
      plaintextUpdate(provider.initialUpdate, (text) => {
        text.insert(0, "typed");
      }),
    );

    const first = provider.settleNow();
    const second = provider.settleNow();
    // Both settles reach their barrier, but neither can COMPLETE while the
    // first is held at the transport.
    await drain();

    expect(events.filter((event) => event === "settling")).toHaveLength(2);
    expect(events).not.toContain("settled");

    releaseFirstSettle();
    await first;
    await second;
    expect(events.filter((event) => event === "settled")).toHaveLength(2);

    await provider.close({ settle: false });
  });

  it("reports a JOURNAL failure to onSettleError too — the edit never reached the engine", async () => {
    // Round 2 (D2b). runSettle aborts on a journal failure BEFORE the settle
    // chain, so onSettleStart/onSettleError never fired and the error routed
    // only to onSessionError — the same reconnect-only sink this PR exists to
    // stop relying on. A recordUpdate that failed is worse than a settle that
    // failed: the edit is not even in the engine.
    const engine = seedPlaintextEngine();
    const recordFailure = new Error("injected record failure");
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate) throw recordFailure;
        return engine.sendRequest(request);
      },
    };
    const settleErrors: unknown[] = [];
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      onSettleError: (error) => settleErrors.push(error),
      scheduleSettle: () => () => undefined,
    });

    const update = plaintextUpdate(provider.initialUpdate, (text) => {
      text.insert(0, "never journaled");
    });
    await provider.applyLocalUpdate(update).catch(() => undefined);
    await provider.settleNow().catch(() => undefined);

    // The failure that reaches the save-state channel is the REAL cause —
    // the refused recordUpdate — not some generic wrapper.
    expect(settleErrors.length).toBeGreaterThan(0);
    expect(
      settleErrors.some(
        (error) =>
          error === recordFailure ||
          (error instanceof Error && error.cause === recordFailure),
      ),
    ).toBe(true);
    await provider.close({ settle: false }).catch(() => undefined);
  });

  it("surfaces an unrecoverable journal update and still closes the provider", async () => {
    const engine = seedPlaintextEngine();
    const recordFailure = new Error("injected record failure");
    const methods: string[] = [];
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        methods.push(request.method);
        if (request.method === YDOC_METHOD.recordUpdate) throw recordFailure;
        return engine.sendRequest(request);
      },
    };
    const localErrors: unknown[] = [];
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      onLocalEditError: (error) => localErrors.push(error),
      scheduleSettle: () => () => undefined,
    });
    const update = plaintextUpdate(provider.initialUpdate, (text) => {
      text.insert(0, "local");
    });

    const journalFailure = await provider.applyLocalUpdate(update).catch(
      (error: unknown) => error,
    );
    expect(journalFailure).toMatchObject({
      message: expect.stringContaining(recordFailure.message),
      cause: recordFailure,
    });
    await expect(provider.settleNow()).rejects.toBe(journalFailure);
    expect(localErrors).toEqual([journalFailure]);
    expect(engine.requests.map((request) => request.method)).not.toContain(
      YDOC_METHOD.settle,
    );
    await expect(provider.close({ settle: false })).resolves.toBeUndefined();
    expect(methods.at(-1)).toBe(YDOC_METHOD.close);
  });

  it("retries a provider release with settle true after an unsettled close refusal", async () => {
    const engine = seedPlaintextEngine();
    const unsettledClose = new Error("injected unsettled close");
    const closes: Array<boolean | undefined> = [];
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.close) {
          const settle = (request.params as { settle?: boolean }).settle;
          closes.push(settle);
          if (settle === false) throw unsettledClose;
        }
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined,
    });
    // A recorded update, so the escalated settling close below finds
    // durable state instead of hitting the daemon's NoMarker guard.
    await provider.applyLocalUpdate(
      plaintextUpdate(provider.initialUpdate, (text) => {
        text.insert(0, "typed");
      }),
    );

    await expect(provider.close({ settle: false })).resolves.toBeUndefined();
    expect(closes).toEqual([false, true]);
    expect(engine.activeSessionIds()).toHaveLength(0);
  });

  // #534, codex P1. The escalation above is right for an ordinary teardown and
  // WRONG for a caller releasing a session it is about to declare absent: the
  // daemon refuses that release precisely BECAUSE content arrived, so settling
  // it writes the file the caller is about to say does not exist. That caller
  // says `settleOnRefusal: false`, and the refusal comes back instead.
  it("never escalates to a settling close when the caller forbids it", async () => {
    const engine = seedPlaintextEngine();
    const unsettledClose = new Error("injected unsettled close");
    const closes: Array<boolean | undefined> = [];
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.close) {
          const settle = (request.params as { settle?: boolean }).settle;
          closes.push(settle);
          if (settle === false) throw unsettledClose;
        }
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined,
    });

    await expect(
      provider.close({ settle: false, settleOnRefusal: false }),
    ).rejects.toBe(unsettledClose);
    // ONE close attempt, and it did not settle. The settling retry is what
    // would have materialized the path.
    expect(closes).toEqual([false]);
  });

  it("marks a close whose settle failed but whose release succeeded as RELEASED", async () => {
    const engine = seedPlaintextEngine("settled base");
    const settleFailure = new Error("injected settle refusal");
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.settle) throw settleFailure;
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined,
    });

    // The distinction is load-bearing for the capture layer's live-session
    // guard: a released-but-unsettled close must LIFT the path guard (nothing
    // holds the lease), while a failed release must retain it.
    const rejection = await provider.close().catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(YdocReleasedWithSettleFailureError);
    expect((rejection as YdocReleasedWithSettleFailureError).cause).toBe(settleFailure);
    expect(engine.activeSessionIds()).toHaveLength(0);
  });

  it("escalates a transient richdoc release to a settling close, like plaintext", async () => {
    const engine = new YdocLoopbackEngine();
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      content: "",
      contentKind: "richdoc",
    });
    const transientClose = new Error("injected transient close failure");
    const closes: Array<boolean | undefined> = [];
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.close) {
          const settle = (request.params as { settle?: boolean }).settle;
          closes.push(settle);
          if (closes.length === 1) throw transientClose;
        }
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "richdoc",
      onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined,
    });
    // A recorded update, so the escalated settling close below finds
    // durable state instead of hitting the daemon's NoMarker guard.
    await provider.applyLocalUpdate(richdocUpdate(provider.initialUpdate, "typed"));

    await expect(provider.close({ settle: false })).resolves.toBeUndefined();
    // Richdoc settles since R15-3's full-fidelity projection: the retry
    // escalates to a settling close so pending edits are preserved.
    expect(closes).toEqual([false, true]);
    expect(engine.activeSessionIds()).toHaveLength(0);
  });

  it("rejects edits while a failed provider close is incomplete, then converges on retry", async () => {
    const engine = seedPlaintextEngine();
    const firstCloseFailure = new Error("injected plain close failure");
    const settlingCloseFailure = new Error("injected settling close failure");
    const closes: Array<boolean | undefined> = [];
    let allowClose = false;
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.close) {
          const settle = (request.params as { settle?: boolean }).settle;
          closes.push(settle);
          if (!allowClose) {
            throw settle === false
              ? firstCloseFailure
              : settlingCloseFailure;
          }
        }
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined,
    });
    const update = plaintextUpdate(provider.initialUpdate, (text) => {
      text.insert(0, "must reject");
    });

    await expect(provider.close({ settle: false })).rejects.toBe(
      settlingCloseFailure,
    );
    await expect(provider.applyLocalUpdate(update)).rejects.toBe(
      settlingCloseFailure,
    );
    expect(engine.recordedUpdates).toHaveLength(0);

    allowClose = true;
    await expect(provider.close({ settle: false })).resolves.toBeUndefined();
    expect(closes).toEqual([false, true, false]);
    expect(engine.activeSessionIds()).toHaveLength(0);
  });

  it("treats typed ydoc-session-not-found close refusal as an already-complete release", async () => {
    const engine = seedPlaintextEngine();
    const closes: Array<boolean | undefined> = [];
    const notFound = Object.assign(new Error("ydoc-session-not-found"), {
      code: "wire-error",
      wireError: {
        code: "INVALID_PARAMS",
        message: "ydoc-session-not-found",
        retry: "no",
      },
    });
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.close) {
          closes.push((request.params as { settle?: boolean }).settle);
          await engine.sendRequest(request);
          throw notFound;
        }
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined,
    });

    await expect(provider.close({ settle: false })).resolves.toBeUndefined();
    expect(closes).toEqual([false]);
    expect(engine.activeSessionIds()).toHaveLength(0);
    await expect(provider.close({ settle: false })).resolves.toBeUndefined();
  });

  it("resyncs once and settles again when a settle is refused for pending remote updates", async () => {
    // #650. `ydoc-remote-updates-pending` says peers drained edits under this
    // session's lease, so this doc is BEHIND the durable lineage. The engine
    // refuses rather than materializing content this editor never saw, and the
    // cure is to resync (which returns the drained state) and settle the
    // merged result.
    //
    // It rides INVALID_PARAMS / retry: "no", the terminal shape — so the
    // MESSAGE is the only thing that tells this transient race apart from a
    // refusal that answers the write for good, and the typed discriminator is
    // what reads it.
    //
    // Not reachable in a shipping build: the engine raises this only for a
    // marker in `Regime::Replicated`, which only dohc-engine-sync's inbound
    // apply path constructs — the sync stack is unbuilt (#356, #378). Injected
    // here so the classification is right before two-peer sync lands.
    const engine = seedPlaintextEngine();
    const methods: string[] = [];
    let refused = false;
    const remoteUpdatesPending = Object.assign(
      new Error("ydoc-remote-updates-pending"),
      {
        code: "wire-error",
        wireError: {
          code: "INVALID_PARAMS",
          message: "ydoc-remote-updates-pending",
          retry: "no",
        },
      },
    );
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        methods.push(request.method);
        if (request.method === YDOC_METHOD.settle && !refused) {
          refused = true;
          throw remoteUpdatesPending;
        }
        return engine.sendRequest(request);
      },
    };
    const adapter = new YdocLiveAdapter(transport);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    // A recorded update, so the settles below find durable state instead
    // of hitting the daemon's NoMarker guard.
    await session.applyLocalTextEdit({ root: "plainText", index: 0, insert: "typed" });

    await expect(session.settle()).resolves.toMatchObject({
      materialized: true,
    });
    // The resync sits BETWEEN the two settles. Reordered or missing, the
    // second settle projects the same state the first was refused for.
    expect(methods.filter((method) => method !== YDOC_METHOD.open)).toEqual([
      YDOC_METHOD.recordUpdate,
      YDOC_METHOD.settle,
      YDOC_METHOD.resync,
      YDOC_METHOD.settle,
    ]);
  });

  it("detects a per-session event sequence gap and marks the session stale", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    const source = new Y.Doc();
    Y.applyUpdate(source, session.initialUpdate);
    const text = source.getText("plainText");
    const beforeFirst = Y.encodeStateVector(source);
    text.insert(0, "A");
    const first = Y.encodeStateAsUpdate(source, beforeFirst);
    const beforeSecond = Y.encodeStateVector(source);
    text.insert(1, "B");
    const second = Y.encodeStateAsUpdate(source, beforeSecond);
    const resyncErrors: YdocResyncNeededError[] = [];
    session.onResyncNeeded((error) => resyncErrors.push(error));

    engine.applyRemoteUpdate(session.sessionId, first);
    engine.applyRemoteUpdate(session.sessionId, second, { seq: 3 });

    expect(resyncErrors).toHaveLength(1);
    expect(resyncErrors[0]?.reason).toBe("event-sequence-gap");
    expect(session.doc.getText("plainText").toString()).toBe("A");
    expect(() =>
      session.applyLocalTextEdit({ root: "plainText", index: 1, insert: "C" }),
    ).toThrow(YdocResyncNeededError);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(engine.requests.map((request) => request.method)).toContain(
      YDOC_METHOD.resync,
    );
    expect(session.doc.getText("plainText").toString()).toBe("AB");
    await expect(
      session.applyLocalTextEdit({ root: "plainText", index: 2, insert: "C" }),
    ).resolves.toBeDefined();

    await session.close({ settle: true });
    adapter.dispose();
  });

  it("resyncs again when a remote event arrives during the resync window", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    const source = new Y.Doc();
    Y.applyUpdate(source, session.initialUpdate);
    const text = source.getText("plainText");
    const beforeFirst = Y.encodeStateVector(source);
    text.insert(0, "A");
    const first = Y.encodeStateAsUpdate(source, beforeFirst);
    const beforeSecond = Y.encodeStateVector(source);
    text.insert(1, "B");
    const second = Y.encodeStateAsUpdate(source, beforeSecond);
    const beforeThird = Y.encodeStateVector(source);
    text.insert(2, "C");
    const third = Y.encodeStateAsUpdate(source, beforeThird);

    engine.applyRemoteUpdate(session.sessionId, first);
    // seq gap -> stale; the resync request is in flight after this call.
    engine.applyRemoteUpdate(session.sessionId, second, { seq: 3 });
    // An event landing INSIDE the resync window: its update cannot be ordered
    // against the in-flight state, so the session must resync once more
    // instead of silently resetting the baseline past it.
    engine.applyRemoteUpdate(session.sessionId, third, { seq: 4 });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const resyncCalls = engine.requests.filter(
      (request) => request.method === YDOC_METHOD.resync,
    );
    expect(resyncCalls).toHaveLength(2);
    expect(session.doc.getText("plainText").toString()).toBe("ABC");

    await session.close({ settle: true });
    adapter.dispose();
  });

  it("surfaces remote event decode errors without throwing into dispatch", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    const resyncErrors: YdocResyncNeededError[] = [];
    session.onResyncNeeded((error) => resyncErrors.push(error));

    expect(() =>
      engine.emitEvent({
        seq: 1,
        sessionGeneration: 1,
        name: YDOC_EVENT.remoteUpdate,
        payload: {
          sessionId: session.sessionId,
          updateBase64: "not-base64",
        },
      }),
    ).not.toThrow();
    expect(resyncErrors[0]?.reason).toBe("event-decode-failed");

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("rejects a structurally malformed loopback record update atomically", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    await expect(
      engine.sendRequest({
        id: 999,
        method: YDOC_METHOD.recordUpdate,
        workspace: WORKSPACE,
        idempotencyKey: `${session.sessionId}:malformed`,
        params: {
          sessionId: session.sessionId,
          updateBase64: "/w==",
        },
      }),
    ).rejects.toThrow();
    expect(engine.recordedUpdates).toHaveLength(0);
    expect(engine.sessionText(session.sessionId)).toBe("");

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("uses independent record and event sequences for loopback sessions", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const firstSession = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    const secondSession = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    const firstRecord = await firstSession.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "A",
    });
    const secondRecord = await secondSession.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "B",
    });
    const firstRemote = plaintextUpdate(firstSession.initialUpdate, (text) => {
      text.insert(0, "1");
    });
    const secondRemote = plaintextUpdate(secondSession.initialUpdate, (text) => {
      text.insert(0, "2");
    });
    engine.emitRemoteUpdate(firstSession.sessionId, firstRemote);
    engine.emitRemoteUpdate(secondSession.sessionId, secondRemote);

    expect(firstRecord?.seq).toBe(1);
    expect(secondRecord?.seq).toBe(1);
    expect(engine.events.map((event) => event.seq)).toEqual([1, 1]);

    await firstSession.close({ settle: true });
    await secondSession.close({ settle: true });
    adapter.dispose();
  });

  it("opens a captured seed that contains a valid replacement character", async () => {
    const engine = seedPlaintextEngine("before \uFFFD after");
    const adapter = new YdocLiveAdapter(engine);

    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    expect(session.doc.getText("plainText").toString()).toBe("before \uFFFD after");
    await session.close({ settle: true });
    adapter.dispose();
  });

  it("still rejects a captured seed that contains a lone surrogate", async () => {
    const engine = seedPlaintextEngine("bad \ud800 seed");
    const adapter = new YdocLiveAdapter(engine);

    await expect(
      adapter.openSession({
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH,
        contentKind: "plaintext",
      }),
    ).rejects.toBeInstanceOf(IllFormedUtf16EditError);
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
    // `settle: true` (not `false`): the external edit left the projection
    // past the manual settle's `last_settled_sha`, and a local-only close
    // refuses a prune the artifact does not already cover (durable.rs
    // close_session, #721). `settle: true` runs the ladder's normal pre-close
    // settle first, which is what covers it.
    await provider.close({ settle: true });

    expect(settled.content).toBe("seed local");
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
      // The captured seed ("seed") now journals through a real recordUpdate
      // (#721/#728: `ydoc_open_state_on_store` returns `seedContent` for a
      // head-present open with no lineage yet, and the adapter records it),
      // ahead of the manual local edit's own recordUpdate.
      YDOC_METHOD.recordUpdate,
      YDOC_METHOD.recordUpdate,
      YDOC_METHOD.settle,
      YDOC_METHOD.applyExternalMarkdownEdit,
      YDOC_METHOD.settle,
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
    expect(engine.requests[1]).toMatchObject({
      idempotencyKey: "session-1:1",
      params: {
        sessionId: "session-1",
        updateBase64: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/),
      },
    });
    expect(engine.requests[2]).toMatchObject({
      idempotencyKey: "session-1:2",
      params: {
        sessionId: "session-1",
        updateBase64: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/),
      },
    });
    expect(engine.requests[3]?.params).toEqual({
      sessionId: "session-1",
      summary: "manual settle",
    });
    expect(engine.requests[4]?.params).toEqual({
      sessionId: "session-1",
      markdown: "external edit",
    });
    expect(engine.requests[5]?.params).toEqual({
      sessionId: "session-1",
      summary: "session close",
    });
    expect(engine.requests[6]?.params).toEqual({
      sessionId: "session-1",
      settle: false,
    });
    expect(engine.events[0]).toMatchObject({
      seq: 1,
      sessionGeneration: 1,
      name: YDOC_EVENT.remoteUpdate,
      payload: {
        sessionId: "session-1",
        updateBase64: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/),
      },
    });
  });

  it("rejects ill-formed external markdown before sending it to the engine", async () => {
    const engine = seedPlaintextEngine("seed");
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    await expect(
      session.applyExternalMarkdownEdit("bad \ud800 markdown"),
    ).rejects.toBeInstanceOf(IllFormedUtf16EditError);
    expect(engine.requests.map((request) => request.method)).not.toContain(
      YDOC_METHOD.applyExternalMarkdownEdit,
    );

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("keeps request ids unique across sessions sharing one adapter", async () => {
    const engine = new YdocLoopbackEngine();
    for (const path of ["a.txt", "b.txt"]) {
      engine.seedFile({
        workspace: WORKSPACE,
        versionId: VERSION,
        path,
        content: "",
        contentKind: "plaintext",
      });
    }
    const adapter = new YdocLiveAdapter(engine);
    const sessionA = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "a.txt",
      contentKind: "plaintext",
    });
    const sessionB = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "b.txt",
      contentKind: "plaintext",
    });

    const ids = engine.requests.map((request) => request.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);

    await sessionA.close({ settle: false });
    await sessionB.close({ settle: false });
    adapter.dispose();
  });

  it("escalates seed-failure cleanup to a settling close when the plain close refuses", async () => {
    // A seed apply can fail AFTER the daemon committed it (request timeout on
    // an applied update): close settle:false then refuses UnsettledClose. The
    // cleanup must fall back to a settling close so the daemon entry releases
    // instead of wedging until workspace close.
    const engine = seedPlaintextEngine("seeded body");
    const seedFailure = new Error("injected seed timeout");
    const refusal = new Error("unsettled-close");
    const closes: Array<boolean | undefined> = [];
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.open) {
          const response = await engine.sendRequest(request);
          return {
            id: response.id,
            result: {
              ...(response.result as Record<string, unknown>),
              lineage: "absent",
              seedContent: "seeded body",
            },
          };
        }
        if (request.method === YDOC_METHOD.recordUpdate) throw seedFailure;
        if (request.method === YDOC_METHOD.close) {
          const params = request.params as { settle?: boolean };
          closes.push(params.settle);
          if (params.settle === false) throw refusal;
          return { id: request.id, result: null };
        }
        return engine.sendRequest(request);
      },
    };
    const adapter = new YdocLiveAdapter(transport);
    await expect(
      adapter.openSession({
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH,
        contentKind: "plaintext",
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(seedFailure.message),
      cause: seedFailure,
    });
    expect(closes).toEqual([false, true]);
    adapter.dispose();
  });
});

describe("the ydoc.open deadline (#616)", () => {
  // The seam EngineClient owns for a deadlined request: arm a timer at
  // `request.deadlineMs`, and reject with EngineRequestDeadlineError when it
  // fires (engineClient.ts, `sendRequest`, pinned there by "times out only the
  // expired request and ignores its late reply"). A daemon fake that answers
  // instantly would certify the translation below without ever reaching it, so
  // this one answers nothing at all.
  function silentDaemon(): EngineTransport & { armed: number[] } {
    const armed: number[] = [];
    return {
      armed,
      sendRequest(request) {
        const deadlineMs = request.deadlineMs;
        if (deadlineMs === undefined || deadlineMs === null) {
          return new Promise<never>(() => undefined);
        }
        armed.push(deadlineMs);
        return new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(
              new EngineRequestDeadlineError(
                request.id,
                request.method,
                deadlineMs,
              ),
            );
          }, deadlineMs);
        });
      },
      onEvent: () => () => undefined,
    };
  }

  it("carries the measured bound on ydoc.open, and on no other request", async () => {
    const requests: Request[] = [];
    const engine = seedPlaintextEngine("hello");
    const recording: EngineTransport = {
      async sendRequest(request) {
        requests.push(request);
        return await engine.sendRequest(request);
      },
      onEvent: (handler) => engine.onEvent(handler),
    };
    const adapter = new YdocLiveAdapter(recording);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    await session.applyLocalTextEdit({
      root: "plainText",
      index: 5,
      insert: "!",
    });
    await session.close({ settle: true });
    adapter.dispose();

    const deadlines = new Map(
      requests.map((request) => [request.method, request.deadlineMs ?? null]),
    );
    expect(deadlines.get(YDOC_METHOD.open)).toBe(YDOC_OPEN_DEADLINE_MS);
    expect(deadlines.get(YDOC_METHOD.recordUpdate)).toBeNull();
    expect(deadlines.get(YDOC_METHOD.close)).toBeNull();
  });

  it("refuses at the bound when the daemon never answers, naming the limit and the wait", async () => {
    // What the bound's SIZE has to clear is measured in
    // ydocOpenMeasurement.e2e.test.ts. What is pinned here is that the open
    // ends at whatever that bound is, and not one tick before it.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    try {
      const transport = silentDaemon();
      const adapter = new YdocLiveAdapter(transport);
      const opening = adapter.openSession({
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH,
        contentKind: "plaintext",
      });
      const settled = vi.fn();
      void opening.then(settled, settled);

      await vi.advanceTimersByTimeAsync(YDOC_OPEN_DEADLINE_MS - 1);
      expect(transport.armed).toEqual([YDOC_OPEN_DEADLINE_MS]);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const error: unknown = await opening.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(YdocOpenTimedOutError);
      const timedOut = error as YdocOpenTimedOutError;
      expect(timedOut.limitMs).toBe(YDOC_OPEN_DEADLINE_MS);
      expect(timedOut.waitedMs).toBe(YDOC_OPEN_DEADLINE_MS);
      expect(timedOut.path).toBe(PATH);
      expect(timedOut.message).toContain(
        `The ydoc.open deadlineMs limit of ${YDOC_OPEN_DEADLINE_MS}ms was reached`,
      );
      expect(timedOut.message).toContain(
        `the caller waited ${YDOC_OPEN_DEADLINE_MS}ms`,
      );
      expect(timedOut.cause).toBeInstanceOf(EngineRequestDeadlineError);
      adapter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers the daemon's own DEADLINE_EXCEEDED the same way", async () => {
    // The number is on the wire, so the daemon's supervisor holds it too and
    // can be the side that reports it (supervisor.rs adopts `deadline_ms`).
    // Its refusal arrives as a wire error, which no ladder above retries and
    // `isEngineWorkspaceOpenRefusedError` did not recognise — so the same
    // expiry, reported by the other clock, put the writable plain editor over
    // a document the daemon may still hold.
    const adapter = new YdocLiveAdapter({
      sendRequest: (request) =>
        Promise.reject(
          new EngineRequestError(request.id, {
            code: "DEADLINE_EXCEEDED",
            message: "request deadline elapsed",
            retry: "afterBackoff",
          }),
        ),
      onEvent: () => () => undefined,
    });
    const error: unknown = await adapter
      .openSession({
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH,
        contentKind: "plaintext",
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(YdocOpenTimedOutError);
    expect((error as YdocOpenTimedOutError).limitMs).toBe(YDOC_OPEN_DEADLINE_MS);
    expect((error as YdocOpenTimedOutError).cause).toBeInstanceOf(
      EngineRequestError,
    );
    adapter.dispose();
  });

  it("leaves a transport failure that is not this deadline exactly as it was", async () => {
    // The translation is keyed on the deadline error's IDENTITY, not on the
    // code every dropped socket also carries: a daemon that died mid-open is
    // still a reconnect to the ladder above, and calling it a timeout would
    // stop the rebind that recovers it.
    const dropped = { code: "transport-error", message: "socket closed" };
    const adapter = new YdocLiveAdapter({
      sendRequest: () => Promise.reject(dropped),
      onEvent: () => () => undefined,
    });
    await expect(
      adapter.openSession({
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH,
        contentKind: "plaintext",
      }),
    ).rejects.toBe(dropped);
    adapter.dispose();
  });

  it("resurrects an evicted lineage, and prunes a closed one", async () => {
    // #713 review, P2. The loopback used to keep the CRDT rows inside the
    // session, so an evict took the document with it and the reopen found the
    // file. That models LESS than the daemon — which keeps the lineage across
    // an eviction and resurrects it — so any test driving it would certify a
    // convergence that never happens. Mirrors
    // `an_uncoverable_dirty_session_evicts_and_the_reopen_resurrects_it`
    // in crates/dohc-workspace-engine/tests/rpc_ydoc.rs.
    const engine = seedPlaintextEngine("on disk");
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      sendRequest: (request) => engine.sendRequest(request),
    };
    const open = async () =>
      await openEngineYdocProviderSession({
        transport,
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH,
        contentKind: "plaintext",
        onRemoteUpdate: () => undefined,
        scheduleSettle: () => () => undefined,
      });

    const first = await open();
    await first.applyLocalUpdate(
      plaintextUpdate(first.initialUpdate, (text) => {
        text.insert(0, "typed and never settled: ");
      }),
    );
    await first.evict();

    // MUTATION: delete the lineage in `evict` too -> this open seeds "on disk"
    // instead of resurrecting the edited document, and the desktop's #665
    // convergence test would pass against a fake that can lose the document.
    const resurrected = await open();
    expect(resurrected.lineage).toBe("existing");
    expect(resurrected.doc.getText("plainText").toString()).toBe(
      "typed and never settled: on disk",
    );

    // The other half, and the reason evict is a separate verb: a local-only
    // CLOSE prunes those rows, so the next open reseeds from the file.
    await resurrected.close({ settle: false });
    const reseeded = await open();
    expect(reseeded.lineage).toBe("existing");
    expect(reseeded.doc.getText("plainText").toString()).toBe("on disk");
    await reseeded.close({ settle: false });
  });

  it("resurrects a remote update after eviction", async () => {
    const engine = seedPlaintextEngine("on disk");
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      sendRequest: (request) => engine.sendRequest(request),
    };
    const open = async () =>
      await openEngineYdocProviderSession({
        transport,
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH,
        contentKind: "plaintext",
        onRemoteUpdate: () => undefined,
        scheduleSettle: () => () => undefined,
      });

    const first = await open();
    engine.applyRemoteUpdate(
      engine.activeSessionIds()[0]!,
      plaintextUpdate(first.initialUpdate, (text) => {
        text.insert(0, "remote: ");
      }),
    );
    await first.evict();

    const reopened = await open();
    expect(reopened.lineage).toBe("existing");
    expect(reopened.doc.getText("plainText").toString()).toBe(
      "remote: on disk",
    );
    await reopened.close({ settle: false });
  });

  it("resurrects an external markdown edit after eviction", async () => {
    const engine = seedPlaintextEngine("on disk");
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      sendRequest: (request) => engine.sendRequest(request),
    };
    const open = async () =>
      await openEngineYdocProviderSession({
        transport,
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH,
        contentKind: "plaintext",
        onRemoteUpdate: () => undefined,
        scheduleSettle: () => () => undefined,
      });

    const first = await open();
    await first.applyExternalMarkdownEdit("edited from outside: on disk");
    await first.evict();

    const reopened = await open();
    expect(reopened.lineage).toBe("existing");
    expect(reopened.doc.getText("plainText").toString()).toBe(
      "edited from outside: on disk",
    );
    await reopened.close({ settle: false });
  });

  // #721. The loopback used to prune on every local-only close, where the
  // daemon refuses one that would discard a lineage the artifact never
  // received (durable.rs close_session). Driven at the RAW adapter layer —
  // not through `openEngineYdocProviderSession`'s ladder, which retries a
  // refused settle:false close as settle:true and would hide this.
  it("refuses a local-only close over content the artifact never received", async () => {
    const engine = seedPlaintextEngine("on disk");
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    await session.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "typed, never settled: ",
    });

    // MUTATION: prune unconditionally instead of refusing -> this resolves
    // instead of rejecting, and the reopen below would find the lineage
    // pruned even though nothing ever settled or captured its content.
    const refusal = await session
      .close({ settle: false })
      .then(() => null, (error: unknown) => error);
    expect(isYdocUnsettledCloseRefusal(refusal)).toBe(true);

    // The refusal did not silently prune: the lease stayed reserved and the
    // lineage is intact, so a settling close over the SAME session covers it
    // and succeeds.
    await session.close({ settle: true });
    adapter.dispose();
  });

  // #721 follow-up 1. A REPLICATED lineage's close compacts and KEEPS the
  // CRDT rows regardless of settle state (durable.rs close_session) — the
  // opposite of the local-only guard the test above pins.
  it("keeps a replicated lineage across a settle:false close instead of pruning it", async () => {
    const engine = seedPlaintextEngine("on disk");
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    await session.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "typed and unsettled: ",
    });
    engine.markSessionReplicated(session.sessionId);

    // MUTATION: delete every lineage on a local-only close (ignore regime) ->
    // this still resolves, but the reopen below would find the lineage gone.
    await expect(session.close({ settle: false })).resolves.toBeUndefined();

    const reopened = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(reopened.lineage).toBe("existing");
    expect(reopened.doc.getText("plainText").toString()).toBe(
      "typed and unsettled: on disk",
    );
    await reopened.close({ settle: true });
    adapter.dispose();
  });

  // #721 follow-up 2. The daemon's `ydoc_docs` row is keyed by (workspace,
  // version, objectId) (durable.rs), not by path. A path-keyed lineage would
  // let a reused path inherit a stranger's edits and lose a renamed
  // object's, which is exactly what the two probes below pin.
  it("keys the lineage by object identity, so a rename resurrects it and a reused path does not", async () => {
    const OLD_PATH = "notes/original.md";
    const NEW_PATH = "notes/renamed.md";
    const engine = new YdocLoopbackEngine();
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: OLD_PATH,
      content: "original content",
      contentKind: "plaintext",
      objectId: "object-original",
    });
    const adapter = new YdocLiveAdapter(engine);

    const first = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: OLD_PATH,
      contentKind: "plaintext",
    });
    await first.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "typed, never settled: ",
    });
    await first.evict();

    // A DIFFERENT object lands at the old path (delete + unrelated
    // recreate). MUTATION: key the lineage by path -> this open resurrects
    // "object-original"'s edits under a document that never saw them.
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: OLD_PATH,
      content: "a completely different file",
      contentKind: "plaintext",
      objectId: "object-new",
    });
    const reusedPath = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: OLD_PATH,
      contentKind: "plaintext",
    });
    expect(reusedPath.lineage).toBe("existing");
    expect(reusedPath.doc.getText("plainText").toString()).toBe(
      "a completely different file",
    );
    // The captured head already covers this recorded seed, so a non-settling
    // close can prune the local-only lineage without materializing anything.
    await reusedPath.close({ settle: false });

    // The SAME object, renamed to a NEW path. MUTATION: key the lineage by
    // path -> this open seeds fresh from the file instead of resurrecting
    // "object-original"'s unsettled edit.
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: NEW_PATH,
      content: "original content",
      contentKind: "plaintext",
      objectId: "object-original",
    });
    const renamed = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: NEW_PATH,
      contentKind: "plaintext",
    });
    expect(renamed.lineage).toBe("existing");
    expect(renamed.doc.getText("plainText").toString()).toBe(
      "typed, never settled: original content",
    );
    await renamed.close({ settle: true });
    adapter.dispose();
  });

  // Codex P2 on #728. Both the daemon's absent-head open and its capture
  // ingestion resolve an unrecorded path to the SAME derived object id
  // (actor.rs, store.rs) — `seedFile`'s default must match the id `open()`
  // already derives for a path capture has not ingested yet.
  it("a capture that seeds a path after it was already opened finds the same object identity", async () => {
    const engine = new YdocLoopbackEngine();
    const adapter = new YdocLiveAdapter(engine);

    // Opened BEFORE capture ever ingests this path: no `files` row yet, so
    // the object id is DERIVED (the absent-head open path).
    const first = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(first.lineage).toBe("absent");
    await first.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "typed before capture ever saw this file: ",
    });
    await first.evict();

    // Capture ingests the file for the first time now, AFTER the open
    // already derived an object id for it.
    // MUTATION: default `seedFile`'s objectId to an unrelated counter
    // instead of the SAME derivation the absent-head open used -> this
    // reopen resurrects nothing, because the file's object id does not
    // match the lineage the first open's derived id already created.
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      content: "captured now",
      contentKind: "plaintext",
    });

    const reopened = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(reopened.lineage).toBe("existing");
    expect(reopened.doc.getText("plainText").toString()).toBe(
      "typed before capture ever saw this file: ",
    );
    await reopened.close({ settle: true });
    adapter.dispose();
  });

  // Codex round on #728 head 1a05775e. The `?? resurrectedDoc(session.doc)`
  // fallback this test used to pin was unreachable: after the seedContent
  // fix, every server-side content source (a captured seed, a
  // resurrection, a local edit, a remote update) journals a lineage before
  // markSessionReplicated can run, so a session with no lineage entry
  // never carries content that fallback could lose — the test's own
  // "mutation" (an empty-doc substitution) stayed green either way.
  // Staging unjournaled live state to reach it was declined: the client
  // has no path that mutates a session's doc without a recordUpdate
  // journaling it first, so that staging would certify state production
  // cannot produce. Per the no-dead-paths rule, the fallback is deleted
  // (see markSessionReplicated) and this test now pins the resulting
  // contract instead: promoting an un-journaled session throws, and
  // promoting a journaled one preserves the content already there.
  it("markSessionReplicated requires a journaled lineage, and preserves live content once one exists", async () => {
    // No `seedFile` call: this path has no captured head at all, so
    // opening it derives an empty doc with no auto-seed recordUpdate
    // (#721/#728) — the clean "nothing journaled yet" case this contract
    // needs.
    const engine = new YdocLoopbackEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    // No recordUpdate yet: there is no lineage row to promote.
    expect(() => engine.markSessionReplicated(session.sessionId)).toThrow(
      /markSessionReplicated requires a journaled lineage/,
    );

    // A recorded update journals the lineage; promoting it now preserves
    // the content already there.
    await session.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "typed content",
    });
    engine.markSessionReplicated(session.sessionId);
    await expect(session.close({ settle: false })).resolves.toBeUndefined();

    const reopened = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(reopened.lineage).toBe("existing");
    expect(reopened.doc.getText("plainText").toString()).toBe(
      "typed content",
    );
    await reopened.close({ settle: true });
    adapter.dispose();
  });

  // Codex P2 on #728, the safe-direction limit's positive half. A CAPTURED
  // head covers the local-only close guard exactly as a settle does
  // (durable.rs's `captured_head_sha`, the disk -> engine direction) —
  // covered by the SAME `files` row `open()` already reads as the disk
  // state, so no new tracking was needed to add this arm.
  it("a captured head covers the close guard the same way a settle does", async () => {
    const engine = seedPlaintextEngine("captured text");
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    // Two recorded edits that net back to EXACTLY the captured file's
    // bytes: never settled, but capture already put this content on the
    // artifact. The insert-then-revert is what proves the guard reads the
    // CURRENT projection, not merely "no update ever happened".
    await session.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "X",
    });
    await session.applyLocalEdit((doc) => {
      doc.getText("plainText").delete(0, 1);
    });
    expect(session.doc.getText("plainText").toString()).toBe(
      "captured text",
    );

    // MUTATION: drop the captured_head_sha arm from the close guard -> this
    // refuses with ydoc-unsettled-close even though the artifact already
    // holds this exact text.
    await expect(session.close({ settle: false })).resolves.toBeUndefined();
    adapter.dispose();
  });

  // Certification round on #728. No test drove a wire `ydoc.close` with the
  // `settle` flag omitted entirely THROUGH the loopback — mutating the
  // default to `?? false` left the rest of the suite green. Driven at the
  // raw adapter layer: `YdocAdapterSession.close()` with no options omits
  // the `settle` key from the wire params outright.
  it("close() with the settle flag omitted follows the daemon's implicit-settle default", async () => {
    const engine = seedPlaintextEngine("on disk");
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    await session.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "typed, closed with no settle flag at all: ",
    });

    // MUTATION: default the omitted flag to `false` instead of mirroring
    // `!(session.lineage_absent && session.first_update_pending)`
    // (crates/dohc-workspace-engine/src/lib.rs) -> this settles nothing,
    // and the close below refuses with ydoc-unsettled-close instead of
    // resolving.
    await expect(session.close()).resolves.toBeUndefined();

    const reopened = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    // The implicit settle pruned the old lineage. Reopening records a new
    // captured-file seed, so the session immediately has existing lineage.
    expect(reopened.lineage).toBe("existing");
    await reopened.close({ settle: false });
    adapter.dispose();
  });

  // Codex P2 on #728 head ed66dc43. `coveredByCapture` looked up the
  // captured file by PATH but never compared its object id against the
  // session's own — so a path REBOUND to a different object, whose
  // markdown coincidentally matches this session's unsettled content,
  // wrongly covered a close that belongs to the OLD object. The daemon's
  // `captured_head_sha` query filters by object id and would refuse it
  // (durable.rs:1278-1310).
  it("a captured head only covers the SAME object's close guard, not a rebound one", async () => {
    const engine = new YdocLoopbackEngine();
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      content: "shared text",
      contentKind: "plaintext",
      objectId: "object-old",
    });
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(session.lineage).toBe("existing");

    // Two edits that net back to EXACTLY the seeded object's own bytes, so
    // the lineage exists (an update was recorded) but nothing settled it.
    await session.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "X",
    });
    await session.applyLocalEdit((doc) => {
      doc.getText("plainText").delete(0, 1);
    });
    expect(session.doc.getText("plainText").toString()).toBe("shared text");

    // The path is REBOUND to a DIFFERENT object with identical markdown —
    // a delete + unrelated recreate that happens to land on the same
    // bytes.
    // MUTATION: drop the object-id comparison from `coveredByCapture` ->
    // this close SUCCEEDS, because the NEW object's captured content
    // happens to match the OLD object's session content.
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      content: "shared text",
      contentKind: "plaintext",
      objectId: "object-new",
    });

    await expect(session.close({ settle: false })).rejects.toThrow(
      /ydoc-unsettled-close/,
    );
    adapter.dispose();
  });

  // Codex P2 on #728 head ed66dc43. `seedFile`'s default objectId re-derived
  // the plain id unconditionally, even when that exact id already had a
  // LIVE ALIAS somewhere else — an object renamed away from this path and
  // still referenced at its new one. Mirrors `resolve_capture_object`'s
  // disambiguation branch (crates/dohc-engine-domain/src/store.rs).
  it("a recaptured path does not graft onto a renamed object's still-live lineage", async () => {
    const PATH1 = "notes/original.md";
    const PATH2 = "notes/renamed.md";
    const engine = new YdocLoopbackEngine();
    const adapter = new YdocLiveAdapter(engine);

    // Object A originates at PATH1 via an ordinary absent-head open — no
    // capture has ingested it yet, so its object id is DERIVED from PATH1.
    const first = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH1,
      contentKind: "plaintext",
    });
    await first.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "A's edit, never settled: ",
    });
    await first.evict();
    const aObjectId = first.objectId;

    // A is renamed to PATH2 and stays live there — an explicit seedFile
    // carrying A's own derived id forward, exactly as a rename must.
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH2,
      content: "A, now at its new path",
      contentKind: "plaintext",
      objectId: aObjectId,
    });

    // PATH1 is recaptured by an entirely unrelated file, with no explicit
    // object id.
    // MUTATION: default a recaptured path's object id to the plain
    // derivation without checking for a live alias elsewhere -> this
    // collides with A's own derived id (it originated at PATH1), and the
    // reopen below resurrects A's unsettled edit instead of seeding the
    // new file's own content.
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH1,
      content: "a completely unrelated new file",
      contentKind: "plaintext",
    });

    const recaptured = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH1,
      contentKind: "plaintext",
    });
    expect(recaptured.objectId).not.toBe(aObjectId);
    expect(recaptured.lineage).toBe("existing");
    expect(recaptured.doc.getText("plainText").toString()).toBe(
      "a completely unrelated new file",
    );
    // The captured head covers the newly recorded seed, so a non-settling
    // close can prune it without materializing anything.
    await recaptured.close({ settle: false });

    // A's own lineage, at its new path, is untouched.
    const reopenedA = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH2,
      contentKind: "plaintext",
    });
    expect(reopenedA.objectId).toBe(aObjectId);
    expect(reopenedA.lineage).toBe("existing");
    expect(reopenedA.doc.getText("plainText").toString()).toBe(
      "A's edit, never settled: ",
    );
    await reopenedA.close({ settle: true });
    adapter.dispose();
  });

  // Codex P2 on #728 head 787993c6, FALSE-GREEN direction. Resurrection kept
  // the REOPEN's requested content kind instead of the lineage's own stored
  // kind. `ydoc_open_state_on_store` reads the persisted marker's
  // content_kind whenever durable state exists, never the request — a
  // plaintext lineage bound as richdoc settles the empty `body` fragment
  // instead of the `plainText` content it actually holds, a silent
  // Markdown-loss shape production never allows.
  it("resurrection uses the lineage's STORED content kind, not the reopen's request", async () => {
    const engine = seedPlaintextEngine("plain text content");
    const adapter = new YdocLiveAdapter(engine);
    const first = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    await first.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "typed, never settled: ",
    });
    await first.evict();

    // MUTATION: keep the REQUEST's kind on a resurrection instead of the
    // lineage's stored kind -> this session comes up richdoc over a
    // plaintext lineage, and its `doc.getText("plainText")` (below) is
    // empty because the content actually lives in a fragment this reopen
    // never reads.
    const reopened = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "richdoc",
    });
    expect(reopened.contentKind).toBe("plaintext");
    expect(reopened.doc.getText("plainText").toString()).toBe(
      "typed, never settled: plain text content",
    );
    const settled = await reopened.settle();
    expect(settled.content).toBe(
      "typed, never settled: plain text content",
    );
    await reopened.close({ settle: true });
    adapter.dispose();
  });

  // Codex P2 on #728 head 787993c6. The captured-head coverage lookup read
  // the session's OWN path, but the daemon's `captured_head_sha` query is
  // scoped by (workspace, version, object_id) with NO path restriction — a
  // rename does not mint a new object. A rename followed by a capture at
  // the object's NEW path must still cover an OLD session still bound to
  // it, the same way it would in production.
  it("captured-head coverage resolves by object identity, not the session's own path", async () => {
    const PATH1 = "notes/original.md";
    const PATH2 = "notes/renamed.md";
    const engine = new YdocLoopbackEngine();
    const adapter = new YdocLiveAdapter(engine);

    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH1,
      contentKind: "plaintext",
    });
    await session.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "typed, never settled: ",
    });

    // The object is renamed to PATH2 (re-keying the `files` row) and
    // captured there with bytes matching this session's own content.
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH2,
      content: "typed, never settled: ",
      contentKind: "plaintext",
      objectId: session.objectId,
    });

    // MUTATION: resolve the captured head by the session's own PATH instead
    // of its object identity -> this close refuses with
    // ydoc-unsettled-close, because the file record now lives at PATH2 and
    // a path-first lookup at PATH1 finds nothing.
    await expect(session.close({ settle: false })).resolves.toBeUndefined();
    adapter.dispose();
  });

  // Codex round on #728 head 6cf9700e, finding 1. `capturedFileFor` scanned
  // by object id alone. The daemon's `captured_head_sha` proof query is
  // scoped by (workspace_id, version_id, object_id) (durable.rs) — object
  // ids are only unique WITHIN that scope, so a fixture reusing one across
  // scopes must never let one scope's row cover another's close.
  it("captured-head coverage is scoped by workspace and version, not object id alone", async () => {
    const OTHER_VERSION = "version-2";
    const engine = new YdocLoopbackEngine();
    const adapter = new YdocLiveAdapter(engine);

    // No file seeded in THIS scope at all — the session's object id is
    // plain-derived from its own path, and nothing in `files` matches it
    // yet.
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(session.lineage).toBe("absent");
    await session.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "same object id, wrong scope: ",
    });

    // A DIFFERENT version's fixture reuses the SAME (derived) object id
    // string, with content matching this session's content — a plausible
    // fixture collision the daemon's DocKey always keeps apart. This is
    // the ONLY `files` entry with this object id, in either scope.
    // MUTATION: scan `files` by object id alone, ignoring workspace/version
    // -> this close SUCCEEDS against the OTHER scope's snapshot.
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: OTHER_VERSION,
      path: PATH,
      content: "same object id, wrong scope: ",
      contentKind: "plaintext",
      objectId: session.objectId,
    });

    await expect(session.close({ settle: false })).rejects.toThrow(
      /ydoc-unsettled-close/,
    );
    adapter.dispose();
  });

  // Codex round on #728 head 6cf9700e, finding 2. `seedFile` never removed
  // an object's OLD row when it was re-seeded at a new path, so a scan
  // (`capturedFileFor`) found the STALE row first (Map iteration is
  // insertion order) and never reached the current one. The daemon keeps
  // one snapshot row per object; re-seeding must replace, not append.
  it("re-seeding the same object at a new path retires its old row, so coverage reads the CURRENT one", async () => {
    const OBJECT_ID = "object-moved-with-new-bytes";
    const PATH_A = "notes/first.md";
    const PATH_B = "notes/second.md";
    const engine = new YdocLoopbackEngine();
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH_A,
      content: "stale bytes at the old path",
      contentKind: "plaintext",
      objectId: OBJECT_ID,
    });
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH_A,
      contentKind: "plaintext",
    });
    expect(session.objectId).toBe(OBJECT_ID);

    // Two edits that net back to bytes matching the object's NEW capture at
    // PATH_B, never its stale row at PATH_A.
    await session.applyLocalEdit((doc) => {
      const text = doc.getText("plainText");
      text.delete(0, text.length);
      text.insert(0, "fresh bytes at the new path");
    });
    expect(session.doc.getText("plainText").toString()).toBe(
      "fresh bytes at the new path",
    );

    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH_B,
      content: "fresh bytes at the new path",
      contentKind: "plaintext",
      objectId: OBJECT_ID,
    });

    // MUTATION: leave the object's OLD row at PATH_A in the map instead of
    // retiring it on the re-seed above -> `capturedFileFor`'s scan returns
    // PATH_A's stale row FIRST (it was inserted first), which never
    // matches this session's current content, and this close refuses.
    await expect(session.close({ settle: false })).resolves.toBeUndefined();
    adapter.dispose();
  });

  // Codex round on #728 head 6cf9700e, finding 3, closing the certifier's
  // named false-green gap. The fresh no-file OPEN branch derived a plain
  // id without checking for a live alias, silently resurrecting a renamed
  // object's lineage under a document that never saw it. The daemon
  // refuses instead (actor.rs ydoc_open_state_on_store,
  // object_has_live_alias) — only capture's locked resolution may mint a
  // disambiguated id for this case.
  it("opening a vacated path refuses object-alias-collision instead of resurrecting the renamed object's lineage", async () => {
    const PATH_A = "notes/original.md";
    const PATH_B = "notes/renamed.md";
    const engine = new YdocLoopbackEngine();
    const adapter = new YdocLiveAdapter(engine);

    // Object A originates at PATH_A via an ordinary absent-head open.
    const first = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH_A,
      contentKind: "plaintext",
    });
    await first.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "A's edit, never settled: ",
    });
    await first.evict();
    const aObjectId = first.objectId;

    // A is renamed to PATH_B and stays live there.
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH_B,
      content: "A, now at its new path",
      contentKind: "plaintext",
      objectId: aObjectId,
    });

    // MUTATION: derive the plain id for a fresh open without checking for
    // a live alias -> this open silently resurrects A's lineage under a
    // document that never saw it, instead of refusing.
    await expect(
      adapter.openSession({
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH_A,
        contentKind: "plaintext",
      }),
    ).rejects.toThrow(/ydoc-object-alias-collision/);

    // A's own lineage, at its new path, is untouched.
    const reopenedA = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH_B,
      contentKind: "plaintext",
    });
    expect(reopenedA.objectId).toBe(aObjectId);
    expect(reopenedA.lineage).toBe("existing");
    expect(reopenedA.doc.getText("plainText").toString()).toBe(
      "A's edit, never settled: ",
    );
    await reopenedA.close({ settle: true });
    adapter.dispose();
  });

  // Codex round on #728 head 6cf9700e, finding 4. An explicit settle:true
  // on an UNTOUCHED absent-lineage session projected the empty doc and
  // materialized it — the daemon's `ydoc_settle_on_store` finds no marker
  // row at all for a session that never recorded a durable update, and
  // refuses (NoMarker) rather than letting an empty projection clobber
  // whatever the artifact holds.
  it("an explicit settle:true close on an untouched absent-lineage session refuses instead of materializing an empty projection", async () => {
    const materialized: Array<{ path: string; content: string }> = [];
    const engine = new YdocLoopbackEngine({
      materialize: (input) => materialized.push(input),
    });
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(session.lineage).toBe("absent");

    // MUTATION: settle unconditionally on an explicit settle:true, without
    // checking absent-and-first-update-pending -> this close SUCCEEDS,
    // materializing an EMPTY projection over whatever the artifact holds.
    await expect(session.close({ settle: true })).rejects.toThrow();
    expect(materialized).toHaveLength(0);

    // The session is still the daemon's: a non-settling close succeeds
    // cleanly.
    await session.close({ settle: false });
    adapter.dispose();
  });

  // Codex round on #728 rebased head a5d7b7bb. The NoMarker guard's blind
  // spot: a head-present open with NO existing lineage used to embed its
  // markdown directly into `initialUpdateBase64`, leaving
  // `firstUpdatePending` true forever — so a direct settle over a freshly
  // opened captured file, with no local edits at all, wrongly hit the
  // guard above. `ydoc_open_state_on_store` (actor.rs) never embeds a seed
  // in `initial_update`: `seed_content` carries it separately, and the
  // CLIENT applies-and-records it through a REAL `ydoc.recordUpdate`
  // (`YdocLiveAdapter.openSession`), which is what clears
  // `firstUpdatePending` honestly — the guard itself needed no change.
  it("a head-present open with no lineage yet journals its seed through recordUpdate, so an untouched settle succeeds", async () => {
    const materialized: Array<{ path: string; content: string }> = [];
    const engine = new YdocLoopbackEngine({
      materialize: (input) => materialized.push(input),
    });
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      content: "captured content",
      contentKind: "plaintext",
    });
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(session.lineage).toBe("existing");
    expect(session.doc.getText("plainText").toString()).toBe(
      "captured content",
    );

    // MUTATION: embed the seed directly in `initialUpdateBase64` instead of
    // returning `seedContent` for the adapter to record -> this close
    // wrongly refuses (NoMarker), even though the artifact already holds
    // this exact content and nothing was ever "untouched" from the
    // daemon's point of view.
    await expect(session.close({ settle: true })).resolves.toBeUndefined();
    expect(materialized).toEqual([
      { path: PATH, content: "captured content" },
    ]);
    adapter.dispose();
  });

  // Codex round on #728 head ed57b683, finding 1 (the certifier's own
  // recorded residual). `resolve_capture_object`'s FIRST step,
  // `alias_object_id`, reuses a path's own current alias before
  // derivation or disambiguation ever run — a routine re-capture of the
  // SAME path (content changed, no rename) must keep the object identity
  // its current row already holds, including an explicit id, or the
  // evicted lineage behind it becomes unreachable.
  it("re-seeding a path with no explicit id reuses its own current entry's id, not a fresh derivation", async () => {
    const engine = new YdocLoopbackEngine();
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      content: "original content",
      contentKind: "plaintext",
      objectId: "object-explicit-id",
    });
    const adapter = new YdocLiveAdapter(engine);
    const first = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(first.objectId).toBe("object-explicit-id");
    await first.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "typed, never settled: ",
    });
    await first.evict();

    // A routine re-capture of the SAME path (content changed, no rename),
    // with no explicit object id.
    // MUTATION: re-derive a fresh id instead of reusing the path's own
    // current entry -> this reopen gets a DIFFERENT object id, and the
    // evicted lineage (still keyed by "object-explicit-id") becomes
    // unreachable.
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      content: "updated content",
      contentKind: "plaintext",
    });

    const reopened = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(reopened.objectId).toBe("object-explicit-id");
    expect(reopened.lineage).toBe("existing");
    expect(reopened.doc.getText("plainText").toString()).toBe(
      "typed, never settled: original content",
    );
    await reopened.close({ settle: true });
    adapter.dispose();
  });

  // Codex round on #728 head ed57b683, finding 2 (the certifier's own
  // recorded residual). `objectHasLiveAliasElsewhere` scanned every
  // workspace. The daemon's `object_has_live_alias` filters by
  // `workspace_id` — object ids are only unique within a workspace, so a
  // fixture in a DIFFERENT workspace that happens to reuse this exact
  // string must never collide.
  it("object-alias-collision is scoped to the target workspace, not global", async () => {
    const OTHER_WORKSPACE = "workspace-handle-other";
    const engine = new YdocLoopbackEngine();
    const adapter = new YdocLiveAdapter(engine);

    // Learn the id THIS workspace's path would derive, side-effect-free
    // (no edit, so evicting leaves no lineage behind).
    const probe = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    const derivedId = probe.objectId;
    await probe.evict();

    // A DIFFERENT workspace's fixture happens to reuse that exact id
    // string.
    // MUTATION: scan `objectHasLiveAliasElsewhere` across every workspace
    // instead of scoping to the target one -> this open refuses
    // object-alias-collision even though nothing in THIS workspace holds
    // the id.
    engine.seedFile({
      workspace: OTHER_WORKSPACE,
      versionId: VERSION,
      path: PATH,
      content: "unrelated workspace's file",
      contentKind: "plaintext",
      objectId: derivedId,
    });

    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(session.objectId).toBe(derivedId);
    expect(session.lineage).toBe("absent");
    await session.close({ settle: false });
    adapter.dispose();
  });

  it("evicts without settling, closing, or handing the text over again", async () => {
    // #665. Evict does not SETTLE or CLOSE. When nothing is owed,
    // `resendMissingState` is a no-op, so the provider hands over no text again
    // and sends only `ydoc.evict`.
    const engine = seedPlaintextEngine("on disk");
    const methods: string[] = [];
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request: Request) {
        methods.push(request.method);
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
    });
    await provider.applyLocalUpdate(
      plaintextUpdate(provider.initialUpdate, (text) => {
        text.insert(0, "typed and never settled");
      }),
    );
    methods.length = 0;

    await provider.evict();

    // MUTATION: route `evict` through the close ladder -> ydoc.settle and
    // ydoc.close appear here, and the refusal the evict escapes comes back.
    expect(methods).toEqual([YDOC_METHOD.evict]);
    // The lease is gone, so the path binds again.
    const reopened = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
    });
    await reopened.close({ settle: false });
  });
});
