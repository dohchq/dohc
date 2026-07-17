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

declare global {
  interface String {
    isWellFormed(): boolean;
  }
}

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
  | "session-closed";

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
      "The local Y.Doc edit contains ill-formed UTF-16 text.",
    );
    this.name = "IllFormedUtf16EditError";
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

function assertWellFormedString(value: string): void {
  if (!value.isWellFormed()) throw new IllFormedUtf16EditError();
}

function assertWellFormedJson(value: unknown): void {
  if (typeof value === "string") {
    assertWellFormedString(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertWellFormedJson(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertWellFormedString(key);
      assertWellFormedJson(item);
    }
  }
}

function assertWellFormedXmlNode(node: Y.XmlElement | Y.XmlText): void {
  if (node instanceof Y.XmlText) {
    assertWellFormedString(node.toString());
    return;
  }
  for (const [key, value] of Object.entries(node.getAttributes())) {
    assertWellFormedString(key);
    if (value !== undefined) assertWellFormedString(value);
  }
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
      assertWellFormedXmlNode(child);
    }
  }
}

function assertDocTextIsWellFormed(doc: Y.Doc): void {
  assertWellFormedString(doc.getText("plainText").toString());
  for (const child of doc.getXmlFragment("body").toArray()) {
    if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
      assertWellFormedXmlNode(child);
    }
  }
  assertWellFormedJson(doc.getMap("frontmatter").toJSON());
  assertWellFormedJson(doc.getMap("meta").toJSON());
}

interface LocalRecordCapture {
  readonly options: ApplyLocalUpdateOptions | undefined;
  operation?: Promise<YdocRecordUpdateResult>;
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
  private readonly remoteUpdateListeners = new Set<(update: Uint8Array) => void>();
  private readonly remoteApplyErrorListeners = new Set<
    (error: RemoteYdocApplyError) => void
  >();

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
    // Encoded Yjs updates have already passed through lib0's UTF-8 codec, which
    // replaces lone surrogates. Live-doc validation in the observer is still
    // defense-in-depth here; applyLocalEdit is the load-bearing editor path.
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
    let result!: YdocRecordUpdateResult;
    const operation = this.recordChain.then(async () => {
      result = decodeYdocRecordUpdateResult(
        await this.adapter.request(
          this.workspace,
          YDOC_METHOD.recordUpdate,
          params,
        ),
      );
    });
    this.recordChain = operation.catch(() => undefined);
    return operation.then(() => result);
  }

  async settle(options?: { summary?: string }): Promise<YdocSettleResult> {
    this.assertOpen();
    await this.recordChain;
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

  currentStateUpdate(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  receiveRemoteUpdate(update: Uint8Array): void {
    if (this.closed) return;
    try {
      Y.applyUpdate(this.doc, update, ENGINE_DELIVERED_ORIGIN);
    } catch (cause) {
      // applyUpdate can integrate a prefix before throwing. Re-read the actual
      // post-attempt doc; a later full-state update converges from this state.
      const error = new RemoteYdocApplyError({
        attemptedUpdate: update,
        postAttemptStateUpdate: Y.encodeStateAsUpdate(this.doc),
        cause,
      });
      for (const listener of this.remoteApplyErrorListeners) listener(error);
      return;
    }
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
    if (this.closed) return;
    if (origin === ENGINE_DELIVERED_ORIGIN) {
      for (const listener of this.remoteUpdateListeners) listener(update);
      return;
    }
    if (origin !== LOCAL_EDITOR_ORIGIN) return;

    // Validate the live ContentString values before this encoded delta is
    // enqueued. Encoding has already sanitized its own copy of the content.
    assertDocTextIsWellFormed(this.doc);
    const operation = this.enqueueRecordUpdate(
      update,
      this.activeLocalRecordCapture?.options,
    );
    if (this.activeLocalRecordCapture !== null) {
      this.activeLocalRecordCapture.operation = operation;
    }
  };

  private runLocalMutation(
    mutation: () => void,
    options?: ApplyLocalUpdateOptions,
  ): Promise<YdocRecordUpdateResult | undefined> {
    this.assertOpen();
    const capture: LocalRecordCapture = { options };
    this.activeLocalRecordCapture = capture;
    try {
      mutation();
    } finally {
      this.activeLocalRecordCapture = null;
    }
    return capture.operation ?? Promise.resolve(undefined);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new YdocAdapterError(
        "session-closed",
        "The Y.Doc adapter session is closed.",
      );
    }
  }
}

export class YdocLiveAdapter {
  private nextRequestId = 1;
  private readonly sessions = new Map<string, YdocAdapterSession>();
  private readonly unsubscribeEvents: () => void;
  private readonly transport: EngineTransport;

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
  ): Promise<Response["result"]> {
    const id = this.nextRequestId++;
    const response = await this.transport.sendRequest({
      id,
      method,
      workspace,
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
  }

  dispose(): void {
    this.unsubscribeEvents();
  }

  private receiveEvent(event: Event): void {
    if (event.name !== YDOC_EVENT.remoteUpdate) return;
    const payload = decodeYdocRemoteUpdatePayload(event.payload);
    this.sessions
      .get(payload.sessionId)
      ?.receiveRemoteUpdate(base64ToBytes(payload.updateBase64));
  }
}
