import { chatWords, noticesWords } from "@dohc/interface-words/notices";
import { useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { useAccountName } from "../account/useAccountName";
import { workspaceName } from "../chats/workspaceName";
import { NotYet } from "../NotYet";
import { ActionPill } from "../notices/ActionPill";
import { phoneWrites } from "../server/phoneWrites";
import { useTheme, workspaceMarkFills } from "../theme";
import { outboxProblem } from "./Composer";
import { ProblemLine } from "../account/ProblemLine";
import { blockedBy } from "./conversationWrites";
import { DamagedKept } from "./DamagedKept";
import { MessageRow } from "./MessageRow";
import { recoveryRows, type RecoveryRow } from "./outboxMessages";
import { localAuthor } from "./serverMessages";
import { useConversationWrites, useLocalActions, useOutboxState } from "./useOutbox";

// Messages on this phone, from Settings: every message of the signed-in account that its outbox keeps and the server
// hasn't saved, and every saved reaction a read since shows otherwise, in any workspace, with records that can't be
// read. A withheld message stays reachable here when its chat is closed or no longer shows. A message in the open
// workspace opens its chat. One that can't be read says only that, with no workspace or chat, since neither can be
// known. Errors stay in place.
export function OutboxRecovery() {
  const theme = useTheme();
  const router = useRouter();
  const signIn = useSignIn();
  const { outbox, workspaces, currentWorkspaceId } = useAccount();
  const state = useOutboxState(outbox);
  const isCurrent = useCallback(() => signIn.isCurrent(), [signIn]);
  const writes = useConversationWrites(outbox, phoneWrites, isCurrent);
  const blocked = state ? blockedBy(state, phoneWrites) : "loading";
  const actions = useLocalActions(writes, blocked !== null);
  const accountName = useAccountName(signIn);
  const you = useMemo(() => localAuthor(accountName, workspaceMarkFills), [accountName]);
  if (!phoneWrites) return <NotYet symbol="hammer" />;

  const { rows, unreadable } = state
    ? recoveryRows(state, { origin: signIn.origin, accountId: signIn.userId })
    : { rows: [], unreadable: [] };
  const damaged = state?.status === "damaged";
  const problem = damaged ? null : outboxProblem(state, blocked, () => outbox.wake());
  const nameOf = (workspaceId: string) => {
    const found =
      workspaces.status === "ready"
        ? workspaces.workspaces.find((entry) => entry.workspaceId === workspaceId)
        : undefined;
    return found ? workspaceName(found) : null;
  };
  // In the open workspace only, so opening never switches the workspace under another screen. A reply or reaction
  // opens its thread, once the outbox knows it.
  const open = (row: RecoveryRow) => {
    if (row.workspaceId !== currentWorkspaceId) return null;
    const { streamId, threadId } = row;
    if (streamId !== null)
      return () =>
        router.push({
          pathname: "/chat/[id]",
          params: { id: streamId, workspace: row.workspaceId },
        });
    if (threadId !== null)
      return () =>
        router.push({
          pathname: "/chat/[id]",
          params: { id: threadId, thread: "1", workspace: row.workspaceId },
        });
    if (row.filePath)
      return () =>
        router.push({
          pathname: "/page",
          params: { path: row.filePath!, workspace: row.workspaceId },
        });
    return null;
  };
  const empty = state?.status === "ready" && rows.length === 0 && unreadable.length === 0;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={styles.page}
    >
      {problem ? (
        <View style={styles.inset}>
          {problem.retry ? (
            <ProblemLine text={problem.text} onRetry={problem.retry} />
          ) : (
            <Text style={[styles.text, { color: theme.muted }]}>{problem.text}</Text>
          )}
        </View>
      ) : null}
      {damaged ? (
        <View style={styles.inset}>
          <DamagedKept outbox={outbox} live={isCurrent} />
        </View>
      ) : null}
      {empty ? (
        <Text style={[styles.text, styles.inset, { color: theme.muted }]}>
          {chatWords.noMessagesOnPhone}
        </Text>
      ) : null}
      {rows.map((row, index) => {
        const workspace = nameOf(row.workspaceId);
        const previous = rows[index - 1];
        const onOpen = open(row);
        return (
          <View key={row.mark.operationId}>
            {workspace && previous?.workspaceId !== row.workspaceId ? (
              <Text
                style={[styles.heading, styles.inset, { color: theme.muted }]}
                accessibilityRole="header"
              >
                {workspace}
              </Text>
            ) : null}
            <MessageRow
              message={{
                id: row.mark.operationId,
                author: you,
                at: "",
                minute: 0,
                body: [{ text: row.mark.body }],
                ...(row.reaction ? { reactionMarks: [row.reaction] } : { local: row.mark }),
              }}
              continued={false}
              afterExtras={false}
              actions={actions}
            />
            {onOpen ? (
              <View style={styles.open}>
                <ActionPill label={noticesWords.open} onPress={onOpen} />
              </View>
            ) : null}
          </View>
        );
      })}
      {unreadable.map((handle) => {
        const failed = actions.problems.get(handle);
        return (
          <View key={handle} style={[styles.unreadable, styles.inset]}>
            <Text style={[styles.text, { color: theme.ink }]}>{chatWords.unreadableMessage}</Text>
            {failed ? (
              <Text style={[styles.text, { color: theme.danger }]} accessibilityRole="alert">
                {failed}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <ActionPill
                label={chatWords.discard}
                disabled={actions.blocked}
                onPress={() => actions.discardUnreadable(handle)}
              />
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: 48, gap: 8 },
  inset: { paddingHorizontal: 16 },
  heading: { fontSize: 15, fontWeight: "600", paddingTop: 16 },
  text: { fontSize: 17, lineHeight: 22 },
  open: { flexDirection: "row", paddingLeft: 62, paddingTop: 6 },
  unreadable: { gap: 6, paddingTop: 14 },
  actions: { flexDirection: "row", gap: 8 },
});
