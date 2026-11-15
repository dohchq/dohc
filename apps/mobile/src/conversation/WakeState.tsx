import { chatWords, noticesWords } from "@dohc/interface-words/notices";
import type { PhoneChatWake } from "@dohc/workspace-contracts/chat-wakes";
import { CircleAlert, CircleX, Clock, Play } from "lucide-react-native";
import { StyleSheet, Text, View } from "react-native";
import { ActionPill } from "../notices/ActionPill";
import { useTheme, type Theme } from "../theme";
import { retryable, wakeLine, type WakeLine, type WakeRetry } from "./chatWakeState";

// Where each agent a message woke stands, one line per wake, under the message or a Notice's answer. Each state has
// its own mark and colour beside its words. A failed read keeps the last lines, says so, and offers Try again where the
// surface has room for it. Where the surface passes `onRetryWake`, a line that didn't start offers Try again, and one
// that wasn't confirmed Try on another computer; what a press does is the surface's.

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
  retries,
  onRetryWake,
}: {
  wakes: readonly PhoneChatWake[];
  failed: boolean;
  /** Try again after a failed read. Without it, the surface offers Try again itself. */
  onRetry?: () => void;
  /** Each line's Try again state, by wake ID. */
  retries?: ReadonlyMap<string, WakeRetry>;
  /** Try again on a line. Without it, as while writes wait, no line offers one. */
  onRetryWake?: (wake: PhoneChatWake) => void;
}) {
  const theme = useTheme();
  const lines = wakes.flatMap((wake) => {
    const line = wakeLine(wake);
    return line ? [{ line, wake }] : [];
  });
  // A failed read still says so, with Try again, when it has no line to keep.
  if (lines.length === 0 && !failed) return null;
  return (
    <View style={styles.wakes}>
      {lines.map(({ line, wake }) => {
        const Mark = marks[line.state];
        const color = tint(line.state, theme);
        const retry = retries?.get(wake.wakeId);
        const phase = retry?.generation === wake.generation ? retry.phase : null;
        const offered = onRetryWake && !failed && retryable(wake) && phase !== "missing";
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
              {offered && phase === "failed" ? (
                <Text style={[styles.text, { color: theme.danger }]} accessibilityRole="alert">
                  {chatWords.wakeRetryFailed}
                </Text>
              ) : null}
              {offered ? (
                <View style={styles.retry}>
                  <ActionPill
                    // After a failure, Try again sends the same request again, with no second alert.
                    label={
                      wake.state === "unclaimed" || phase === "failed"
                        ? noticesWords.tryAgain
                        : chatWords.wakeTryElsewhere
                    }
                    busy={phase === "sending"}
                    onPress={() => onRetryWake?.(wake)}
                  />
                </View>
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
