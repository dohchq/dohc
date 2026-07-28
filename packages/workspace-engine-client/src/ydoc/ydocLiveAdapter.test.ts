import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DaemonRefusalError } from "../live/daemonLiveAdapter";
import {
  IllFormedUtf16EditError,
  RemoteYdocApplyError,
  YdocResyncNeededError,
  YdocSessionQuarantinedError,
  YdocLiveAdapter,
  isWellFormedUtf16,
  type EngineTransport,
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

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("rejects a split masked behind offsetting U+FFFD deletions (BYPASS-1)", async () => {
    // Reviewer repro: a single raw transaction deletes two pre-existing U+FFFD
    // while a mid-surrogate split adds two, netting to zero. Aggregate counting
    // misses it; deleted-U+FFFD accounting rejects it. Divergence vs the real
    // R11a engine: yrs="😀x" vs editor="�x�" (crates/dohc-engine-collab).
    const engine = seedPlaintextEngine("��😀");
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

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
    const engine = seedPlaintextEngine("�abc");
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    const result = await session.applyLocalEdit((doc) => {
      const text = doc.getText("plainText");
      text.delete(0, 1);
      text.insert(0, "x");
    });
    expect(result?.seq).toBe(1);
    expect(session.doc.getText("plainText").toString()).toBe("xabc");
    expect(engine.recordedUpdates).toHaveLength(1);

    await session.close({ settle: false });
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

    await session.close({ settle: false });
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

      await session.close({ settle: false });
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

    await session.close({ settle: false });
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

    expect(settled.markdown).toBe("first second");
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

    await expect(provider.close({ settle: false })).resolves.toBeUndefined();
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

    await session.close({ settle: false });
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

    await session.close({ settle: false });
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

    await firstSession.close({ settle: false });
    await secondSession.close({ settle: false });
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
    expect(engine.requests[1]).toMatchObject({
      idempotencyKey: "session-1:1",
      params: {
        sessionId: "session-1",
        updateBase64: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/),
      },
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
        markdown: "",
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
              seedMarkdown: "seeded body",
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
