import { SymbolView } from "expo-symbols";
import { memo, useEffect } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useTheme } from "../theme";

// Slack's section header, quieter than the chats under it: the name on the left, the chevron on the right.
export const SectionHeader = memo(function SectionHeader({ title, collapsed, unread, first, onToggle }: {
  title: string; collapsed: boolean; unread: boolean; first: boolean; onToggle(): void;
}) {
  const theme = useTheme();
  const turn = useSharedValue(collapsed ? -90 : 0);
  useEffect(() => { turn.value = withTiming(collapsed ? -90 : 0, { duration: 180 }); }, [collapsed, turn]);
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value}deg` }] }));
  return (
    <Pressable onPress={onToggle} style={[styles.header, { marginTop: first ? 6 : 10 }]} hitSlop={{ top: 4, bottom: 4 }} accessibilityRole="button"
      accessibilityState={{ expanded: !collapsed }} accessibilityLabel={`${title}${collapsed && unread ? ", has unread" : ""}`}>
      <Text style={[styles.title, { color: theme.muted }]}>{title}</Text>
      <Animated.View style={[styles.trailing, chevron]}>
        <SymbolView name="chevron.down" size={12} weight="medium" tintColor={theme.muted} fallback={null} />
      </Animated.View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 36, paddingHorizontal: 16 },
  title: { fontSize: 15, fontWeight: "600" },
  trailing: { width: 20, alignItems: "center" },
});
