import { accountWords } from "@dohc/interface-words/account";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSignIn } from "../account/AccountProvider";
import { sampleBuild } from "../sampleBuild";
import { useTheme } from "../theme";
import { waitingToSend } from "../demo";
import { sampleMe, type PhoneWorkspace } from "./sample";
import { useWorkspaceMenu } from "./workspaceMenu";

// Slack's Home header: the workspace on the left (tap for its menu, or the switcher once signed in); your mark on the
// right, which opens Settings once signed in. Without a workspace on the phone, only your mark shows.
export function ChatsHeader({ workspace, scrolled }: { workspace: PhoneWorkspace | null; scrolled: boolean }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const openMenu = useWorkspaceMenu(workspace, waitingToSend);
  return (
    // A hairline appears once the list scrolls under the header, as in Mail and Messages.
    <View style={[styles.bar, { paddingTop: insets.top + 6, backgroundColor: theme.bg, borderBottomColor: scrolled ? theme.line : "transparent" }]}>
      {workspace ? (
        <Pressable style={styles.workspace} onPress={() => sampleBuild ? void openMenu() : router.push("/workspaces")} accessibilityRole="button"
          accessibilityLabel={sampleBuild ? `${workspace.name}. Workspace menu` : `Workspace: ${workspace.name}. Switch workspace`}>
          <View style={[styles.mark, { backgroundColor: workspace.color }]}>
            <Text style={styles.markText}>{workspace.initial}</Text>
          </View>
          <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>{workspace.name}</Text>
          <SymbolView name="chevron.down" size={13} weight="semibold" tintColor={theme.muted} style={styles.chevron} fallback={null} />
        </Pressable>
      ) : <View />}
      <View style={styles.actions}>
        {/* New message joins here when compose exists; a button that does nothing tells the person nothing. */}
        {sampleBuild ? (
          // The sample has no Settings: nothing to press, so it isn't a button.
          <View accessible accessibilityRole="image" accessibilityLabel="You" style={styles.action}>
            <View style={[styles.me, { backgroundColor: sampleMe.hue }]}>
              <Text style={styles.meText}>{sampleMe.initials}</Text>
            </View>
          </View>
        ) : <SettingsButton />}
      </View>
    </View>
  );
}

function SettingsButton() {
  const theme = useTheme();
  const router = useRouter();
  const { email } = useSignIn();
  return (
    <Pressable style={styles.action} onPress={() => router.push("/settings")} accessibilityRole="button" accessibilityLabel={accountWords.settings}>
      <View style={[styles.me, { backgroundColor: theme.accent }]}>
        <Text style={[styles.meText, { color: theme.bg }]}>{[...email][0]?.toUpperCase()}</Text>
      </View>
    </Pressable>
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
