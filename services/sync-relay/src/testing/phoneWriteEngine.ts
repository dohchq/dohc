import { asRecord } from "@dohc/workspace-core";
import {
  CHATS_METHOD,
  ChatsLiveAdapter,
  type EngineTransport,
  type JsonValue,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import {
  ChatsLoopbackEngine,
  VersionedLoopbackEngine,
} from "@dohc/workspace-engine-client/testing";

// An in-memory stand-in for a copy's engine that takes the phone's chat
// writes. It writes a receipt for each keyed stage, as the engine does, and
// lists the rows each stage journaled, which the test's copy pushes.

const WRITES = new Set<string>([
  CHATS_METHOD.threadStart,
  CHATS_METHOD.messageSend,
  CHATS_METHOD.decisionResolve,
  CHATS_METHOD.reactionSet,
]);

/** One row a stage journaled, and whether the copy pushed it yet. */
export type PhoneWriteRow = {
  originSeq: number;
  kind: string;
  payload: { [field: string]: JsonValue };
  pushed: boolean;
};
type Receipt = {
  threadId: string;
  outcome: "written" | "lost";
  winnerMessageId?: string;
  rows: PhoneWriteRow[];
};

export class PhoneWriteEngine implements EngineTransport {
  readonly chats = new ChatsLoopbackEngine();
  readonly files = new VersionedLoopbackEngine();
  readonly failing = new Map<string, Error>();
  /** Errors a method answers with after its write committed, as an engine whose answer failed after the commit. */
  readonly failAfter = new Map<string, Error>();
  /** Each chat write that reached the engine, in order. */
  readonly writes: Request[] = [];
  /** The method of each request asked of the engine, including one it then failed. */
  readonly asked: string[] = [];
  readonly receipts = new Map<string, Receipt>();
  /** Runs as each chat write reaches the engine, before it changes anything. */
  beforeWrite: () => void = () => undefined;
  /** Journals the account's read mark with a person's message, as a copy that shows the account's read places does. */
  readMarks = false;
  /** Each explicit read mark that reached the engine, in order. */
  readonly marks: Request[] = [];
  /** The rows explicit read marks journaled, which the copy pushes with the receipts' rows. */
  private readonly markRows: PhoneWriteRow[] = [];
  private readonly held = new Map<string, { reached(): void; open: Promise<void> }>();
  private originSeq = 0;

  constructor(
    private readonly workspaceId: string,
    private readonly originId: string,
  ) {}

  onEvent() {
    return () => undefined;
  }
  close() {}

  /** Holds the next request for `method` until the test releases it. `reached` resolves once it waits. */
  hold(method: string): { reached: Promise<void>; release(): void } {
    let reached!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    this.held.set(method, {
      reached,
      open: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    return { reached: waiting, release: () => release() };
  }

  async sendRequest(request: Request): Promise<Response> {
    this.asked.push(request.method);
    const held = this.held.get(request.method);
    if (held !== undefined) {
      this.held.delete(request.method);
      held.reached();
      await held.open;
    }
    const failure = this.failing.get(request.method);
    if (failure) throw failure;
    if (request.method === "sync.ordinary.publicationState") {
      const stageKeys = asRecord(request.params)?.stageKeys as string[];
      return {
        id: request.id,
        result: { stages: stageKeys.map((stageKey) => this.stateOf(stageKey)) },
      };
    }
    if (!request.method.startsWith("chats.")) return await this.files.sendRequest(request);
    if (request.method === CHATS_METHOD.readStateMarkAccountRead) return await this.mark(request);
    const write = WRITES.has(request.method);
    if (write) {
      this.writes.push(request);
      this.beforeWrite();
    }
    let response: Response;
    try {
      response = await this.chats.sendRequest(request);
    } catch (error) {
      // The engine's own refusal: the request didn't happen, and won't if asked again.
      throw new EngineRequestError(
        request.id,
        {
          code: "INVALID_PARAMS",
          message: error instanceof Error ? error.message : "refused",
          retry: "no",
        },
        request.method,
      );
    }
    if (
      write &&
      asRecord(request.params)?.stageReceipt === true &&
      typeof request.idempotencyKey === "string"
    ) {
      await this.receive(request, request.idempotencyKey);
    }
    const after = this.failAfter.get(request.method);
    if (after) throw after;
    return response;
  }

  /** Pushes each row the receipts and read marks list that the relay hasn't had yet, in the order the engine journaled them. */
  push(relay: (row: PhoneWriteRow) => void): void {
    const rows = [...this.receipts.values()]
      .flatMap((receipt) => receipt.rows)
      .concat(this.markRows);
    for (const row of rows.sort((left, right) => left.originSeq - right.originSeq)) {
      if (row.pushed) continue;
      relay(row);
      row.pushed = true;
    }
  }

  // The engine moves the mark to the message and journals it with the owner's context, as a copy that shows the
  // account's read places does. The stand-in keeps no mark, so a repeat journals again.
  private async mark(request: Request): Promise<Response> {
    this.marks.push(request);
    let response: Response;
    try {
      response = await this.chats.sendRequest(request);
    } catch (error) {
      throw new EngineRequestError(
        request.id,
        {
          code: "INVALID_PARAMS",
          message: error instanceof Error ? error.message : "refused",
          retry: "no",
        },
        request.method,
      );
    }
    const params = asRecord(request.params) ?? {};
    if (typeof params.replicationOwnerUserId === "string") {
      const read = new ChatsLiveAdapter(this.chats, String(request.workspace), {
        workspaceId: this.workspaceId,
      });
      const message = await read.getMessage({
        workspaceId: this.workspaceId,
        messageId: String(params.messageId),
      });
      this.markRows.push({
        originSeq: ++this.originSeq,
        kind: "chat.thread.read.set",
        pushed: false,
        payload: {
          accountUserId: params.replicationOwnerUserId,
          threadId: message.threadId,
          lastReadCreatedAtMs: message.createdAtMs,
          lastReadMessageId: message.id,
          atMs: message.createdAtMs,
          ownerPrivateAccountId: params.replicationOwnerUserId,
        },
      });
    }
    return response;
  }

  private stateOf(stageKey: string): JsonValue {
    const receipt = this.receipts.get(stageKey);
    if (receipt === undefined) return { stageKey, state: "absent" };
    return {
      stageKey,
      state: "present",
      outcome: receipt.outcome,
      threadId: receipt.threadId,
      ...(receipt.winnerMessageId === undefined
        ? {}
        : { winnerMessageId: receipt.winnerMessageId }),
      coordinates: receipt.rows.map((row) => ({
        originId: this.originId,
        originSeq: row.originSeq,
        state: row.pushed ? "pushed" : "pending",
      })),
    };
  }

  // What the engine journals for a stage, read back from the stand-in.
  private async receive(request: Request, key: string): Promise<void> {
    if (this.receipts.has(key)) return;
    const { workspaceId } = this;
    const params = asRecord(request.params) ?? {};
    const read = new ChatsLiveAdapter(this.chats, String(request.workspace), { workspaceId });
    const row = (kind: string, payload: { [field: string]: JsonValue }): PhoneWriteRow => ({
      originSeq: ++this.originSeq,
      kind,
      payload,
      pushed: false,
    });
    if (request.method === CHATS_METHOD.decisionResolve) {
      const threadId = String(params.threadId);
      const decision = (await read.listThreadDecisions(workspaceId, threadId)).find(
        (each) => each.messageId === params.messageId,
      );
      const winner = decision?.resolvedByMessageId ?? "";
      const chosen = decision?.chosenOption;
      this.receipts.set(
        key,
        winner === params.resolvedByMessageId
          ? {
              threadId,
              outcome: "written",
              rows: [
                row("chat.decision.set", {
                  threadId,
                  messageId: String(params.messageId),
                  state: "resolved",
                  resolvedByMessageId: winner,
                  ...(decision?.options && decision.options.length > 0
                    ? { options: [...decision.options] }
                    : {}),
                  ...(chosen === undefined ? {} : { chosenOption: chosen }),
                  atMs: 2,
                }),
              ],
            }
          : { threadId, outcome: "lost", winnerMessageId: winner, rows: [] },
      );
      return;
    }
    if (request.method === CHATS_METHOD.reactionSet) {
      const threadId = String(params.threadId);
      this.receipts.set(key, {
        threadId,
        outcome: "written",
        rows: [
          row("chat.reaction.set", {
            threadId,
            messageId: String(params.messageId),
            emoji: String(params.emoji),
            authorId: String(asRecord(params.author)?.authorId),
            authorKind: "human",
            authorDisplayName: String(asRecord(params.author)?.displayName),
            state: String(params.state),
            atMs: 3,
          }),
        ],
      });
      return;
    }
    const message = await read.getMessage({ workspaceId, messageId: String(params.messageId) });
    const rows = [
      row("chat.message.append", {
        messageId: message.id,
        threadId: message.threadId,
        authorKind: message.author.kind,
        authorDisplayName: message.author.displayName,
        authorUserId: message.authorUserId ?? null,
        body: message.body,
        createdAtMs: message.createdAtMs,
        ...(message.parentMessageId === undefined
          ? {}
          : { parentMessageId: message.parentMessageId }),
      }),
    ];
    if (
      this.readMarks &&
      message.author.kind === "human" &&
      typeof message.authorUserId === "string"
    ) {
      rows.push(
        row("chat.thread.read.set", {
          accountUserId: message.authorUserId,
          threadId: message.threadId,
          lastReadCreatedAtMs: message.createdAtMs,
          lastReadMessageId: message.id,
          atMs: message.createdAtMs,
          ownerPrivateAccountId: message.authorUserId,
        }),
      );
    }
    // The open question, with its choices as the engine stores them.
    const options =
      (await read.listThreadDecisions(workspaceId, message.threadId)).find(
        (each) => each.messageId === message.id,
      )?.options ?? [];
    if (params.needsDecision === true || options.length > 0) {
      rows.push(
        row("chat.decision.set", {
          threadId: message.threadId,
          messageId: message.id,
          state: "open",
          ...(options.length > 0 ? { options: [...options] } : {}),
          atMs: 1,
        }),
      );
    }
    this.receipts.set(key, { threadId: message.threadId, outcome: "written", rows });
  }
}

const human = { kind: "human" as const, displayName: "Ana" };

/** A Group with a post, an agent's poll in it, and a thread on a secret file with a question of the owner's. */
export async function seedPhoneChats(
  chats: ChatsLiveAdapter,
  workspaceId: string,
  ownerUserId: string,
) {
  const planning = await chats.createChannel({ workspaceId, name: "Planning", type: "both" });
  await chats.startChannelThread({
    workspaceId,
    channelId: planning.channelId,
    threadId: "thread-stay",
    messageId: "message-stay",
    lane: "posts",
    author: human,
    authorUserId: ownerUserId,
    authorActorKey: null,
    body: "Where do we stay?",
  });
  await chats.sendMessage({
    workspaceId,
    threadId: "thread-stay",
    messageId: "message-poll",
    author: { kind: "agent", displayName: "Nova" },
    authorOwnerDisplayName: "Ana",
    authorActorKey: null,
    body: "Alfama or Baixa?",
    options: ["Alfama", "Baixa"],
  });
  const onSecret = await chats.createThread({
    workspaceId,
    title: "Keys",
    linkedFile: { objectId: "object-env", pathHint: ".env" },
  });
  await chats.sendMessage({
    workspaceId,
    threadId: onSecret.id,
    messageId: "message-secret",
    author: human,
    authorUserId: ownerUserId,
    authorActorKey: null,
    body: "Which key?",
    needsDecision: true,
  });
  return { planning, onSecret };
}
