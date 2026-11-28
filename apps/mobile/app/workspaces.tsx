import { accountWords } from "@dohc/interface-words/account";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { Check } from "lucide-react-native";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PhoneWorkspace } from "../src/chats/types";
import { useShownWorkspaces } from "../src/chats/Workspaces";
import { workspaceGroups } from "../src/server/workspaceList";
import { useTheme } from "../src/theme";
import { signedInOnly } from "../src/sampleOnly";

// The workspace switcher, a small sheet from the workspace in the Chats and Home headers. It lists the workspaces that
// show on this phone; Settings chooses which those are. Once the account has joined someone else's workspace, the
// list splits under two headings, its own first. Choosing one opens it and closes the sheet. One whose sync isn't set
// up yet is listed, dimmed, with why, and can't be chosen.
function WorkspacesSheet() {
  const theme = useTheme();
  const router = useRouter();
  const { current, workspaces, choose, preload } = useShownWorkspaces();
  const { own, shared } = workspaceGroups(workspaces);
  const split = shared.length > 0;
  const open = (workspaceId: string) => {
    void Haptics.selectionAsync();
    choose(workspaceId);
    router.back();
  };
  const chosenId = current?.id ?? null;
  return (
    // A scroll view, so the sheet stops at the screen's height and every workspace stays reachable.
    <ScrollView contentContainerStyle={styles.sheet}>
      <Text style={[styles.title, { color: theme.ink }]} accessibilityRole="header">
        {accountWords.workspaces}
      </Text>
      {workspaces.length === 0 ? (
        <Text style={[styles.empty, { color: theme.muted }]}>{accountWords.noneShown}</Text>
      ) : null}
      <Group
        heading={split && own.length > 0 ? accountWords.yourWorkspaces : null}
        rows={own}
        chosenId={chosenId}
        onChoose={open}
        onPreload={preload}
      />
      <Group
        heading={split ? accountWords.sharedWithYou : null}
        rows={shared}
        chosenId={chosenId}
        onChoose={open}
        onPreload={preload}
      />
    </ScrollView>
  );
}

function Group({
  heading,
  rows,
  chosenId,
  onChoose,
  onPreload,
}: {
  heading: string | null;
  rows: readonly PhoneWorkspace[];
  chosenId: string | null;
  onChoose(workspaceId: string): void;
  onPreload?(workspaceId: string): void;
}) {
  const theme = useTheme();
  if (rows.length === 0) return null;
  return (
    <View style={heading ? styles.group : null}>
      {heading ? (
        <Text style={[styles.heading, { color: theme.muted }]} accessibilityRole="header">
          {heading}
        </Text>
      ) : null}
      {rows.map((workspace) => (
        <WorkspaceRow
          key={workspace.id}
          workspace={workspace}
          chosen={workspace.id === chosenId}
          onChoose={onChoose}
          onPreload={onPreload}
        />
      ))}
    </View>
  );
}

function WorkspaceRow({
  workspace,
  chosen,
  onChoose,
  onPreload,
}: {
  workspace: PhoneWorkspace;
  chosen: boolean;
  onChoose(workspaceId: string): void;
  onPreload?(workspaceId: string): void;
}) {
  const theme = useTheme();
  const disabled = workspace.canOpen === false;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: chosen, disabled }}
      accessibilityLabel={
        disabled ? `${workspace.name}, ${accountWords.notSyncedYet}` : workspace.name
      }
      disabled={disabled}
      android_ripple={{ color: theme.panel2 }}
      onPressIn={!chosen && onPreload ? () => onPreload(workspace.id) : undefined}
      onPress={() => onChoose(workspace.id)}
      style={({ pressed }) => [
        styles.row,
        pressed && Platform.OS === "ios" ? { backgroundColor: theme.panel2 } : null,
      ]}
    >
      <View
        style={[styles.mark, { backgroundColor: workspace.color }, disabled ? styles.dimmed : null]}
      >
        <Text style={styles.initial}>{workspace.initial}</Text>
      </View>
      <View style={styles.text}>
        <Text
          style={[styles.name, { color: disabled ? theme.muted : theme.ink }]}
          numberOfLines={1}
        >
          {workspace.name}
        </Text>
        {disabled ? (
          <Text style={[styles.reason, { color: theme.muted }]}>{accountWords.notSyncedYet}</Text>
        ) : null}
      </View>
      {chosen ? <Check size={18} color={theme.ink} strokeWidth={2} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingHorizontal: 8, paddingTop: 20, paddingBottom: 24 },
  title: { fontSize: 17, fontWeight: "600", paddingHorizontal: 12, paddingBottom: 8 },
  empty: { fontSize: 15, lineHeight: 20, paddingHorizontal: 12, paddingVertical: 8 },
  group: { paddingTop: 8 },
  heading: { fontSize: 13, fontWeight: "600", paddingHorizontal: 12, paddingVertical: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 12,
    borderRadius: 12,
    overflow: "hidden",
  },
  mark: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  initial: { color: "#fff", fontSize: 15, fontWeight: "700" },
  text: { flex: 1, paddingVertical: 6 },
  name: { fontSize: 17 },
  reason: { fontSize: 13, lineHeight: 18 },
  // The mark keeps its colour, faded, so the row still reads as that workspace.
  dimmed: { opacity: 0.45 },
});

export default signedInOnly(WorkspacesSheet);
