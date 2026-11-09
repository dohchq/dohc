import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "./theme";

// A screen that isn't built yet says so plainly instead of showing pretend content.
export function NotYet({ symbol, title }: { symbol: SymbolViewProps["name"]; title: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <SymbolView name={symbol} size={40} tintColor={theme.subtle} fallback={null} />
      <Text style={[styles.title, { color: theme.ink }]}>{title}</Text>
      <Text style={[styles.body, { color: theme.muted }]}>Not built yet</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 32 },
  title: { fontSize: 20, fontWeight: "600", marginTop: 8 },
  body: { fontSize: 15 },
});
