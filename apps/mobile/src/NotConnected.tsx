import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "./theme";

// What a build without sample data shows until the app can connect to a server.
export function NotConnected() {
  const theme = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <Text style={[styles.text, { color: theme.muted }]} accessibilityRole="text">This build can't connect to a server yet.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  text: { fontSize: 17, textAlign: "center" },
});
