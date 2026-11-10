import { Pressable, StyleSheet, Text } from "react-native";
import { useTheme } from "../theme";

// Connect's full-width buttons: the accent fill for the step to take, or quiet text for the way back.
export function Button({ label, onPress, disabled = false, quiet = false }: { label: string; onPress(): void; disabled?: boolean; quiet?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, quiet ? null : { backgroundColor: disabled ? theme.line : theme.accent, opacity: pressed ? 0.85 : 1 }]}>
      <Text style={[styles.label, { color: quiet ? theme.ink : disabled ? theme.subtle : theme.bg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 50, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  label: { fontSize: 17, fontWeight: "600" },
});
