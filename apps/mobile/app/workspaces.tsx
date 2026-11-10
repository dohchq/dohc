import { accountWords } from "@dohc/interface-words/account";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { Check } from "lucide-react-native";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useShownWorkspaces } from "../src/chats/Workspaces";
import { useTheme } from "../src/theme";
import { signedInOnly } from "../src/sampleOnly";

// The workspace switcher, a small sheet from the workspace in the Chats and Home headers. It lists the workspaces that
// show on this phone; Settings chooses which those are. Choosing one opens it and closes the sheet. One whose sync
// isn't set up yet is listed, dimmed, with why, and can't be chosen.
function WorkspacesSheet() {
  const theme = useTheme();
  const router = useRouter();
  const { current, workspaces, choose } = useShownWorkspaces();
  return (
    // A scroll view, so the sheet stops at the screen's height and every workspace stays reachable.
    <ScrollView contentContainerStyle={styles.sheet}>
      <Text style={[styles.title, { color: theme.ink }]} accessibilityRole="header">{accountWords.workspaces}</Text>
      {workspaces.length === 0 ? <Text style={[styles.empty, { color: theme.muted }]}>{accountWords.noneShown}</Text> : null}
      {workspaces.map(workspace => {
        const chosen = workspace.id === current?.id;
        const disabled = workspace.canOpen === false;
        return (
          <Pressable key={workspace.id} accessibilityRole="button" accessibilityState={{ selected: chosen, disabled }}
            accessibilityLabel={disabled ? `${workspace.name}, ${accountWords.notSyncedYet}` : workspace.name} disabled={disabled}
            onPress={() => {
              void Haptics.selectionAsync();
              choose(workspace.id);
              router.back();
            }}
            style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.panel2 } : null]}>
            <View style={[styles.mark, { backgroundColor: workspace.color }, disabled ? styles.dimmed : null]}>
              <Text style={styles.initial}>{workspace.initial}</Text>
            </View>
            <View style={styles.text}>
              <Text style={[styles.name, { color: disabled ? theme.muted : theme.ink }]} numberOfLines={1}>{workspace.name}</Text>
              {disabled ? <Text style={[styles.reason, { color: theme.muted }]}>{accountWords.notSyncedYet}</Text> : null}
            </View>
            {chosen ? <Check size={18} color={theme.ink} strokeWidth={2} /> : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingHorizontal: 8, paddingTop: 20, paddingBottom: 24 },
  title: { fontSize: 17, fontWeight: "600", paddingHorizontal: 12, paddingBottom: 8 },
  empty: { fontSize: 15, lineHeight: 20, paddingHorizontal: 12, paddingVertical: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingHorizontal: 12, borderRadius: 12 },
  mark: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  initial: { color: "#fff", fontSize: 15, fontWeight: "700" },
  text: { flex: 1, paddingVertical: 6 },
  name: { fontSize: 17 },
  reason: { fontSize: 13, lineHeight: 18 },
  // The mark keeps its colour, faded, so the row still reads as that workspace.
  dimmed: { opacity: 0.45 },
});

export default signedInOnly(WorkspacesSheet);
