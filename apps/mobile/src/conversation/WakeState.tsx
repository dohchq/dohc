import { chatWords, noticesWords } from "@dohc/interface-words/notices";
import type { PhoneChatWake } from "@dohc/workspace-contracts/chat-wakes";
import { CircleAlert, CircleX, Clock, Play } from "lucide-react-native";
import { StyleSheet, Text, View } from "react-native";
import { ActionPill } from "../notices/ActionPill";
import { useTheme, type Theme } from "../theme";
import { wakeLines, type WakeLine } from "./chatWakeState";

// Where each agent a message woke stands, one line per wake, under the message or a Notice's answer. Each state has
// its own mark and colour beside its words. It only reads: it never starts or retries an agent. A failed read keeps
// the last lines, says so, and offers Try again where the surface has room for it.

const marks = {
  waiting: Clock,
  claimed: Play,
  unclaimed: CircleX,
  unconfirmed: CircleAlert,
} as const;

const tint = (state: WakeLine["state"], theme: Theme) =>
  state === "unclaimed" ? theme.danger : state === "unconfirmed" ? theme.warning : theme.muted;

export function WakeState({
  wakes,
  failed,
  onRetry,
}: {
  wakes: readonly PhoneChatWake[];
  failed: boolean;
  /** Try again after a failed read. Without it, the surface offers Try again itself. */
  onRetry?: () => void;
}) {
  const theme = useTheme();
  const lines = wakeLines(wakes);
  // A failed read still says so, with Try again, when it has no line to keep.
  if (lines.length === 0 && !failed) return null;
  return (
    <View style={styles.wakes}>
      {lines.map((line) => {
        const Mark = marks[line.state];
        const color = tint(line.state, theme);
        return (
          <View key={line.wakeId} style={styles.line}>
            <View style={styles.mark}>
              <Mark size={14} color={color} strokeWidth={2} />
            </View>
            <View style={styles.words}>
              <Text style={[styles.text, { color }]}>{line.text}</Text>
              {line.note ? (
                <Text style={[styles.text, { color: theme.muted }]}>{line.note}</Text>
              ) : null}
            </View>
          </View>
        );
      })}
      {failed ? (
        <Text style={[styles.text, { color: theme.danger }]}>{chatWords.wakeReadFailed}</Text>
      ) : null}
      {failed && onRetry ? (
        <View style={styles.retry}>
          <ActionPill label={noticesWords.tryAgain} onPress={onRetry} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wakes: { gap: 4, marginTop: 6 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  // Centres the mark on the first line of 20 pt text.
  mark: { height: 20, justifyContent: "center" },
  words: { flex: 1 },
  text: { fontSize: 15, lineHeight: 20 },
  retry: { flexDirection: "row", marginTop: 2 },
});
