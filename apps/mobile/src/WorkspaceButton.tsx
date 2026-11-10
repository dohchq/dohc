import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useWorkspaces } from "./chats/Workspaces";
import { sampleBuild } from "./sampleBuild";
import { useTheme } from "./theme";

// The workspace switcher, in the header as in Slack and Notion. A signed-in build opens the switcher sheet; the
// sample has none.
export function WorkspaceButton() {
  const theme = useTheme();
  const router = useRouter();
  const { current: workspace } = useWorkspaces();
  if (!workspace) return null;
  return (
    <Pressable style={styles.button} onPress={sampleBuild ? undefined : () => router.push("/workspaces")}
      accessibilityRole="button" accessibilityLabel={`Workspace: ${workspace.name}. Switch workspace`}>
      <View style={[styles.mark, { backgroundColor: workspace.color }]}>
        <Text style={styles.initial}>{workspace.initial}</Text>
      </View>
      <SymbolView name="chevron.down" size={11} weight="bold" tintColor={theme.ink} fallback={null} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 4 },
  mark: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  initial: { color: "#fff", fontSize: 14, fontWeight: "700" },
});
