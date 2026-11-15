import { chatWords } from "@dohc/interface-words/notices";
import * as Haptics from "expo-haptics";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ActionPill } from "../notices/ActionPill";
import { useTheme, type Theme } from "../theme";
import type { Decision, Message } from "./types";
import type { AnswerActions } from "./useOutbox";

// Under a message that asks a question or a poll: whether it's answered, a poll's choices in its author's own words,
// and Answer on a question without choices. A choice is the answer, sent at once; Answer starts a reply that answers
// it, in the composer. Without `answers`, as where phone writes are off, the card only shows where the question stands.
export function DecisionCard({
  message,
  decision,
  answers,
}: {
  message: Message;
  decision: Decision;
  answers?: AnswerActions;
}) {
  const theme = useTheme();
  const { state, options } = decision;
  const open = state.kind === "open";
  const canAnswer = answers !== undefined && !answers.blocked && open;
  const chosen = "chosen" in state ? state.chosen : null;
  const status = statusOf(decision, theme);
  const problem = answers?.problems.get(message.id);
  return (
    <View style={styles.card}>
      <View style={styles.status} accessible accessibilityLabel={status.label}>
        <SymbolView name={status.symbol} size={15} tintColor={status.color} fallback={null} />
        <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
      </View>
      {options.length > 0 ? (
        <View style={styles.options}>
          {options.map((option) => {
            const selected = chosen === option;
            const pending = selected && state.kind === "answering";
            return (
              <Pressable
                key={option}
                disabled={!canAnswer}
                onPress={() => {
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  answers?.choose(message, option);
                }}
                accessibilityRole="button"
                accessibilityLabel={option}
                accessibilityState={{ selected, busy: pending, disabled: !canAnswer }}
                style={({ pressed }) => [
                  styles.option,
                  {
                    backgroundColor:
                      selected && !pending
                        ? theme.accent
                        : pending
                          ? theme.mine
                          : pressed
                            ? theme.panel2
                            : "transparent",
                    borderColor: selected ? theme.accent : theme.outline,
                  },
                  // On its way: the border dashes, beside the button's busy state, as a pending reaction's does.
                  pending && styles.pending,
                ]}
              >
                {selected && !pending ? (
                  <SymbolView
                    name="checkmark"
                    size={14}
                    weight="bold"
                    tintColor={theme.bg}
                    fallback={null}
                  />
                ) : null}
                <Text
                  style={[
                    styles.optionText,
                    {
                      color:
                        selected && !pending
                          ? theme.bg
                          : canAnswer || selected
                            ? theme.ink
                            : theme.muted,
                    },
                  ]}
                >
                  {option}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : answers && (open || state.kind === "held") ? (
        <View style={styles.actions}>
          <ActionPill
            label={chatWords.answer}
            disabled={!canAnswer}
            onPress={() => answers.answer(message)}
          />
        </View>
      ) : null}
      {state.kind === "lost" && state.winner ? (
        <View
          style={[styles.winner, { borderLeftColor: theme.line }]}
          accessible
          accessibilityLabel={`${state.winner.name}. ${state.winner.body}`}
        >
          <Text style={[styles.winnerName, { color: theme.ink }]}>{state.winner.name}</Text>
          <Text style={[styles.text, { color: theme.muted }]} numberOfLines={3}>
            {state.winner.body}
          </Text>
        </View>
      ) : null}
      {state.kind === "lost" && state.replySent ? (
        <Text style={[styles.text, { color: theme.muted }]}>{chatWords.answerLost}</Text>
      ) : null}
      {problem ? (
        <Text style={[styles.text, { color: theme.danger }]} accessibilityRole="alert">
          {problem}
        </Text>
      ) : null}
    </View>
  );
}

/** The card's status line. A lost answer whose winner a read doesn't show says only Answered, naming nobody. */
function statusOf(
  { state }: Decision,
  theme: Theme,
): { label: string; symbol: SymbolViewProps["name"]; color: string } {
  switch (state.kind) {
    case "open":
    case "held":
      return { label: chatWords.unanswered, symbol: "questionmark.circle", color: theme.warning };
    case "answering":
      return { label: chatWords.answering, symbol: "ellipsis.circle", color: theme.muted };
    case "answered":
      return { label: chatWords.answered, symbol: "checkmark.circle", color: theme.success };
    case "lost":
      return {
        label: state.winner ? chatWords.alreadyAnswered : chatWords.answered,
        symbol: "checkmark.circle",
        color: theme.success,
      };
  }
}

const styles = StyleSheet.create({
  card: { gap: 8, marginTop: 8 },
  status: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start" },
  statusText: { fontSize: 15, fontWeight: "600" },
  options: { gap: 8 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
    borderWidth: 1,
  },
  pending: { borderStyle: "dashed" },
  optionText: { flexShrink: 1, fontSize: 17, fontWeight: "600" },
  actions: { flexDirection: "row" },
  winner: { gap: 2, paddingLeft: 10, borderLeftWidth: 3 },
  winnerName: { fontSize: 15, fontWeight: "600" },
  text: { fontSize: 17, lineHeight: 22 },
});
