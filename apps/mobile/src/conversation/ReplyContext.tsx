import { chatWords } from "@dohc/interface-words/notices";
import { SymbolView } from "expo-symbols";
import { X } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";

/** The message a reply answers, as the composer names it. */
export interface ReplyTo {
  /** Its author's name. */
  readonly name: string;
  /** Its text, which shows on one line. */
  readonly excerpt: string;
}

// Above the composer while a reply answers a chosen message: whose, and its start, then Cancel reply. It comes before
// the field, so VoiceOver reads it first.
export function ReplyContext({ to, onCancel }: { to: ReplyTo; onCancel(): void }) {
  const theme = useTheme();
  const label = chatWords.replyTo(to.name);
  return (
    <View style={styles.row}>
      <View style={[styles.bar, { backgroundColor: theme.accent }]} />
      <View
        style={styles.text}
        accessible
        accessibilityLabel={to.excerpt ? `${label}. ${to.excerpt}` : label}
      >
        <Text style={[styles.name, { color: theme.ink }]}>{label}</Text>
        {to.excerpt ? (
          <Text style={[styles.excerpt, { color: theme.muted }]} numberOfLines={1}>
            {to.excerpt}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={chatWords.cancelReply}
        onPress={onCancel}
        style={styles.cancel}
      >
        <SymbolView
          name="xmark"
          size={16}
          weight="semibold"
          tintColor={theme.muted}
          fallback={<X size={18} color={theme.muted} strokeWidth={2.5} />}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 6 },
  bar: { width: 3, alignSelf: "stretch", borderRadius: 1.5, marginVertical: 4 },
  text: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: "600" },
  excerpt: { fontSize: 15, lineHeight: 20 },
  cancel: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
});
