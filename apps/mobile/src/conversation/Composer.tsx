import { accountWords } from "@dohc/interface-words/account";
import { confirmWords } from "@dohc/interface-words/confirmations";
import { chatWords } from "@dohc/interface-words/notices";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { ArrowUp, SquarePen, X } from "lucide-react-native";
import { useState, type ReactNode } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChatComposerField, type ClearRequest } from "../../modules/chat-composer";
import { ProblemLine } from "../account/ProblemLine";
import type { OutboxState } from "../server/outbox";
import { useTheme } from "../theme";
import { ReplyContext, type ReplyTo } from "./ReplyContext";
import {
  clearSent,
  clearStatus,
  EMPTY_DRAFT,
  fieldChanged,
  type Blocked,
  type Draft,
  type Lanes,
  type SubmitOutcome,
} from "./conversationWrites";

/** The field's height: one line at the least, and about five at the body size before it scrolls inside itself. */
const FIELD_MIN = 44;
const FIELD_MAX = 132;
/** The longest title the route takes. */
const TITLE_MAX = 200;

/** A problem with the outbox itself, which the composer shows above its field, with Try again when one can help. */
export interface OutboxProblem {
  readonly text: string;
  readonly retry?: () => void;
}

/** What the outbox's state says above the composer, or null. Each Try again is the outbox's `wake`. */
export function outboxProblem(
  state: OutboxState | null,
  blocked: Blocked,
  wake: () => void,
): OutboxProblem | null {
  if (state === null) return null;
  if (blocked === "deleting")
    return state.deletion === "failed" || state.deletion === "failed-unmarked"
      ? {
          text: accountWords.signOutDeleteFailed(state.deletion === "failed-unmarked"),
          retry: wake,
        }
      : null;
  if (blocked === "locked") return { text: chatWords.unlockToSend };
  if (blocked === "failed") return { text: chatWords.outboxUnreadable, retry: wake };
  return null;
}

// The conversation's composer, docked to the keyboard: a native multiline field, with Send, and New post in a Group
// that takes posts. A post adds an optional title. The text clears only once the outbox keeps it, and only if nobody
// edited it meanwhile, by revision, so anything typed meanwhile stays, and a newer post stays a post (`clearSent`,
// `closePost`). Text the outbox couldn't keep stays in the field, with the failure and Try again above it. Return is a
// new line; sending is the button. The screen gives each workspace store and chat its own composer, so a draft never
// reaches another destination.
//
// `replies`: every message is a reply, as in a thread, or in a stream once a message is chosen to reply to. Then there
// is no New post, and the reply's clear leaves New post as it was. `replyTo` names the chosen message above the field.
export function Composer({
  placeholder,
  lanes,
  blocked,
  problem,
  replies = false,
  replyTo = null,
  onCancelReply,
  onSubmit,
  onLayoutHeight,
}: {
  placeholder: string;
  lanes: Lanes;
  blocked: Blocked;
  problem: OutboxProblem | null;
  replies?: boolean;
  replyTo?: ReplyTo | null;
  onCancelReply?(): void;
  onSubmit(kind: "send" | "post" | "reply", body: string, title: string): Promise<SubmitOutcome>;
  onLayoutHeight(height: number): void;
}) {
  const theme = useTheme();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const editTitle = (title: string) =>
    setDraft((current) => ({ ...current, title, titleRevision: current.titleRevision + 1 }));
  const choose = (chosen: Draft["chosen"]) =>
    setDraft((current) => ({ ...current, chosen, chosenRevision: current.chosenRevision + 1 }));
  const { text, title } = draft;
  // A stream that takes only posts is always writing one.
  const mode = replies ? "reply" : lanes.send ? draft.chosen : "post";
  const [height, setHeight] = useState(FIELD_MIN);
  // The last clear asked of the field, and the draft it was for: null for a reply, whose clear closes nothing. Token 0
  // asks nothing. Send waits for its answer.
  const [clear, setClear] = useState<{
    readonly request: ClearRequest;
    readonly sent: Draft | null;
  }>({
    request: { revision: 0, token: 0 },
    sent: null,
  });
  // The token of the last clear the field refused, keeping the body sent.
  const [refused, setRefused] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // Why the outbox kept nothing: Try again submits the same text, and a reply whose message wasn't sent can't wait.
  const [failure, setFailure] = useState<"not-kept" | "parent-gone" | null>(null);
  const status = clearStatus(clear.request, draft.textRevision, refused);
  const busy = submitting || status === "waiting";
  const ready = text.trim().length > 0 && blocked === null && !submitting && status === "settled";

  async function submit() {
    if (!ready) return;
    const sent = draft;
    const kind = mode;
    setSubmitting(true);
    const outcome = await onSubmit(kind, sent.text, sent.title);
    setSubmitting(false);
    if (outcome.kind === "kept" || outcome.kind === "withheld") {
      setFailure(null);
      setClear((previous) => ({
        request: { revision: sent.textRevision, token: previous.request.token + 1 },
        sent: kind === "reply" ? null : sent,
      }));
      if (kind !== "reply") setDraft((current) => clearSent(current, sent));
      if (outcome.kind === "kept") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else if (outcome.kind === "not-kept" || outcome.kind === "parent-gone") {
      setFailure(outcome.kind);
      AccessibilityInfo.announceForAccessibility(
        outcome.kind === "not-kept" ? chatWords.notKept : chatWords.replyParentGone,
      );
    }
  }

  const label = mode === "post" ? chatWords.post : chatWords.sendMessage;
  const fieldLabel = replyTo ? chatWords.replyTo(replyTo.name) : placeholder;
  return (
    <Dock onLayoutHeight={onLayoutHeight}>
      {problem ? (
        problem.retry ? (
          <ProblemLine text={problem.text} onRetry={problem.retry} />
        ) : (
          <Text style={[styles.problem, { color: theme.muted }]}>{problem.text}</Text>
        )
      ) : null}
      {failure === "not-kept" ? (
        <ProblemLine text={chatWords.notKept} onRetry={() => void submit()} />
      ) : failure === "parent-gone" ? (
        <Text style={[styles.problem, { color: theme.danger }]} accessibilityRole="alert">
          {chatWords.replyParentGone}
        </Text>
      ) : null}
      {replyTo && onCancelReply ? <ReplyContext to={replyTo} onCancel={onCancelReply} /> : null}
      {mode === "post" ? (
        <View style={styles.postHead}>
          <TextInput
            value={title}
            onChangeText={editTitle}
            placeholder={chatWords.title}
            placeholderTextColor={theme.subtle}
            accessibilityLabel={chatWords.title}
            maxLength={TITLE_MAX}
            returnKeyType="next"
            style={[styles.title, { color: theme.ink, borderBottomColor: theme.line }]}
          />
          {lanes.send ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={confirmWords.cancel}
              onPress={() => choose("send")}
              style={styles.round}
            >
              <SymbolView
                name="xmark"
                size={16}
                weight="semibold"
                tintColor={theme.muted}
                fallback={<X size={18} color={theme.muted} strokeWidth={2.5} />}
              />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View style={styles.row}>
        {lanes.post && mode === "send" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={chatWords.newPost}
            onPress={() => choose("post")}
            style={styles.round}
          >
            <SymbolView
              name="square.and.pencil"
              size={20}
              weight="medium"
              tintColor={theme.muted}
              fallback={<SquarePen size={20} color={theme.muted} strokeWidth={2} />}
            />
          </Pressable>
        ) : null}
        <View
          style={[styles.field, { backgroundColor: theme.field, borderColor: theme.fieldLine }]}
        >
          <ChatComposerField
            placeholder={placeholder}
            fieldLabel={fieldLabel}
            editable
            textColor={theme.ink}
            placeholderColor={theme.subtle}
            clearIf={clear.request}
            onChangeText={({ nativeEvent: change }) => {
              if (change.refused !== 0) setRefused(change.refused);
              setDraft((current) => fieldChanged(current, change, clear.request, clear.sent));
            }}
            onContentHeight={(event) => setHeight(event.nativeEvent.height)}
            style={{ height: Math.min(Math.max(height, FIELD_MIN), FIELD_MAX) }}
          />
        </View>
        <Pressable
          disabled={!ready}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled: !ready, busy }}
          onPress={() => void submit()}
          style={[styles.round, ready && { backgroundColor: theme.accent }]}
        >
          <SymbolView
            name="arrow.up"
            size={18}
            weight="bold"
            tintColor={ready ? theme.bg : theme.subtle}
            fallback={
              <ArrowUp size={20} color={ready ? theme.bg : theme.subtle} strokeWidth={2.5} />
            }
          />
        </Pressable>
      </View>
    </Dock>
  );
}

/** A problem in the composer's place, docked as the composer is, when the chat can't show one, with Try again. */
export function ComposerProblem({
  problem,
  onLayoutHeight,
}: {
  problem: Required<OutboxProblem>;
  onLayoutHeight(height: number): void;
}) {
  return (
    <Dock onLayoutHeight={onLayoutHeight}>
      <ProblemLine text={problem.text} onRetry={problem.retry} />
    </Dock>
  );
}

/** The bar at the screen's bottom that rides the keyboard, reporting its height so the list's end clears it. */
function Dock({
  onLayoutHeight,
  children,
}: {
  onLayoutHeight(height: number): void;
  children: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom - 6 }} style={styles.sticky}>
      <View
        onLayout={(event) => onLayoutHeight(event.nativeEvent.layout.height)}
        style={[
          styles.bar,
          {
            paddingBottom: Math.max(insets.bottom - 4, 6),
            backgroundColor: theme.bg,
            borderTopColor: theme.line,
          },
        ]}
      >
        {children}
      </View>
    </KeyboardStickyView>
  );
}

const styles = StyleSheet.create({
  sticky: { position: "absolute", left: 0, right: 0, bottom: 0 },
  bar: {
    paddingHorizontal: 12,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  problem: { fontSize: 15, lineHeight: 20, paddingVertical: 8 },
  postHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 6 },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: "600",
    minHeight: 44,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  field: {
    flex: 1,
    minHeight: FIELD_MIN,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 14,
    justifyContent: "center",
  },
});
