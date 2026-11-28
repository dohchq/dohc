import { documentWords } from "@dohc/interface-words/documents";
import { chatWords, noticesWords, relativeTime } from "@dohc/interface-words/notices";
import { useRouter } from "expo-router";
import { ChevronRight, MessageSquare } from "lucide-react-native";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { ProblemLine } from "../account/ProblemLine";
import { useAccountName } from "../account/useAccountName";
import { Composer, outboxProblem } from "../conversation/Composer";
import {
  blockedBy,
  createWriteScope,
  fileCommentSendState,
  fileCommentWrite,
  type Lanes,
} from "../conversation/conversationWrites";
import { MessageRow } from "../conversation/MessageRow";
import { fileCommentRows } from "../conversation/outboxMessages";
import { localAuthor, localMessage } from "../conversation/serverMessages";
import { useConversationWrites, useLocalActions, useOutboxState } from "../conversation/useOutbox";
import { SheetModal } from "../home/FileNameSheet";
import { ActionPill } from "../notices/ActionPill";
import { phoneWrites } from "../server/phoneWrites";
import { views } from "../server/workspaceData";
import { useTheme, workspaceMarkFills } from "../theme";
import { ripple, TOUCH } from "../touch";
import { EmptyLine, HoldRow } from "../workspace/ListStates";
import { useView } from "../workspace/useView";

const COMMENT_LANES: Lanes = { post: false, send: true };

export function FileCommentsSheet(props: {
  readonly open: boolean;
  readonly path: string;
  readonly objectId: string | null;
  readonly onClose: () => void;
}) {
  const { open, path, objectId, onClose } = props;
  const theme = useTheme();
  const router = useRouter();
  const signIn = useSignIn();
  const { data, outbox } = useAccount();
  const workspaceId = data?.workspaceId ?? null;
  const view = useMemo(() => (open ? views.fileChats(path) : null), [open, path]);
  const { state, retry } = useView(view);
  const outboxState = useOutboxState(outbox);
  const [scope] = useState(createWriteScope);
  const activation = useMemo(() => (data ? { store: data, target: path } : null), [data, path]);
  useLayoutEffect(() => (activation ? scope.show(activation) : undefined), [scope, activation]);
  const isCurrent = useCallback(
    () => signIn.isCurrent() && activation !== null && scope.shows(activation),
    [signIn, scope, activation],
  );
  const writes = useConversationWrites(outbox, phoneWrites, isCurrent);
  const blocked = outboxState ? blockedBy(outboxState, phoneWrites) : "loading";
  const actions = useLocalActions(writes, blocked !== null);
  const problem = useMemo(
    () => outboxProblem(outboxState, blocked, () => outbox.wake()),
    [outboxState, blocked, outbox],
  );
  const accountName = useAccountName(signIn);
  const you = useMemo(() => localAuthor(accountName, workspaceMarkFills), [accountName]);
  const [draftObjectId, setDraftObjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setDraftObjectId(null);
  }, [open, path, workspaceId]);

  const threads = useMemo(
    () => [...(state.value?.threads ?? [])].sort((a, b) => b.updatedAtMs - a.updatedAtMs),
    [state.value?.threads],
  );
  const pendingRows = useMemo(
    () =>
      outboxState && workspaceId
        ? fileCommentRows(
            outboxState,
            { origin: signIn.origin, accountId: signIn.userId, workspaceId },
            path,
            objectId,
            new Set(threads.map((t) => t.id)),
          )
        : [],
    [outboxState, signIn.origin, signIn.userId, workspaceId, path, objectId, threads],
  );
  const savedKey = pendingRows
    .filter((r) => r.threadId !== null)
    .map((r) => r.threadId)
    .join(",");
  const prevSaved = useRef("");
  useEffect(() => {
    if (open && savedKey !== "" && savedKey !== prevSaved.current)
      data?.invalidate(views.fileChats(path));
    prevSaved.current = savedKey;
  }, [open, savedKey, data, path]);

  const sendState = fileCommentSendState({
    enabled: data !== null && phoneWrites,
    joined: data?.joined === true,
    objectId,
    readObjectId: state.value ? state.value.fileObjectId : undefined,
    draftObjectId,
    access: state.value?.access,
  });
  const openThread = (threadId: string) => {
    if (!workspaceId) return;
    onClose();
    router.push({
      pathname: "/chat/[id]",
      params: { id: threadId, thread: "1", workspace: workspaceId },
    });
  };
  const onText = useCallback(
    (next: string) => {
      if (next.trim() === "") setDraftObjectId(null);
      else setDraftObjectId((prev) => prev ?? objectId);
    },
    [objectId],
  );
  const submit = useCallback(
    async (_kind: "send" | "post" | "reply", body: string) => {
      const targetObjectId = draftObjectId ?? objectId;
      if (!sendState.canSend || !workspaceId || !targetObjectId)
        return { kind: "blocked" as const };
      const write = fileCommentWrite(path, targetObjectId, body);
      return write ? await writes.submit(workspaceId, write) : { kind: "blocked" as const };
    },
    [draftObjectId, objectId, sendState.canSend, workspaceId, path, writes],
  );

  return (
    <SheetModal
      open={open}
      title={documentWords.comments}
      closeLabel={documentWords.close}
      onClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}>
          {state.value === null ? (
            state.problem ? (
              <View style={styles.inset}>
                <ProblemLine text={documentWords.commentsFailed} onRetry={retry} />
              </View>
            ) : (
              <HoldRow />
            )
          ) : threads.length === 0 && pendingRows.length === 0 ? (
            <EmptyLine text={documentWords.noComments} />
          ) : (
            <>
              {threads.map((thread) => (
                <Pressable
                  key={thread.id}
                  onPress={() => openThread(thread.id)}
                  android_ripple={ripple(theme)}
                  style={({ pressed }) => [
                    styles.row,
                    pressed ? { backgroundColor: theme.panel2 } : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={thread.title || documentWords.commentThread}
                >
                  <MessageSquare size={18} color={theme.ink} strokeWidth={1.9} />
                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, { color: theme.ink }]} numberOfLines={2}>
                      {thread.title || documentWords.commentThread}
                    </Text>
                    <Text style={[styles.meta, { color: theme.subtle }]}>
                      {relativeTime(thread.updatedAtMs)}
                    </Text>
                  </View>
                  <ChevronRight size={16} color={theme.subtle} strokeWidth={2} />
                </Pressable>
              ))}
              {pendingRows.map((row) => (
                <View key={row.mark.operationId}>
                  <MessageRow
                    message={localMessage(row, you)}
                    continued={false}
                    afterExtras={false}
                    actions={actions}
                  />
                  {row.threadId ? (
                    <View style={styles.open}>
                      <ActionPill
                        label={noticesWords.open}
                        onPress={() => openThread(row.threadId!)}
                      />
                    </View>
                  ) : null}
                </View>
              ))}
            </>
          )}
        </ScrollView>
        {sendState.canShow ? (
          <View style={[styles.composer, { borderColor: theme.line, backgroundColor: theme.bg }]}>
            <Composer
              key={`${workspaceId ?? ""}:${path}`}
              placeholder={documentWords.commentPlaceholder}
              lanes={COMMENT_LANES}
              blocked={blocked ?? (!sendState.canSend && !sendState.replaced ? "loading" : null)}
              problem={problem}
              closed={
                sendState.replaced ? chatWords.refused("This file changed or was replaced") : null
              }
              docked={false}
              onText={onText}
              onCleared={() => setDraftObjectId(null)}
              onSubmit={submit}
            />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  inset: { paddingHorizontal: 16, paddingTop: 8 },
  list: { paddingVertical: 8, paddingBottom: 32 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: TOUCH,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 17, lineHeight: 22 },
  meta: { fontSize: 13, lineHeight: 18 },
  open: { flexDirection: "row", paddingLeft: 62, paddingTop: 6 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 8 },
});
