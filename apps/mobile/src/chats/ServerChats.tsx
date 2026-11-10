import { accountWords } from "@dohc/interface-words/account";
import { Stack } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { ProblemLine } from "../account/ProblemLine";
import { NotYet } from "../NotYet";
import { serverName } from "../server/origin";
import { useTheme } from "../theme";
import { ChatsHeader } from "./ChatsHeader";
import { useWorkspaces } from "./Workspaces";

// Chats in a signed-in build: the header, with the switcher and Settings. The chats themselves come from the server
// in a later build, so until then the tab says so instead of showing anything.
export function ServerChats() {
  const theme = useTheme();
  const { workspaces: list, reloadWorkspaces } = useAccount();
  const { origin } = useSignIn();
  const { current } = useWorkspaces();
  const server = serverName(origin);
  const empty = list.status === "ready" && !current
    ? list.workspaces.length === 0 ? accountWords.noWorkspaces(server) : accountWords.noneShown
    : null;
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <ChatsHeader workspace={current} scrolled={false} />
      {list.status === "failed" ? (
        <View style={styles.message}><ProblemLine text={accountWords.problem(list.problem, server)} onRetry={reloadWorkspaces} /></View>
      ) : empty ? (
        <View style={styles.message}><Text style={[styles.text, { color: theme.muted }]}>{empty}</Text></View>
      ) : current ? <NotYet symbol="bubble.left.and.bubble.right" title="Chats" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  message: { paddingHorizontal: 16, paddingTop: 24 },
  text: { fontSize: 17, lineHeight: 22 },
});
