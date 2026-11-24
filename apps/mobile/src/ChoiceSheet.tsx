import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, SlideInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { showSheetWith, type Choices } from "./confirm";
import { useTheme } from "./theme";
import { ripple, TOUCH } from "./touch";

// Android's menu: a Material bottom sheet of the choices, one row each, a destructive one in danger. A tap outside it or
// Back cancels. `choose` in src/confirm.ts asks through it; the host lives at the app's root.
interface Asked {
  readonly choices: Choices;
  answer(index: number | null): void;
}

export function ChoiceSheetHost() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [asked, setAsked] = useState<Asked | null>(null);
  // A second menu asked while one shows replaces it, and the first is cancelled.
  useEffect(
    () =>
      showSheetWith((choices, answer) =>
        setAsked((current) => {
          current?.answer(null);
          return { choices, answer };
        }),
      ),
    [],
  );
  if (!asked) return null;
  const answer = (index: number | null) => {
    setAsked(null);
    asked.answer(index);
  };
  const { title, message, options, cancel } = asked.choices;
  return (
    <Modal
      transparent
      visible
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => answer(null)}
    >
      <Animated.View
        entering={FadeIn.duration(150)}
        style={[styles.scrim, StyleSheet.absoluteFill]}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => answer(null)}
          accessibilityRole="button"
          accessibilityLabel={cancel}
        />
      </Animated.View>
      <Animated.View
        entering={SlideInDown.duration(220)}
        style={[styles.sheet, { backgroundColor: theme.raised, paddingBottom: insets.bottom + 8 }]}
        accessibilityViewIsModal
      >
        <View style={[styles.handle, { backgroundColor: theme.outline }]} />
        {title ? (
          <Text style={[styles.title, { color: theme.muted }]} accessibilityRole="header">
            {title}
          </Text>
        ) : null}
        {message ? <Text style={[styles.message, { color: theme.muted }]}>{message}</Text> : null}
        {options.map((option, index) => (
          <Pressable
            key={option.label}
            onPress={() => answer(index)}
            android_ripple={ripple(theme)}
            accessibilityRole="button"
            style={styles.row}
          >
            <Text style={[styles.label, { color: option.destructive ? theme.danger : theme.ink }]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: "rgba(0,0,0,0.32)" },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 8,
    elevation: 8,
  },
  handle: { alignSelf: "center", width: 32, height: 4, borderRadius: 2, marginBottom: 12 },
  title: { fontSize: 14, fontWeight: "600", paddingHorizontal: 24, paddingBottom: 4 },
  message: { fontSize: 15, lineHeight: 20, paddingHorizontal: 24, paddingBottom: 8 },
  row: { minHeight: TOUCH + 8, justifyContent: "center", paddingHorizontal: 24 },
  label: { fontSize: 17 },
});
