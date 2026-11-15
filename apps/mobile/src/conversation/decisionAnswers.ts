import { chatWords } from "@dohc/interface-words/notices";
import type { ChatWrite } from "../server/chatWrites";
import type { OutboxState } from "../server/outbox";
import type { ChatMessage } from "../server/workspaceReads";
import type { OutboxRecord } from "./conversationWrites";
import type { OutboxScope } from "./outboxMessages";
import type { Decision } from "./types";

// A message's question or poll as the phone shows it, and the reply that answers it. An answer is an ordinary reply
// through the outbox, with `resolves` naming the question. Until the outbox settles this phone's answer, it shows as on
// its way, even when a read shows the question answered; once settled, the server's state wins as soon as a read shows
// it. An answer the server refused as already answered keeps the winning answer it names.

/** What a decision's card needs of the message that asks it, as the server's reads give it. */
export type Asked = Pick<
  ChatMessage,
  | "id"
  | "threadId"
  | "parentMessageId"
  | "decisionState"
  | "options"
  | "chosenOption"
  | "resolvedByMessageId"
>;

/** A message the screen's read shows, by ID, to name a winning answer. */
export type Shown = (id: string) => Pick<ChatMessage, "authorName" | "body"> | undefined;

const nothingShown: Shown = () => undefined;

/** The account's answers in one workspace that the outbox keeps, by the question each answers, oldest first. */
export function answerRecords(
  state: OutboxState,
  scope: OutboxScope & { readonly workspaceId: string },
): ReadonlyMap<string, readonly OutboxRecord[]> {
  const byQuestion = new Map<string, OutboxRecord[]>();
  for (const record of state.records) {
    const { write } = record;
    if (
      record.origin !== scope.origin ||
      record.accountId !== scope.accountId ||
      record.workspaceId !== scope.workspaceId ||
      write.operation !== "reply" ||
      write.args.resolves === undefined
    )
      continue;
    const question = write.args.resolves.messageId;
    byQuestion.set(question, [...(byQuestion.get(question) ?? []), record]);
  }
  return byQuestion;
}

const unfinished = (record: OutboxRecord) =>
  record.stage === "queued" || record.stage === "sending" || record.stage === "stalled";

const chosenOf = (record: OutboxRecord) =>
  record.write.operation === "reply" ? (record.write.args.resolves?.chosenOption ?? null) : null;

const latest = (records: readonly OutboxRecord[], test: (record: OutboxRecord) => boolean) =>
  [...records].reverse().find(test);

/**
 * The card for `asked`, or null when it asks nothing. `answers` are this phone's answers to it, from `answerRecords`.
 * A refused answer for another reason, or one whose chat is gone, changes nothing here: its reply's row says why.
 */
export function decisionOf(
  asked: Asked,
  answers: readonly OutboxRecord[] = [],
  shown: Shown = nothingShown,
): Decision | null {
  if (asked.decisionState === null) return null;
  const { options } = asked;
  const resolved = asked.decisionState === "resolved";
  const serverChosen = resolved ? asked.chosenOption : null;
  const lost = latest(
    answers,
    (record) => record.result?.kind === "refused" && record.result.reason === "already answered",
  );
  if (lost) {
    const named = lost.result?.kind === "refused" ? lost.result.winnerMessageId : null;
    const winnerId = named ?? (resolved ? asked.resolvedByMessageId : null);
    const winner = winnerId === null ? undefined : shown(winnerId);
    return {
      options,
      state: {
        kind: "lost",
        chosen: serverChosen,
        winner: winner ? { name: winner.authorName, body: winner.body } : null,
        replySent: lost.messageId !== null && shown(lost.messageId) !== undefined,
      },
    };
  }
  const sending = latest(answers, (record) => unfinished(record) && !record.withheld);
  if (sending) return { options, state: { kind: "answering", chosen: chosenOf(sending) } };
  if (resolved) return { options, state: { kind: "answered", chosen: serverChosen } };
  const saved = latest(answers, (record) => record.stage === "saved");
  if (saved) return { options, state: { kind: "answered", chosen: chosenOf(saved) } };
  if (answers.some((record) => unfinished(record) && record.withheld))
    return { options, state: { kind: "held" } };
  return { options, state: { kind: "open" } };
}

/** The card's status, in the desktop's words. A lost answer whose winner a read doesn't show says only Answered. */
export function decisionWord({ state }: Decision): string {
  switch (state.kind) {
    case "open":
    case "held":
      return chatWords.unanswered;
    case "answering":
      return chatWords.answering;
    case "answered":
      return chatWords.answered;
    case "lost":
      return state.winner ? chatWords.alreadyAnswered : chatWords.answered;
  }
}

/** Where an answer goes: always the question's own thread, under `parentMessageId` when there is one. */
export interface AnswerPlace {
  readonly threadId: string;
  readonly parentMessageId: string | null;
}

/**
 * Where an answer to `question` goes, as the desktop's chat sends one (apps/desktop/src/renderer/workbench/ChatLane.tsx,
 * `sendReply` and `chooseOption`). A post's answer goes at the top of the post's thread. In a chat's conversation, a
 * poll's choice goes beside the poll, under the poll's own parent, and a free answer under the first message of the
 * poll's chain of replies that `parentOf` knows, which is the question itself when it has no parent.
 */
export function answerPlace(
  question: Pick<Asked, "id" | "threadId" | "parentMessageId">,
  parentOf: (id: string) => string | null | undefined,
  how: { readonly post: boolean; readonly poll: boolean },
): AnswerPlace {
  const { threadId } = question;
  if (how.post) return { threadId, parentMessageId: null };
  if (how.poll) return { threadId, parentMessageId: question.parentMessageId };
  let root = question.id;
  let parent = question.parentMessageId;
  // A reply whose parent the read doesn't show starts its own chain, as the desktop's splitThreads decides.
  for (const seen = new Set([root]); parent !== null && !seen.has(parent);) {
    const next = parentOf(parent);
    if (next === undefined) break;
    root = parent;
    seen.add(root);
    parent = next;
  }
  return { threadId, parentMessageId: root };
}

/**
 * What a composer answering a question does with its text. `answer`: the question takes it, at `place`. `closed`: the
 * question no longer takes an answer, so Send stays off and the text stays until the person cancels Answer or chooses
 * another message; it never goes as an ordinary reply. `waiting`: where the answer goes isn't known yet.
 */
export type AnswerTarget =
  | { readonly kind: "answer"; readonly place: AnswerPlace }
  | { readonly kind: "closed" }
  | { readonly kind: "waiting" };

/**
 * Where a free answer to `asked` goes, given the question as the screen's read shows it, or undefined when the read no
 * longer shows it. `answers` are this phone's answers to it. `post` says whether its thread is a post's, null while
 * that isn't known.
 */
export function answerTarget(
  asked: Asked | undefined,
  answers: readonly OutboxRecord[] | undefined,
  parentOf: (id: string) => string | null | undefined,
  post: boolean | null,
): AnswerTarget {
  const decision = asked && decisionOf(asked, answers);
  if (!asked || decision?.state.kind !== "open" || decision.options.length > 0)
    return { kind: "closed" };
  if (post === null) return { kind: "waiting" };
  return { kind: "answer", place: answerPlace(asked, parentOf, { post, poll: false }) };
}

/**
 * The reply that answers `questionId` at `place`, or null when the body has only spaces. A poll's choice is its own
 * body, as on the desktop, and names the choice it makes.
 */
export function answerWrite(
  place: AnswerPlace,
  questionId: string,
  body: string,
  option?: string,
): ChatWrite | null {
  if (body.trim() === "") return null;
  return {
    operation: "reply",
    args: {
      threadId: place.threadId,
      body,
      ...(place.parentMessageId === null ? {} : { parentMessageId: place.parentMessageId }),
      resolves: {
        messageId: questionId,
        ...(option === undefined ? {} : { chosenOption: option }),
      },
    },
  };
}
