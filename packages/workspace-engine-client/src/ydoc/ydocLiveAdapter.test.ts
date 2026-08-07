import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  EngineRequestDeadlineError,
  EngineRequestError,
} from "../daemon/engineClient";
import { DaemonRefusalError } from "../live/daemonLiveAdapter";
import type { Request } from "./generated/Request";
import {
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
    expect([...(settled.markdown ?? "")]).toEqual([...content]);

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

  // A provider whose settle is refused `file-locked` until the test releases
  // it, with the settle scheduler captured so the ladder can be driven a rung
  // at a time. Shared by the two tests below; each drives it differently,
  // because a debounced settle and an explicit flush are different behaviors.
  async function openAgainstALockedFile(
    text: string,
    options?: { settleDebounceMs?: number },
  ) {
    const engine = seedPlaintextEngine();
    const lock = { held: true };
    const lockedRefusal = new DaemonRefusalError(
      { code: "OVERLOADED", message: "file-locked", retry: "afterBackoff" },
      new Error("daemon response"),
    );
    const transport: EngineTransport = {
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.settle && lock.held) {
          throw lockedRefusal;
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
      lock,
      lockedRefusal,
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
    const { provider, lock, lockedRefusal, settleErrors, settled, delays, scheduler } =
      await openAgainstALockedFile("typed against a locked file", {
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
    expect(settleErrors).toEqual([lockedRefusal, lockedRefusal, lockedRefusal]);
    expect(delays).toEqual([100, 100, 200, 400]);

    // The lock releases; the pending retry lands the write by itself.
    lock.held = false;
    scheduler.fire();
    await drain();
    expect(settled).toHaveLength(1);
    // Success re-arms nothing.
    expect(scheduler.armed).toHaveLength(0);

    await provider.close({ settle: false });
  });

  it("resets the ladder once a settle reaches disk, so the next lock starts over", async () => {
    // The reset is what keeps a document that is locked twice in a session
    // from inheriting the first lock's grown delay — the second lock must be
    // retried as promptly as the first, not minutes later.
    const { provider, lock, settled, delays, scheduler } =
      await openAgainstALockedFile("typed against a locked file", {
        settleDebounceMs: 100,
      });

    // Climb two rungs: armed at 100, retry at 100, retry at 200.
    scheduler.fire();
    await drain();
    scheduler.fire();
    await drain();
    expect(delays).toEqual([100, 100, 200]);

    // The lock releases and the pending retry lands the write.
    lock.held = false;
    scheduler.fire();
    await drain();
    expect(settled).toHaveLength(1);

    // A LATER lock: the next failure must re-arm at the debounce, not at 400.
    lock.held = true;
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
    const { provider, delays, scheduler } = await openAgainstALockedFile(
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
    const { provider, delays, scheduler } = await openAgainstALockedFile(
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
    const { provider, delays, scheduler } = await openAgainstALockedFile(
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
    const { provider, lock, lockedRefusal, settled, scheduler } =
      await openAgainstALockedFile("flushed against a locked file", {
        settleDebounceMs: 100,
      });

    await expect(provider.settleNow()).rejects.toBe(lockedRefusal);
    await drain();
    // The debounced settle the edit armed was superseded by the explicit
    // flush, so the one armed timer is the flush's own retry.
    expect(scheduler.armed.map((entry) => entry.ms)).toEqual([100]);

    lock.held = false;
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
      markdown: "",
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

    await expect(session.settle()).resolves.toMatchObject({
      materialized: true,
    });
    // The resync sits BETWEEN the two settles. Reordered or missing, the
    // second settle projects the same state the first was refused for.
    expect(methods.filter((method) => method !== YDOC_METHOD.open)).toEqual([
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
});
