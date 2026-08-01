import { createHash, randomUUID } from "node:crypto";
import type {
  ActorNeutralWriteMetadata,
  ChatMessageAppendPayload,
  ChatThreadCreatePayload,
  MomentAppendPayload,
  SyncReplicationOpKind,
} from "@dohc/workspace-contracts/engine";
import type { RelayWorkspaceIdentity } from "@dohc/workspace-contracts/relay";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_OPS_PER_APPEND = 500;
const BLOB_UPLOAD_CONCURRENCY = 16;

interface RelayOperation {
  originSeq: number;
  opKind: SyncReplicationOpKind;
  payload: Record<string, unknown>;
  recordedAtMs: number;
}

export interface RelayFileHead {
  objectId: string;
  objectCreatedAtMs: number;
  path: string;
  blobSha256: string;
  updatedAtMs: number;
  latestMomentId: string;
  metadata: ActorNeutralWriteMetadata;
}

export interface RelayTextWrite {
  path: string;
  text: string;
  metadata?: ActorNeutralWriteMetadata;
  /** Test seam for proving that a receiver rejects a false preimage. */
  beforeOverride?: RelayFileHead | null;
}

export interface RelayLinkedChatInput {
  linkedObjectId: string;
  linkedPathHint: string;
  title: string;
  body: string;
  authorDisplayName: string;
  authorUserId: string;
}

export interface RelayLinkedChat {
  threadId: string;
  messageId: string;
}

export interface RelayFilePeerOptions {
  baseUrl: string;
  token: string;
  workspaceId: string;
  originId?: string;
  identity?: RelayWorkspaceIdentity;
  fetch?: typeof fetch;
  nowMs?: () => number;
  newId?: (kind: "moment" | "object" | "thread" | "message") => string;
}

/**
 * A test-only relay peer that writes protocol operations without the retired
 * TypeScript engine. It models one remote machine and one ordered origin.
 */
export class RelayFilePeer {
  readonly originId: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly workspaceId: string;
  private readonly identity?: RelayWorkspaceIdentity;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly mintId: NonNullable<RelayFilePeerOptions["newId"]>;
  private readonly heads = new Map<string, RelayFileHead>();
  private initialized = false;
  private nextOriginSeq = 0;
  private lastRecordedAtMs = -1;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: RelayFilePeerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.token = options.token;
    this.workspaceId = options.workspaceId;
    this.originId = options.originId ?? `relay-file-peer-${randomUUID()}`;
    this.identity = options.identity;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.nowMs ?? Date.now;
    this.mintId =
      options.newId ?? ((kind) => `relay-file-peer-${kind}-${randomUUID()}`);
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => await this.initializeUnlocked());
  }

  async writeText(path: string, text: string): Promise<RelayFileHead>;
  async writeText(input: RelayTextWrite): Promise<RelayFileHead>;
  async writeText(
    pathOrInput: string | RelayTextWrite,
    text?: string,
  ): Promise<RelayFileHead> {
    const input =
      typeof pathOrInput === "string"
        ? { path: pathOrInput, text: text ?? "" }
        : pathOrInput;
    const [head] = await this.writeTextFiles([input]);
    return head!;
  }

  async writeTextFiles(writes: RelayTextWrite[]): Promise<RelayFileHead[]> {
    return await this.exclusive(async () => {
      await this.initializeUnlocked();
      const results: RelayFileHead[] = [];
      for (let offset = 0; offset < writes.length; offset += MAX_OPS_PER_APPEND) {
        const batch = writes.slice(offset, offset + MAX_OPS_PER_APPEND);
        const stagedHeads = new Map(this.heads);
        const prepared = batch.map((write, index) => {
          const item = this.prepareWrite(
            write,
            this.nextOriginSeq + index,
            stagedHeads,
          );
          stagedHeads.set(item.head.path, item.head);
          return item;
        });
        await this.uploadBlobs(prepared.map((item) => item.blob));
        await this.append(prepared.map((item) => item.operation));
        this.nextOriginSeq += prepared.length;
        for (const item of prepared) {
          this.heads.set(item.head.path, item.head);
          results.push(item.head);
        }
      }
      return results;
    });
  }

  async createLinkedChat(input: RelayLinkedChatInput): Promise<RelayLinkedChat> {
    return await this.exclusive(async () => {
      await this.initializeUnlocked();
      const threadId = this.mintId("thread");
      const messageId = this.mintId("message");
      const createdAtMs = this.recordedAtMs();
      const thread: ChatThreadCreatePayload = {
        threadId,
        title: input.title,
        createdAtMs,
        linkedObjectId: input.linkedObjectId,
        linkedPathHint: input.linkedPathHint,
        linkedAtMs: createdAtMs,
      };
      const message: ChatMessageAppendPayload = {
        messageId,
        threadId,
        authorKind: "human",
        authorDisplayName: input.authorDisplayName,
        authorUserId: input.authorUserId,
        body: input.body,
        createdAtMs: this.recordedAtMs(),
      };
      const operations: RelayOperation[] = [
        this.operation("chat.thread.create", thread, this.nextOriginSeq),
        this.operation("chat.message.append", message, this.nextOriginSeq + 1),
      ];
      await this.append(operations);
      this.nextOriginSeq += operations.length;
      return { threadId, messageId };
    });
  }

  private async initializeUnlocked(): Promise<void> {
    if (this.initialized) return;
    const operation = this.operation("workspace.init", {}, this.nextOriginSeq);
    await this.append([operation]);
    this.nextOriginSeq += 1;
    this.initialized = true;
  }

  private prepareWrite(
    input: RelayTextWrite,
    originSeq: number,
    knownHeads: ReadonlyMap<string, RelayFileHead>,
  ): {
    blob: { sha256: string; bytes: ArrayBuffer };
    operation: RelayOperation;
    head: RelayFileHead;
  } {
    const bytes = Buffer.from(input.text, "utf8");
    const blobSha256 = createHash("sha256").update(bytes).digest("hex");
    const blobBytes = Uint8Array.from(bytes).buffer;
    const trackedBefore = knownHeads.get(input.path);
    const before =
      Object.prototype.hasOwnProperty.call(input, "beforeOverride")
        ? input.beforeOverride
        : trackedBefore;
    const recordedAtMs = this.recordedAtMs();
    const metadata = input.metadata ?? { origin: "local-file" };
    const objectId = before?.objectId ?? trackedBefore?.objectId ?? this.mintId("object");
    const objectCreatedAtMs =
      before?.objectCreatedAtMs ?? trackedBefore?.objectCreatedAtMs ?? recordedAtMs;
    const momentId = this.mintId("moment");
    const payload: MomentAppendPayload = {
      momentId,
      versionId: "main",
      objectId,
      objectCreatedAtMs,
      path: input.path,
      recordedAtMs,
      operation: "write",
      payloadBeforeBlobSha256: before?.blobSha256 ?? null,
      payloadBeforePath: before?.path ?? null,
      payloadAfterBlobSha256: blobSha256,
      payloadAfterPath: input.path,
      metadata,
      beforePresent: before ? "present" : "null",
      ...(before
        ? {
            beforeObjectId: before.objectId,
            beforeVersionId: "main" as const,
            beforePath: before.path,
            beforeBlobSha256: before.blobSha256,
            beforeUpdatedAtMs: before.updatedAtMs,
            beforeLatestMomentId: before.latestMomentId,
            beforeMetadata: before.metadata,
          }
        : {}),
    };
    return {
      blob: { sha256: blobSha256, bytes: blobBytes },
      operation: this.operation("moment.append", payload, originSeq, recordedAtMs),
      head: {
        objectId,
        objectCreatedAtMs,
        path: input.path,
        blobSha256,
        updatedAtMs: recordedAtMs,
        latestMomentId: momentId,
        metadata,
      },
    };
  }

  private operation(
    opKind: SyncReplicationOpKind,
    payload: object,
    originSeq: number,
    recordedAtMs = this.recordedAtMs(),
  ): RelayOperation {
    return {
      originSeq,
      opKind,
      payload: payload as Record<string, unknown>,
      recordedAtMs,
    };
  }

  private recordedAtMs(): number {
    this.lastRecordedAtMs = Math.max(this.now(), this.lastRecordedAtMs + 1);
    return this.lastRecordedAtMs;
  }

  private async uploadBlobs(
    blobs: Array<{ sha256: string; bytes: ArrayBuffer }>,
  ): Promise<void> {
    const unique = new Map(blobs.map((blob) => [blob.sha256, blob]));
    if (unique.size === 0) return;
    const have = await this.request("blobs/have", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha256s: [...unique.keys()] }),
    });
    const body = await this.requireJson(have, "blob inventory");
    const missing = body.missing;
    if (!Array.isArray(missing) || missing.some((sha) => typeof sha !== "string")) {
      throw new Error("Relay blob inventory returned an invalid missing list.");
    }
    for (let offset = 0; offset < missing.length; offset += BLOB_UPLOAD_CONCURRENCY) {
      await Promise.all(
        missing.slice(offset, offset + BLOB_UPLOAD_CONCURRENCY).map(async (sha256) => {
          const blob = unique.get(sha256);
          if (!blob) {
            throw new Error(`Relay requested an unlisted blob: ${sha256}.`);
          }
          const response = await this.request(`blobs/${sha256}`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: blob.bytes,
          });
          await this.requireOk(response, `blob upload ${sha256}`);
        }),
      );
    }
  }

  private async append(ops: RelayOperation[]): Promise<void> {
    if (ops.length === 0) return;
    const response = await this.request("log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        originId: this.originId,
        ops,
        ...this.identity,
      }),
    });
    await this.requireOk(response, `log append at origin sequence ${ops[0]!.originSeq}`);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    const requestPath = `/sync/${encodeURIComponent(this.workspaceId)}/${path}`;
    try {
      return await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(
          `Relay request ${requestPath} timed out after ${REQUEST_TIMEOUT_MS} ms.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async requireJson(
    response: Response,
    operation: string,
  ): Promise<Record<string, unknown>> {
    await this.requireOk(response, operation);
    const value = (await response.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Relay ${operation} returned an invalid JSON object.`);
    }
    return value as Record<string, unknown>;
  }

  private async requireOk(response: Response, operation: string): Promise<void> {
    if (response.ok) return;
    throw new Error(
      `Relay ${operation} failed with status ${response.status}: ${await response.text()}`,
    );
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}
