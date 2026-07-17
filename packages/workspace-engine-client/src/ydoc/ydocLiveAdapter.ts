import * as Y from "yjs";
import type { Event } from "./generated/Event";
import type { Request } from "./generated/Request";
import type { Response } from "./generated/Response";
import type { WorkspaceHandle } from "./generated/WorkspaceHandle";
import {
  YDOC_EVENT,
  YDOC_METHOD,
  decodeYdocCloseResult,
  decodeYdocExternalEditResult,
  decodeYdocOpenResult,
  decodeYdocRecordUpdateResult,
  decodeYdocRemoteUpdatePayload,
  decodeYdocSettleResult,
  type YdocApplyExternalMarkdownEditParams,
  type YdocApplyExternalMarkdownEditResult,
  type YdocCloseParams,
  type YdocContentKind,
  type YdocOpenParams,
  type YdocRecordUpdateParams,
  type YdocRecordUpdateResult,
  type YdocSettleParams,
  type YdocSettleResult,
} from "./ydocWireContract";

export const LOCAL_EDITOR_ORIGIN: unique symbol = Symbol(
  "dohc.workspaceEngineClient.localEditorOrigin",
);

export const ENGINE_DELIVERED_ORIGIN: unique symbol = Symbol(
  "dohc.workspaceEngineClient.engineDeliveredOrigin",
);

export interface EngineTransport {
  sendRequest(request: Request): Promise<Response>;
  onEvent(handler: (event: Event) => void): () => void;
}

export type YdocAdapterErrorCode =
  | "invalid-update"
  | "response-mismatch"
  | "resync-needed"
  | "session-closed"
  | "session-quarantined";

export class YdocAdapterError extends Error {
  readonly code: YdocAdapterErrorCode;

  constructor(code: YdocAdapterErrorCode, message: string) {
    super(message);
    this.name = "YdocAdapterError";
    this.code = code;
  }
}

export class IllFormedUtf16EditError extends YdocAdapterError {
  constructor() {
    super(
      "invalid-update",
      "The local Y.Doc edit contains ill-formed UTF-16 text or crosses a surrogate-pair boundary.",
    );
    this.name = "IllFormedUtf16EditError";
  }
}

export class YdocSessionQuarantinedError extends YdocAdapterError {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      "session-quarantined",
      "The Y.Doc session is quarantined after a local update could not be safely journaled.",
    );
    this.name = "YdocSessionQuarantinedError";
    this.cause = cause;
  }
}

export type YdocResyncReason =
  | "event-decode-failed"
  | "event-sequence-gap"
  | "session-generation-changed";

export class YdocResyncNeededError extends YdocAdapterError {
  readonly reason: YdocResyncReason;
  readonly event: Event;
  override readonly cause: unknown;

  constructor(input: {
    reason: YdocResyncReason;
    event: Event;
    cause?: unknown;
  }) {
    super(
      "resync-needed",
      `The Y.Doc session is stale (${input.reason}); engine resynchronization is required.`,
    );
    this.name = "YdocResyncNeededError";
    this.reason = input.reason;
    this.event = input.event;
    this.cause = input.cause;
  }
}

export class RemoteYdocApplyError extends YdocAdapterError {
  readonly attemptedUpdate: Uint8Array;
  readonly postAttemptStateUpdate: Uint8Array;
  override readonly cause: unknown;

  constructor(input: {
    attemptedUpdate: Uint8Array;
    postAttemptStateUpdate: Uint8Array;
    cause: unknown;
  }) {
    super(
      "invalid-update",
      "An engine-delivered Y.Doc update failed during local application.",
    );
    this.name = "RemoteYdocApplyError";
    this.attemptedUpdate = input.attemptedUpdate;
    this.postAttemptStateUpdate = input.postAttemptStateUpdate;
    this.cause = input.cause;
  }
}

export interface OpenYdocAdapterSessionInput {
  workspace: WorkspaceHandle;
  versionId: string;
  path: string;
  contentKind?: YdocContentKind;
}

export interface ApplyLocalUpdateOptions {
  actorOriginId?: string;
}

export interface YdocLocalTextEdit {
  root: "plainText";
  index: number;
  insert?: string;
  deleteLength?: number;
}

const ILL_FORMED_UTF16_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function isWellFormedUtf16(value: string): boolean {
  return typeof value.isWellFormed === "function"
    ? value.isWellFormed()
    : !ILL_FORMED_UTF16_PATTERN.test(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new YdocAdapterError("invalid-update", "Invalid base64 Y.Doc update.");
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function declareDohcRootSchema(doc: Y.Doc): void {
  doc.getMap("frontmatter");
  doc.getMap("meta");
  doc.getXmlFragment("body");
  doc.getText("plainText");
}

function visitJsonStrings(
  value: unknown,
  visitor: (value: string) => void,
): void {
  if (typeof value === "string") {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitJsonStrings(item, visitor);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      visitor(key);
      visitJsonStrings(item, visitor);
    }
  }
}

function visitDeltaStrings(
  text: Y.Text | Y.XmlText,
  visitor: (value: string) => void,
): void {
  for (const operation of text.toDelta()) {
    if (typeof operation.insert === "string") {
      visitor(operation.insert);
    } else {
      visitJsonStrings(operation.insert, visitor);
    }
    for (const [key, value] of Object.entries(operation.attributes ?? {})) {
      visitor(key);
      visitJsonStrings(value, visitor);
    }
  }
}

function visitSharedValueStrings(
  value: unknown,
  visitor: (value: string) => void,
): void {
  if (value instanceof Y.XmlText || value instanceof Y.Text) {
    visitDeltaStrings(value, visitor);
    return;
  }
  if (value instanceof Y.XmlElement) {
    for (const [key, attribute] of Object.entries(value.getAttributes())) {
      visitor(key);
      if (attribute !== undefined) visitor(attribute);
    }
    for (const child of value.toArray()) {
      visitSharedValueStrings(child, visitor);
    }
    return;
  }
  if (value instanceof Y.XmlFragment) {
    for (const child of value.toArray()) {
      visitSharedValueStrings(child, visitor);
    }
    return;
  }
  if (value instanceof Y.Map) {
    visitJsonStrings(value.toJSON(), visitor);
    return;
  }
  if (value instanceof Y.Array) {
    for (const item of value.toArray()) {
      visitSharedValueStrings(item, visitor);
    }
    return;
  }
  visitJsonStrings(value, visitor);
}

interface RootUtf16Snapshot {
  readonly strings: readonly string[];
  readonly replacementCount: number;
}

type DocUtf16Snapshot = ReadonlyMap<string, RootUtf16Snapshot>;

function snapshotDocUtf16(doc: Y.Doc): DocUtf16Snapshot {
  const snapshot = new Map<string, RootUtf16Snapshot>();
  for (const [root, value] of doc.share) {
    const strings: string[] = [root];
    visitSharedValueStrings(value, (item) => strings.push(item));
    snapshot.set(root, {
      strings,
      replacementCount: strings.reduce(
        (count, item) => count + [...item].filter((unit) => unit === "�").length,
        0,
      ),
    });
  }
  return snapshot;
}

function assertDocUtf16IsSafe(
  doc: Y.Doc,
  before: DocUtf16Snapshot,
): void {
  const after = snapshotDocUtf16(doc);
  for (const [root, current] of after) {
    for (const value of current.strings) {
      if (!isWellFormedUtf16(value)) throw new IllFormedUtf16EditError();
    }

    // Opaque Yjs mutations do not expose their intended UTF-16 boundaries.
    // A net-new literal U+FFFD is conservatively rejected because it is also
    // how Yjs exposes a split surrogate pair (cross_engine.rs:264).
    // R11a/R13 OBLIGATION: retain the engine replay-parity gate for arbitrary
    // opaque splits that no live TypeScript scan can reconstruct.
    if (
      current.replacementCount > (before.get(root)?.replacementCount ?? 0)
    ) {
      throw new IllFormedUtf16EditError();
    }
  }
}

function isInsideSurrogatePair(value: string, index: number): boolean {
  if (index <= 0 || index >= value.length) return false;
  const previous = value.charCodeAt(index - 1);
  const current = value.charCodeAt(index);
  return (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function assertTextEditIsValid(text: string, edit: YdocLocalTextEdit): void {
  const deleteLength = edit.deleteLength ?? 0;
  if (
    !Number.isSafeInteger(edit.index) ||
    edit.index < 0 ||
    !Number.isSafeInteger(deleteLength) ||
    deleteLength < 0 ||
    edit.index + deleteLength > text.length
  ) {
    throw new YdocAdapterError(
      "invalid-update",
      "The local Y.Text edit range is outside the current UTF-16 content.",
    );
  }
  if (edit.insert !== undefined && !isWellFormedUtf16(edit.insert)) {
    throw new IllFormedUtf16EditError();
  }
  if (
    isInsideSurrogatePair(text, edit.index) ||
    isInsideSurrogatePair(text, edit.index + deleteLength)
  ) {
    throw new IllFormedUtf16EditError();
  }
}

interface LocalRecordCapture {
  readonly options: ApplyLocalUpdateOptions | undefined;
  readonly before: DocUtf16Snapshot;
  operation?: Promise<YdocRecordUpdateResult>;
  rejection?: Error;
}

export class YdocAdapterSession {
  readonly doc: Y.Doc;
  readonly initialUpdate: Uint8Array;
  readonly objectId: string;
  readonly path: string;
  readonly contentKind: YdocContentKind;
  readonly workspace: WorkspaceHandle;
  readonly sessionId: string;

  private readonly adapter: YdocLiveAdapter;
  private closed = false;
  private lastSettledSha: string | null = null;
  private recordChain: Promise<void> = Promise.resolve();
  private activeLocalRecordCapture: LocalRecordCapture | null = null;
  // Contract: an observer-detected local hazard is reject-and-quarantine.
  // Structured text edits reject before a transaction and do not quarantine.
  private quarantinedError: YdocSessionQuarantinedError | null = null;
  private staleError: YdocResyncNeededError | null = null;
  private nextLocalUpdateSeq = 1;
  private readonly remoteUpdateListeners = new Set<(update: Uint8Array) => void>();
  private readonly remoteApplyErrorListeners = new Set<
    (error: RemoteYdocApplyError) => void
  >();
  private readonly resyncNeededListeners = new Set<
    (error: YdocResyncNeededError) => void
  >();
  private readonly sessionErrorListeners = new Set<(error: unknown) => void>();

  constructor(
    adapter: YdocLiveAdapter,
    workspace: WorkspaceHandle,
    sessionId: string,
    input: {
      objectId: string;
      path: string;
      contentKind: YdocContentKind;
      initialUpdate: Uint8Array;
    },
  ) {
    this.adapter = adapter;
    this.workspace = workspace;
    this.sessionId = sessionId;
    this.objectId = input.objectId;
    this.path = input.path;
    this.contentKind = input.contentKind;
    this.initialUpdate = input.initialUpdate;
    this.doc = new Y.Doc();
    declareDohcRootSchema(this.doc);
    Y.applyUpdate(this.doc, this.initialUpdate, ENGINE_DELIVERED_ORIGIN);
    this.doc.on("update", this.handleDocUpdate);
  }

  canonicalSource(): "ydoc" {
    return "ydoc";
  }

  applyLocalUpdate(
    update: Uint8Array,
    options?: ApplyLocalUpdateOptions,
  ): Promise<YdocRecordUpdateResult | undefined> {
    return this.runLocalMutation(
      () => Y.applyUpdate(this.doc, update, LOCAL_EDITOR_ORIGIN),
      options,
    );
  }

  applyLocalEdit(
    mutator: (doc: Y.Doc) => void,
    options?: ApplyLocalUpdateOptions,
  ): Promise<YdocRecordUpdateResult | undefined> {
    return this.runLocalMutation(
      () => {
        this.doc.transact(() => mutator(this.doc), LOCAL_EDITOR_ORIGIN);
      },
      options,
    );
  }

  applyLocalTextEdit(
    edit: YdocLocalTextEdit,
    options?: ApplyLocalUpdateOptions,
  ): Promise<YdocRecordUpdateResult | undefined> {
    this.assertOpen();
    const text = this.doc.getText(edit.root);
    const current = text.toString();
    assertTextEditIsValid(current, edit);
    return this.runLocalMutation(
      () => {
        this.doc.transact(() => {
          const deleteLength = edit.deleteLength ?? 0;
          if (deleteLength > 0) text.delete(edit.index, deleteLength);
          if (edit.insert !== undefined && edit.insert.length > 0) {
            text.insert(edit.index, edit.insert);
          }
        }, LOCAL_EDITOR_ORIGIN);
      },
      options,
    );
  }

  private enqueueRecordUpdate(
    update: Uint8Array,
    options?: ApplyLocalUpdateOptions,
  ): Promise<YdocRecordUpdateResult> {
    const params: YdocRecordUpdateParams = {
      sessionId: this.sessionId,
      updateBase64: bytesToBase64(update),
      ...(options?.actorOriginId
        ? { actorOriginId: options.actorOriginId }
        : {}),
    };
    const idempotencyKey = `${this.sessionId}:${this.nextLocalUpdateSeq++}`;
    const operation = this.recordChain.then(async () =>
      decodeYdocRecordUpdateResult(
        await this.adapter.request(
          this.workspace,
          YDOC_METHOD.recordUpdate,
          params,
          { idempotencyKey },
        ),
      ),
    );
    const guardedOperation = operation.catch((error: unknown) => {
      this.quarantine(error);
      this.surfaceSessionError(error);
      throw error;
    });
    this.recordChain = guardedOperation.then(() => undefined);
    void this.recordChain.catch(() => undefined);
    void guardedOperation.catch(() => undefined);
    return guardedOperation;
  }

  async settle(options?: { summary?: string }): Promise<YdocSettleResult> {
    this.assertOpen();
    await this.recordChain;
    this.assertOpen();
    const params: YdocSettleParams = {
      sessionId: this.sessionId,
      ...(options?.summary ? { summary: options.summary } : {}),
    };
    const result = decodeYdocSettleResult(
      await this.adapter.request(this.workspace, YDOC_METHOD.settle, params),
    );
    this.lastSettledSha = result.sha256;
    return result;
  }

  async applyExternalMarkdownEdit(
    markdown: string,
  ): Promise<YdocApplyExternalMarkdownEditResult> {
    this.assertOpen();
    // Guard the JSON/Rust boundary with the same well-formedness check local
    // edits get: a lone surrogate cannot cross cleanly and would fail the
    // transport instead of rejecting locally (bot #3601684258).
    if (!isWellFormedUtf16(markdown)) throw new IllFormedUtf16EditError();
    // Flush pending local journals first so the engine merges the external
    // edit against the fully-recorded state, never a stale doc that a later
    // in-flight recordUpdate then reorders behind it (bot #3601684273).
    await this.recordChain;
    this.assertOpen();
    const params: YdocApplyExternalMarkdownEditParams = {
      sessionId: this.sessionId,
      markdown,
    };
    return decodeYdocExternalEditResult(
      await this.adapter.request(
        this.workspace,
        YDOC_METHOD.applyExternalMarkdownEdit,
        params,
      ),
    );
  }

  isSelfMaterializedSha(sha256: string): boolean {
    return this.lastSettledSha === sha256;
  }

  onRemoteUpdate(handler: (update: Uint8Array) => void): () => void {
    this.remoteUpdateListeners.add(handler);
    return () => this.remoteUpdateListeners.delete(handler);
  }

  onRemoteApplyError(handler: (error: RemoteYdocApplyError) => void): () => void {
    this.remoteApplyErrorListeners.add(handler);
    return () => this.remoteApplyErrorListeners.delete(handler);
  }

  onResyncNeeded(handler: (error: YdocResyncNeededError) => void): () => void {
    this.resyncNeededListeners.add(handler);
    return () => this.resyncNeededListeners.delete(handler);
  }

  onSessionError(handler: (error: unknown) => void): () => void {
    this.sessionErrorListeners.add(handler);
    return () => this.sessionErrorListeners.delete(handler);
  }

  currentStateUpdate(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  receiveRemoteUpdate(update: Uint8Array): void {
    if (this.closed || this.staleError !== null) return;
    try {
      Y.applyUpdate(this.doc, update, ENGINE_DELIVERED_ORIGIN);
    } catch (cause) {
      const error = new RemoteYdocApplyError({
        attemptedUpdate: update,
        postAttemptStateUpdate: Y.encodeStateAsUpdate(this.doc),
        cause,
      });
      this.notifyListeners(this.remoteApplyErrorListeners, error);
    }
  }

  markStale(error: YdocResyncNeededError): void {
    if (this.closed || this.staleError !== null) return;
    this.staleError = error;
    this.notifyListeners(this.resyncNeededListeners, error);
  }

  async close(options?: { settle?: boolean; summary?: string }): Promise<void> {
    if (this.closed) return;
    await this.recordChain;
    const params: YdocCloseParams = {
      sessionId: this.sessionId,
      ...(options?.settle !== undefined ? { settle: options.settle } : {}),
      ...(options?.summary ? { summary: options.summary } : {}),
    };
    decodeYdocCloseResult(
      await this.adapter.request(this.workspace, YDOC_METHOD.close, params),
    );
    this.closed = true;
    this.doc.off("update", this.handleDocUpdate);
    this.adapter.releaseSession(this.sessionId);
  }

  private readonly handleDocUpdate = (
    update: Uint8Array,
    origin: unknown,
  ): void => {
    try {
      if (this.closed) return;
      if (origin === ENGINE_DELIVERED_ORIGIN) {
        this.notifyListeners(this.remoteUpdateListeners, update);
        return;
      }
      if (origin !== LOCAL_EDITOR_ORIGIN) return;

      const capture = this.activeLocalRecordCapture;
      assertDocUtf16IsSafe(this.doc, capture?.before ?? snapshotDocUtf16(this.doc));
      const operation = this.enqueueRecordUpdate(update, capture?.options);
      if (capture !== null) capture.operation = operation;
    } catch (error) {
      if (origin === LOCAL_EDITOR_ORIGIN) {
        const rejection =
          error instanceof Error ? error : new Error("Unknown local Y.Doc observer failure.");
        if (this.activeLocalRecordCapture !== null) {
          this.activeLocalRecordCapture.rejection = rejection;
        }
        this.quarantine(rejection);
        this.surfaceSessionError(rejection);
      } else {
        this.surfaceSessionError(error);
      }
    }
  };

  private runLocalMutation(
    mutation: () => void,
    options?: ApplyLocalUpdateOptions,
  ): Promise<YdocRecordUpdateResult | undefined> {
    this.assertOpen();
    const capture: LocalRecordCapture = {
      options,
      before: snapshotDocUtf16(this.doc),
    };
    this.activeLocalRecordCapture = capture;
    try {
      mutation();
    } finally {
      this.activeLocalRecordCapture = null;
    }
    if (capture.rejection !== undefined) throw capture.rejection;
    return capture.operation ?? Promise.resolve(undefined);
  }

  private quarantine(cause: unknown): void {
    this.quarantinedError ??= new YdocSessionQuarantinedError(cause);
  }

  private notifyListeners<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        this.surfaceSessionError(error);
      }
    }
  }

  private surfaceSessionError(error: unknown): void {
    for (const listener of this.sessionErrorListeners) {
      try {
        listener(error);
      } catch {
        // Error channels are terminal observer boundaries; listener failures
        // must never escape into Yjs transaction cleanup.
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new YdocAdapterError(
        "session-closed",
        "The Y.Doc adapter session is closed.",
      );
    }
    if (this.quarantinedError !== null) throw this.quarantinedError;
    if (this.staleError !== null) throw this.staleError;
  }
}

export class YdocLiveAdapter {
  private nextRequestId = 1;
  private readonly sessions = new Map<string, YdocAdapterSession>();
  private readonly unsubscribeEvents: () => void;
  private readonly transport: EngineTransport;
  private readonly eventPositions = new Map<
    string,
    { seq: number; sessionGeneration: number }
  >();

  constructor(transport: EngineTransport) {
    this.transport = transport;
    this.unsubscribeEvents = transport.onEvent((event) => this.receiveEvent(event));
  }

  async openSession(
    input: OpenYdocAdapterSessionInput,
  ): Promise<YdocAdapterSession> {
    const params: YdocOpenParams = {
      versionId: input.versionId,
      path: input.path,
      ...(input.contentKind ? { contentKind: input.contentKind } : {}),
    };
    const result = decodeYdocOpenResult(
      await this.request(input.workspace, YDOC_METHOD.open, params),
    );
    const session = new YdocAdapterSession(this, input.workspace, result.sessionId, {
      objectId: result.objectId,
      path: result.path,
      contentKind: result.contentKind,
      initialUpdate: base64ToBytes(result.initialUpdateBase64),
    });
    this.sessions.set(result.sessionId, session);
    return session;
  }

  async request(
    workspace: WorkspaceHandle,
    method: string,
    params: Request["params"],
    options?: { idempotencyKey?: string },
  ): Promise<Response["result"]> {
    const id = this.nextRequestId++;
    const response = await this.transport.sendRequest({
      id,
      method,
      workspace,
      ...(options?.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      params,
    });
    if (response.id !== id) {
      throw new YdocAdapterError(
        "response-mismatch",
        `Expected response ${id}, received ${response.id}.`,
      );
    }
    return response.result;
  }

  releaseSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.eventPositions.delete(sessionId);
  }

  dispose(): void {
    this.unsubscribeEvents();
  }

  private receiveEvent(event: Event): void {
    try {
      if (event.name !== YDOC_EVENT.remoteUpdate) return;
      const payload = decodeYdocRemoteUpdatePayload(event.payload);
      const session = this.sessions.get(payload.sessionId);
      if (session === undefined) return;
      const previous = this.eventPositions.get(payload.sessionId);
      this.eventPositions.set(payload.sessionId, {
        seq: event.seq,
        sessionGeneration: event.sessionGeneration,
      });
      if (
        previous !== undefined &&
        event.sessionGeneration !== previous.sessionGeneration
      ) {
        session.markStale(
          new YdocResyncNeededError({
            reason: "session-generation-changed",
            event,
          }),
        );
        return;
      }
      if (previous !== undefined && event.seq !== previous.seq + 1) {
        session.markStale(
          new YdocResyncNeededError({
            reason: "event-sequence-gap",
            event,
          }),
        );
        return;
      }
      session.receiveRemoteUpdate(base64ToBytes(payload.updateBase64));
    } catch (cause) {
      this.markAllSessionsStale(
        new YdocResyncNeededError({
          reason: "event-decode-failed",
          event,
          cause,
        }),
      );
    }
  }

  private markAllSessionsStale(error: YdocResyncNeededError): void {
    for (const session of this.sessions.values()) session.markStale(error);
  }
}
