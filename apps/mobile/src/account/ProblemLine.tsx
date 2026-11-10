import { noticesWords } from "@dohc/interface-words/notices";
import { StyleSheet, Text, View } from "react-native";
import { ActionPill } from "../notices/ActionPill";
import { useTheme } from "../theme";

// A list that could not load, or a change that didn't take, says so in its place in one line, with Try again under it.
export function ProblemLine({ text, onRetry }: { text: string; onRetry(): void }) {
  const theme = useTheme();
  return (
    <View style={styles.line}>
      <Text style={[styles.text, { color: theme.danger }]} accessibilityRole="alert">{text}</Text>
      <View style={styles.action}><ActionPill label={noticesWords.tryAgain} onPress={onRetry} /></View>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { gap: 8, paddingVertical: 8 },
  text: { fontSize: 15, lineHeight: 20 },
  action: { flexDirection: "row" },
});
