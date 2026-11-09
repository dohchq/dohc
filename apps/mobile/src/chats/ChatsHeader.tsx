import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { waitingToSend } from "../demo";
import { sampleMe, type SampleWorkspace } from "./sample";
import { useWorkspaceMenu } from "./workspaceMenu";

// Slack's Home header: the workspace on the left (tap for its menu); your mark on the right.
export function ChatsHeader({ workspace, scrolled }: { workspace: SampleWorkspace; scrolled: boolean }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const openMenu = useWorkspaceMenu(workspace, waitingToSend);
  return (
    // A hairline appears once the list scrolls under the header, as in Mail and Messages.
    <View style={[styles.bar, { paddingTop: insets.top + 6, backgroundColor: theme.bg, borderBottomColor: scrolled ? theme.line : "transparent" }]}>
      <Pressable style={styles.workspace} onPress={() => void openMenu()} accessibilityRole="button" accessibilityLabel={`${workspace.name}. Workspace menu`}>
        <View style={[styles.mark, { backgroundColor: workspace.color }]}>
          <Text style={styles.markText}>{workspace.initial}</Text>
        </View>
        <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>{workspace.name}</Text>
        <SymbolView name="chevron.down" size={13} weight="semibold" tintColor={theme.muted} style={styles.chevron} fallback={null} />
      </Pressable>
      <View style={styles.actions}>
        {/* New message joins here when compose exists; a button that does nothing tells the person nothing. */}
        {/* A plain mark until Settings exists: nothing to press, so it isn't a button. */}
        <View accessible accessibilityRole="image" accessibilityLabel="You" style={styles.action}>
          <View style={[styles.me, { backgroundColor: sampleMe.hue }]}>
            <Text style={styles.meText}>{sampleMe.initials}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 16, paddingRight: 10, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  workspace: { flexDirection: "row", alignItems: "center", gap: 9, flexShrink: 1, minHeight: 44 },
  mark: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  markText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  name: { fontSize: 22, fontWeight: "700", flexShrink: 1 },
  chevron: { marginLeft: -3 },
  actions: { flexDirection: "row", alignItems: "center" },
  action: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  me: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  meText: { color: "#fff", fontSize: 12, fontWeight: "700" },
});
