import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";

// A worded action under a notice, toast or band: a 32pt outlined pill inside a real 44pt touch area,
// so the pill's row keeps its spacing while the whole 44pt height takes the tap. In a row too narrow for it, as beside
// Copy and × at the largest text sizes on a narrow phone, the pill shrinks and its label wraps.
export function ActionPill({ label, onPress }: { label: string; onPress?(): void }) {
  const theme = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.target}>
      {({ pressed }) => (
        <View style={[styles.pill, { borderColor: theme.outline, backgroundColor: pressed ? theme.panel2 : "transparent" }]}>
          <Text style={[styles.label, { color: theme.ink }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  target: { flexShrink: 1, paddingVertical: 6, marginVertical: -6 },
  pill: { minHeight: 32, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, justifyContent: "center" },
  label: { fontSize: 14, fontWeight: "600", textAlign: "center" },
});
