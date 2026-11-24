import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";
import { TOUCH } from "../touch";

// A worded action under a notice, toast or band: a 32pt outlined pill inside a real touch area as tall as TOUCH,
// so the pill's row keeps its spacing while the whole height takes the tap. In a row too narrow for it, as beside
// Copy and × at the largest text sizes on a narrow phone, the pill shrinks and its label wraps.
export function ActionPill({
  label,
  onPress,
  disabled: off = false,
  busy = false,
}: {
  label: string;
  onPress?(): void;
  disabled?: boolean;
  /** Its action is under way: the pill takes no tap until it ends. */
  busy?: boolean;
}) {
  const theme = useTheme();
  const disabled = off || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={styles.target}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.pill,
            { borderColor: theme.outline, backgroundColor: pressed ? theme.panel2 : "transparent" },
          ]}
        >
          <Text style={[styles.label, { color: disabled ? theme.subtle : theme.ink }]}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const PAD = (TOUCH - 32) / 2;

const styles = StyleSheet.create({
  target: { flexShrink: 1, paddingVertical: PAD, marginVertical: -PAD },
  pill: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: "center",
  },
  label: { fontSize: 14, fontWeight: "600", textAlign: "center" },
});
