import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";

// Design-pass stand-in: the shipped composer is a native module (Swift and Kotlin) with mention chips.
export function Composer({ placeholder, onLayoutHeight }: { placeholder: string; onLayoutHeight(height: number): void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const ready = text.trim().length > 0;
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom - 6 }} style={styles.sticky}>
      <View onLayout={event => onLayoutHeight(event.nativeEvent.layout.height)}
        style={[styles.bar, { paddingBottom: Math.max(insets.bottom - 4, 6), backgroundColor: theme.bg, borderTopColor: theme.line }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Add" style={styles.round}>
          <SymbolView name="plus" size={20} weight="medium" tintColor={theme.muted} fallback={null} />
        </Pressable>
        <View style={[styles.field, { backgroundColor: theme.field, borderColor: theme.fieldLine }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            placeholderTextColor={theme.subtle}
            multiline
            style={[styles.input, { color: theme.ink }]}
            accessibilityLabel={placeholder}
          />
        </View>
        <Pressable disabled={!ready} accessibilityRole="button" accessibilityLabel="Send"
          onPress={() => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setText(""); }}
          style={[styles.round, ready && { backgroundColor: theme.accent }]}>
          <SymbolView name="arrow.up" size={18} weight="bold" tintColor={ready ? theme.bg : theme.subtle} fallback={null} />
        </Pressable>
      </View>
    </KeyboardStickyView>
  );
}

const styles = StyleSheet.create({
  sticky: { position: "absolute", left: 0, right: 0, bottom: 0 },
  bar: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  field: { flex: 1, minHeight: 44, maxHeight: 132, borderRadius: 22, borderWidth: 1, paddingHorizontal: 14, justifyContent: "center" },
  input: { fontSize: 17, paddingTop: 11, paddingBottom: 11 },
});
