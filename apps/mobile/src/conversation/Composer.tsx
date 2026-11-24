import { confirmWords } from "@dohc/interface-words/confirmations";
import { chatWords } from "@dohc/interface-words/notices";
import type { PhoneMentionCandidate } from "@dohc/workspace-contracts/chat-wakes";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { ArrowUp, SquarePen, X } from "lucide-react-native";
import { useContext, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChatComposerField, type ClearRequest } from "../../modules/chat-composer";
import { ProblemLine } from "../account/ProblemLine";
import type { OutboxState } from "../server/outbox";
import { useTheme } from "../theme";
import { TOUCH } from "../touch";
import { useBackCloses } from "../backCloses";
import { ReplyContext, replyLabel, type ReplyTo } from "./ReplyContext";
import {
  clearedBy,
  clearSent,
  clearStatus,
  EMPTY_DRAFT,
  fieldChanged,
  replyParentGone,
  type Blocked,
  type Draft,
  type Lanes,
  type SubmitFailure,
  type SubmitOutcome,
} from "./conversationWrites";
import { MentionMenu } from "./MentionMenu";
import { ComposerBar } from "./revealAboveComposer";
import {
  acceptsReport,
  activeMention,
  askReplacement,
  composing,
  mentionCompletion,
  mentionMatches,
  NO_REPLACING,
  phoneMentions,
  replacementAnswered,
  replacePending,
  snapshotOf,
  type FieldSnapshot,
  type PhoneMention,
  type Replacing,
} from "./mentionDraft";

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

/**
 * What the outbox's state says above the composer, or null. Try again is the outbox's `wake`. The words name where a
 * failed Sign out is tried again and a damaged file is deleted, since the composer can do neither.
 */
export function outboxProblem(
  state: OutboxState | null,
  blocked: Blocked,
  wake: () => void,
): OutboxProblem | null {
  if (state === null) return null;
  if (blocked === "deleting") return { text: chatWords.signOutDeleteFailedHere };
  if (blocked === "locked") return { text: chatWords.unlockToSend };
  if (blocked === "failed") return { text: chatWords.outboxUnreadable, retry: wake };
  if (blocked === "damaged") return { text: chatWords.outboxDamagedHere };
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
// `closed` says why the chosen message no longer takes the text: Send stays off, and the text stays, until the person
// cancels it or chooses another; it shows once the field has answered for any text being sent. Undocked, as in a
// Notice's row, it sits where it's placed, without the bar.
//
// `initialText` is a draft kept elsewhere, as a Notice's answer keeps its text above its recycled row: the field shows
// it once, only while it's still empty and unedited, and reports it as an edit. `onText` follows the field's text, and
// `onCleared` says the field cleared the text the outbox kept.
//
// The composer follows the field's latest report of its selection and composition too. While an input method is
// composing, Send stays off, since the word being composed isn't text yet. A range replacement goes to the field as
// a request made from that report (`askReplacement`), which the field applies only if nothing moved since, and answers
// once (`replacementAnswered`).
//
// `mentions` are who the conversation's context read says it can mention, or null while that read loads or after it
// failed. While the caret types an `@` outside code, the menu above the field lists the matches; a tap asks the field to
// complete the text, once, and a refusal leaves it as it was.
export function Composer({
  placeholder,
  lanes,
  blocked,
  problem,
  replies = false,
  replyTo = null,
  closed = null,
  initialText = "",
  onCancelReply,
  onSubmit,
  onText,
  onCleared,
  onLayoutHeight,
  docked = true,
  mentions = null,
}: {
  placeholder: string;
  lanes: Lanes;
  blocked: Blocked;
  problem: OutboxProblem | null;
  replies?: boolean;
  replyTo?: ReplyTo | null;
  closed?: string | null;
  initialText?: string;
  onCancelReply?(): void;
  onSubmit(kind: "send" | "post" | "reply", body: string, title: string): Promise<SubmitOutcome>;
  onText?(text: string): void;
  onCleared?(): void;
  onLayoutHeight?(height: number): void;
  docked?: boolean;
  mentions?: readonly PhoneMentionCandidate[] | null;
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
  // Back closes a New post's title, or the reply's context, before it leaves the chat.
  useBackCloses(mode === "post" && lanes.send, () => choose("send"));
  useBackCloses(replyTo !== null && onCancelReply !== undefined, () => onCancelReply?.());
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
  // The field's latest report, and the last replacement asked of it, with its answer once it came. `accepted` is the
  // sequence of the last report taken, read as each report arrives, so a stale one is dropped whole (`acceptsReport`).
  const [field, setField] = useState<FieldSnapshot | null>(null);
  const accepted = useRef(0);
  const [replacing, setReplacing] = useState<Replacing>(NO_REPLACING);
  const [submitting, setSubmitting] = useState(false);
  // Why the outbox kept nothing: Try again submits the same text, and a reply whose message wasn't sent can't wait, so
  // Send stays off while that reply is chosen (`replyParentGone`).
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const status = clearStatus(clear.request, draft.textRevision, refused);
  const busy = submitting || status === "waiting";
  const ready =
    text.trim().length > 0 &&
    !composing(field) &&
    !replacePending(replacing) &&
    blocked === null &&
    !submitting &&
    status === "settled" &&
    closed === null &&
    !replyParentGone(failure, replyTo);

  async function submit() {
    if (!ready) return;
    const sent = draft;
    const kind = mode;
    const chosen = replyTo;
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
      setFailure(
        outcome.kind === "parent-gone"
          ? { kind: outcome.kind, replyTo: chosen }
          : { kind: outcome.kind },
      );
      AccessibilityInfo.announceForAccessibility(
        outcome.kind === "not-kept" ? chatWords.notKept : chatWords.replyParentGone,
      );
    }
  }

  // The menu waits while the field owes an answer, so a second tap can't ask for another completion meanwhile.
  const candidates = useMemo(() => (mentions ? phoneMentions(mentions) : null), [mentions]);
  const active = candidates && !replacePending(replacing) ? activeMention(field) : null;
  const matches = candidates && active ? mentionMatches(active, candidates) : null;
  const pick = (candidate: PhoneMention) => {
    if (field === null || active === null) return;
    const asked = askReplacement(replacing, field, mentionCompletion(field, active, candidate));
    if (asked.kind === "asked") setReplacing(asked.replacing);
  };

  const label = mode === "post" ? chatWords.post : chatWords.sendMessage;
  const fieldLabel = replyTo ? replyLabel(replyTo) : placeholder;
  const Holder = docked ? Dock : Inline;
  return (
    <Holder onLayoutHeight={onLayoutHeight}>
      {problem ? (
        problem.retry ? (
          <ProblemLine text={problem.text} onRetry={problem.retry} />
        ) : (
          <Text style={[styles.problem, { color: theme.muted }]}>{problem.text}</Text>
        )
      ) : null}
      {closed !== null ? (
        busy ? null : (
          <Text style={[styles.problem, { color: theme.danger }]} accessibilityRole="alert">
            {closed}
          </Text>
        )
      ) : failure?.kind === "not-kept" ? (
        <ProblemLine text={chatWords.notKept} onRetry={() => void submit()} />
      ) : failure?.kind === "parent-gone" ? (
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
      {matches ? <MentionMenu matches={matches} onPick={pick} /> : null}
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
            replaceIf={replacing.request}
            initialText={initialText}
            onChangeText={({ nativeEvent: change }) => {
              if (change.replaced !== undefined)
                setReplacing((current) => replacementAnswered(current, change));
              if (!acceptsReport(accepted.current, change)) return;
              accepted.current = change.sequence;
              setField(snapshotOf(change));
              if (change.refused !== 0) setRefused(change.refused);
              setDraft((current) => fieldChanged(current, change, clear.request, clear.sent));
              onText?.(change.text);
              if (clearedBy(change, clear.request)) onCleared?.();
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
    </Holder>
  );
}

/** The composer in place, as in a Notice's row, reporting its height as the dock does. */
function Inline({
  onLayoutHeight,
  children,
}: {
  onLayoutHeight?(height: number): void;
  children: ReactNode;
}) {
  return (
    <View
      onLayout={
        onLayoutHeight ? (event) => onLayoutHeight(event.nativeEvent.layout.height) : undefined
      }
    >
      {children}
    </View>
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
  onLayoutHeight?(height: number): void;
  children: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const bar = useContext(ComposerBar);
  return (
    <KeyboardStickyView
      offset={{ closed: 0, opened: insets.bottom - 6 + LIFT }}
      style={styles.sticky}
    >
      <View
        ref={bar}
        onLayout={(event) => onLayoutHeight?.(event.nativeEvent.layout.height)}
        style={[
          styles.bar,
          {
            paddingBottom: Math.max(insets.bottom - 4 + LIFT, 6),
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

// Android's gesture handle sits lower in its inset than iOS's home indicator: the bar keeps 8 dp more above it there.
// The keyboard's offset takes the same back, so above the keyboard the bar sits as it does on iOS.
const LIFT = Platform.OS === "android" ? 8 : 0;

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
    width: TOUCH,
    height: TOUCH,
    borderRadius: TOUCH / 2,
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
