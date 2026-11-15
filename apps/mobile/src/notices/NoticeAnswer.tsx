import { chatWords } from "@dohc/interface-words/notices";
import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import { AccessibilityInfo, Keyboard, StyleSheet, Text, View } from "react-native";
import { Composer } from "../conversation/Composer";
import type { Lanes, SubmitOutcome } from "../conversation/conversationWrites";
import { DecisionCard, statusOf } from "../conversation/DecisionCard";
import { LocalFooter } from "../conversation/MessageRow";
import { ReplyContext, replyLabel, type ReplyTo } from "../conversation/ReplyContext";
import type { Message } from "../conversation/types";
import type { AnswerActions } from "../conversation/useOutbox";
import { useTheme } from "../theme";
import type { NoticeAnswerView } from "./phoneNotice";

// An agent's question in its Notice's row. Collapsed, the row shows where the question stands, in its one element.
// Expanded, as a group whose controls VoiceOver reaches one by one, it shows the whole question as a read verified it,
// a poll's choices, which answer at a tap, or the field named "Answer <name>" with Send and Cancel reply, and this
// phone's answers that aren't saved, with Send, Copy and Discard. The name is the verified message's author's, never
// the Notice's sender's. The field's text is kept above the row, so a recycled row shows it again, and through a failed
// read, with Send off. It closes once the field cleared the answer the outbox kept, so text typed meanwhile stays.

/** Every answer is a reply, and never a post. */
const REPLY_LANES: Lanes = { post: false, send: true };

/** Where the question stands, under a collapsed row's text. VoiceOver hears it in the row's label. */
export function AnswerStatus({ answer }: { answer: NoticeAnswerView }) {
  const theme = useTheme();
  const status = statusOf(answer.decision, theme);
  return (
    <View style={styles.status}>
      <SymbolView name={status.symbol} size={15} tintColor={status.color} fallback={null} />
      <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
    </View>
  );
}

export function NoticeAnswer({ answer }: { answer: NoticeAnswerView }) {
  const theme = useTheme();
  const { question, decision, editing, actions } = answer;
  const [problem, setProblem] = useState<string | null>(null);
  const to: ReplyTo = { name: question?.authorName ?? "", excerpt: "", answers: true };
  // The card's choices name the question by its ID; the card needs nothing else of it.
  const asked = useMemo<Message>(
    () => ({
      id: question?.id ?? "",
      author: { id: "", name: question?.authorName ?? "", kind: "agent" },
      at: "",
      minute: 0,
      body: [],
    }),
    [question],
  );
  const settle = (outcome: SubmitOutcome) => {
    if (outcome.kind === "kept" || outcome.kind === "withheld") {
      setProblem(null);
      Keyboard.dismiss();
    }
    return outcome;
  };
  const choices: AnswerActions = {
    blocked: !answer.answerable || actions.blocked,
    problems: new Map<string, string>(problem !== null && question ? [[question.id, problem]] : []),
    choose: (_message, option) => {
      setProblem(null);
      void answer.submit(option, option).then((outcome) => {
        settle(outcome);
        if (outcome.kind !== "not-kept") return;
        setProblem(chatWords.notKept);
        AccessibilityInfo.announceForAccessibility(chatWords.notKept);
      });
    },
    answer: () => undefined,
  };
  const open = editing !== null && question !== null;
  const polls = decision.options.length > 0;
  return (
    <View style={styles.answer}>
      {open ? (
        <View
          accessible
          accessibilityLabel={`${question.authorName}. ${question.body}`}
          style={[styles.question, { borderLeftColor: theme.line }]}
        >
          <Text style={[styles.author, { color: theme.ink }]}>{question.authorName}</Text>
          <Text style={[styles.body, { color: theme.ink }]}>{question.body}</Text>
        </View>
      ) : null}
      {open && polls ? <ReplyContext to={to} onCancel={answer.cancel} /> : null}
      <DecisionCard
        message={asked}
        decision={decision}
        {...(open && polls ? { answers: choices } : {})}
      />
      {answer.marks.map((mark) => (
        <LocalFooter
          key={mark.operationId}
          mark={mark}
          actions={actions}
          theme={theme}
          sendable={answer.sendable}
          discardsPending
        />
      ))}
      {open && !polls ? (
        <Composer
          key={editing}
          placeholder={replyLabel(to)}
          lanes={REPLY_LANES}
          blocked={actions.blocked || !answer.current ? "loading" : null}
          problem={null}
          replies
          replyTo={to}
          closed={answer.answerable || !answer.current ? null : chatWords.answerClosed}
          initialText={answer.draft()}
          onCancelReply={answer.cancel}
          onSubmit={(_kind, body) => answer.submit(body)}
          onText={answer.keepDraft}
          onCleared={() => {
            Keyboard.dismiss();
            answer.cancel();
          }}
          docked={false}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  answer: { gap: 6, marginTop: 6 },
  status: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 },
  statusText: { fontSize: 15, fontWeight: "600" },
  question: { gap: 2, paddingLeft: 10, borderLeftWidth: 3 },
  author: { fontSize: 15, fontWeight: "600" },
  body: { fontSize: 17, lineHeight: 22 },
});
