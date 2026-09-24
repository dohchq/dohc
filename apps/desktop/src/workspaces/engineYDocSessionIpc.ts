import { validateUserWritePath } from "@dohc/workspace-core";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import {
  isYdocArtifactAssetsInvalidRefusal,
  type ArtifactAssetDescriptor,
  type ChangeAttributionWire,
} from "@dohc/workspace-engine-client";
import { isEngineWorkspaceOpenRefusedError } from "@dohc/workspace-engine-client/daemon";
import * as Y from "yjs";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";

import {
  AcknowledgeEngineYDocLineageReplacementPayload,
  AcknowledgeEngineYDocLineageReplacementResult,
  ApplyEngineYDocUpdatePayload,
  ApplyEngineYDocUpdateResult,
  CloseEngineYDocSessionPayload,
  EngineYDocLineageReplacementEvent,
  EngineYDocRemoteUpdateEvent,
  EngineYDocSaveStateEvent,
  EngineYDocOwnerHandoff,
  OpenEngineYDocSessionPayload,
  OpenEngineYDocSessionResult,
  ReadEngineYDocArtifactAssetPayload,
  ReadEngineYDocArtifactAssetResult,
  type AcknowledgeEngineYDocLineageReplacementPayload as AcknowledgePayload,
  type AcknowledgeEngineYDocLineageReplacementResult as AcknowledgeResult,
  type ApplyEngineYDocUpdatePayload as ApplyUpdatePayload,
  type ApplyEngineYDocUpdateResult as ApplyUpdateResult,
  type CloseEngineYDocSessionPayload as ClosePayload,
  type OpenEngineYDocSessionPayload as OpenPayload,
  type OpenEngineYDocSessionResult as OpenResult,
  type ReadEngineYDocArtifactAssetPayload as ReadArtifactPayload,
  type ReadEngineYDocArtifactAssetResult as ReadArtifactResult,
} from "../ipc/bridgeContract";
import { CHANNELS, type EngineYDocSaveStateName } from "../ipc/channels";
import {
  createEngineYDocSaveSeqState,
  noteLocalEdit,
  noteSettleOutcome,
  noteSettleStart,
  type EngineYDocSaveSeqState,
} from "./engineYDocSaveSeq";
import {
  EngineYDocSessionOwner,
  type EngineYDocSessionOutbound,
  type EngineYDocSessionReleaseOutcome,
} from "./engineYDocSessionOwner";
import type {
  WorkspaceFileMutationYDocPort,
} from "./workspaceFileMutationOwner";
import {
  isYDocPathNotInVersionError,
  isYDocRemovalInProgressError,
  isYDocSessionUnreleasedError,
  type WorkspaceEngineCapture,
  type WorkspaceEngineYDocProviderSession,
} from "./workspaceEngineCapture";

export interface EngineYDocIpcSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: "destroyed", listener: () => void): this;
}

// A shared view's named live provider settles on its host and has no
// settleNow; a local capture's provider does.
export type EngineYDocSessionProvider = Omit<WorkspaceEngineYDocProviderSession, "settleNow"> & {
  liveWritable?(): boolean;
  settleNow?: WorkspaceEngineYDocProviderSession["settleNow"];
};
export interface EngineYDocSessionCapture {
  openYDocSession(input: Omit<Parameters<WorkspaceEngineCapture["openYDocSession"]>[0], "onSaveState"> & {onSaveState?: (state: EngineYDocSaveStateName, token: number) => void}): Promise<EngineYDocSessionProvider>;
}

interface EngineYDocWorkspace {
  workspaceId: string;
  rootPath: string;
  attachmentId: symbol;
}

export interface EngineYDocRendererSession {
  readonly workspaceId: string;
  readonly generation: number;
  isCurrent(): boolean;
}

interface EngineYDocSessionIpcOptions {
  sessionFor: (
    sender: EngineYDocIpcSender,
  ) => EngineYDocRendererSession | undefined;
  acquireWorkspace: (workspaceId: string) => {
    workspace: EngineYDocWorkspace;
    assertCurrent(): void;
    release(): void;
  };
  captureFor: (
    workspace: EngineYDocWorkspace,
  ) => EngineYDocSessionCapture | null;
  ensureCaptureFor: (workspace: EngineYDocWorkspace) => Promise<void>;
  isSharedView: (workspace: EngineYDocWorkspace) => boolean;
  sharedCaptureFor?: (workspace: EngineYDocWorkspace) => Promise<EngineYDocSessionCapture | null>;
  resolveDocumentPath: (
    workspace: EngineYDocWorkspace,
    path: string,
  ) => Promise<string | null>;
  onError: (message: string, error?: unknown) => void;
}

interface SessionEvent {
  state: EngineYDocSaveStateName;
  seq: number;
}

interface LineageReplacement {
  update: Uint8Array;
  recoveredPaths: string[];
  artifactAssets: readonly ArtifactAssetDescriptor[];
}

interface EngineYDocIpcOwnedSession {
  ownerHandoff?: { ready(): void; fail(error: unknown): void; done: Promise<void>; finish(): void };
  workspace: EngineYDocWorkspace;
  provider: EngineYDocSessionProvider;
  saveSeq: EngineYDocSaveSeqState;
  artifactAssetsById: Map<string, ArtifactAssetDescriptor>;
  retiredArtifactAssets: ArtifactAssetDescriptor[];
  deleted: boolean;
  emit: (event: SessionEvent) => void;
  // Sends an update that did not come from this editor to its Y.Doc.
  show(update: Uint8Array): void;
  markDeleted(): void;
  close: WorkspaceEngineYDocProviderSession["close"];
}

/** Who a main-side document edit is recorded under. */
export interface LiveDocumentEditOrigin {
  actorOriginId?: string;
  attribution: ChangeAttributionWire;
}

export interface LiveDocumentEdit {
  workspaceId: string;
  /** Validated and normalized; resolved again to the path sessions use. */
  path: string;
  /** The update that makes the edit against `state`, the document's encoded current state, or null for no change. */
  change(state: Uint8Array): Promise<Uint8Array | null>;
  origin: LiveDocumentEditOrigin;
}

/** Main-side reads and edits of live documents, for doors other than the editor. */
export interface LiveDocumentSessions {
  /** `state` is the encoded Y.Doc an open editor holds, or null when none holds it. */
  readDocument(input: { workspaceId: string; path: string }): Promise<{ path: string; state: Uint8Array | null }>;
  editDocument(input: LiveDocumentEdit): Promise<{ path: string; changed: boolean }>;
}

type EngineYDocIpcSessionOwner = EngineYDocSessionOwner<
  EngineYDocIpcSender,
  EngineYDocIpcOwnedSession,
  SessionEvent,
  Uint8Array,
  LineageReplacement
>;

type SessionOutbound = EngineYDocSessionOutbound<
  EngineYDocIpcSender,
  SessionEvent,
  Uint8Array,
  LineageReplacement
>;

function sameArtifactAsset(
  left: ArtifactAssetDescriptor,
  right: ArtifactAssetDescriptor,
): boolean {
  return (
    left.id === right.id &&
    left.mimeType === right.mimeType &&
    left.created === right.created &&
    left.ref === right.ref &&
    left.sha256 === right.sha256 &&
    left.lastRetrieved === right.lastRetrieved &&
    left.version === right.version
  );
}

interface DocumentReservationState {
  openings: number;
  mutations: number;
  tail: Promise<void>;
}

class LiveDocumentOwnedError extends Error {
  constructor() {
    super(
      "The engine owns this live document. Close its editor before writing the file directly.",
    );
    this.name = "LiveDocumentOwnedError";
  }
}

function liveDocumentMutationRefusal(): Error {
  return new LiveDocumentOwnedError();
}

/** Atomic admission shared by canonical Y.Doc opens and direct mutations. */
class DocumentMutationReservations {
  readonly #states = new Map<
    symbol,
    Map<string, DocumentReservationState>
  >();

  async reserveOpen(authorityId: symbol, path: string): Promise<() => void> {
    const state = this.#state(authorityId, path);
    const admittedMutations = state.tail;
    state.openings += 1;
    await admittedMutations;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.openings -= 1;
      this.#deleteIdle(authorityId, path, state);
    };
  }

  runMutation<T>(
    authorityId: symbol,
    path: string,
    ownsDocument: () => boolean,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const state = this.#state(authorityId, path);
    if (state.openings > 0 || ownsDocument()) {
      this.#deleteIdle(authorityId, path, state);
      return Promise.reject(liveDocumentMutationRefusal());
    }
    state.mutations += 1;
    const previous = state.tail;
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    state.tail = previous.then(() => turn);
    return previous
      .then(async () => {
        if (ownsDocument()) throw liveDocumentMutationRefusal();
        return mutation();
      })
      .finally(() => {
        releaseTurn();
        state.mutations -= 1;
        this.#deleteIdle(authorityId, path, state);
      });
  }

  #state(authorityId: symbol, key: string): DocumentReservationState {
    let byPath = this.#states.get(authorityId);
    if (!byPath) {
      byPath = new Map();
      this.#states.set(authorityId, byPath);
    }
    const state = byPath.get(key) ?? {
      openings: 0,
      mutations: 0,
      tail: Promise.resolve(),
    };
    byPath.set(key, state);
    return state;
  }

  #deleteIdle(
    authorityId: symbol,
    key: string,
    state: DocumentReservationState,
  ): void {
    if (state.openings !== 0 || state.mutations !== 0) return;
    const byPath = this.#states.get(authorityId);
    if (byPath?.get(key) === state) byPath.delete(key);
    if (byPath?.size === 0) this.#states.delete(authorityId);
  }
}

class EngineYDocSessionIpc implements LiveDocumentSessions {
  readonly #sessionFor: EngineYDocSessionIpcOptions["sessionFor"];
  readonly #acquireWorkspace: EngineYDocSessionIpcOptions["acquireWorkspace"];
  readonly #captureFor: EngineYDocSessionIpcOptions["captureFor"];
  readonly #ensureCaptureFor: EngineYDocSessionIpcOptions["ensureCaptureFor"];
  readonly #sharedCaptureFor: EngineYDocSessionIpcOptions["sharedCaptureFor"];
  readonly #isSharedView: EngineYDocSessionIpcOptions["isSharedView"];
  readonly #resolveDocumentPath: EngineYDocSessionIpcOptions[
    "resolveDocumentPath"
  ];
  readonly #onError: EngineYDocSessionIpcOptions["onError"];
  readonly #owner: EngineYDocIpcSessionOwner;
  readonly #documentReservations: DocumentMutationReservations;
  readonly #fileMutationPort: WorkspaceFileMutationYDocPort;

  constructor(options: EngineYDocSessionIpcOptions) {
    this.#sessionFor = options.sessionFor;
    this.#acquireWorkspace = options.acquireWorkspace;
    this.#captureFor = options.captureFor;
    this.#ensureCaptureFor = options.ensureCaptureFor;
    this.#isSharedView = options.isSharedView;
    this.#sharedCaptureFor = options.sharedCaptureFor;
    this.#resolveDocumentPath = options.resolveDocumentPath;
    this.#onError = options.onError;
    this.#documentReservations = new DocumentMutationReservations();
    this.#owner = new EngineYDocSessionOwner({
      onOutbound: (outbound) => this.#send(outbound),
      onReleaseFailed: ({ path, error }) => {
        this.#onError(
          `[desktop] engine Y.Doc session close failed for ${path}; ` +
            "the engine may still hold the document, so it stays read-only until a retry releases it.",
          error,
        );
      },
    });
    const fileMutationPort: WorkspaceFileMutationYDocPort = {
      withDocumentUnowned: (authorityId, path, mutation) =>
        this.#documentReservations.runMutation(
          authorityId,
          path,
          () => this.#owner.ownsDocument(authorityId, path),
          mutation,
        ),
      markDeletedUnderPath: (authorityId, pathOrPrefix) => {
        this.#owner.forEachSessionUnderPath(
          authorityId,
          pathOrPrefix,
          (session) => session.markDeleted(),
        );
      },
    };
    this.#fileMutationPort = Object.freeze(fileMutationPort);
  }

  async open(
    sender: EngineYDocIpcSender,
    payload: OpenPayload,
  ): Promise<OpenResult> {
    const input = OpenEngineYDocSessionPayload.parse(payload);
    const rendererSession = this.#sessionFor(sender);
    if (
      !rendererSession ||
      rendererSession.workspaceId !== input.workspaceId ||
      !rendererSession.isCurrent()
    ) {
      return unavailableOpen();
    }
    const authority = this.#acquireWorkspace(input.workspaceId);
    try {
      return await this.#openWithAuthority(
        sender,
        input,
        authority,
        rendererSession,
      );
    } finally {
      authority.release();
    }
  }

  async #openWithAuthority(
    sender: EngineYDocIpcSender,
    input: OpenPayload,
    authority: ReturnType<EngineYDocSessionIpcOptions["acquireWorkspace"]>,
    rendererSession: EngineYDocRendererSession,
  ): Promise<OpenResult> {
    const workspace = authority.workspace;
    authority.assertCurrent();
    if (!rendererSession.isCurrent()) return unavailableOpen();
    if (this.#isSharedView(workspace) && !this.#sharedCaptureFor) return unavailableOpen();
    const validatedPath = validateUserWritePath(input.path);
    if (!validatedPath.ok) return unavailableOpen();
    const requestedSpellingKind = liveDocumentKindForPath(
      validatedPath.normalized,
    );
    const generation = rendererSession.generation;
    let canonicalPath: string | null;
    try {
      canonicalPath = await this.#resolveDocumentPath(
        workspace,
        validatedPath.normalized,
      );
    } catch (error) {
      this.#onError(
        `[desktop] engine Y.Doc open could not resolve ${validatedPath.normalized}:`,
        error,
      );
      return requestedSpellingKind === null
        ? unavailableOpen()
        : unavailableOpen({ documentUnavailable: true });
    }
    if (
      !rendererSession.isCurrent() ||
      (this.#isSharedView(workspace) && !this.#sharedCaptureFor)
    ) {
      return unavailableOpen();
    }
    if (canonicalPath === null) {
      return requestedSpellingKind === null
        ? unavailableOpen()
        : unavailableOpen({ documentUnavailable: true });
    }
    const canonicalKind = liveDocumentKindForPath(canonicalPath);
    if (requestedSpellingKind !== canonicalKind) {
      return unavailableOpen({ documentUnavailable: true });
    }
    if (canonicalKind === null) return unavailableOpen();
    if (this.#isSharedView(workspace) && (canonicalKind !== "richdoc" || !/\.md$/i.test(canonicalPath))) return unavailableOpen();
    const releaseOpening = await this.#documentReservations.reserveOpen(
      workspace.attachmentId,
      canonicalPath,
    );
    try {
      authority.assertCurrent();
      return await this.#openReserved(
        sender,
        input,
        workspace,
        canonicalPath,
        validatedPath.normalized,
        canonicalKind,
        authority,
        rendererSession,
        generation,
      );
    } finally {
      releaseOpening();
    }
  }

  async #openReserved(
    sender: EngineYDocIpcSender,
    input: OpenPayload,
    workspace: EngineYDocWorkspace,
    canonicalPath: string,
    requestedPath: string,
    documentKind: NonNullable<ReturnType<typeof liveDocumentKindForPath>>,
    authority: ReturnType<EngineYDocSessionIpcOptions["acquireWorkspace"]>,
    rendererSession: EngineYDocRendererSession,
    generation: number,
  ): Promise<OpenResult> {
    const shared = this.#isSharedView(workspace);
    let capture: EngineYDocSessionCapture | null;
    if (shared && this.#sharedCaptureFor) {
      try { capture = await this.#sharedCaptureFor?.(workspace) ?? null; }
      catch { return unavailableOpen({ liveHostUnavailable: true }); }
      authority.assertCurrent();
      if (!capture || !rendererSession.isCurrent()) return unavailableOpen({ liveHostUnavailable: true });
    } else capture = this.#captureFor(workspace);
    if (!capture) {
      try {
        await this.#ensureCaptureFor(workspace);
      } catch (error) {
        this.#onError(
          `[desktop] engine Y.Doc open could not open the workspace activity for ${canonicalPath}:`,
          error,
        );
      }
      authority.assertCurrent();
      // Window loading now overlaps the daemon handshake. The await above can
      // span a reload, and a retired renderer must never acquire its session.
      if (!rendererSession.isCurrent()) {
        return unavailableOpen();
      }
      capture = this.#captureFor(workspace);
      if (!capture) return unavailableOpen();
    }

    let currentPath: string | null;
    try {
      currentPath = await this.#resolveDocumentPath(workspace, requestedPath);
    } catch (error) {
      this.#onError(
        `[desktop] engine Y.Doc open could not recheck ${canonicalPath}:`,
        error,
      );
      return unavailableOpen({ documentUnavailable: true });
    }
    authority.assertCurrent();
    if (
      currentPath === null ||
      currentPath !== canonicalPath
    ) {
      return unavailableOpen({ documentUnavailable: true });
    }
    if (
      !rendererSession.isCurrent() || this.#isSharedView(workspace) !== shared ||
      (this.#isSharedView(workspace) && !this.#sharedCaptureFor)
    ) {
      return unavailableOpen();
    }
    const opened = await this.#owner.open({
      sender,
      generation,
      sessionId: input.sessionId,
      workspaceId: workspace.workspaceId,
      authorityId: workspace.attachmentId,
      path: canonicalPath,
      openSession: async (signals) => {
        const saveSeq = createEngineYDocSaveSeqState();
        let delivery: "pending" | "active" | "discarded" = "pending";
        const pending: Array<() => void> = [];
        const publish = (send: () => void): void => {
          if (delivery === "active") send();
          else if (delivery === "pending") pending.push(send);
        };
        let provider: EngineYDocSessionProvider;
        try {
          provider = await capture.openYDocSession({
            path: canonicalPath,
            contentKind: documentKind,
            onSaveState: (state, token) => {
              const seq =
                state === "settling"
                  ? noteSettleStart(saveSeq, token)
                  : noteSettleOutcome(saveSeq, token);
              publish(() => signals.emit({ state, seq }));
            },
            onRemoteUpdate: (update) => {
              publish(() => signals.remoteUpdate(update));
            },
            onLineageReplaced: (update, recoveredPaths) => {
              publish(() =>
                signals.replaceLineage({
                  update,
                  recoveredPaths,
                  artifactAssets: provider.artifactAssets ?? [],
                }),
              );
            },
          });
        } catch (error) {
          delivery = "discarded";
          pending.length = 0;
          throw error;
        }

        const owned: EngineYDocIpcOwnedSession = {
          workspace,
          provider,
          saveSeq,
          artifactAssetsById: new Map(
            (provider.artifactAssets ?? []).map((descriptor) => [
              descriptor.id,
              descriptor,
            ]),
          ),
          retiredArtifactAssets: [],
          deleted: false,
          emit: signals.emit,
          show: (update) => publish(() => signals.remoteUpdate(update)),
          markDeleted() {
            owned.deleted = true;
            owned.emit({ state: "deleted", seq: owned.saveSeq.dirtySeq });
          },
          close: (options) => {
            owned.ownerHandoff?.fail(new Error("Owner session closed."));
            owned.ownerHandoff?.finish();
            owned.ownerHandoff = undefined;
            return provider.close(options);
          },
        };
        if (provider.contentKind === documentKind) {
          delivery = "active";
          for (const send of pending.splice(0)) send();
        } else {
          delivery = "discarded";
          pending.length = 0;
        }
        return { session: owned, value: owned };
      },
    });

    if (opened.kind === "opened") {
      const owned = opened.value;
      if (owned.provider.contentKind !== documentKind) {
        this.#onError(
          `[desktop] engine Y.Doc open for ${canonicalPath} came back ${owned.provider.contentKind}; ` +
            `the editor requested ${documentKind} (kind-mismatched lineage).`,
        );
        const release = await this.#owner.release({
          sender,
          generation,
          sessionId: input.sessionId,
        });
        return release.kind === "failed"
          ? unavailableOpen({ engineMayHoldDocument: true })
          : unavailableOpen();
      }
      return OpenEngineYDocSessionResult.parse({
        available: true,
        initialUpdate: Y.encodeStateAsUpdate(owned.provider.doc),
        ...(owned.provider.objectId ? { objectId: owned.provider.objectId } : {}),
        ...(owned.provider.versionId
          ? { versionId: owned.provider.versionId }
          : {}),
        artifactAssets: owned.provider.artifactAssets ?? [],
        lineageGeneration: opened.lineageGeneration,
      });
    }
    if (opened.kind === "cancelled") {
      return opened.release.kind === "failed"
        ? unavailableOpen({ engineMayHoldDocument: true })
        : unavailableOpen();
    }
    if (
      opened.reason === "session-in-use" ||
      opened.reason === "session-unreleased"
    ) {
      return unavailableOpen({ engineMayHoldDocument: true });
    }
    if (opened.reason !== "open-refused") return unavailableOpen();

    this.#onError(
      `[desktop] engine Y.Doc open refused for ${canonicalPath}:`,
      opened.error,
    );
    return shared ? unavailableOpen({ liveHostUnavailable: true }) : this.#openRefusal(opened.error);
  }

  async readArtifactAsset(
    sender: EngineYDocIpcSender,
    payload: ReadArtifactPayload,
  ): Promise<ReadArtifactResult> {
    const input = ReadEngineYDocArtifactAssetPayload.parse(payload);
    const access = this.#owner.accessSession(
      this.#caller(sender, input.sessionId),
      (owned) => {
        const requested = input.descriptor;
        const descriptor = [
          owned.artifactAssetsById.get(requested.id),
          ...owned.retiredArtifactAssets,
        ].find(
          (candidate) =>
            candidate !== undefined && sameArtifactAsset(candidate, requested),
        );
        if (!descriptor) {
          throw new Error(
            `The live document does not reference artifact asset ${requested.id}.`,
          );
        }
        return owned.provider.readArtifactAsset(descriptor);
      },
    );
    if (access.kind === "refused") {
      throw new Error(
        "The live document session is no longer available. Open the file again.",
      );
    }
    return ReadEngineYDocArtifactAssetResult.parse(await access.value);
  }

  applyUpdate(
    sender: EngineYDocIpcSender,
    payload: ApplyUpdatePayload,
  ): ApplyUpdateResult {
    const input = ApplyEngineYDocUpdatePayload.parse(payload);
    const applied = this.#owner.applyUpdate(
      {
        ...this.#caller(sender, input.sessionId),
        lineageGeneration: input.lineageGeneration,
      },
      (owned): ApplyUpdateResult => {
        if (owned.deleted) {
          owned.emit({ state: "deleted", seq: input.seq });
          return { accepted: false, reason: "deleted" };
        }
        if (this.#isSharedView(owned.workspace) && !owned.provider.liveWritable?.()) {
          owned.emit({ state: "read-only", seq: input.seq });
          return { accepted: false, reason: "read-only" };
        }
        owned.provider.applyLocalUpdate(
          input.update,
          () => noteLocalEdit(owned.saveSeq, input.seq),
          // A renderer editor update is a person typing: agent and
          // automation writes take the collection write seam, never this
          // IPC. The declared kind rides beside the device attribution.
          { attribution: { actorKind: "human" } },
        );
        return { accepted: true };
      },
    );
    if (applied.kind === "refused") {
      return ApplyEngineYDocUpdateResult.parse({
        accepted: false,
        reason: applied.reason,
      });
    }
    return ApplyEngineYDocUpdateResult.parse(applied.value);
  }

  /**
   * A live document for a main-side door, such as the CLI socket that MCP
   * also uses. The editor session that holds the document answers with its
   * encoded Y.Doc; `state` is null when no editor holds it, and the caller
   * reads the settled file at `path`.
   */
  async readDocument(
    input: { workspaceId: string; path: string },
  ): Promise<{ path: string; state: Uint8Array | null }> {
    const authority = this.#acquireWorkspace(input.workspaceId);
    try {
      authority.assertCurrent();
      const path = await this.#markdownDocumentPath(authority.workspace, input.path);
      authority.assertCurrent();
      const held = this.#isSharedView(authority.workspace)
        ? undefined
        : this.#owner.documentSession(authority.workspace.attachmentId, path);
      return { path, state: held ? Y.encodeStateAsUpdate(held.session.provider.doc) : null };
    } finally {
      authority.release();
    }
  }

  /**
   * Applies a main-side edit to a live document. The editor session that
   * holds the document applies it and shows it to the person. With no editor
   * open, a session opened for this edit alone applies and settles it, and an
   * editor that opens meanwhile waits for that session to close.
   */
  async editDocument(input: LiveDocumentEdit): Promise<{ path: string; changed: boolean }> {
    const authority = this.#acquireWorkspace(input.workspaceId);
    try {
      authority.assertCurrent();
      const workspace = authority.workspace;
      if (this.#isSharedView(workspace)) {
        throw new Error("Documents in a shared view change through the share, not this workspace.");
      }
      const path = await this.#markdownDocumentPath(workspace, input.path);
      authority.assertCurrent();
      const attachment = workspace.attachmentId;
      const held = this.#owner.documentSession(attachment, path);
      if (held) return { path, changed: await this.#editHeld(held, path, input) };
      try {
        const changed = await this.#documentReservations.runMutation(
          attachment,
          path,
          () => this.#owner.ownsDocument(attachment, path),
          async () => {
            authority.assertCurrent();
            return await this.#editUnheld(workspace, path, input);
          },
        );
        return { path, changed };
      } catch (error) {
        if (!(error instanceof LiveDocumentOwnedError)) throw error;
        throw new Error(`${path} opened in an editor as dohc began the edit, and nothing changed. Try again.`);
      }
    } finally {
      authority.release();
    }
  }

  async #markdownDocumentPath(workspace: EngineYDocWorkspace, requested: string): Promise<string> {
    if (liveDocumentKindForPath(requested) !== "richdoc") {
      throw new Error(`${requested} is not a Markdown document.`);
    }
    const path = await this.#resolveDocumentPath(workspace, requested);
    if (path === null) throw new Error(`No document at ${requested}.`);
    if (liveDocumentKindForPath(path) !== "richdoc") {
      throw new Error(`${requested} is not a Markdown document.`);
    }
    return path;
  }

  async #editHeld(
    held: NonNullable<ReturnType<EngineYDocIpcSessionOwner["documentSession"]>>,
    path: string,
    input: LiveDocumentEdit,
  ): Promise<boolean> {
    const owned = held.session;
    // Checked again once the edit is computed: an update computed against one
    // lineage must not land on its replacement.
    const assertSame = (): void => {
      try {
        held.assertCurrent();
      } catch {
        throw new Error(`${path} changed hands while dohc prepared the edit, and nothing changed. Read it again, then retry.`);
      }
      if (owned.deleted) throw new Error(`${path} was deleted.`);
      if (owned.ownerHandoff) throw new Error(`dohc is handing ${path} to its live session, and nothing changed. Try again.`);
    };
    assertSame();
    return await applyDocumentEdit(owned.provider, path, input, { assertSame, show: owned.show });
  }

  async #editUnheld(
    workspace: EngineYDocWorkspace,
    path: string,
    input: LiveDocumentEdit,
  ): Promise<boolean> {
    let capture = this.#captureFor(workspace);
    if (!capture) {
      await this.#ensureCaptureFor(workspace);
      capture = this.#captureFor(workspace);
    }
    if (!capture) throw new Error("The workspace engine is not running.");
    const provider = await capture.openYDocSession({
      path,
      contentKind: "richdoc",
      // Nothing else reads this session's doc before it closes.
      onRemoteUpdate: () => undefined,
    });
    let changed: boolean;
    try {
      if (provider.contentKind !== "richdoc") {
        throw new Error(`${path} is not a Markdown document.`);
      }
      changed = await applyDocumentEdit(provider, path, input, {
        assertSame: () => undefined,
        show: () => undefined,
      });
    } catch (error) {
      await provider.close().catch((closeError: unknown) => {
        this.#onError(`[desktop] engine Y.Doc close after a refused edit failed for ${path}:`, closeError);
      });
      throw error;
    }
    // The edit is applied and saved. A failed release leaves the session to
    // the capture's own recovery; reporting it as a failed edit would bring a
    // retry that applies the edit twice.
    await provider.close().catch((closeError: unknown) => {
      this.#onError(`[desktop] engine Y.Doc close after an edit failed for ${path}:`, closeError);
    });
    return changed;
  }

  existingOwner(binding: LiveObjectBinding) {
    const authority = this.#acquireWorkspace(binding.workspaceId);
    try {
      authority.assertCurrent();
      const captured = this.#owner.documentSession(authority.workspace.attachmentId, binding.currentPath);
      const owned = captured?.session;
      const native = owned?.provider.nativeOwner;
      if (!captured || !owned || !native) throw new Error("Existing owner is unavailable.");
      const renderer = this.#sessionFor(captured.caller.sender);
      const assertCurrent = () => {
        const currentAuthority = this.#acquireWorkspace(binding.workspaceId);
        try {
          currentAuthority.assertCurrent();
          if (currentAuthority.workspace.attachmentId !== owned.workspace.attachmentId) throw new Error("Owner workspace changed.");
        } finally { currentAuthority.release(); }
        captured.assertCurrent();
        if (!renderer?.isCurrent() || captured.caller.sender.isDestroyed() || owned.deleted || this.#isSharedView(owned.workspace) ||
          owned.provider.nativeOwner?.sessionId !== native.sessionId || owned.provider.objectId !== binding.objectId ||
          owned.provider.versionId !== binding.mainVersionId || owned.provider.lineageClaimId !== binding.lineageClaimId) throw new Error("Existing owner changed.");
      };
      assertCurrent();
      return {
        nativeSessionId: native.sessionId,
        assertCurrent,
        onDurableLocalChange: (handler: () => void) => {
          assertCurrent();
          return native.onDurableLocalChange(handler);
        },
        prepareHandoff: async (signal: AbortSignal) => {
          assertCurrent(); signal.throwIfAborted();
          if (owned.ownerHandoff) throw new Error("Owner handoff is already active.");
          let ready!: () => void, fail!: (error: unknown) => void, finish!: () => void;
          const prepared = new Promise<void>((resolve,reject) => { ready = resolve; fail = reject; });
          const done = new Promise<void>(resolve => { finish = resolve; });
          const handoff = { ready,fail,done,finish };
          owned.ownerHandoff = handoff;
          const abort = () => { fail(signal.reason); finish(); if (owned.ownerHandoff === handoff) owned.ownerHandoff = undefined; };
          signal.addEventListener("abort",abort,{once: true});
          void done.finally(() => signal.removeEventListener("abort",abort));
          try {captured.caller.sender.send(CHANNELS.engineYDocOwnerHandoff, EngineYDocOwnerHandoff.parse({sessionId: captured.caller.sessionId,lineageGeneration: captured.caller.lineageGeneration}));}
          catch (error) {fail(error); finish(); if (owned.ownerHandoff === handoff) owned.ownerHandoff = undefined;}
          await prepared; assertCurrent();
        },
        finishHandoff: async (_adopted: boolean) => {
          const handoff = owned.ownerHandoff;
          if (!handoff) return;
          owned.ownerHandoff = undefined;
          handoff.fail(new Error("Owner handoff ended.")); handoff.finish();
        },
        remoteApplied: async (update: Uint8Array) => { assertCurrent(); await native.applyRemoteUpdate(update); assertCurrent(); },
      };
    } finally { authority.release(); }
  }

  async prepareOwnerHandoff(sender: EngineYDocIpcSender, payload: EngineYDocOwnerHandoff): Promise<void> {
    const input = EngineYDocOwnerHandoff.parse(payload);
    const caller = { ...this.#caller(sender,input.sessionId),lineageGeneration: input.lineageGeneration };
    const access = this.#owner.applyUpdate(caller, owned => owned);
    if (access.kind !== "applied") throw new Error("Owner handoff session is unavailable.");
    const owned = access.value, handoff = owned.ownerHandoff, native = owned.provider.nativeOwner;
    if (!handoff || !native || owned.deleted || this.#isSharedView(owned.workspace)) throw new Error("Owner handoff was not requested.");
    try {
      await native.flush();
      const current = this.#owner.applyUpdate(caller, value => value === owned && value.ownerHandoff === handoff && value.provider.nativeOwner?.sessionId === native.sessionId);
      if (current.kind !== "applied" || !current.value) throw new Error("Owner handoff session changed.");
      handoff.ready();
      await handoff.done;
    } catch (error) { handoff.fail(error); handoff.finish(); if (owned.ownerHandoff === handoff) owned.ownerHandoff = undefined; throw error; }
  }

  acknowledgeLineageReplacement(
    sender: EngineYDocIpcSender,
    payload: AcknowledgePayload,
  ): AcknowledgeResult {
    const input = AcknowledgeEngineYDocLineageReplacementPayload.parse(payload);
    const caller = this.#caller(sender, input.sessionId);
    const acknowledged = this.#owner.acknowledgeLineageReplacement(
      {
        ...caller,
        lineageGeneration: input.lineageGeneration,
      },
      (owned, replacement) => {
        for (const descriptor of owned.artifactAssetsById.values()) {
          if (
            !owned.retiredArtifactAssets.some((retired) =>
              sameArtifactAsset(retired, descriptor),
            )
          ) {
            owned.retiredArtifactAssets.push(descriptor);
          }
        }
        owned.artifactAssetsById = new Map(
          replacement.artifactAssets.map((descriptor) => [
            descriptor.id,
            descriptor,
          ]),
        );
      },
    );
    if (acknowledged.kind === "refused") {
      return AcknowledgeEngineYDocLineageReplacementResult.parse({
        accepted: false,
        reason: acknowledged.reason,
      });
    }
    return AcknowledgeEngineYDocLineageReplacementResult.parse({
      accepted: true,
      updates: acknowledged.updates,
    });
  }

  async close(sender: EngineYDocIpcSender, payload: ClosePayload): Promise<void> {
    const input = CloseEngineYDocSessionPayload.parse(payload);
    await this.#owner.release(this.#caller(sender, input.sessionId));
  }

  retireSender(
    sender: EngineYDocIpcSender,
    generation: number,
  ): Promise<EngineYDocSessionReleaseOutcome[]> {
    return this.#owner.retireSender({ sender, generation });
  }

  shutdown(): Promise<EngineYDocSessionReleaseOutcome[]> {
    return this.#owner.shutdown();
  }

  fileMutationPort(): WorkspaceFileMutationYDocPort {
    return this.#fileMutationPort;
  }

  retireAuthority(
    authorityId: symbol,
  ): Promise<EngineYDocSessionReleaseOutcome[]> {
    return this.#owner.retireAuthority(authorityId);
  }
  #caller(sender: EngineYDocIpcSender, sessionId: string) {
    return {
      sender,
      generation: this.#sessionFor(sender)?.generation ?? -1,
      sessionId,
    };
  }

  #send(outbound: SessionOutbound): void {
    const rendererSession = this.#sessionFor(outbound.sender);
    if (
      !rendererSession ||
      !rendererSession.isCurrent() ||
      rendererSession.generation !== outbound.generation
    ) {
      throw new Error("The renderer generation no longer owns this session.");
    }
    const { message } = outbound;
    try {
      if (message.kind === "session-event") {
        outbound.sender.send(
          CHANNELS.engineYDocSaveState,
          EngineYDocSaveStateEvent.parse({
            sessionId: outbound.sessionId,
            ...message.event,
          }),
        );
        return;
      }
      if (message.kind === "remote-update") {
        outbound.sender.send(
          CHANNELS.engineYDocRemoteUpdate,
          EngineYDocRemoteUpdateEvent.parse({
            sessionId: outbound.sessionId,
            update: message.update,
            lineageGeneration: message.lineageGeneration,
          }),
        );
        return;
      }
      outbound.sender.send(
        CHANNELS.engineYDocLineageReplacement,
        EngineYDocLineageReplacementEvent.parse({
          sessionId: outbound.sessionId,
          ...message.replacement,
          lineageGeneration: message.lineageGeneration,
        }),
      );
    } catch (error) {
      if (
        rendererSession.isCurrent() &&
        rendererSession.generation === outbound.generation
      ) {
        this.#onError(
          `[desktop] engine Y.Doc ${message.kind} delivery failed for ${outbound.path}.`,
          error,
        );
      }
      throw error;
    }
  }

  #openRefusal(error: unknown): OpenResult {
    if (isYDocPathNotInVersionError(error)) {
      return unavailableOpen({ notInVersion: true });
    }
    if (isYDocRemovalInProgressError(error)) {
      return unavailableOpen({
        removalInProgress: {
          operation: error.removalOperation,
          message: error.inProgress,
        },
      });
    }
    if (isYdocArtifactAssetsInvalidRefusal(error)) {
      return unavailableOpen({ artifactAssetsInvalid: true });
    }
    if (
      isEngineWorkspaceOpenRefusedError(error) ||
      isYDocSessionUnreleasedError(error)
    ) {
      return unavailableOpen({ engineMayHoldDocument: true });
    }
    return unavailableOpen();
  }
}

// Journals one main-side edit on a live document session and settles it, so
// the edit is in the engine and the file when the caller hears back. The
// update is computed off this thread against the session's state and reaches
// the editor as a remote update, which merges with anything the person typed
// meanwhile.
async function applyDocumentEdit(
  provider: EngineYDocSessionProvider,
  path: string,
  input: LiveDocumentEdit,
  session: { assertSame(): void; show(update: Uint8Array): void },
): Promise<boolean> {
  const settleNow = provider.settleNow;
  if (!settleNow) throw new Error(`${path} cannot take an edit from here.`);
  const update = await input.change(Y.encodeStateAsUpdate(provider.doc));
  if (update === null) return false;
  session.assertSame();
  let armed = false;
  provider.applyLocalUpdate(update, () => {
    armed = true;
  }, input.origin);
  session.show(update);
  try {
    await settleNow.call(provider);
  } catch (error) {
    if (!armed) throw error;
    // The session's journal holds the edit and a later settle saves it.
    // Sending the edit again could apply it twice.
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The edit is in ${path}, but dohc has not saved it to the file yet (${cause}). Read the document before you retry.`,
      { cause: error },
    );
  }
  if (!armed) throw new Error(`The engine did not accept the edit to ${path}.`);
  return true;
}

export function createEngineYDocSessionIpc(
  options: EngineYDocSessionIpcOptions,
): EngineYDocSessionIpc {
  return new EngineYDocSessionIpc(options);
}

function unavailableOpen(
  details: Omit<OpenResult, "available"> = {},
): OpenResult {
  return OpenEngineYDocSessionResult.parse({ available: false, ...details });
}
