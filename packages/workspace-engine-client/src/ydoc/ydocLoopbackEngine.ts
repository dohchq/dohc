import { createHash } from "node:crypto";
import * as Y from "yjs";
import type { Event } from "./generated/Event";
import type { JsonValue } from "./generated/serde_json/JsonValue";
import type { Request } from "./generated/Request";
import type { Response } from "./generated/Response";
import type { EngineTransport } from "./ydocLiveAdapter";
import {
  YDOC_EVENT,
  YDOC_METHOD,
  type JsonObject,
  type YdocContentKind,
} from "./ydocWireContract";

interface LoopbackFile {
  objectId: string;
  contentKind: YdocContentKind;
  markdown: string;
}

interface LoopbackSession {
  sessionId: string;
  workspace: string;
  versionId: string;
  objectId: string;
  path: string;
  contentKind: YdocContentKind;
  doc: Y.Doc;
  updateSeq: number;
  eventSeq: number;
}

export interface EmitLoopbackRemoteUpdateOptions {
  seq?: number;
  sessionGeneration?: number;
}

export interface SeedLoopbackFileInput {
  workspace: string;
  versionId: string;
  path: string;
  markdown: string;
  contentKind?: YdocContentKind;
  objectId?: string;
}

function fileKey(workspace: string, versionId: string, path: string): string {
  return `${workspace}\u0000${versionId}\u0000${path}`;
}

function asObject(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requiredString(object: JsonObject, key: string, label: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error(`${label}.${key} is invalid.`);
  return value;
}

function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} is invalid.`);
  return value;
}

function optionalBoolean(object: JsonObject, key: string): boolean | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} is invalid.`);
  return value;
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createSeededDoc(markdown: string, contentKind: YdocContentKind): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap("frontmatter");
  doc.getMap("meta");
  doc.getXmlFragment("body");
  doc.getText("plainText");
  if (contentKind === "plaintext") {
    doc.getText("plainText").insert(0, markdown);
  } else if (markdown.length > 0) {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(markdown)]);
    doc.getXmlFragment("body").insert(0, [paragraph]);
  }
  return doc;
}

function project(session: LoopbackSession): string {
  if (session.contentKind === "plaintext") {
    return session.doc.getText("plainText").toString();
  }
  return session.doc
    .getXmlFragment("body")
    .toArray()
    .map((node) => {
      if (node instanceof Y.XmlText) return node.toString();
      if (node instanceof Y.XmlElement) {
        return node
          .toArray()
          .map((child) => child.toString())
          .join("");
      }
      return node.toString();
    })
    .join("\n\n");
}

export class YdocLoopbackEngine implements EngineTransport {
  readonly requests: Request[] = [];
  readonly responses: Response[] = [];
  readonly events: Event[] = [];
  readonly recordedUpdates: Uint8Array[] = [];

  private readonly files = new Map<string, LoopbackFile>();
  private readonly sessions = new Map<string, LoopbackSession>();
  private readonly eventHandlers = new Set<(event: Event) => void>();
  private nextSessionId = 1;
  private nextMomentId = 1;

  seedFile(input: SeedLoopbackFileInput): void {
    this.files.set(fileKey(input.workspace, input.versionId, input.path), {
      objectId: input.objectId ?? `object-${this.files.size + 1}`,
      contentKind: input.contentKind ?? "richdoc",
      markdown: input.markdown,
    });
  }

  onEvent(handler: (event: Event) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
    const result = this.handleRequest(request);
    const response: Response = { id: request.id, result };
    this.responses.push(response);
    return response;
  }

  activeSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  sessionText(sessionId: string): string {
    return project(this.requireSession(sessionId));
  }

  sessionStateUpdate(sessionId: string): Uint8Array {
    return Y.encodeStateAsUpdate(this.requireSession(sessionId).doc);
  }

  applyRemoteUpdate(
    sessionId: string,
    update: Uint8Array,
    options?: EmitLoopbackRemoteUpdateOptions,
  ): void {
    const session = this.requireSession(sessionId);
    Y.applyUpdate(session.doc, update);
    this.emitRemoteUpdate(sessionId, update, options);
  }

  emitRemoteUpdate(
    sessionId: string,
    update: Uint8Array,
    options?: EmitLoopbackRemoteUpdateOptions,
  ): void {
    const session = this.requireSession(sessionId);
    const seq = options?.seq ?? session.eventSeq + 1;
    session.eventSeq = seq;
    const event: Event = {
      seq,
      sessionGeneration: options?.sessionGeneration ?? 1,
      name: YDOC_EVENT.remoteUpdate,
      payload: {
        sessionId,
        updateBase64: encodeBase64(update),
      },
    };
    this.emitEvent(event);
  }

  emitEvent(event: Event): void {
    this.events.push(event);
    for (const handler of this.eventHandlers) handler(event);
  }

  private handleRequest(request: Request): JsonValue {
    switch (request.method) {
      case YDOC_METHOD.open:
        return this.open(request);
      case YDOC_METHOD.recordUpdate:
        return this.recordUpdate(request);
      case YDOC_METHOD.settle:
        return this.settle(request.params);
      case YDOC_METHOD.applyExternalMarkdownEdit:
        return this.applyExternalMarkdownEdit(request.params);
      case YDOC_METHOD.close:
        return this.close(request.params);
      case YDOC_METHOD.resync:
        return this.resync(request.params);
      default:
        throw new Error(`Unsupported loopback method: ${request.method}`);
    }
  }

  private open(request: Request): JsonValue {
    if (typeof request.workspace !== "string") {
      throw new Error("ydoc.open requires a workspace handle.");
    }
    const params = asObject(request.params, "ydoc.open params");
    const versionId = requiredString(params, "versionId", "ydoc.open params");
    const path = requiredString(params, "path", "ydoc.open params");
    const requestedKind = optionalString(params, "contentKind");
    if (
      requestedKind !== undefined &&
      requestedKind !== "richdoc" &&
      requestedKind !== "plaintext"
    ) {
      throw new Error("ydoc.open params.contentKind is invalid.");
    }
    const file = this.files.get(fileKey(request.workspace, versionId, path));
    if (!file) throw new Error("Loopback file not found.");
    const contentKind = requestedKind ?? file.contentKind;
    const sessionId = `session-${this.nextSessionId++}`;
    const doc = createSeededDoc(file.markdown, contentKind);
    this.sessions.set(sessionId, {
      sessionId,
      workspace: request.workspace,
      versionId,
      objectId: file.objectId,
      path,
      contentKind,
      doc,
      updateSeq: 0,
      eventSeq: 0,
    });
    return {
      sessionId,
      objectId: file.objectId,
      path,
      contentKind,
      initialUpdateBase64: encodeBase64(Y.encodeStateAsUpdate(doc)),
    };
  }

  private recordUpdate(request: Request): JsonValue {
    if (
      typeof request.idempotencyKey !== "string" ||
      request.idempotencyKey.length === 0
    ) {
      throw new Error("ydoc.recordUpdate requires an idempotency key.");
    }
    const params = asObject(request.params, "ydoc.recordUpdate params");
    const session = this.requireSession(
      requiredString(params, "sessionId", "ydoc.recordUpdate params"),
    );
    const update = decodeBase64(
      requiredString(params, "updateBase64", "ydoc.recordUpdate params"),
    );
    optionalString(params, "actorOriginId");
    const validationDoc = new Y.Doc();
    Y.applyUpdate(validationDoc, Y.encodeStateAsUpdate(session.doc));
    Y.applyUpdate(validationDoc, update);
    Y.applyUpdate(session.doc, update);
    this.recordedUpdates.push(update);
    session.updateSeq += 1;
    return { seq: session.updateSeq };
  }

  private settle(value: JsonValue): JsonValue {
    const params = asObject(value, "ydoc.settle params");
    const session = this.requireSession(
      requiredString(params, "sessionId", "ydoc.settle params"),
    );
    optionalString(params, "summary");
    const markdown = project(session);
    return {
      momentId: `moment-${this.nextMomentId++}`,
      path: session.path,
      markdown,
      sha256: sha256(markdown),
      projection: {
        contentKind: session.contentKind,
        sourceStateVectorSha256: sha256(Y.encodeStateVector(session.doc)),
        destructive: false,
      },
    };
  }

  private applyExternalMarkdownEdit(value: JsonValue): JsonValue {
    const params = asObject(value, "ydoc.applyExternalMarkdownEdit params");
    const session = this.requireSession(
      requiredString(
        params,
        "sessionId",
        "ydoc.applyExternalMarkdownEdit params",
      ),
    );
    const markdown = requiredString(
      params,
      "markdown",
      "ydoc.applyExternalMarkdownEdit params",
    );
    const before = Y.encodeStateVector(session.doc);
    session.doc.transact(() => {
      if (session.contentKind === "plaintext") {
        const text = session.doc.getText("plainText");
        text.delete(0, text.length);
        text.insert(0, markdown);
      } else {
        const body = session.doc.getXmlFragment("body");
        body.delete(0, body.length);
        if (markdown.length > 0) {
          const paragraph = new Y.XmlElement("paragraph");
          paragraph.insert(0, [new Y.XmlText(markdown)]);
          body.insert(0, [paragraph]);
        }
      }
    });
    this.emitRemoteUpdate(
      session.sessionId,
      Y.encodeStateAsUpdate(session.doc, before),
    );
    return { kind: "merged", markdown };
  }

  private close(value: JsonValue): JsonValue {
    const params = asObject(value, "ydoc.close params");
    const sessionId = requiredString(params, "sessionId", "ydoc.close params");
    optionalBoolean(params, "settle");
    optionalString(params, "summary");
    this.requireSession(sessionId);
    this.sessions.delete(sessionId);
    return { closed: true };
  }

  private resync(value: JsonValue): JsonValue {
    const params = asObject(value, "ydoc.resync params");
    const session = this.requireSession(
      requiredString(params, "sessionId", "ydoc.resync params"),
    );
    // The live adapter preserves its event position across a resync, so the
    // loopback sequence stays MONOTONIC — resetting it would make the next
    // remote update emit seq 1 and re-mark the freshly-resynced session
    // stale.
    return {
      initialUpdateBase64: encodeBase64(Y.encodeStateAsUpdate(session.doc)),
    };
  }

  private requireSession(sessionId: string): LoopbackSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown loopback session: ${sessionId}`);
    return session;
  }
}
