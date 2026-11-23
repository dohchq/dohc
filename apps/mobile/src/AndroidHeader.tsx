import { workspaceWords } from "@dohc/interface-words/workspace";
import type { NativeStackHeaderProps } from "expo-router/native-stack";
import { ArrowLeft, type LucideIcon } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "./theme";

// Android's header for the screens in a tab's stack. There the system header lays a nested stack's screen out under
// itself, so this one sits above the screen in its column instead. It shows the screen's own options: its title,
// headerLeft and headerRight, and a back arrow on a screen pushed inside the tab.
export function TabHeader({ options, back, navigation }: NativeStackHeaderProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const props = { tintColor: theme.ink, canGoBack: back !== undefined };
  const title = typeof options.title === "string" ? options.title : "";
  return (
    <View style={[styles.bar, { paddingTop: insets.top + 6, backgroundColor: theme.bg }]}>
      {back ? (
        <HeaderButton icon={ArrowLeft} label={workspaceWords.back} onPress={navigation.goBack} />
      ) : null}
      {options.headerLeft?.(props)}
      <Text
        style={[styles.title, { color: theme.ink }]}
        numberOfLines={1}
        accessibilityRole="header"
      >
        {title}
      </Text>
      {options.headerRight?.(props)}
    </View>
  );
}

/** A header button on Android: a label, or an icon named by its label. iOS draws its own in the system bar. */
export function HeaderButton({
  label,
  icon: Icon,
  onPress,
}: {
  label: string;
  icon?: LucideIcon;
  onPress(): void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.button}
      android_ripple={{ color: theme.line, borderless: true }}
    >
      {Icon ? (
        <Icon size={24} color={theme.ink} strokeWidth={2} />
      ) : (
        <Text style={[styles.label, { color: theme.accent }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingLeft: 16,
    paddingRight: 6,
    paddingBottom: 8,
  },
  title: { flex: 1, fontSize: 22, lineHeight: 48, fontWeight: "700" },
  button: {
    minWidth: 48,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  label: { fontSize: 15, fontWeight: "600" },
});
