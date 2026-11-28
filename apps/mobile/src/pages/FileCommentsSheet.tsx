import { documentWords } from "@dohc/interface-words/documents";
import { chatWords, noticesWords, relativeTime } from "@dohc/interface-words/notices";
import { useRouter } from "expo-router";
import { ChevronRight, MessageSquare } from "lucide-react-native";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { useAccountName } from "../account/useAccountName";
import {
  blockedBy,
  canStartFileComment,
  createWriteScope,
  fileCommentWrite,
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
import { EmptyLine, HoldRow, RetryRow } from "../workspace/ListStates";
import { useView } from "../workspace/useView";

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
  const accountName = useAccountName(signIn);
  const you = useMemo(() => localAuthor(accountName, workspaceMarkFills), [accountName]);
  const [draft, setDraft] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setSubmitError(null);
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

  const canComment =
    data !== null &&
    canStartFileComment({
      enabled: phoneWrites,
      joined: data.joined,
      objectId,
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
  const submit = async () => {
    if (!canComment || !workspaceId || !objectId || submitting) return;
    const write = fileCommentWrite(path, objectId, draft);
    if (!write) return;
    setSubmitting(true);
    setSubmitError(null);
    const outcome = await writes.submit(workspaceId, write);
    setSubmitting(false);
    if (outcome.kind === "kept" || outcome.kind === "withheld") setDraft("");
    else if (outcome.kind === "not-kept") setSubmitError(chatWords.notKept);
  };
  const sendDisabled = draft.trim() === "" || submitting || blocked !== null;

  return (
    <SheetModal
      open={open}
      title={documentWords.comments}
      closeLabel={documentWords.close}
      onClose={onClose}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.list}
      >
        {state.value === null ? (
          state.problem ? (
            <RetryRow label={documentWords.commentsFailed} onRetry={retry} />
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
      {canComment ? (
        <View style={[styles.composer, { borderColor: theme.line, backgroundColor: theme.bg }]}>
          {submitError ? (
            <Text style={[styles.error, { color: theme.danger }]} accessibilityRole="alert">
              {submitError}
            </Text>
          ) : null}
          <View style={styles.composerRow}>
            <TextInput
              value={draft}
              onChangeText={(next) => {
                setDraft(next);
                setSubmitError(null);
              }}
              placeholder={documentWords.commentPlaceholder}
              placeholderTextColor={theme.subtle}
              editable={!submitting && blocked === null}
              multiline
              accessibilityLabel={documentWords.commentPlaceholder}
              style={[
                styles.input,
                { color: theme.ink, backgroundColor: theme.panel, borderColor: theme.line },
              ]}
            />
            <Pressable
              disabled={sendDisabled}
              onPress={() => void submit()}
              android_ripple={ripple(theme, true)}
              style={[
                styles.sendBtn,
                { backgroundColor: sendDisabled ? theme.panel2 : theme.accent },
              ]}
              accessibilityRole="button"
              accessibilityLabel={documentWords.commentAction}
            >
              <Text style={[styles.sendText, { color: sendDisabled ? theme.subtle : theme.bg }]}>
                {documentWords.commentAction}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </SheetModal>
  );
}

const styles = StyleSheet.create({
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
  composer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 12, gap: 6 },
  composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  input: {
    flex: 1,
    fontSize: 17,
    minHeight: TOUCH,
    maxHeight: 120,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sendBtn: {
    minHeight: TOUCH,
    paddingHorizontal: 14,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  sendText: { fontSize: 15, fontWeight: "600" },
  error: { fontSize: 14, lineHeight: 20 },
});
