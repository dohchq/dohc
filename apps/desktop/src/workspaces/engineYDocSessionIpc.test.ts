import {registerTypingCheckpoint} from "./outageTypingRecovery";
import { SharedDocumentWaitingError } from "../ipc/sharedDocumentOpenState";
import { engineSaveState } from "./engineYDocSaveState";
import {
  DaemonRefusalError,
  YdocOwnerDraftPendingError,
  type ArtifactAssetDescriptor,
} from "@dohc/workspace-engine-client";
import * as Y from "yjs";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { documentEditUpdate, documentMarkdown, markdownToYDoc, type DocumentEdit } from "@dohc/ydoc-projection";

import {
  YDocPathNotInVersionError,
  YDocRemovalInProgressError,
  YDocSessionUnreleasedError,
  type WorkspaceEngineYDocProviderSession,
} from "./workspaceEngineCapture";
import {
  createEngineYDocSessionIpc,
  DOCUMENT_EDIT_SHARED_WARNING,
  DOCUMENT_EDIT_PENDING_WARNING,
  EngineYDocArrivals,
  LiveDocumentEditAppliedError,
  type EngineYDocIpcSender,
  type EngineYDocSessionCapture,
} from "./engineYDocSessionIpc";
import { CHANNELS, ENGINE_YDOC_UPDATE_MAX_BYTES } from "../ipc/channels";
import { isPrivacyDenial } from "./privacyDenial";

// A real macOS privacy refusal needs System Settings; a test answers for it.
vi.mock("./privacyDenial", async (actual) => {
  const real = await actual<typeof import("./privacyDenial")>();
  return { ...real, isPrivacyDenial: vi.fn(real.isPrivacyDenial) };
});
import { deferred } from "../testing/deferred";

const AUTHORITY_ID = Symbol("attachment-a");

it("returns the held-file reason through the live-open bridge", async () => {
  const h = harness();
  vi.spyOn(h.capture, "openYDocSession").mockRejectedValue(new DaemonRefusalError({ code: "CONFLICT", message: "capture-file-held: notes/a.md", retry: "no" }, undefined));
  expect(await h.ipc.open(new FakeSender(7), openPayload)).toEqual({ available: false, captureHeld: true });
  await h.ipc.shutdown();
});

class FakeSender implements EngineYDocIpcSender {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  readonly #destroyedListeners: Array<() => void> = [];
  #destroyed = false;
  #sendError: Error | null = null;

  constructor(readonly id: number) {}

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  send(channel: string, payload: unknown): void {
    if (this.#destroyed) throw new Error("sender destroyed");
    if (this.#sendError) throw this.#sendError;
    this.sent.push({ channel, payload });
  }

  once(event: "destroyed", listener: () => void): this {
    if (event === "destroyed") this.#destroyedListeners.push(listener);
    return this;
  }

  destroy(): void {
    this.#destroyed = true;
    for (const listener of this.#destroyedListeners) listener();
  }

  failSendsWith(error: Error | null): void {
    this.#sendError = error;
  }
}

function asset(id: string, ref = `assets/${id}.png`): ArtifactAssetDescriptor {
  return {
    id,
    mimeType: "image/png",
    created: 1,
    ref,
    sha256: "a".repeat(64),
  };
}

function providerSession(
  input: Partial<WorkspaceEngineYDocProviderSession> = {},
): WorkspaceEngineYDocProviderSession {
  const base = {
    doc: new Y.Doc(),
    initialUpdate: new Uint8Array(),
    path: "notes/a.md",
    contentKind: "richdoc",
    settleNow: vi.fn(async () => {
      throw new Error("settleNow is not used by this IPC adapter fixture");
    }),
    applyLocalUpdate: vi.fn((_update, onArmed) => onArmed?.()),
    applyDecidedLocalUpdate: vi.fn(async () => false),
    readArtifactAsset: vi.fn(async (descriptor) => ({
      descriptor,
      bytes: new Uint8Array([1, 2, 3]),
    })),
    close: vi.fn(async () => undefined),
  } satisfies WorkspaceEngineYDocProviderSession;
  return Object.assign(base, input);
}

function workspaceAuthority(workspaceId: string) {
  return {
    workspace: {
      workspaceId,
      rootPath: "C:/workspace",
      attachmentId: AUTHORITY_ID,
    },
    assertCurrent: vi.fn(),
    release: vi.fn(),
  };
}

interface TestHarnessOptions {
  rootPath?: string;
  resolveDocumentPath?: (
    workspace: { workspaceId: string; rootPath: string; attachmentId: symbol },
    path: string,
  ) => Promise<string | null>;
  rendererWorkspaceId?: string;
  sharedCaptureFor?: Parameters<typeof createEngineYDocSessionIpc>[0]["sharedCaptureFor"];
}

function rendererSession(
  generationOf: () => number = () => 1,
  isAvailable: () => boolean = () => true,
  workspaceId = "workspace-1",
) {
  const generation = generationOf();
  return {
    workspaceId,
    generation,
    isCurrent: () => isAvailable() && generationOf() === generation,
  };
}

function harness(
  session = providerSession(),
  options: TestHarnessOptions = {},
) {
  const resolveDocumentPath =
    options.resolveDocumentPath ?? (async (_workspace, path: string) => path);
  let generation = 1;
  let retired = false;
  let readOnly = false;
  let person = "person-local";
  let capturedOpen:
    | Parameters<EngineYDocSessionCapture["openYDocSession"]>[0]
    | undefined;
  const capture: EngineYDocSessionCapture = {
    openYDocSession: vi.fn(async (input) => {
      capturedOpen = input;
      return session;
    }),
  };
  const onError = vi.fn();
  const ipc = createEngineYDocSessionIpc({
    localPersonId: () => person,
    sessionFor: () =>
      retired
        ? undefined
        : rendererSession(
            () => generation,
            () => !retired,
            options.rendererWorkspaceId,
          ),
    acquireWorkspace: (workspaceId: string) => {
      const authority = workspaceAuthority(workspaceId);
      return options.rootPath === undefined ? authority : { ...authority, workspace: { ...authority.workspace, rootPath: options.rootPath } };
    },
    captureFor: () => capture,
    ensureCaptureFor: vi.fn(async () => undefined),
    isSharedView: () => readOnly,
    sharedCaptureFor: options.sharedCaptureFor,
    resolveDocumentPath,
    onError,
  });
  return {
    ipc,
    capture,
    onError,
    session,
    capturedOpen: () => capturedOpen,
    setGeneration: (next: number) => {
      generation = next;
    },
    retireSession: () => {
      retired = true;
    },
    setReadOnly: (next: boolean) => {
      readOnly = next;
    },
    setPerson: (next: string) => {
      person = next;
    },
  };
}

const openPayload = {
  workspaceId: "workspace-1",
  sessionId: "renderer-session-1",
  path: "notes/a.md",
};
const DOCUMENT = { workspaceId: openPayload.workspaceId, path: openPayload.path };

describe("engine Y.Doc IPC adapter", () => {
  it("reports main's unresolved flag on status events and clears it after admission", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    let unresolved = true;
    const unregister = registerTypingCheckpoint(DOCUMENT.workspaceId, async () => {}, () => false,
      {checkpointId: "active-session", path: DOCUMENT.path}, undefined, () => unresolved);
    try {
      await h.ipc.open(sender, openPayload);
      h.capturedOpen()?.onSaveState?.("settling", 0, "status");
      expect(sender.sent.at(-1)?.payload).toMatchObject({typingUnresolved: true, seq: 0});
      unresolved = false;
      h.capturedOpen()?.onSaveState?.("saved", 0, "status");
      expect(sender.sent.at(-1)?.payload).toMatchObject({typingUnresolved: false, seq: 0});
    } finally {
      unregister();
      await h.ipc.shutdown();
    }
  });

  it("sends a definitive edit refusal through the scoped save event", async () => {
    const h = harness(providerSession());
    const sender = new FakeSender(7);
    await h.ipc.open(sender, openPayload);
    const message = 'dohc could not save an edit to "notes/a.md". Copy it from recovery.';
    h.capturedOpen()?.onEditRefused?.("request-1", message);
    expect(sender.sent).toContainEqual({
      channel: CHANNELS.engineYDocSaveState,
      payload: { sessionId: openPayload.sessionId, ...DOCUMENT, typingUnresolved: false, ...engineSaveState("error", { requestId: "request-1", message }), seq: 0,
        editRefusal: { workspaceId: "workspace-1", path: "notes/a.md", requestId: "request-1", message } },
    });
    await h.ipc.shutdown();
  });
  it("names main's person when each request first arrives and keeps that person for its retries", async () => {
    const h = harness(providerSession());
    const sender = new FakeSender(7);
    await h.ipc.open(sender, openPayload);
    h.setPerson("account-alice");
    const update = new Uint8Array([0, 0]);
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const apply = (requestId: string, claims: Record<string, unknown> = {}) =>
      h.ipc.applyUpdate(sender, { ...claims, sessionId: openPayload.sessionId, update, seq: 1, lineageGeneration: 1, requestId });
    expect(apply(first)).toEqual({ accepted: true });
    // The account changes while the renderer still retries its first request.
    h.setPerson("account-bob");
    expect(apply(first)).toEqual({ accepted: true });
    // A new request is the person main has now. What the renderer says, an
    // old context, an earlier generation, or a person, names no one.
    expect(apply(second, { authorContext: "account-alice-context", authorContextGeneration: 0, actorOriginId: "account-alice",
      attribution: { actorKind: "human", onBehalfOf: "account-alice", depth: 0 } })).toEqual({ accepted: true });
    const typedBy = (personId: string, idempotencyKey: string) =>
      ({ idempotencyKey, actorOriginId: personId, attribution: { actorKind: "human", onBehalfOf: personId, depth: 0 } });
    expect(vi.mocked(h.session.applyLocalUpdate).mock.calls.map(call => call[2])).toEqual([
      typedBy("account-alice", first), typedBy("account-alice", first), typedBy("account-bob", second),
    ]);
    await h.ipc.shutdown();
  });

  it("keeps the arrival person for an identical retry through a recreated session, and never for changed bytes", async () => {
    // The engine's request ledger: a key repeats only with the same bytes and attribution.
    const ledger = new Map<string, string>();
    const outcomes: Array<{ outcome: "recorded" | "deduped" | "refused"; person: string | undefined }> = [];
    const provider = () => providerSession({
      applyLocalUpdate: vi.fn<WorkspaceEngineYDocProviderSession["applyLocalUpdate"]>((update, onArmed, options) => {
        const key = options?.idempotencyKey ?? "";
        const payload = JSON.stringify([[...update], options?.actorOriginId ?? null, options?.attribution ?? null]);
        const recorded = ledger.get(key);
        if (recorded === undefined) {
          ledger.set(key, payload);
          outcomes.push({ outcome: "recorded", person: options?.actorOriginId });
          onArmed?.();
          return;
        }
        outcomes.push({ outcome: recorded === payload ? "deduped" : "refused", person: options?.actorOriginId });
      }),
    });
    const original = provider();
    const h = harness(original);
    const sender = new FakeSender(7);
    await h.ipc.open(sender, openPayload);
    h.setPerson("account-alice");
    const requestId = "33333333-3333-4333-8333-333333333333";
    const batch = new Uint8Array([1, 2, 3]);
    const apply = (sessionId: string, update: Uint8Array) =>
      h.ipc.applyUpdate(sender, { sessionId, update, seq: 1, lineageGeneration: 1, requestId });
    expect(apply(openPayload.sessionId, batch)).toEqual({ accepted: true });
    // The acceptance never reaches the renderer. The account changes, and the
    // document's session closes and opens again over a new provider.
    h.setPerson("account-bob");
    await h.ipc.close(sender, { sessionId: openPayload.sessionId });
    const recreated = provider();
    vi.mocked(h.capture.openYDocSession).mockResolvedValueOnce(recreated);
    const reopened = { ...openPayload, sessionId: "renderer-session-2" };
    await h.ipc.open(sender, reopened);
    expect(original.close).toHaveBeenCalled();
    // The same batch is still Alice's; other bytes under its id are Bob's.
    expect(apply(reopened.sessionId, batch)).toEqual({ accepted: true });
    expect(apply(reopened.sessionId, new Uint8Array([9]))).toEqual({ accepted: true });
    expect(outcomes).toEqual([
      { outcome: "recorded", person: "account-alice" },
      { outcome: "deduped", person: "account-alice" },
      { outcome: "refused", person: "account-bob" },
    ]);
    expect(vi.mocked(recreated.applyLocalUpdate)).toHaveBeenCalledTimes(2);
    await h.ipc.shutdown();
  });

  it("lets a renderer session's next update retire its earlier ones, and its workspace attachment retire them all", async () => {
    const h = harness(providerSession());
    const sender = new FakeSender(7);
    await h.ipc.open(sender, openPayload);
    const first = "44444444-4444-4444-8444-444444444444";
    const second = "55555555-5555-4555-8555-555555555555";
    const apply = (sessionId: string, requestId: string, update: Uint8Array) =>
      h.ipc.applyUpdate(sender, { sessionId, update, seq: 1, lineageGeneration: 1, requestId });
    const a = new Uint8Array([1]);
    const b = new Uint8Array([2]);
    h.setPerson("account-alice");
    apply(openPayload.sessionId, first, a);
    // Sent only once the renderer heard the first accepted.
    apply(openPayload.sessionId, second, b);
    h.setPerson("account-bob");
    apply(openPayload.sessionId, second, b);
    apply(openPayload.sessionId, first, a);
    await h.ipc.retireAuthority(AUTHORITY_ID);
    h.setPerson("account-carol");
    const reopened = { ...openPayload, sessionId: "renderer-session-3" };
    await h.ipc.open(sender, reopened);
    apply(reopened.sessionId, first, a);
    const people = vi.mocked(h.session.applyLocalUpdate).mock.calls.map(call => call[2]?.actorOriginId);
    expect(people).toEqual(["account-alice", "account-alice", "account-alice", "account-bob", "account-carol"]);
    await h.ipc.shutdown();
  });

  it("bounds what renderers leave behind, reaching an update still being retried last", () => {
    const arrivals = new EngineYDocArrivals(2);
    const authorityId = Symbol("attachment");
    let person = "account-alice";
    const name = (source: string, requestId: string) => arrivals.person(
      { authorityId, path: "notes/a.md", source, requestId, update: new Uint8Array([1]) }, () => person);
    name("session-1", "request-1");
    name("session-2", "request-2");
    // Session 1 retries, so session 2's leftover is the oldest.
    name("session-1", "request-1");
    name("session-3", "request-3");
    person = "account-bob";
    expect(name("session-1", "request-1")).toBe("account-alice");
    expect(name("session-3", "request-3")).toBe("account-alice");
    expect(name("session-2", "request-2")).toBe("account-bob");
  });

  it("keeps nothing beyond the bounded records however many renderer sessions come and go", () => {
    const arrivals = new EngineYDocArrivals(3);
    const authorityId = Symbol("attachment");
    const send = (session: number, request: number) => arrivals.person({
      authorityId, path: "notes/a.md", source: `session-${session}`,
      requestId: `request-${session}-${request}`, update: new Uint8Array([request]),
    }, () => "account-alice");
    for (let request = 0; request < 3; request += 1) send(0, request);
    // A session keeps only the update it may still retry.
    expect(arrivals.size).toBe(1);
    // Sessions that close or reload leave their last update, up to the bound.
    for (let session = 1; session < 50; session += 1) {
      for (let request = 0; request < 3; request += 1) send(session, request);
    }
    expect(arrivals.size).toBe(3);
    arrivals.retireAuthority(authorityId);
    expect(arrivals.size).toBe(0);
  });

  it("preserves author capacity refusal on the owned session's save event", async () => {
    const h = harness(providerSession());
    const sender = new FakeSender(7);
    await h.ipc.open(sender, openPayload);
    h.capturedOpen()?.onSaveState?.("error", 1, "outcome", true);
    expect(sender.sent).toContainEqual({
      channel: CHANNELS.engineYDocSaveState,
      payload: {sessionId: openPayload.sessionId, ...DOCUMENT, typingUnresolved: false, ...engineSaveState("error"), seq: 0, authorCapacity: true},
    });
    await h.ipc.shutdown();
  });

  it("routes shared Markdown through the named provider and pauses when that host stops", async () => {
    let live = true;
    const shared = Object.assign(providerSession(), {liveWritable: () => live});
    const open = vi.fn(async () => shared);
    const h = harness(providerSession(), {sharedCaptureFor: async () => ({openYDocSession: open})});
    h.setReadOnly(true);
    const sender = new FakeSender(7);
    const opened = await h.ipc.open(sender, openPayload);
    expect(opened.available).toBe(true);
    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
    const update = {sessionId: openPayload.sessionId, update: new Uint8Array([0, 0]), seq: 1, lineageGeneration: 1, requestId: "11111111-1111-4111-8111-111111111111"};
    expect(h.ipc.applyUpdate(sender, update)).toEqual({accepted: true});
    expect(shared.applyLocalUpdate).toHaveBeenCalledOnce();
    live = false;
    expect(h.ipc.applyUpdate(sender, {...update, seq: 2})).toEqual({accepted: false, reason: "read-only"});
    expect(shared.applyLocalUpdate).toHaveBeenCalledOnce();
    await h.ipc.shutdown();
  });

  it.each(["access-ended", "reconnecting"] as const)("forwards the hosted read-only cause %s", async (cause) => {
    const open = vi.fn<EngineYDocSessionCapture["openYDocSession"]>(async () => providerSession());
    const h = harness(providerSession(), {sharedCaptureFor: async () => ({openYDocSession: open})});
    h.setReadOnly(true);
    const sender = new FakeSender(7);
    await h.ipc.open(sender, openPayload);
    open.mock.calls[0]![0].onSaveState?.("read-only", 0, "status", undefined, cause);
    expect(sender.sent.at(-1)?.payload).toMatchObject({access: "read-only", seq: 0, readOnlyCause: cause});
    await h.ipc.shutdown();
  });

  it.each(["access-ended", "reconnecting"] as const)("preserves the refused apply cause %s", async (cause) => {
    const shared = Object.assign(providerSession(), {liveWritable: () => false});
    const open = vi.fn<EngineYDocSessionCapture["openYDocSession"]>(async () => shared);
    const h = harness(providerSession(), {sharedCaptureFor: async () => ({openYDocSession: open})});
    h.setReadOnly(true);
    const sender = new FakeSender(7);
    await h.ipc.open(sender, openPayload);
    open.mock.calls[0]![0].onSaveState?.("read-only", 0, "status", undefined, "reconnecting");
    open.mock.calls[0]![0].onSaveState?.("read-only", 0, "status", undefined, cause);
    expect(sender.sent.at(-1)?.payload).toMatchObject({readOnlyCause: cause});
    expect(h.ipc.applyUpdate(sender, {sessionId: openPayload.sessionId, update: new Uint8Array([0, 0]),
      seq: 1, lineageGeneration: 1, requestId: "11111111-1111-4111-8111-111111111111"})).toEqual({accepted: false, reason: "read-only"});
    expect(sender.sent.at(-1)?.payload).toMatchObject({access: "read-only", seq: 1, readOnlyCause: cause});
    expect(shared.applyLocalUpdate).not.toHaveBeenCalled();
    await h.ipc.shutdown();
  });

  it("owns readiness by caller and cancels it on close or attachment retirement", async () => {
    const started = deferred<void>();
    const waitForAdmission = vi.fn((_path: string, signal: AbortSignal) => new Promise<boolean>(resolve => {
      signal.addEventListener("abort", () => resolve(false), {once: true});
      started.resolve();
    }));
    const h = harness(providerSession(), {sharedCaptureFor: async () => ({openYDocSession: vi.fn(), waitForAdmission})});
    h.setReadOnly(true);
    const first = new FakeSender(7), second = new FakeSender(8);
    const waiting = h.ipc.waitForAdmission(first, openPayload);
    await started.promise;
    await h.ipc.close(second, {sessionId: openPayload.sessionId});
    expect(waitForAdmission.mock.calls[0]![1].aborted).toBe(false);
    await h.ipc.close(first, {sessionId: openPayload.sessionId});
    expect(await waiting).toBe(false);
    const retired = h.ipc.waitForAdmission(first, openPayload);
    await vi.waitFor(() => expect(waitForAdmission).toHaveBeenCalledTimes(2));
    await h.ipc.retireAuthority(AUTHORITY_ID);
    expect(await retired).toBe(false);
    await h.ipc.shutdown();
  });

  it("rejects readiness for another workspace and ignores readiness after the caller changes generation", async () => {
    const reply = deferred<boolean>();
    const waitForAdmission = vi.fn(async () => reply.promise);
    const h = harness(providerSession(), {sharedCaptureFor: async () => ({openYDocSession: vi.fn(), waitForAdmission})});
    h.setReadOnly(true);
    const sender = new FakeSender(7);
    expect(await h.ipc.waitForAdmission(sender, {...openPayload, workspaceId: "other"})).toBe(false);
    expect(waitForAdmission).not.toHaveBeenCalled();
    const pending = h.ipc.waitForAdmission(sender, openPayload);
    await vi.waitFor(() => expect(waitForAdmission).toHaveBeenCalledOnce());
    h.setGeneration(2); reply.resolve(true);
    expect(await pending).toBe(false);
    await h.ipc.shutdown();
  });

  it("keeps an unavailable named host read-only without opening a local proposal editor", async () => {
    const h = harness(providerSession(), {sharedCaptureFor: async () => ({openYDocSession: async () => {throw new Error("offline");}})});
    h.setReadOnly(true);
    expect(await h.ipc.open(new FakeSender(7), openPayload)).toEqual({available: false, liveHostUnavailable: true});
    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("carries pending record delivery through a refused open", async () => {
    const waiting = { state: "pending" as const, message: "Record saved on this device. Waiting to send." };
    const h = harness(providerSession(), { sharedCaptureFor: async () => ({ openYDocSession: async () => { throw new SharedDocumentWaitingError(waiting); } }) });
    h.setReadOnly(true);
    expect(await h.ipc.open(new FakeSender(7), openPayload)).toEqual({ available: false, sharedWaiting: waiting });
    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("retires shared admission when the renderer switches workspaces", async () => {
    const pending = deferred<EngineYDocSessionCapture | null>();
    const entered = deferred<void>();
    const shared = {openYDocSession: vi.fn(async () => providerSession())};
    const h = harness(providerSession(), {sharedCaptureFor: () => {entered.resolve(); return pending.promise;}});
    h.setReadOnly(true);
    const opening = h.ipc.open(new FakeSender(7), openPayload);
    await entered.promise;
    h.retireSession();
    pending.resolve(shared);
    expect((await opening).available).toBe(false);
    expect(shared.openYDocSession).not.toHaveBeenCalled();
    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
  });

  // Turning sync on claimed an open editor's history and told its session to
  // resync, which is how the provider learns the claim. A registration that
  // arrives before that resync lands waits for it instead of refusing.
  function claimHarness(initialClaim: string | null) {
    let providerClaim = initialClaim;
    const resync = deferred<void>();
    const nativeOwner = {onDurableLocalChange: () => () => {}, sessionId: "native-existing",
      flush: vi.fn(async () => undefined), applyRemoteUpdate: vi.fn(async () => undefined), resyncIfNeeded: vi.fn(() => resync.promise)};
    const provider = providerSession({nativeOwner, objectId: "object", versionId: "main"});
    Object.defineProperty(provider, "lineageClaimId", {get: () => providerClaim});
    return {h: harness(provider), nativeOwner, resync, learn(claim: string) { providerClaim = claim; }};
  }
  const claimBinding = {workspaceId: "workspace-1", mainVersionId: "main", objectId: "object",
    lineageClaimId: "a".repeat(64), currentPath: "notes/a.md", selectorPaths: ["notes/a.md"], restoreFenceGeneration: 1};

  it("registers an idle editor as owner once its pending resync learns the claim sync made", async () => {
    const c = claimHarness(null);
    await c.h.ipc.open(new FakeSender(7), openPayload);
    let settled = false;
    const registering = c.h.ipc.existingOwner(claimBinding).finally(() => { settled = true; });
    await Promise.resolve();
    expect(c.nativeOwner.resyncIfNeeded).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    c.learn("a".repeat(64));
    c.resync.resolve();

    const owner = await registering;
    expect(owner.nativeSessionId).toBe("native-existing");
    expect(() => owner.assertCurrent()).not.toThrow();
  });

  it("refuses an editor whose resync did not bring the registered claim, after one wait", async () => {
    const c = claimHarness(null);
    await c.h.ipc.open(new FakeSender(7), openPayload);
    c.resync.resolve();
    await expect(c.h.ipc.existingOwner(claimBinding)).rejects.toThrow("The open document has not learned its sync claim yet.");
    expect(c.nativeOwner.resyncIfNeeded).toHaveBeenCalledOnce();
  });

  // The resync replaced the lineage and kept the native session, and the
  // renderer adopted the replacement before the wait ended. The new lineage
  // happens to carry the registered claim; the owner captured before the
  // wait is gone, so the registration refuses.
  it("refuses when the resync replaced the lineage, even once the renderer adopts it", async () => {
    const c = claimHarness(null);
    const sender = new FakeSender(7);
    await c.h.ipc.open(sender, openPayload);
    const registering = c.h.ipc.existingOwner(claimBinding);
    await Promise.resolve();

    c.learn("a".repeat(64));
    c.h.capturedOpen()?.onLineageReplaced?.(new Uint8Array([9]), []);
    expect(c.h.ipc.acknowledgeLineageReplacement(sender, {sessionId: openPayload.sessionId, lineageGeneration: 2}))
      .toMatchObject({accepted: true});
    c.resync.resolve();

    await expect(registering).rejects.toThrow("Owner session changed.");
    await expect(c.h.ipc.existingOwner(claimBinding)).resolves.toMatchObject({nativeSessionId: "native-existing"});
  });

  it("refuses at once when the editor holds a different claim", async () => {
    const c = claimHarness("b".repeat(64));
    await c.h.ipc.open(new FakeSender(7), openPayload);
    await expect(c.h.ipc.existingOwner(claimBinding)).rejects.toThrow("Existing owner changed.");
    expect(c.nativeOwner.resyncIfNeeded).not.toHaveBeenCalled();
  });

  it("lets the transport retire a stale owner when a durable change arrives", async () => {
    let notify!: () => void;
    const nativeOwner = {onDurableLocalChange: (handler: () => void) => {notify = handler; return () => {};},
      sessionId: "native-existing", flush: vi.fn(async () => undefined), applyRemoteUpdate: vi.fn(async () => undefined), resyncIfNeeded: vi.fn(async () => undefined)};
    const h = harness(providerSession({nativeOwner, objectId: "object", versionId: "main", lineageClaimId: "a".repeat(64)}));
    await h.ipc.open(new FakeSender(7), openPayload);
    const owner = await h.ipc.existingOwner({workspaceId: "workspace-1", mainVersionId: "main", objectId: "object",
      lineageClaimId: "a".repeat(64), currentPath: "notes/a.md", selectorPaths: ["notes/a.md"], restoreFenceGeneration: 1});
    const stop = vi.fn();
    owner.onDurableLocalChange(() => {try {owner.assertCurrent();} catch {stop();}});
    h.setGeneration(2);
    expect(() => notify()).not.toThrow();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("hands the existing session to main only after its journal flush and keeps the renderer held until completion", async () => {
    const flush = deferred<void>();
    const nativeOwner = {onDurableLocalChange: vi.fn(() => () => {}),sessionId: "native-existing",flush: vi.fn(() => flush.promise),refresh: vi.fn(async () => undefined),applyRemoteUpdate: vi.fn(async (_update: Uint8Array) => undefined),resyncIfNeeded: vi.fn(async () => undefined)};
    const h = harness(providerSession({nativeOwner,objectId: "object",versionId: "main",lineageClaimId: "a".repeat(64)}));
    const sender = new FakeSender(7);
    await h.ipc.open(sender,openPayload);
    const owner = await h.ipc.existingOwner({workspaceId: "workspace-1",mainVersionId: "main",objectId: "object",lineageClaimId: "a".repeat(64),currentPath: "notes/a.md",selectorPaths: ["notes/a.md"],restoreFenceGeneration: 1});
    const payload = {sessionId: openPayload.sessionId,lineageGeneration: 1};
    const prepared = owner.prepareHandoff(new AbortController().signal);
    expect(sender.sent.at(-1)?.payload).toEqual(payload);
    expect(() => h.capturedOpen()?.assertRecordWritable?.()).toThrow("Try again");
    await expect(h.ipc.prepareOwnerHandoff(new FakeSender(9),payload)).rejects.toThrow();
    await expect(h.ipc.prepareOwnerHandoff(sender,{...payload,lineageGeneration: 2})).rejects.toThrow();
    let released = false;
    const holding = h.ipc.prepareOwnerHandoff(sender,payload).then(() => { released = true; });
    expect(nativeOwner.flush).toHaveBeenCalledOnce();
    flush.resolve(); await prepared;
    expect(released).toBe(false);
    await owner.finishHandoff(true); await holding;
    expect(released).toBe(true);
    expect(() => h.capturedOpen()?.assertRecordWritable?.()).not.toThrow();
    const updates = Array.from({length: 100}, (_, index) => new Uint8Array([index, 0]));
    for (const update of updates) await owner.remoteApplied(update);
    expect(nativeOwner.refresh).not.toHaveBeenCalled();
    expect(nativeOwner.applyRemoteUpdate.mock.calls.map(([update]) => update)).toEqual(updates);
    expect(nativeOwner.applyRemoteUpdate.mock.calls.reduce((bytes, [update]) => bytes + update.byteLength, 0)).toBe(200);
    h.setGeneration(2);
    expect(() => owner.assertCurrent()).toThrow();
    await expect(owner.remoteApplied(new Uint8Array([0,0]))).rejects.toThrow();
    expect(nativeOwner.applyRemoteUpdate).toHaveBeenCalledTimes(100);
  });

  it("releases a prepared renderer when relay acquisition is cancelled", async () => {
    const nativeOwner = {onDurableLocalChange: vi.fn(() => () => {}),sessionId: "native-existing",flush: vi.fn(async () => undefined),applyRemoteUpdate: vi.fn(async () => undefined),resyncIfNeeded: vi.fn(async () => undefined)};
    const h = harness(providerSession({nativeOwner,objectId: "object",versionId: "main",lineageClaimId: "a".repeat(64)}));
    const sender = new FakeSender(7); await h.ipc.open(sender,openPayload);
    const owner = await h.ipc.existingOwner({workspaceId: "workspace-1",mainVersionId: "main",objectId: "object",lineageClaimId: "a".repeat(64),currentPath: "notes/a.md",selectorPaths: ["notes/a.md"],restoreFenceGeneration: 1});
    const signal = new AbortController();
    const prepared = owner.prepareHandoff(signal.signal);
    const holding = h.ipc.prepareOwnerHandoff(sender,{sessionId: openPayload.sessionId,lineageGeneration: 1});
    await prepared;
    signal.abort(new Error("disconnected"));
    await holding;
    await expect(h.ipc.prepareOwnerHandoff(sender,{sessionId: openPayload.sessionId,lineageGeneration: 1})).rejects.toThrow("not requested");
  });
  // An agent's Stop again refuses a document an editor holds, as the window closes its own editors first.
  it("changes a document's live editing for a main-side door only while no editor holds it", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    await h.ipc.open(sender, openPayload);
    const change = vi.fn(async () => "stopped");
    await expect(h.ipc.withLiveEditingChange(AUTHORITY_ID, "notes/a.md", change))
      .rejects.toThrow("notes/a.md is open in an editor. Close it in dohc, then try again.");
    expect(change).not.toHaveBeenCalled();
    await h.ipc.close(sender, { sessionId: openPayload.sessionId });
    await expect(h.ipc.withLiveEditingChange(AUTHORITY_ID, "notes/a.md", change)).resolves.toBe("stopped");
    // The change's own failure passes through unchanged.
    await expect(h.ipc.withLiveEditingChange(AUTHORITY_ID, "notes/a.md", async () => {throw new Error("Stop live editing is waiting.");}))
      .rejects.toThrow("Stop live editing is waiting.");
  });
  it("opens the canonical session and applies updates through its save sequence", async () => {
    const sender = new FakeSender(7);
    const h = harness();

    const opened = await h.ipc.open(sender, openPayload);

    expect(opened).toMatchObject({
      available: true,
      lineageGeneration: 1,
      artifactAssets: [],
    });
    expect(opened.initialUpdate).toBeInstanceOf(Uint8Array);
    expect(h.capturedOpen()).toMatchObject({
      path: "notes/a.md",
      contentKind: "richdoc",
    });
    await expect(
      h.ipc
        .fileMutationPort()
        .withDocumentUnowned(AUTHORITY_ID, "notes/a.md", async () => true),
    ).rejects.toThrow(
      "The engine owns this live document. Close its editor before writing the file directly.",
    );

    expect(
      h.ipc.applyUpdate(sender, {
        sessionId: openPayload.sessionId,
        update: new Uint8Array([1]),
        lineageGeneration: 1, requestId: "11111111-1111-4111-8111-111111111111",
        seq: 4,
      }),
    ).toEqual({ accepted: true });
    h.capturedOpen()?.onSaveState?.("settling", 9, "start");
    h.capturedOpen()?.onSaveState?.("saved", 9, "outcome");
    expect(sender.sent.slice(-2).map(({ payload }) => payload)).toEqual([
      { sessionId: openPayload.sessionId, ...DOCUMENT, typingUnresolved: false, ...engineSaveState("settling"), seq: 4 },
      { sessionId: openPayload.sessionId, ...DOCUMENT, typingUnresolved: false, ...engineSaveState("saved"), seq: 4 },
    ]);
  });

  it("answers Try again by settling the session open for the document, or closed when none is", async () => {
    const settleNow = vi.fn(async () => ({
      momentId: "moment-1", path: "notes/a.md", content: null, sha256: "a".repeat(64), materialized: true,
      projection: { contentKind: "richdoc" as const, sourceStateVectorSha256: "b".repeat(64), destructive: false },
    }));
    const h = harness(providerSession({ settleNow }));
    const sender = new FakeSender(7);
    const retry = { workspaceId: "workspace-1", path: "notes/a.md" };
    await expect(h.ipc.retrySave(sender, retry)).resolves.toBe("closed");

    await h.ipc.open(sender, openPayload);
    await expect(h.ipc.retrySave(sender, retry)).resolves.toBe("settled");
    expect(settleNow).toHaveBeenCalledOnce();
    await expect(h.ipc.retrySave(sender, { ...retry, path: "notes/b.md" })).resolves.toBe("closed");
    // Another window in the same workspace cannot save this window's session.
    await expect(h.ipc.retrySave(new FakeSender(8), retry)).resolves.toBe("closed");
    await expect(h.ipc.retrySave(sender, { ...retry, workspaceId: "workspace-2" })).rejects.toThrow("another workspace");
    expect(settleNow).toHaveBeenCalledOnce();

    await h.ipc.close(sender, { sessionId: openPayload.sessionId });
    await expect(h.ipc.retrySave(sender, retry)).resolves.toBe("closed");
    expect(settleNow).toHaveBeenCalledOnce();
    await h.ipc.shutdown();
  });

  it("lets each window's Try again save only that window's session for the document", async () => {
    const settleNow = vi.fn(async () => ({
      momentId: "moment-1", path: "notes/a.md", content: null, sha256: "a".repeat(64), materialized: true,
      projection: { contentKind: "richdoc" as const, sourceStateVectorSha256: "b".repeat(64), destructive: false },
    }));
    const h = harness(providerSession({ settleNow }));
    const first = new FakeSender(7);
    const second = new FakeSender(8);
    const retry = { workspaceId: "workspace-1", path: "notes/a.md" };

    await h.ipc.open(first, openPayload);
    await expect(h.ipc.retrySave(first, retry)).resolves.toBe("settled");
    await expect(h.ipc.retrySave(second, retry)).resolves.toBe("closed");
    expect(settleNow).toHaveBeenCalledTimes(1);

    await h.ipc.close(first, { sessionId: openPayload.sessionId });
    await h.ipc.open(second, { ...openPayload, sessionId: "renderer-session-2" });
    await expect(h.ipc.retrySave(second, retry)).resolves.toBe("settled");
    await expect(h.ipc.retrySave(first, retry)).resolves.toBe("closed");
    expect(settleNow).toHaveBeenCalledTimes(2);
    await h.ipc.shutdown();
  });

  it("rejects Try again when the settle fails or cannot start", async () => {
    const refusal = new Error("workspace operation failed");
    const failing = harness(providerSession({ settleNow: vi.fn(async () => { throw refusal; }) }));
    const sender = new FakeSender(7);
    await failing.ipc.open(sender, openPayload);
    const retry = { workspaceId: "workspace-1", path: "notes/a.md" };
    await expect(failing.ipc.retrySave(sender, retry)).rejects.toBe(refusal);
    await failing.ipc.shutdown();

    const shared = providerSession();
    delete (shared as Partial<WorkspaceEngineYDocProviderSession>).settleNow;
    const noSettle = harness(shared);
    await noSettle.ipc.open(sender, openPayload);
    await expect(noSettle.ipc.retrySave(sender, retry)).rejects.toThrow("could not start a save");
    await noSettle.ipc.shutdown();
  });

  it("marks only a settle that failed to write as a save failure, and names a read-only file", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-save-failure-"));
    mkdirSync(join(root, "notes"));
    const file = join(root, "notes", "a.md");
    writeFileSync(file, "# A\n");
    try {
      const h = harness(providerSession(), { rootPath: root });
      const sender = new FakeSender(7);
      await h.ipc.open(sender, openPayload);
      const failures = () => sender.sent.map(({ payload }) => (payload as { saveFailure?: unknown }).saveFailure);

      h.capturedOpen()?.onSaveState?.("error", 1, "outcome");
      expect(failures().at(-1)).toEqual({ reason: null });
      chmodSync(file, 0o444);
      h.capturedOpen()?.onSaveState?.("settling", 2, "start");
      h.capturedOpen()?.onSaveState?.("error", 2, "outcome");
      expect(failures().at(-1)).toEqual({ reason: "read-only" });
      // An author-capacity refusal and an error no settle reported are not save failures.
      h.capturedOpen()?.onSaveState?.("settling", 3, "start");
      h.capturedOpen()?.onSaveState?.("error", 3, "outcome", true);
      expect(failures().at(-1)).toBeUndefined();
      h.capturedOpen()?.onSaveState?.("settling", 0, "status");
      h.capturedOpen()?.onSaveState?.("error", 0, "status");
      expect(failures().at(-1)).toBeUndefined();
      await h.ipc.shutdown();
    } finally {
      chmodSync(file, 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names a save macOS refused as a privacy refusal, not a read-only file", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-save-privacy-"));
    mkdirSync(join(root, "notes"));
    const file = join(root, "notes", "a.md");
    writeFileSync(file, "# A\n");
    chmodSync(file, 0o444);
    vi.mocked(isPrivacyDenial).mockReturnValueOnce(true);
    try {
      const h = harness(providerSession(), { rootPath: root });
      const sender = new FakeSender(7);
      await h.ipc.open(sender, openPayload);
      h.capturedOpen()?.onSaveState?.("error", 1, "outcome");
      expect(sender.sent.map(({ payload }) => (payload as { saveFailure?: unknown }).saveFailure).at(-1))
        .toEqual({ reason: "privacy-denied" });
      await h.ipc.shutdown();
    } finally {
      chmodSync(file, 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names a save the engine refused because the volume shares new files", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-save-volume-"));
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "a.md"), "# A\n");
    try {
      const h = harness(providerSession(), { rootPath: root });
      const sender = new FakeSender(7);
      await h.ipc.open(sender, openPayload);
      const refusal = new DaemonRefusalError({ code: "INTERNAL", message: "volume-shares-new-files", retry: "no" }, undefined);
      h.capturedOpen()?.onSaveState?.("error", 1, "outcome", false, undefined, new Error("settle failed", { cause: refusal }));
      expect(sender.sent.map(({ payload }) => (payload as { saveFailure?: unknown }).saveFailure).at(-1))
        .toEqual({ reason: "volume-shares-new-files" });
      await h.ipc.shutdown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names a save the engine refused over a missing file as a file deleted outside dohc", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-save-deleted-"));
    try {
      const h = harness(providerSession(), { rootPath: root });
      const sender = new FakeSender(7);
      await h.ipc.open(sender, openPayload);
      const failures = () => sender.sent.map(({ payload }) => (payload as { saveFailure?: unknown }).saveFailure);
      const stale = new DaemonRefusalError({ code: "INVALID_PARAMS", message: "conflict-stale-target", retry: "no" }, undefined);
      h.capturedOpen()?.onSaveState?.("error", 1, "outcome", false, undefined, new Error("settle failed", { cause: stale }));
      expect(failures().at(-1)).toEqual({ reason: "deleted" });
      // A missing file the engine did not refuse for is a document that has
      // no file yet.
      h.capturedOpen()?.onSaveState?.("settling", 2, "start");
      h.capturedOpen()?.onSaveState?.("error", 2, "outcome", false, undefined, new Error("disk full"));
      expect(failures().at(-1)).toEqual({ reason: null });
      await h.ipc.shutdown();

      // A shared view's file is its host's to put back.
      let sharedOpen: Parameters<EngineYDocSessionCapture["openYDocSession"]>[0] | undefined;
      const shared = harness(providerSession(), { rootPath: root, sharedCaptureFor: async () => ({
        openYDocSession: async (input) => { sharedOpen = input; return providerSession(); },
      }) });
      shared.setReadOnly(true);
      const viewer = new FakeSender(8);
      expect((await shared.ipc.open(viewer, openPayload)).available).toBe(true);
      sharedOpen?.onSaveState?.("error", 1, "outcome", false, undefined, stale);
      expect(viewer.sent.map(({ payload }) => (payload as { saveFailure?: unknown }).saveFailure).at(-1)).toEqual({ reason: null });
      await shared.ipc.shutdown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("saves a deleted file again only from the window that holds it, including after its tab closed", async () => {
    const close = vi.fn(async () => undefined);
    const h = harness(providerSession({ close }));
    const saveDeletedFileAgain = vi.fn(async () => true);
    h.capture.saveDeletedFileAgain = saveDeletedFileAgain;
    const sender = new FakeSender(7);
    const again = { workspaceId: "workspace-1", path: "notes/a.md", recreateFile: true as const };
    await expect(h.ipc.retrySave(sender, again)).resolves.toBe("closed");
    expect(saveDeletedFileAgain).not.toHaveBeenCalled();

    await h.ipc.open(sender, openPayload);
    await expect(h.ipc.retrySave(new FakeSender(8), again)).resolves.toBe("closed");
    expect(saveDeletedFileAgain).not.toHaveBeenCalled();
    await expect(h.ipc.retrySave(sender, again)).resolves.toBe("settled");
    expect(saveDeletedFileAgain).toHaveBeenCalledWith("notes/a.md");
    expect(h.session.settleNow).not.toHaveBeenCalled();

    // The tab closes and the close is refused: the session still holds the
    // text. Save it again saves it, then finishes the close.
    close.mockRejectedValueOnce(new Error("conflict-stale-target"));
    await h.ipc.close(sender, { sessionId: openPayload.sessionId });
    await expect(h.ipc.retrySave(sender, again)).resolves.toBe("settled");
    expect(saveDeletedFileAgain).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    await expect(h.ipc.retrySave(sender, again)).resolves.toBe("closed");
    expect(saveDeletedFileAgain).toHaveBeenCalledTimes(2);
    await h.ipc.shutdown();

    // A shared view's file is its host's to put back.
    const shared = harness(providerSession(), { sharedCaptureFor: async () => ({ openYDocSession: async () => providerSession() }) });
    shared.capture.saveDeletedFileAgain = saveDeletedFileAgain;
    shared.setReadOnly(true);
    expect((await shared.ipc.open(sender, openPayload)).available).toBe(true);
    await expect(shared.ipc.retrySave(sender, again)).resolves.toBe("closed");
    expect(saveDeletedFileAgain).toHaveBeenCalledTimes(2);
    await shared.ipc.shutdown();
  });

  // A Finder lock refuses writes with EPERM, as a macOS privacy refusal does,
  // but the file still reads, so it is read-only, not a privacy refusal.
  it.runIf(process.platform === "darwin")("names a file locked in Finder read-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-save-locked-"));
    mkdirSync(join(root, "notes"));
    const file = join(root, "notes", "a.md");
    writeFileSync(file, "# A\n");
    execFileSync("chflags", ["uchg", file]);
    try {
      const h = harness(providerSession(), { rootPath: root });
      const sender = new FakeSender(7);
      await h.ipc.open(sender, openPayload);
      h.capturedOpen()?.onSaveState?.("error", 1, "outcome");
      expect(sender.sent.map(({ payload }) => (payload as { saveFailure?: unknown }).saveFailure).at(-1))
        .toEqual({ reason: "read-only" });
      await h.ipc.shutdown();
    } finally {
      execFileSync("chflags", ["nouchg", file]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retires a busy outcome while keeping its original edit sequence", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    await h.ipc.open(sender, openPayload);
    const edit = (seq: number) => h.ipc.applyUpdate(sender, {
      sessionId: openPayload.sessionId,
      update: new Uint8Array([seq]),
      lineageGeneration: 1, requestId: `11111111-1111-4111-8111-${seq.toString().padStart(12, "0")}`,
      seq,
    });
    edit(4);
    h.capturedOpen()?.onSaveState?.("settling", 9, "start");
    edit(5);
    h.capturedOpen()?.onSaveState?.("settling", 9, "outcome");
    // An already completed token claims nothing, even if reported again.
    h.capturedOpen()?.onSaveState?.("saved", 9, "outcome");
    h.capturedOpen()?.onSaveState?.("settling", 10, "start");
    h.capturedOpen()?.onSaveState?.("saved", 10, "outcome");
    expect(sender.sent.slice(-4).map(({ payload }) => payload)).toEqual([
      { sessionId: openPayload.sessionId, ...DOCUMENT, typingUnresolved: false, ...engineSaveState("settling"), seq: 4 },
      { sessionId: openPayload.sessionId, ...DOCUMENT, typingUnresolved: false, ...engineSaveState("saved"), seq: 0 },
      { sessionId: openPayload.sessionId, ...DOCUMENT, typingUnresolved: false, ...engineSaveState("settling"), seq: 5 },
      { sessionId: openPayload.sessionId, ...DOCUMENT, typingUnresolved: false, ...engineSaveState("saved"), seq: 5 },
    ]);
    await h.ipc.shutdown();
  });

  it("keeps opening and corrective status reports outside the edit ledger", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    await h.ipc.open(sender, openPayload);
    h.capturedOpen()?.onSaveState?.("settling", 0, "status");
    h.ipc.applyUpdate(sender, {
      sessionId: openPayload.sessionId,
      update: new Uint8Array([1]),
      lineageGeneration: 1, requestId: "11111111-1111-4111-8111-111111111111",
      seq: 4,
    });
    h.capturedOpen()?.onSaveState?.("settling", 9, "start");
    h.capturedOpen()?.onSaveState?.("error", 9, "outcome");
    h.capturedOpen()?.onSaveState?.("changed-on-disk", 9, "status");
    h.capturedOpen()?.onSaveState?.("settling", 0, "status");
    h.capturedOpen()?.onSaveState?.("error", 0, "status");
    expect(sender.sent.slice(-5).map(({ payload }) => payload)).toEqual([
      { sessionId: openPayload.sessionId, ...DOCUMENT, typingUnresolved: false, ...engineSaveState("settling"), seq: 0 },
      { sessionId: openPayload.sessionId, ...DOCUMENT, typingUnresolved: false, ...engineSaveState("error"), seq: 4, saveFailure: { reason: null } },
      { sessionId: openPayload.sessionId, ...DOCUMENT, typingUnresolved: false, ...engineSaveState("changed-on-disk"), seq: 0 },
      { sessionId: openPayload.sessionId, ...DOCUMENT, typingUnresolved: false, ...engineSaveState("settling"), seq: 0 },
      { sessionId: openPayload.sessionId, ...DOCUMENT, typingUnresolved: false, ...engineSaveState("error"), seq: 0 },
    ]);
    await h.ipc.shutdown();
  });

  it("refuses an open outside the renderer session's workspace", async () => {
    const sender = new FakeSender(7);
    const h = harness(providerSession(), {
      rendererWorkspaceId: "workspace-2",
    });

    await expect(h.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
    });
    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("reports current remote-update delivery failures but ignores stale senders", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    await h.ipc.open(sender, openPayload);
    const deliveryError = new Error("renderer send failed");

    sender.failSendsWith(deliveryError);
    h.capturedOpen()?.onRemoteUpdate(new Uint8Array([1]));
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("remote-update delivery failed"),
      deliveryError,
    );

    sender.failSendsWith(null);
    h.onError.mockClear();
    h.capturedOpen()?.onRemoteUpdate(
      new Uint8Array(ENGINE_YDOC_UPDATE_MAX_BYTES + 1),
    );
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("remote-update delivery failed"),
      expect.any(Error),
    );

    h.onError.mockClear();
    h.setGeneration(2);
    h.capturedOpen()?.onRemoteUpdate(new Uint8Array([2]));
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("resolves the physical workspace path before reserving and opening it", async () => {
    const sender = new FakeSender(7);
    const resolveDocumentPath = vi.fn(
      async (
        _workspace: {
          workspaceId: string;
          rootPath: string;
          attachmentId: symbol;
        },
        _path: string,
      ) =>
        "notes/a.md",
    );
    const h = harness(providerSession(), { resolveDocumentPath });

    await expect(
      h.ipc.open(sender, { ...openPayload, path: "alias/a.md" }),
    ).resolves.toMatchObject({ available: true });

    expect(resolveDocumentPath).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        rootPath: "C:/workspace",
        attachmentId: AUTHORITY_ID,
      },
      "alias/a.md",
    );
    expect(resolveDocumentPath.mock.calls.map(([, path]) => path)).toEqual([
      "alias/a.md",
      "alias/a.md",
    ]);
    expect(h.capturedOpen()).toMatchObject({ path: "notes/a.md" });
    await expect(
      h.ipc
        .fileMutationPort()
        .withDocumentUnowned(AUTHORITY_ID, "notes/a.md", async () => true),
    ).rejects.toThrow("The engine owns this live document");
  });

  it.each([
    {
      requestedPath: "alias/note.md",
      canonicalPath: "drawings/scene.excalidraw",
      canonicalKind: "scene" as const,
    },
    {
      requestedPath: "alias/scene.excalidraw",
      canonicalPath: "notes/note.md",
      canonicalKind: "richdoc" as const,
    },
  ])(
    "refuses a $requestedPath leaf alias to a cross-kind $canonicalPath target",
    async ({ requestedPath, canonicalPath, canonicalKind }) => {
      const sender = new FakeSender(7);
      const resolveDocumentPath = vi.fn(async () => canonicalPath);
      const h = harness(
        providerSession({ path: canonicalPath, contentKind: canonicalKind }),
        { resolveDocumentPath },
      );

      await expect(
        h.ipc.open(sender, { ...openPayload, path: requestedPath }),
      ).resolves.toEqual({
        available: false,
        documentUnavailable: true,
      });

      expect(resolveDocumentPath).toHaveBeenCalledOnce();
      expect(h.capture.openYDocSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      requestedPath: "alias/note.md",
      canonicalPath: "notes/note.markdown",
      documentKind: "richdoc" as const,
    },
    {
      requestedPath: "alias/scene.excalidraw",
      canonicalPath: "drawings/scene.excalidraw",
      documentKind: "scene" as const,
    },
  ])(
    "keeps a same-kind $requestedPath leaf alias eligible for its canonical session",
    async ({ requestedPath, canonicalPath, documentKind }) => {
      const sender = new FakeSender(7);
      const resolveDocumentPath = vi.fn(async () => canonicalPath);
      const h = harness(
        providerSession({ path: canonicalPath, contentKind: documentKind }),
        { resolveDocumentPath },
      );

      await expect(
        h.ipc.open(sender, { ...openPayload, path: requestedPath }),
      ).resolves.toMatchObject({ available: true });

      expect(resolveDocumentPath).toHaveBeenCalledTimes(2);
      expect(h.capturedOpen()).toMatchObject({
        path: canonicalPath,
        contentKind: documentKind,
      });
    },
  );

  it("coordinates case aliases through their resolved physical path", async () => {
    const sender = new FakeSender(7);
    const canonicalPath = "Notes/Folder/A.md";
    const h = harness(providerSession({ path: canonicalPath }), {
      resolveDocumentPath: async () => canonicalPath,
    });
    await h.ipc.open(sender, {
      ...openPayload,
      path: "notes/folder/a.md",
    });

    const mutation = vi.fn(async () => undefined);
    await expect(
      h.ipc
        .fileMutationPort()
        .withDocumentUnowned(AUTHORITY_ID, canonicalPath, mutation),
    ).rejects.toThrow("The engine owns this live document");
    expect(mutation).not.toHaveBeenCalled();

    h.ipc
      .fileMutationPort()
      .markDeletedUnderPath(AUTHORITY_ID, "Notes/Folder");
    expect(sender.sent.at(-1)?.payload).toMatchObject({ typingUnresolved: false, ...engineSaveState("deleted") });
  });

  it("opens the workspace activity when the renderer outruns daemon startup", async () => {
    const sender = new FakeSender(7);
    let captureAvailable = false;
    const capture: EngineYDocSessionCapture = {
      openYDocSession: vi.fn(async () => providerSession()),
    };
    const ensureCaptureFor = vi.fn(async () => {
      captureAvailable = true;
    });
    const ipc = createEngineYDocSessionIpc({
      localPersonId: () => "person-local",
      sessionFor: () => rendererSession(),
      acquireWorkspace: workspaceAuthority,
      captureFor: () => (captureAvailable ? capture : null),
      ensureCaptureFor,
      isSharedView: () => false,
      resolveDocumentPath: async (_workspace, path) => path,
      onError: vi.fn(),
    });

    await expect(ipc.open(sender, openPayload)).resolves.toMatchObject({
      available: true,
    });
    expect(ensureCaptureFor).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      rootPath: "C:/workspace",
      attachmentId: AUTHORITY_ID,
    });
    expect(capture.openYDocSession).toHaveBeenCalledOnce();
  });

  it("releases a provider whose document kind does not match the request", async () => {
    const session = providerSession({ contentKind: "scene" });
    const sender = new FakeSender(7);
    const h = harness(session);

    await expect(h.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
    });
    expect(session.close).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("kind-mismatched lineage"),
    );
  });

  it("reports when a kind-mismatched provider may still hold the document", async () => {
    const releaseError = new Error("provider close failed");
    const session = providerSession({
      contentKind: "scene",
      close: vi.fn(async () => {
        throw releaseError;
      }),
    });
    const sender = new FakeSender(7);
    const h = harness(session);

    await expect(h.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
      engineMayHoldDocument: true,
    });
    expect(session.close).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("kind-mismatched lineage"),
    );
    expect(h.onError).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("session close failed"),
      releaseError,
    );
  });

  it("refuses a direct mutation while a canonical session is opening", async () => {
    const sender = new FakeSender(7);
    const openingEntered = deferred<void>();
    const providerReady = deferred<WorkspaceEngineYDocProviderSession>();
    const capture: EngineYDocSessionCapture = {
      openYDocSession: vi.fn(async () => {
        openingEntered.resolve();
        return providerReady.promise;
      }),
    };
    const ipc = createEngineYDocSessionIpc({
      localPersonId: () => "person-local",
      sessionFor: () => rendererSession(),
      acquireWorkspace: workspaceAuthority,
      captureFor: () => capture,
      ensureCaptureFor: vi.fn(async () => undefined),
      isSharedView: () => false,
      resolveDocumentPath: async (_workspace, path) => path,
      onError: vi.fn(),
    });

    const opening = ipc.open(sender, openPayload);
    await openingEntered.promise;
    const mutation = vi.fn(async () => undefined);
    await expect(
      ipc
        .fileMutationPort()
        .withDocumentUnowned(AUTHORITY_ID, "notes/a.md", mutation),
    ).rejects.toThrow(
      "The engine owns this live document. Close its editor before writing the file directly.",
    );
    expect(mutation).not.toHaveBeenCalled();

    providerReady.resolve(providerSession());
    await expect(opening).resolves.toMatchObject({ available: true });
  });

  it("queues a canonical session open behind the direct mutation that owns the path", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    const trace: string[] = [];
    const mutationEntered = deferred<void>();
    const releaseMutation = deferred<void>();
    const openingEntered = deferred<void>();
    const providerReady = deferred<WorkspaceEngineYDocProviderSession>();
    vi.mocked(h.capture.openYDocSession).mockImplementationOnce(async () => {
      trace.push("open-entered");
      openingEntered.resolve();
      return providerReady.promise;
    });
    const mutation = h.ipc
      .fileMutationPort()
      .withDocumentUnowned(AUTHORITY_ID, "notes/a.md", async () => {
        mutationEntered.resolve();
        await releaseMutation.promise;
        trace.push("mutation-finished");
      });
    await mutationEntered.promise;

    const opening = h.ipc.open(sender, openPayload);
    void opening.then(() => {
      trace.push("opened");
    });

    releaseMutation.resolve();
    await mutation;
    await openingEntered.promise;
    expect(trace).toEqual(["mutation-finished", "open-entered"]);
    const laterMutation = vi.fn(async () => undefined);
    await expect(
      h.ipc
        .fileMutationPort()
        .withDocumentUnowned(AUTHORITY_ID, "notes/a.md", laterMutation),
    ).rejects.toThrow("The engine owns this live document");
    expect(laterMutation).not.toHaveBeenCalled();

    providerReady.resolve(providerSession());
    await expect(opening).resolves.toMatchObject({ available: true });
    expect(h.capture.openYDocSession).toHaveBeenCalledOnce();
    expect(trace).toEqual(["mutation-finished", "open-entered", "opened"]);
  });

  it("releases a failed direct-mutation reservation", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    const failure = new Error("write failed");

    await expect(
      h.ipc
        .fileMutationPort()
        .withDocumentUnowned(AUTHORITY_ID, "notes/a.md", async () => {
          throw failure;
        }),
    ).rejects.toBe(failure);

    await expect(h.ipc.open(sender, openPayload)).resolves.toMatchObject({
      available: true,
    });
    expect(h.capture.openYDocSession).toHaveBeenCalledOnce();
  });

  it("opens after the direct mutation ahead of it fails", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    const mutationEntered = deferred<void>();
    const releaseMutation = deferred<void>();
    const mutationError = new Error("write failed after admission");
    const mutation = h.ipc
      .fileMutationPort()
      .withDocumentUnowned(AUTHORITY_ID, "notes/a.md", async () => {
        mutationEntered.resolve();
        await releaseMutation.promise;
        throw mutationError;
      });
    await mutationEntered.promise;

    const opening = h.ipc.open(sender, openPayload);
    releaseMutation.resolve();

    await expect(mutation).rejects.toBe(mutationError);
    await expect(opening).resolves.toMatchObject({ available: true });
    expect(h.capture.openYDocSession).toHaveBeenCalledOnce();
  });

  it("refuses an alias that retargets while its canonical open is queued", async () => {
    const sender = new FakeSender(7);
    const firstResolution = deferred<void>();
    let aliasTarget = "notes/a.md";
    const resolveDocumentPath = vi.fn(async (_workspace, requestedPath: string) => {
      if (requestedPath === "alias/a.md") {
        const target = aliasTarget;
        firstResolution.resolve();
        return target;
      }
      return requestedPath;
    });
    const h = harness(providerSession(), { resolveDocumentPath });
    const mutationEntered = deferred<void>();
    const releaseMutation = deferred<void>();
    const mutation = h.ipc
      .fileMutationPort()
      .withDocumentUnowned(AUTHORITY_ID, "notes/a.md", async () => {
        mutationEntered.resolve();
        await releaseMutation.promise;
      });
    await mutationEntered.promise;

    const opening = h.ipc.open(sender, { ...openPayload, path: "alias/a.md" });
    await firstResolution.promise;
    aliasTarget = "notes/b.md";
    releaseMutation.resolve();
    await mutation;

    await expect(opening).resolves.toEqual({
      available: false,
      documentUnavailable: true,
    });
    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
    expect(resolveDocumentPath.mock.calls.map(([, path]) => path)).toEqual([
      "alias/a.md",
      "alias/a.md",
    ]);
    const laterMutation = vi.fn(async () => undefined);
    await expect(
      h.ipc
        .fileMutationPort()
        .withDocumentUnowned(AUTHORITY_ID, "notes/a.md", laterMutation),
    ).resolves.toBeUndefined();
    expect(laterMutation).toHaveBeenCalledOnce();
  });

  it.each(["renderer generation", "shared view"] as const)(
    "releases a queued open when its %s changes",
    async (transition) => {
      const sender = new FakeSender(7);
      const firstResolution = deferred<void>();
      const resolveDocumentPath = vi.fn(async (_workspace, path: string) => {
        firstResolution.resolve();
        return path;
      });
      const h = harness(providerSession(), { resolveDocumentPath });
      const mutationEntered = deferred<void>();
      const releaseMutation = deferred<void>();
      const mutation = h.ipc
        .fileMutationPort()
        .withDocumentUnowned(AUTHORITY_ID, "notes/a.md", async () => {
          mutationEntered.resolve();
          await releaseMutation.promise;
        });
      await mutationEntered.promise;

      const opening = h.ipc.open(sender, openPayload);
      await firstResolution.promise;
      if (transition === "renderer generation") h.setGeneration(2);
      else h.setReadOnly(true);
      releaseMutation.resolve();
      await mutation;

      await expect(opening).resolves.toEqual({ available: false });
      expect(resolveDocumentPath).toHaveBeenCalledTimes(2);
      expect(h.capture.openYDocSession).not.toHaveBeenCalled();
      h.setGeneration(1);
      h.setReadOnly(false);
      const laterMutation = vi.fn(async () => undefined);
      await expect(
        h.ipc
          .fileMutationPort()
          .withDocumentUnowned(AUTHORITY_ID, "notes/a.md", laterMutation),
      ).resolves.toBeUndefined();
      expect(laterMutation).toHaveBeenCalledOnce();
    },
  );

  it("refuses an open when the physical path changes before capture admission", async () => {
    const sender = new FakeSender(7);
    let resolution = 0;
    const resolveDocumentPath = vi.fn(async () => {
      resolution += 1;
      return resolution === 1 ? "notes/a.md" : null;
    });
    const h = harness(providerSession(), { resolveDocumentPath });

    await expect(h.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
      documentUnavailable: true,
    });

    expect(resolveDocumentPath).toHaveBeenCalledTimes(2);
    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("keeps a live document unavailable when it disappears before admission", async () => {
    const sender = new FakeSender(7);
    const h = harness(providerSession(), {
      resolveDocumentPath: async () => null,
    });

    await expect(h.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
      documentUnavailable: true,
    });
    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("refuses a capture resolved for a retired renderer generation", async () => {
    const sender = new FakeSender(7);
    let generation = 1;
    let captureAvailable = false;
    const captureReady = deferred<void>();
    const ensureStarted = deferred<void>();
    const capture: EngineYDocSessionCapture = {
      openYDocSession: vi.fn(async () => providerSession()),
    };
    const ensureCaptureFor = vi.fn(() => {
      ensureStarted.resolve();
      return captureReady.promise;
    });
    const ipc = createEngineYDocSessionIpc({
      localPersonId: () => "person-local",
      sessionFor: () => rendererSession(() => generation),
      acquireWorkspace: workspaceAuthority,
      captureFor: () => (captureAvailable ? capture : null),
      ensureCaptureFor,
      isSharedView: () => false,
      resolveDocumentPath: async (_workspace, path) => path,
      onError: vi.fn(),
    });

    const opening = ipc.open(sender, openPayload);
    await ensureStarted.promise;
    expect(ensureCaptureFor).toHaveBeenCalledOnce();
    generation = 2;
    captureAvailable = true;
    captureReady.resolve();

    await expect(opening).resolves.toEqual({ available: false });
    expect(capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("denies a fresh open after reload retirement invalidates admission", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    h.retireSession();

    await expect(h.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
    });

    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("rechecks shared-view and deletion policy before every update", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    await h.ipc.open(sender, openPayload);

    h.setReadOnly(true);
    expect(
      h.ipc.applyUpdate(sender, {
        sessionId: openPayload.sessionId,
        update: new Uint8Array([1]),
        lineageGeneration: 1, requestId: "11111111-1111-4111-8111-111111111111",
        seq: 5,
      }),
    ).toEqual({ accepted: false, reason: "read-only" });
    expect(sender.sent.at(-1)?.payload).toEqual({
      sessionId: openPayload.sessionId,
      ...DOCUMENT,
      typingUnresolved: false, ...engineSaveState("read-only"),
      seq: 5,
      readOnlyCause: "reconnecting",
    });

    h.setReadOnly(false);
    h.ipc
      .fileMutationPort()
      .markDeletedUnderPath(AUTHORITY_ID, "notes");
    expect(sender.sent.at(-1)?.payload).toEqual({
      sessionId: openPayload.sessionId,
      ...DOCUMENT,
      typingUnresolved: false, ...engineSaveState("deleted"),
      seq: 0,
    });
    expect(
      h.ipc.applyUpdate(sender, {
        sessionId: openPayload.sessionId,
        update: new Uint8Array([2]),
        lineageGeneration: 1, requestId: "11111111-1111-4111-8111-111111111111",
        seq: 6,
      }),
    ).toEqual({ accepted: false, reason: "deleted" });
    expect(h.session.applyLocalUpdate).not.toHaveBeenCalled();
  });

  it("refuses every later update once another object takes the path", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    await h.ipc.open(sender, openPayload);

    h.capturedOpen()?.onObjectChanged?.();
    expect(sender.sent.at(-1)?.payload).toEqual({
      sessionId: openPayload.sessionId,
      ...DOCUMENT,
      typingUnresolved: false, ...engineSaveState("object-changed"),
      seq: 0,
    });
    expect(
      h.ipc.applyUpdate(sender, {
        sessionId: openPayload.sessionId,
        update: new Uint8Array([2]),
        lineageGeneration: 1, requestId: "11111111-1111-4111-8111-111111111111",
        seq: 6,
      }),
    ).toEqual({ accepted: false, reason: "object-changed" });
    expect(h.session.applyLocalUpdate).not.toHaveBeenCalled();
  });

  it("moves pinned artifact authority only when the lineage is acknowledged", async () => {
    const losing = asset("shared", "assets/losing.png");
    const winner = asset("shared", "assets/winner.png");
    const session = providerSession({ artifactAssets: [losing] });
    const sender = new FakeSender(7);
    const h = harness(session);
    await h.ipc.open(sender, openPayload);

    Object.defineProperty(session, "artifactAssets", { value: [winner] });
    h.capturedOpen()?.onLineageReplaced?.(
      new Uint8Array([9]),
      ["recovered/losing.md"],
    );
    h.capturedOpen()?.onRemoteUpdate(new Uint8Array([8]));

    expect(sender.sent.at(-1)?.payload).toMatchObject({
      sessionId: openPayload.sessionId,
      update: new Uint8Array([9]),
      recoveredPaths: ["recovered/losing.md"],
      artifactAssets: [winner],
      lineageGeneration: 2,
    });
    await expect(
      h.ipc.readArtifactAsset(sender, {
        sessionId: openPayload.sessionId,
        descriptor: losing,
      }),
    ).resolves.toMatchObject({ descriptor: losing });

    expect(
      h.ipc.acknowledgeLineageReplacement(sender, {
        sessionId: openPayload.sessionId,
        lineageGeneration: 2,
      }),
    ).toEqual({ accepted: true, updates: [new Uint8Array([8])] });
    expect(
      h.ipc.acknowledgeLineageReplacement(sender, {
        sessionId: openPayload.sessionId,
        lineageGeneration: 2,
      }),
    ).toEqual({ accepted: false, reason: "lineage-transition" });
    await expect(
      h.ipc.readArtifactAsset(sender, {
        sessionId: openPayload.sessionId,
        descriptor: winner,
      }),
    ).resolves.toMatchObject({ descriptor: winner });
    await expect(
      h.ipc.readArtifactAsset(sender, {
        sessionId: openPayload.sessionId,
        descriptor: losing,
      }),
    ).resolves.toMatchObject({ descriptor: losing });
  });

  it("derives asset access from the exact sender, generation, and pinned descriptor", async () => {
    const pinned = asset("image");
    const sender = new FakeSender(7);
    const foreign = new FakeSender(7);
    const h = harness(providerSession({ artifactAssets: [pinned] }));
    await h.ipc.open(sender, openPayload);

    await expect(
      h.ipc.readArtifactAsset(foreign, {
        sessionId: openPayload.sessionId,
        descriptor: pinned,
      }),
    ).rejects.toThrow("no longer available");
    await expect(
      h.ipc.readArtifactAsset(sender, {
        sessionId: openPayload.sessionId,
        descriptor: { ...pinned, sha256: "b".repeat(64) },
      }),
    ).rejects.toThrow("does not reference artifact asset image");

    h.ipc
      .fileMutationPort()
      .markDeletedUnderPath(AUTHORITY_ID, "notes/a.md");
    await expect(
      h.ipc.readArtifactAsset(sender, {
        sessionId: openPayload.sessionId,
        descriptor: pinned,
      }),
    ).resolves.toMatchObject({ descriptor: pinned });

    h.setGeneration(2);
    await expect(
      h.ipc.readArtifactAsset(sender, {
        sessionId: openPayload.sessionId,
        descriptor: pinned,
      }),
    ).rejects.toThrow("no longer available");
  });

  it("keeps a failed release read-only and retries it by workspace path", async () => {
    let releaseFails = true;
    const close = vi.fn(async () => {
      if (releaseFails) throw new Error("daemon retained the session");
    });
    const sender = new FakeSender(7);
    const h = harness(providerSession({ close }));
    await expect(h.ipc.open(sender, openPayload)).resolves.toMatchObject({
      available: true,
    });
    await h.ipc.close(sender, { sessionId: openPayload.sessionId });

    await expect(
      h.ipc.open(sender, { ...openPayload, sessionId: "retry-session" }),
    ).resolves.toEqual({ available: false, engineMayHoldDocument: true });
    expect(h.capture.openYDocSession).toHaveBeenCalledTimes(1);

    releaseFails = false;
    await expect(
      h.ipc.open(sender, { ...openPayload, sessionId: "retry-session-2" }),
    ).resolves.toMatchObject({ available: true });
    expect(h.capture.openYDocSession).toHaveBeenCalledTimes(2);
  });

  it("keeps duplicate document opens read-only until the owner releases them", async () => {
    const sender = new FakeSender(7);
    const openStarted = deferred<void>();
    const engineOpen = deferred<WorkspaceEngineYDocProviderSession>();
    const closeStarted = deferred<void>();
    const closeGate = deferred<void>();
    const close = vi.fn(async () => {
      closeStarted.resolve();
      await closeGate.promise;
    });
    const capture: EngineYDocSessionCapture = {
      openYDocSession: vi.fn(() => {
        openStarted.resolve();
        return engineOpen.promise;
      }),
    };
    const ipc = createEngineYDocSessionIpc({
      localPersonId: () => "person-local",
      sessionFor: () => rendererSession(),
      acquireWorkspace: workspaceAuthority,
      captureFor: () => capture,
      ensureCaptureFor: vi.fn(async () => undefined),
      isSharedView: () => false,
      resolveDocumentPath: async (_workspace, path) => path,
      onError: vi.fn(),
    });

    const opening = ipc.open(sender, openPayload);
    await openStarted.promise;
    await expect(
      ipc.open(sender, { ...openPayload, sessionId: "while-opening" }),
    ).resolves.toEqual({
      available: false,
      engineMayHoldDocument: true,
    });

    engineOpen.resolve(providerSession({ close }));
    await expect(opening).resolves.toMatchObject({ available: true });
    await expect(
      ipc.open(sender, { ...openPayload, sessionId: "while-open" }),
    ).resolves.toEqual({
      available: false,
      engineMayHoldDocument: true,
    });

    const closing = ipc.close(sender, { sessionId: openPayload.sessionId });
    await closeStarted.promise;
    const replacement = ipc.open(sender, {
      ...openPayload,
      sessionId: "after-release",
    });
    expect(capture.openYDocSession).toHaveBeenCalledTimes(1);

    closeGate.resolve();
    await closing;
    await expect(replacement).resolves.toMatchObject({ available: true });
    expect(capture.openYDocSession).toHaveBeenCalledTimes(2);
  });

  it("maps domain open refusals to the bridge contract", async () => {
    const sender = new FakeSender(7);
    const cases: Array<[unknown, object]> = [
      [
        new YDocPathNotInVersionError("notes/a.md", "version-2"),
        { available: false, notInVersion: true },
      ],
      [
        new YDocRemovalInProgressError(
          "notes/a.md",
          "A move is in progress.",
          "open",
          "move",
        ),
        {
          available: false,
          removalInProgress: {
            operation: "move",
            message: "A move is in progress.",
          },
        },
      ],
      [
        new YDocSessionUnreleasedError("notes/a.md", new Error("held")),
        { available: false, engineMayHoldDocument: true },
      ],
      [
        new DaemonRefusalError(
          {
            code: "OVERLOADED",
            message: "Workspace is still updating. Try again.",
            retry: "afterBackoff",
          },
          undefined,
        ),
        { available: false, engineMayHoldDocument: true },
      ],
      [
        {
          wireError: {
            code: "INTERNAL",
            message: "ydoc-artifact-assets-invalid",
          },
        },
        { available: false, artifactAssetsInvalid: true },
      ],
    ];

    for (const [error, expected] of cases) {
      const capture: EngineYDocSessionCapture = {
        openYDocSession: vi.fn(async () => {
          throw error;
        }),
      };
      const ipc = createEngineYDocSessionIpc({
        localPersonId: () => "person-local",
        sessionFor: () => rendererSession(),
        acquireWorkspace: workspaceAuthority,
        captureFor: () => capture,
        ensureCaptureFor: vi.fn(async () => undefined),
        isSharedView: () => false,
        resolveDocumentPath: async (_workspace, path) => path,
        onError: vi.fn(),
      });
      await expect(ipc.open(sender, openPayload)).resolves.toEqual(expected);
    }
  });

  it("refuses shared, unclassified, and invalid paths before opening a session", async () => {
    const sender = new FakeSender(7);
    const shared = harness();
    shared.setReadOnly(true);
    await expect(shared.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
    });
    expect(shared.capture.openYDocSession).not.toHaveBeenCalled();

    const ordinary = harness();
    await expect(
      ordinary.ipc.open(sender, { ...openPayload, path: "notes/a.bin" }),
    ).resolves.toEqual({ available: false });
    await expect(
      ordinary.ipc.open(sender, { ...openPayload, path: "../escape.md" }),
    ).resolves.toEqual({ available: false });
    expect(ordinary.capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("retires a pending open through the central sender-retirement adapter", async () => {
    const sender = new FakeSender(7);
    const openStarted = deferred<void>();
    const engineOpen = deferred<WorkspaceEngineYDocProviderSession>();
    const close = vi.fn(async () => undefined);
    const capture: EngineYDocSessionCapture = {
      openYDocSession: vi.fn(() => {
        openStarted.resolve();
        return engineOpen.promise;
      }),
    };
    const ipc = createEngineYDocSessionIpc({
      localPersonId: () => "person-local",
      sessionFor: () => rendererSession(),
      acquireWorkspace: workspaceAuthority,
      captureFor: () => capture,
      ensureCaptureFor: vi.fn(async () => undefined),
      isSharedView: () => false,
      resolveDocumentPath: async (_workspace, path) => path,
      onError: vi.fn(),
    });

    const opening = ipc.open(sender, openPayload);
    await openStarted.promise;
    const retirement = ipc.retireSender(sender, 1);
    engineOpen.resolve(providerSession({ close }));

    await expect(opening).resolves.toEqual({ available: false });
    await retirement;
    expect(close).toHaveBeenCalledWith(undefined);
  });

  it("does not create a session after physical authority retires during capture startup", async () => {
    const sender = new FakeSender(7);
    const attachmentId = Symbol("attachment-a");
    const captureStarted = deferred<void>();
    const captureGate = deferred<void>();
    let captureAvailable = false;
    let authorityCurrent = true;
    const capture: EngineYDocSessionCapture = {
      openYDocSession: vi.fn(async () => providerSession()),
    };
    const authority = {
      workspace: {
        workspaceId: openPayload.workspaceId,
        rootPath: "C:/workspace",
        attachmentId,
      },
      assertCurrent: vi.fn(() => {
        if (!authorityCurrent) {
          throw new Error("workspace attachment is no longer current");
        }
      }),
      release: vi.fn(),
    };
    const ipc = createEngineYDocSessionIpc({
      localPersonId: () => "person-local",
      sessionFor: () => rendererSession(),
      acquireWorkspace: () => authority,
      captureFor: () => (captureAvailable ? capture : null),
      ensureCaptureFor: vi.fn(async () => {
        captureStarted.resolve();
        await captureGate.promise;
        captureAvailable = true;
      }),
      isSharedView: () => false,
      resolveDocumentPath: async (_workspace, path) => path,
      onError: vi.fn(),
    });

    const opening = ipc.open(sender, openPayload);
    await captureStarted.promise;
    authorityCurrent = false;
    captureGate.resolve();

    await expect(opening).rejects.toThrow(
      "workspace attachment is no longer current",
    );
    expect(capture.openYDocSession).not.toHaveBeenCalled();
    expect(authority.release).toHaveBeenCalledOnce();
  });

  it("drops stale-generation output and releases an unannounced lineage", async () => {
    const close = vi.fn(async () => undefined);
    const sender = new FakeSender(7);
    const h = harness(providerSession({ close }));
    await h.ipc.open(sender, openPayload);
    sender.sent.length = 0;

    h.setGeneration(2);
    h.capturedOpen()?.onRemoteUpdate(new Uint8Array([1]));
    h.capturedOpen()?.onLineageReplaced?.(new Uint8Array([2]), []);

    expect(sender.sent).toEqual([]);
    expect(close).toHaveBeenCalledWith(undefined);
    expect(
      h.ipc.applyUpdate(sender, {
        sessionId: openPayload.sessionId,
        update: new Uint8Array([3]),
        lineageGeneration: 1, requestId: "11111111-1111-4111-8111-111111111111",
        seq: 1,
      }),
    ).toEqual({ accepted: false, reason: "session-unavailable" });
  });

  describe("main-side document edits", () => {
    const agentOrigin = {
      actorOriginId: "claude-code",
      attribution: { actorKind: "agent" as const, onBehalfOf: "local", depth: 0 },
    };
    type SettleResult = Awaited<ReturnType<WorkspaceEngineYDocProviderSession["settleNow"]>>;

    // A session over a real document: an applied update lands in its doc, the
    // way the capture's canonical doc takes a journaled update.
    function editableSession(trace: string[] = [], markdown = "# Plan\n\nBefore.") {
      const doc = markdownToYDoc(markdown);
      return providerSession({
        doc,
        applyDecidedLocalUpdate: vi.fn(async (decide, onArmed) => {
          const update = decide(doc);
          if (update === null) return false;
          trace.push("apply");
          Y.applyUpdate(doc, update);
          onArmed?.();
          return true;
        }),
        settleNow: vi.fn(async () => {
          trace.push("settle");
          return { materialized: true } as SettleResult;
        }),
        close: vi.fn(async () => {
          trace.push("close");
        }),
      });
    }

    const pendingDraft = { binding: { workspaceId: "workspace-1", mainVersionId: "main", objectId: "object",
      lineageClaimId: "a".repeat(64), currentPath: "notes/a.md", selectorPaths: ["notes/a.md"], restoreFenceGeneration: 0 },
      relayDatabaseNamespace: "relay", revision: 1, acceptedCursor: 0, nativeHeadSequence: 1,
      nativeUnsettled: true, outboxId: "outbox", pendingBytes: 10, state: "active" as const };

    const keepBlocksSeen: boolean[] = [];
    const edit = (documentEdit: DocumentEdit) => ({
      workspaceId: "workspace-1",
      path: "notes/a.md",
      origin: agentOrigin,
      assertEditable: async () => undefined,
      change: async (state: Uint8Array, { keepBlocks }: { keepBlocks: boolean }) => {
        keepBlocksSeen.push(keepBlocks);
        return documentEditUpdate(state, documentEdit, { keepBlocks });
      },
    });
    const append = edit({ replacement: "After." });

    it("refuses a lossy note before it opens a session or changes the held one", async () => {
      const session = editableSession();
      const h = harness(session);
      const refusal = new Error("dohc can't change notes/a.md without also changing parts it can't show.");
      const refused = { ...append, assertEditable: vi.fn(async () => { throw refusal; }) };

      await expect(h.ipc.editDocument(refused)).rejects.toBe(refusal);
      expect(refused.assertEditable).toHaveBeenCalledWith("notes/a.md");
      expect(h.capture.openYDocSession).not.toHaveBeenCalled();

      await h.ipc.open(new FakeSender(7), openPayload);
      await expect(h.ipc.editDocument(refused)).rejects.toBe(refusal);
      expect(session.applyLocalUpdate).not.toHaveBeenCalled();
      expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toBe("# Plan\n\nBefore.");
    });

    it("applies the edit through the editor that holds the document and shows it there", async () => {
      const sender = new FakeSender(7);
      const session = editableSession();
      const h = harness(session);
      const opened = await h.ipc.open(sender, openPayload);
      const editor = new Y.Doc();
      Y.applyUpdate(editor, opened.initialUpdate!);
      keepBlocksSeen.length = 0;

      await expect(h.ipc.editDocument(append)).resolves.toEqual({ path: "notes/a.md", changed: true, warning: DOCUMENT_EDIT_SHARED_WARNING });

      expect(keepBlocksSeen).toEqual([true]);
      expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toBe("# Plan\n\nBefore.\n\nAfter.");
      expect(session.applyDecidedLocalUpdate).toHaveBeenCalledWith(
        expect.any(Function), undefined, { ...agentOrigin, idempotencyKey: expect.any(String) },
      );
      expect(session.settleNow).toHaveBeenCalledOnce();
      expect(h.capture.openYDocSession).toHaveBeenCalledOnce();
      const shown = sender.sent.filter(({ channel }) => channel === CHANNELS.engineYDocRemoteUpdate);
      expect(shown).toHaveLength(1);
      const payload = shown[0]!.payload as { sessionId: string; update: Uint8Array; lineageGeneration: number };
      expect(payload).toMatchObject({ sessionId: openPayload.sessionId, lineageGeneration: 1 });
      Y.applyUpdate(editor, payload.update);
      expect(documentMarkdown(Y.encodeStateAsUpdate(editor))).toBe("# Plan\n\nBefore.\n\nAfter.");
      await h.ipc.shutdown();
    });

    // The person turns the paragraph into a heading while the agent's text
    // goes into it. The merge keeps the heading, and the agent's text goes
    // with the paragraph it was typed into, so the agent must not hear the
    // edit landed.
    it("tells the agent when a person's change to the block took the edit's text", async () => {
      const session = editableSession();
      const h = harness(session);
      await h.ipc.open(new FakeSender(7), openPayload);
      const heading = documentEditUpdate(
        Y.encodeStateAsUpdate(session.doc),
        { find: "Before.", replacement: "## Before." },
        { keepBlocks: false },
      )!;
      vi.mocked(session.settleNow).mockImplementationOnce(async () => {
        Y.applyUpdate(session.doc, heading);
        return { materialized: true } as SettleResult;
      });

      const lost = h.ipc.editDocument(edit({ find: "Before.", replacement: "Before and after." }));
      await expect(lost).rejects.toThrow("some or all of its text is not in notes/a.md");
      // The edit reached the document, so a resent request must not apply it again.
      await expect(lost).rejects.toBeInstanceOf(LiveDocumentEditAppliedError);
      expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toBe("# Plan\n\n## Before.");

      // Typing elsewhere at the same moment leaves the edit's text in place.
      const typed = new Y.Doc();
      Y.applyUpdate(typed, Y.encodeStateAsUpdate(session.doc));
      const otherBlock = documentEditUpdate(
        Y.encodeStateAsUpdate(typed),
        { find: "# Plan", replacement: "# Plan for May" },
        { keepBlocks: true },
      )!;
      vi.mocked(session.settleNow).mockImplementationOnce(async () => {
        Y.applyUpdate(session.doc, otherBlock);
        return { materialized: true } as SettleResult;
      });
      await expect(h.ipc.editDocument(edit({ find: "## Before.", replacement: "## Before noon." })))
        .resolves.toEqual({ path: "notes/a.md", changed: true, warning: DOCUMENT_EDIT_SHARED_WARNING });
      expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toBe("# Plan for May\n\n## Before noon.");
      await h.ipc.shutdown();
    });

    // The person backspaces over part of the agent's text as it lands. The
    // edit landed and was then edited, so the agent hears it landed; being
    // told to redo it would add the text a second time.
    it("reports an edit the person then edited as landed", async () => {
      const session = editableSession();
      const h = harness(session);
      await h.ipc.open(new FakeSender(7), openPayload);
      vi.mocked(session.settleNow).mockImplementationOnce(async () => {
        const backspace = documentEditUpdate(
          Y.encodeStateAsUpdate(session.doc),
          { find: "Before and after.", replacement: "Before and afte." },
          { keepBlocks: true },
        )!;
        Y.applyUpdate(session.doc, backspace);
        return { materialized: true } as SettleResult;
      });

      await expect(h.ipc.editDocument(edit({ find: "Before.", replacement: "Before and after." })))
        .resolves.toEqual({ path: "notes/a.md", changed: true, warning: DOCUMENT_EDIT_SHARED_WARNING });
      expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toBe("# Plan\n\nBefore and afte.");
      await h.ipc.shutdown();
    });

    it("refuses an edit that would remove a block the person may be typing in", async () => {
      const session = editableSession();
      const h = harness(session);
      await h.ipc.open(new FakeSender(7), openPayload);
      await expect(h.ipc.editDocument(edit({ find: "Before.", replacement: "# Before." })))
        .rejects.toThrow("this edit would remove a block");
      expect(session.applyLocalUpdate).not.toHaveBeenCalled();
      await h.ipc.shutdown();
    });

    it("applies nothing when the editor's session changes while the edit is computed", async () => {
      const session = editableSession();
      const h = harness(session);
      await h.ipc.open(new FakeSender(7), openPayload);
      const computing = deferred<void>();
      const release = deferred<void>();
      const editing = h.ipc.editDocument({
        ...append,
        change: async (state, options) => {
          computing.resolve();
          await release.promise;
          return documentEditUpdate(state, { replacement: "After." }, options);
        },
      });
      await computing.promise;
      h.capturedOpen()?.onLineageReplaced?.(Y.encodeStateAsUpdate(markdownToYDoc("Winner.")), []);
      release.resolve();
      await expect(editing).rejects.toThrow("changed hands while dohc prepared the edit, and nothing changed");
      expect(session.applyLocalUpdate).not.toHaveBeenCalled();
      await h.ipc.shutdown();
    });

    it("opens a session for the edit alone when no editor holds the document", async () => {
      const trace: string[] = [];
      const session = editableSession(trace);
      const h = harness(session);
      keepBlocksSeen.length = 0;

      await expect(h.ipc.editDocument(edit({ find: "Before.", replacement: "# Before." }))).resolves.toEqual({
        path: "notes/a.md",
        changed: true,
      });

      // Nobody can type in it, so a block may change kind.
      expect(keepBlocksSeen).toEqual([false]);
      expect(trace).toEqual(["apply", "settle", "close"]);
      expect(h.capturedOpen()).toMatchObject({ path: "notes/a.md", contentKind: "richdoc" });
      expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toBe("# Plan\n\n# Before.");
    });

    it("keeps blocks in a synced document no editor here holds, since another device may be typing", async () => {
      const session = Object.assign(editableSession(), { lineageClaimId: "claim-1" });
      const h = harness(session);
      keepBlocksSeen.length = 0;
      await expect(h.ipc.editDocument(edit({ find: "Before.", replacement: "# Before." })))
        .rejects.toThrow("this edit would remove a block");
      expect(keepBlocksSeen).toEqual([true]);
      expect(session.applyLocalUpdate).not.toHaveBeenCalled();
      expect(session.close).toHaveBeenCalledOnce();
    });

    it("runs two edits to one document in turn, so the second reads the first one's result", async () => {
      const session = editableSession([], "Budget: 400 dollars");
      const h = harness(session);
      await h.ipc.open(new FakeSender(7), openPayload);
      const first = h.ipc.editDocument(edit({ find: "400", replacement: "450" }));
      const second = h.ipc.editDocument(edit({ find: "400", replacement: "500" }));
      await expect(first).resolves.toEqual({ path: "notes/a.md", changed: true, warning: DOCUMENT_EDIT_SHARED_WARNING });
      await expect(second).rejects.toThrow("not in the document");
      expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toBe("Budget: 450 dollars");
      await h.ipc.shutdown();
    });

    it("reports a saved edit as done when only the session's release fails", async () => {
      const trace: string[] = [];
      const session = editableSession(trace);
      vi.mocked(session.close).mockRejectedValueOnce(new Error("release refused"));
      const h = harness(session);
      await expect(h.ipc.editDocument(append)).resolves.toEqual({ path: "notes/a.md", changed: true });
      expect(trace).toEqual(["apply", "settle"]);
      expect(h.onError).toHaveBeenCalledWith(
        expect.stringContaining("close after an edit failed for notes/a.md"),
        expect.objectContaining({ message: "release refused" }),
      );
    });

    it("keeps an editor that opens during the edit waiting until the edit's session closes", async () => {
      const trace: string[] = [];
      const editSession = editableSession(trace);
      const released = deferred<void>();
      const resolveDocumentPath = vi.fn(async (_workspace: unknown, path: string) => path);
      const h = harness(editSession, { resolveDocumentPath });
      vi.mocked(editSession.settleNow).mockImplementationOnce(async () => {
        trace.push("settle");
        await released.promise;
        return { materialized: true } as SettleResult;
      });
      vi.mocked(h.capture.openYDocSession)
        .mockImplementationOnce(async () => editSession)
        .mockImplementationOnce(async () => {
          trace.push("editor-open");
          return providerSession();
        });
      const editing = h.ipc.editDocument(append);
      await vi.waitFor(() => expect(trace).toContain("settle"));

      const opening = h.ipc.open(new FakeSender(7), openPayload);
      // The open resolves its path, then reaches the reservation. Drain the
      // queue so an open that did not wait would already be in the capture.
      await vi.waitFor(() => expect(resolveDocumentPath).toHaveBeenCalledTimes(2));
      await new Promise((drained) => setImmediate(drained));
      expect(trace).toEqual(["apply", "settle"]);

      released.resolve();
      await editing;
      await expect(opening).resolves.toMatchObject({ available: true });
      expect(trace).toEqual(["apply", "settle", "close", "editor-open"]);
      await h.ipc.shutdown();
    });

    it("refuses with a retryable reason when an editor opens as the edit begins", async () => {
      const session = editableSession();
      const h = harness(session);
      // The editor's open holds the document's reservation when the edit asks
      // for it.
      const opening = deferred<WorkspaceEngineYDocProviderSession>();
      vi.mocked(h.capture.openYDocSession).mockImplementationOnce(async () => await opening.promise);
      const opened = h.ipc.open(new FakeSender(7), openPayload);
      await vi.waitFor(() => expect(h.capture.openYDocSession).toHaveBeenCalledOnce());
      await expect(h.ipc.editDocument(append)).rejects.toThrow(
        "notes/a.md opened in an editor as dohc began the edit, and nothing changed. Try again.",
      );
      opening.resolve(session);
      await opened;
      expect(session.applyLocalUpdate).not.toHaveBeenCalled();
      await h.ipc.shutdown();
    });

    it("tells the caller an edit is in the document when only its save failed", async () => {
      const session = editableSession();
      vi.mocked(session.settleNow).mockRejectedValueOnce(new Error("disk full"));
      const h = harness(session);
      await expect(h.ipc.editDocument(append)).rejects.toThrow(
        "The edit is in notes/a.md, but dohc has not saved it to the file yet (disk full). Read the document before you retry.",
      );
      expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toContain("After.");
      expect(session.close).toHaveBeenCalledOnce();
    });

    it.each([[false, "active"], [true, "active"], [false, "sealed"], [true, "sealed"]] as const)("reports an admitted pending edit as success, held=%s state=%s", async (held, state) => {
      const session = editableSession();
      const pending = new YdocOwnerDraftPendingError({ ...pendingDraft, state });
      vi.mocked(session.settleNow).mockRejectedValueOnce(pending);
      const h = harness(session);
      if (held) await h.ipc.open(new FakeSender(7), openPayload);
      await expect(h.ipc.editDocument(append)).resolves.toEqual({
        path: "notes/a.md", changed: true, warning: held
          ? `${DOCUMENT_EDIT_PENDING_WARNING} ${DOCUMENT_EDIT_SHARED_WARNING}` : DOCUMENT_EDIT_PENDING_WARNING,
      });
      expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toContain("After.");
      expect(session.applyLocalUpdate).not.toHaveBeenCalled();
      await h.ipc.shutdown();
    });

    it.each(["sealed", "frozen", "uncertain"])('does not report a refused edit as kept when an older draft is %s', async reason => {
      const session = editableSession();
      const refusal = new Error(reason);
      vi.mocked(session.applyDecidedLocalUpdate).mockImplementationOnce(async (_decide, armed) => {
        armed?.();
        throw refusal;
      });
      vi.mocked(session.settleNow).mockRejectedValue(new YdocOwnerDraftPendingError(pendingDraft));
      const h = harness(session);
      await expect(h.ipc.editDocument(append)).rejects.toBe(refusal);
      expect(session.settleNow).not.toHaveBeenCalled();
      expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).not.toContain("After.");
    });

    it("checks the held session again when the admission decision runs", async () => {
      const session = editableSession();
      const h = harness(session);
      await h.ipc.open(new FakeSender(7), openPayload);
      vi.mocked(session.applyDecidedLocalUpdate).mockImplementationOnce(async decide => {
        h.capturedOpen()?.onLineageReplaced?.(Y.encodeStateAsUpdate(markdownToYDoc("Winner.")), []);
        decide(session.doc);
        return true;
      });
      await expect(h.ipc.editDocument(append)).rejects.toThrow("changed hands");
      expect(session.settleNow).not.toHaveBeenCalled();
      await h.ipc.shutdown();
    });

    it("reports no change without applying or settling", async () => {
      const session = editableSession();
      const h = harness(session);
      await expect(
        h.ipc.editDocument({ ...append, change: async () => null }),
      ).resolves.toEqual({ path: "notes/a.md", changed: false });
      expect(session.applyLocalUpdate).not.toHaveBeenCalled();
      expect(session.settleNow).not.toHaveBeenCalled();
      expect(session.close).toHaveBeenCalledOnce();
    });

    it("refuses shared views, scenes, and missing documents before opening a session", async () => {
      const h = harness(editableSession(), {
        resolveDocumentPath: async (_workspace, path) => (path === "gone.md" ? null : path),
      });
      await expect(h.ipc.editDocument({ ...append, path: "board.excalidraw" }))
        .rejects.toThrow("not a Markdown document");
      await expect(h.ipc.editDocument({ ...append, path: "gone.md" }))
        .rejects.toThrow("No document at gone.md");
      h.setReadOnly(true);
      await expect(h.ipc.editDocument(append))
        .rejects.toThrow("shared view");
      expect(h.capture.openYDocSession).not.toHaveBeenCalled();
    });

    it("reads the held document's state, or nothing when no editor holds it", async () => {
      const session = editableSession();
      const h = harness(session);
      await expect(h.ipc.readDocument({ workspaceId: "workspace-1", path: "notes/a.md" }))
        .resolves.toEqual({ path: "notes/a.md", state: null });

      await h.ipc.open(new FakeSender(7), openPayload);
      const read = await h.ipc.readDocument({ workspaceId: "workspace-1", path: "notes/a.md" });
      expect(documentMarkdown(read.state!)).toBe("# Plan\n\nBefore.");
      await h.ipc.shutdown();
    });
  });

  it("releases pending work on sender retirement and uses shuttingDown only for quit", async () => {
    const sender = new FakeSender(7);
    const close = vi.fn(async () => undefined);
    const h = harness(providerSession({ close }));
    await h.ipc.open(sender, openPayload);

    await h.ipc.retireSender(sender, 1);
    expect(close).toHaveBeenCalledWith(undefined);

    h.setGeneration(2);
    await h.ipc.open(sender, { ...openPayload, sessionId: "second" });
    await h.ipc.shutdown();
    expect(close).toHaveBeenLastCalledWith({ shuttingDown: true });
  });
});
