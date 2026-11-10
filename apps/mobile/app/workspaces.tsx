import { accountWords } from "@dohc/interface-words/account";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { Check } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useShownWorkspaces } from "../src/chats/Workspaces";
import { useTheme } from "../src/theme";

// The workspace switcher, a small sheet from the workspace in the Chats and Home headers. It lists the workspaces that
// show on this phone; Settings chooses which those are. Choosing one opens it and closes the sheet.
export default function WorkspacesSheet() {
  const theme = useTheme();
  const router = useRouter();
  const { current, workspaces, choose } = useShownWorkspaces();
  return (
    <View style={styles.sheet}>
      <Text style={[styles.title, { color: theme.ink }]} accessibilityRole="header">{accountWords.workspaces}</Text>
      {workspaces.length === 0 ? <Text style={[styles.empty, { color: theme.muted }]}>{accountWords.noneShown}</Text> : null}
      {workspaces.map(workspace => {
        const chosen = workspace.id === current?.id;
        return (
          <Pressable key={workspace.id} accessibilityRole="button" accessibilityState={{ selected: chosen }}
            onPress={() => {
              void Haptics.selectionAsync();
              choose(workspace.id);
              router.back();
            }}
            style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.panel2 } : null]}>
            <View style={[styles.mark, { backgroundColor: workspace.color }]}>
              <Text style={styles.initial}>{workspace.initial}</Text>
            </View>
            <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>{workspace.name}</Text>
            {chosen ? <Check size={18} color={theme.ink} strokeWidth={2} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingHorizontal: 8, paddingTop: 20, paddingBottom: 24 },
  title: { fontSize: 17, fontWeight: "600", paddingHorizontal: 12, paddingBottom: 8 },
  empty: { fontSize: 15, lineHeight: 20, paddingHorizontal: 12, paddingVertical: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingHorizontal: 12, borderRadius: 12 },
  mark: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  initial: { color: "#fff", fontSize: 15, fontWeight: "700" },
  name: { flex: 1, fontSize: 17 },
});
