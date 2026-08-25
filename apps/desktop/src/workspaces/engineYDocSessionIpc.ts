import { validateUserWritePath } from "@dohc/workspace-core";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import {
  isYdocArtifactAssetsInvalidRefusal,
  type ArtifactAssetDescriptor,
} from "@dohc/workspace-engine-client";
import { isEngineWorkspaceOpenRefusedError } from "@dohc/workspace-engine-client/daemon";
import * as Y from "yjs";

import {
  AcknowledgeEngineYDocLineageReplacementPayload,
  AcknowledgeEngineYDocLineageReplacementResult,
  ApplyEngineYDocUpdatePayload,
  ApplyEngineYDocUpdateResult,
  CloseEngineYDocSessionPayload,
  EngineYDocLineageReplacementEventSchema,
  EngineYDocRemoteUpdateEventSchema,
  EngineYDocSaveStateEventSchema,
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

export type EngineYDocSessionCapture = Pick<
  WorkspaceEngineCapture,
  "openYDocSession"
>;

interface EngineYDocWorkspace {
  workspaceId: string;
}

interface EngineYDocSessionIpcOptions {
  generationOf: (senderId: number) => number;
  requireWorkspace: (workspaceId: string) => EngineYDocWorkspace;
  captureFor: (workspaceId: string) => EngineYDocSessionCapture | null;
  ensureCaptureFor: (workspaceId: string) => Promise<void>;
  isSharedView: (workspaceId: string) => boolean;
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
  workspaceId: string;
  provider: WorkspaceEngineYDocProviderSession;
  saveSeq: EngineYDocSaveSeqState;
  artifactAssetsById: Map<string, ArtifactAssetDescriptor>;
  retiredArtifactAssets: ArtifactAssetDescriptor[];
  deleted: boolean;
  emit: (event: SessionEvent) => void;
  markDeleted(): void;
  close: WorkspaceEngineYDocProviderSession["close"];
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

class EngineYDocSessionIpc {
  readonly #generationOf: EngineYDocSessionIpcOptions["generationOf"];
  readonly #requireWorkspace: EngineYDocSessionIpcOptions["requireWorkspace"];
  readonly #captureFor: EngineYDocSessionIpcOptions["captureFor"];
  readonly #ensureCaptureFor: EngineYDocSessionIpcOptions["ensureCaptureFor"];
  readonly #isSharedView: EngineYDocSessionIpcOptions["isSharedView"];
  readonly #onError: EngineYDocSessionIpcOptions["onError"];
  readonly #owner: EngineYDocIpcSessionOwner;
  readonly #fileMutationPort: WorkspaceFileMutationYDocPort;
  readonly #cleanupHooked = new WeakSet<EngineYDocIpcSender>();
  readonly #trackedGeneration = new WeakMap<EngineYDocIpcSender, number>();

  constructor(options: EngineYDocSessionIpcOptions) {
    this.#generationOf = options.generationOf;
    this.#requireWorkspace = options.requireWorkspace;
    this.#captureFor = options.captureFor;
    this.#ensureCaptureFor = options.ensureCaptureFor;
    this.#isSharedView = options.isSharedView;
    this.#onError = options.onError;
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
      ownsDocument: (workspaceId: string, path: string) =>
        this.#owner.ownsDocument(workspaceId, path),
      forEachSessionUnderPath: (workspaceId, pathOrPrefix, visit) => {
        this.#owner.forEachSessionUnderPath(
          workspaceId,
          pathOrPrefix,
          (session) => visit({ markDeleted: () => session.markDeleted() }),
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
    const workspace = this.#requireWorkspace(input.workspaceId);
    if (this.#isSharedView(workspace.workspaceId)) return unavailableOpen();

    const validatedPath = validateUserWritePath(input.path);
    if (!validatedPath.ok) return unavailableOpen();
    const path = validatedPath.normalized;
    const requestedKind = liveDocumentKindForPath(path);
    const generation = this.#generationOf(sender.id);
    if (requestedKind === null) return unavailableOpen();

    let capture = this.#captureFor(workspace.workspaceId);
    if (!capture) {
      try {
        await this.#ensureCaptureFor(workspace.workspaceId);
      } catch (error) {
        this.#onError(
          `[desktop] engine Y.Doc open could not open the workspace activity for ${path}:`,
          error,
        );
      }
      // Window loading now overlaps the daemon handshake. The await above can
      // span a reload, and a retired renderer must never acquire its session.
      if (sender.isDestroyed() || this.#generationOf(sender.id) !== generation) {
        return unavailableOpen();
      }
      capture = this.#captureFor(workspace.workspaceId);
      if (!capture) return unavailableOpen();
    }

    this.#trackSender(sender, generation);
    const opened = await this.#owner.open({
      sender,
      generation,
      sessionId: input.sessionId,
      workspaceId: workspace.workspaceId,
      path,
      openSession: async (signals) => {
        const saveSeq = createEngineYDocSaveSeqState();
        let delivery: "pending" | "active" | "discarded" = "pending";
        const pending: Array<() => void> = [];
        const publish = (send: () => void): void => {
          if (delivery === "active") send();
          else if (delivery === "pending") pending.push(send);
        };
        let provider: WorkspaceEngineYDocProviderSession;
        try {
          provider = await capture.openYDocSession({
            path,
            contentKind: requestedKind,
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
          workspaceId: workspace.workspaceId,
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
          markDeleted() {
            owned.deleted = true;
            owned.emit({ state: "deleted", seq: owned.saveSeq.dirtySeq });
          },
          close: (options) => provider.close(options),
        };
        if (provider.contentKind === requestedKind) {
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
      if (owned.provider.contentKind !== requestedKind) {
        this.#onError(
          `[desktop] engine Y.Doc open for ${path} came back ${owned.provider.contentKind}; ` +
            `the editor requested ${requestedKind} (kind-mismatched lineage).`,
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

    this.#onError(`[desktop] engine Y.Doc open refused for ${path}:`, opened.error);
    return this.#openRefusal(opened.error);
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
        if (this.#isSharedView(owned.workspaceId)) {
          owned.emit({ state: "read-only", seq: input.seq });
          return { accepted: false, reason: "read-only" };
        }
        owned.provider.applyLocalUpdate(input.update, () =>
          noteLocalEdit(owned.saveSeq, input.seq),
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

  #trackSender(sender: EngineYDocIpcSender, generation: number): void {
    this.#trackedGeneration.set(sender, generation);
    if (this.#cleanupHooked.has(sender)) return;
    this.#cleanupHooked.add(sender);
    sender.once("destroyed", () => {
      const tracked = this.#trackedGeneration.get(sender);
      if (tracked !== undefined) {
        void this.#owner.retireSender({ sender, generation: tracked });
      }
    });
  }

  #caller(sender: EngineYDocIpcSender, sessionId: string) {
    return {
      sender,
      generation: this.#generationOf(sender.id),
      sessionId,
    };
  }

  #send(outbound: SessionOutbound): void {
    if (
      outbound.sender.isDestroyed() ||
      this.#generationOf(outbound.sender.id) !== outbound.generation
    ) {
      throw new Error("The renderer generation no longer owns this session.");
    }
    const { message } = outbound;
    try {
      if (message.kind === "session-event") {
        outbound.sender.send(
          CHANNELS.engineYDocSaveState,
          EngineYDocSaveStateEventSchema.parse({
            sessionId: outbound.sessionId,
            ...message.event,
          }),
        );
        return;
      }
      if (message.kind === "remote-update") {
        outbound.sender.send(
          CHANNELS.engineYDocRemoteUpdate,
          EngineYDocRemoteUpdateEventSchema.parse({
            sessionId: outbound.sessionId,
            update: message.update,
            lineageGeneration: message.lineageGeneration,
          }),
        );
        return;
      }
      outbound.sender.send(
        CHANNELS.engineYDocLineageReplacement,
        EngineYDocLineageReplacementEventSchema.parse({
          sessionId: outbound.sessionId,
          ...message.replacement,
          lineageGeneration: message.lineageGeneration,
        }),
      );
    } catch (error) {
      if (
        !outbound.sender.isDestroyed() &&
        this.#generationOf(outbound.sender.id) === outbound.generation
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
