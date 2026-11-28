import { SymbolView } from "expo-symbols";
import { useRouter } from "expo-router";
import { Reply, SmilePlus, X } from "lucide-react-native";
import { memo, useContext, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ScrollViewInstance,
  type ViewInstance,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { confirmWords } from "@dohc/interface-words/confirmations";
import { chatWords } from "@dohc/interface-words/notices";
import { workspaceWords } from "@dohc/interface-words/workspace";
import type { PhoneChatWake } from "@dohc/workspace-contracts/chat-wakes";
import { AgentMark } from "../AgentMark";
import { ActionPill } from "../notices/ActionPill";
import { sampleBuild } from "../sampleBuild";
import { useTheme, type Theme } from "../theme";
import { DecisionCard } from "./DecisionCard";
import { RevealAboveComposer } from "./revealAboveComposer";
import { localOffers } from "./outboxMessages";
import type { Author, LocalMark, Message, Reaction, ReactionMark, Segment } from "./types";
import type { AnswerActions, LocalActions, ReactActions } from "./useOutbox";
import type { WakeRetry } from "./chatWakeState";
import { WakeState } from "./WakeState";
import { symbolFallback } from "../symbolFallback";
import { useBackCloses } from "../backCloses";
import { ripple, slopTo } from "../touch";

// One message, as in Slack: an author line starts a group; follow-ups from the same author within a few minutes don't repeat it.
// Where writes are on, a message the server has offers its reactions, Add reaction and Reply; one only this phone has
// offers Reply when a reply can wait for it. A message that asks a question or a poll shows its card, which takes
// answers where writes are on. A message the server has shows where each agent it woke stands, and, where writes are
// on, Try again on an agent that didn't start or wasn't confirmed.
export const MessageRow = memo(function MessageRow({
  message,
  continued,
  afterExtras,
  onOpenReplies,
  onPrefetchReplies,
  actions,
  react,
  onReply,
  answers,
  wakes,
  wakesFailed = false,
  onRetryWakes,
  wakeRetries,
  onRetryWake,
}: {
  message: Message;
  continued: boolean;
  afterExtras: boolean;
  onOpenReplies?(message: Message): void;
  onPrefetchReplies?(message: Message): void;
  /** What a message only this phone has offers, and a reaction it keeps. */
  actions?: LocalActions;
  /** Reactions, where writes are on. */
  react?: ReactActions;
  onReply?(message: Message): void;
  /** A question's or poll's answers, where writes are on. */
  answers?: AnswerActions;
  /** The wakes of a message the server has, from the latest read of its conversation's wakes. */
  wakes?: readonly PhoneChatWake[];
  /** That read failed, so the wakes are from the read before. */
  wakesFailed?: boolean;
  onRetryWakes?(): void;
  /** Its conversation's lines' Try again states, by wake ID. */
  wakeRetries?: ReadonlyMap<string, WakeRetry>;
  /** Try again on one of its lines, where writes are on and the read holds. */
  onRetryWake?(wake: PhoneChatWake): void;
}) {
  const theme = useTheme();
  const paddingTop = continued ? (afterExtras ? 12 : 8) : 14;
  // An agent's mark and name open its card, which only the sample has yet.
  const agent = sampleBuild && !continued && message.author.kind === "agent";
  const [name, setName] = useState<Box | null>(null);
  return (
    <View style={[styles.row, { paddingTop }]}>
      <View style={styles.gutter}>
        {continued ? null : <Avatar author={message.author} theme={theme} size={36} />}
      </View>
      <View style={styles.main}>
        {continued ? null : (
          <View style={styles.byline}>
            <Text
              style={[styles.author, { color: theme.ink }]}
              accessibilityElementsHidden={agent}
              importantForAccessibility={agent ? "no-hide-descendants" : "auto"}
              onLayout={agent ? (event) => setName(event.nativeEvent.layout) : undefined}
            >
              {message.author.name}
            </Text>
            {message.local ? (
              <LocalStateText mark={message.local} theme={theme} />
            ) : (
              <Text style={[styles.time, { color: theme.subtle }]}>{message.at}</Text>
            )}
          </View>
        )}
        {message.title ? (
          <Text style={[styles.postTitle, { color: theme.ink }]}>{message.title}</Text>
        ) : null}
        {message.working ? (
          <Working label={message.working} theme={theme} />
        ) : (
          <Body segments={message.body} theme={theme} />
        )}
        {message.local && actions ? (
          <LocalFooter mark={message.local} actions={actions} theme={theme} />
        ) : null}
        {message.decision ? (
          <DecisionCard
            message={message}
            decision={message.decision}
            {...(answers ? { answers } : {})}
          />
        ) : null}
        {wakes && message.local === undefined ? (
          <WakeState
            wakes={wakes}
            failed={wakesFailed}
            {...(onRetryWakes ? { onRetry: onRetryWakes } : {})}
            {...(wakeRetries ? { retries: wakeRetries } : {})}
            {...(onRetryWake ? { onRetryWake } : {})}
          />
        ) : null}
        {message.local === undefined && message.threadId && react ? (
          <MessageActions
            message={message}
            react={react}
            blocked={actions?.blocked ?? false}
            {...(onReply ? { onReply } : {})}
            theme={theme}
          />
        ) : message.reactions ? (
          <View style={styles.reactions}>
            {message.reactions.map((reaction) => (
              <ReactionChip key={reaction.emoji} reaction={reaction} theme={theme} />
            ))}
          </View>
        ) : message.replyable && onReply ? (
          <View style={styles.reactions}>
            <ReplyButton onPress={() => onReply(message)} theme={theme} />
          </View>
        ) : null}
        {message.reactionMarks?.length && actions ? (
          <ReactionFooter marks={message.reactionMarks} actions={actions} theme={theme} />
        ) : null}
        {message.replies ? (
          <Pressable
            style={styles.replies}
            hitSlop={slopTo(22)}
            accessibilityRole="button"
            onPressIn={onPrefetchReplies ? () => onPrefetchReplies(message) : undefined}
            onPress={onOpenReplies ? () => onOpenReplies(message) : undefined}
            accessibilityLabel={`${message.replies.count} replies, last at ${message.replies.last}`}
          >
            <View style={styles.pile}>
              {message.replies.people.map((person) => (
                <Avatar key={person.id} author={person} theme={theme} size={20} />
              ))}
            </View>
            <Text style={[styles.repliesText, { color: theme.accent }]}>
              {workspaceWords.replies(message.replies.count)}
            </Text>
            <Text style={[styles.time, { color: theme.subtle }]}>
              {workspaceWords.lastReply(message.replies.last)}
            </Text>
            <SymbolView
              name="chevron.right"
              size={11}
              weight="semibold"
              tintColor={theme.subtle}
              fallback={symbolFallback("chevron.right", 11, theme.subtle)}
            />
          </Pressable>
        ) : null}
      </View>
      {agent ? <AgentTarget author={message.author} top={paddingTop} name={name} /> : null}
    </View>
  );
});

type Box = { x: number; y: number; width: number; height: number };

/** Where a message only this phone has stands, in the time's place. A saved one shows nothing until a read has it. */
function LocalStateText({ mark, theme }: { mark: LocalMark; theme: Theme }) {
  const text =
    mark.state.kind === "waiting"
      ? chatWords.waitingToSend
      : mark.state.kind === "sending"
        ? chatWords.sending
        : mark.state.kind === "stalled"
          ? chatWords.stillSending
          : null;
  return text ? <Text style={[styles.time, { color: theme.subtle }]}>{text}</Text> : null;
}

/** Under a message only this phone has: why it wasn't sent, and what can be done (`localOffers`). */
export function LocalFooter({
  mark,
  actions,
  theme,
  sendable = true,
  discardsPending = false,
}: {
  mark: LocalMark;
  actions: LocalActions;
  theme: Theme;
  sendable?: boolean;
  discardsPending?: boolean;
}) {
  const { state } = mark;
  const problem = actions.problems.get(mark.operationId);
  const reason =
    state.kind === "withheld"
      ? mark.maySendOnReopen
        ? chatWords.notSentMaySendOnReopen
        : chatWords.notSent
      : state.kind === "refused"
        ? chatWords.refused(state.reason)
        : state.kind === "missing"
          ? chatWords.missing
          : null;
  const offers = localOffers(mark, { sendable, discardsPending });
  if (!offers.discard && problem === undefined) return null;
  return (
    <View style={styles.local}>
      {reason ? <Text style={[styles.localText, { color: theme.danger }]}>{reason}</Text> : null}
      {problem ? (
        <Text style={[styles.localText, { color: theme.danger }]} accessibilityRole="alert">
          {problem}
        </Text>
      ) : null}
      <View style={styles.localActions}>
        {offers.send ? (
          <ActionPill
            label={chatWords.send}
            disabled={actions.blocked}
            onPress={() => actions.send(mark)}
          />
        ) : null}
        {offers.copy ? (
          <ActionPill label={chatWords.copyMessage} onPress={() => actions.copy(mark)} />
        ) : null}
        {offers.discard ? (
          <ActionPill
            label={chatWords.discard}
            disabled={actions.blocked}
            onPress={() => actions.discard(mark)}
          />
        ) : null}
      </View>
    </View>
  );
}

/** The desktop's reaction choices (apps/desktop/src/renderer/workbench/chatMessages.tsx). */
const REACTION_CHOICES = ["👍", "❤️", "🎉", "🙌", "😄", "👀", "✅", "🚀"] as const;

/** One emoji's reactions. A button where it can change; dashed while this phone's reaction with it isn't settled. */
function ReactionChip({
  reaction,
  onPress,
  disabled = false,
  theme,
}: {
  reaction: Reaction;
  onPress?(): void;
  disabled?: boolean;
  theme: Theme;
}) {
  const mine = reaction.mine === true;
  const pending = reaction.pending === true;
  const style = [
    styles.reaction,
    {
      backgroundColor: mine ? theme.mine : theme.reaction,
      borderColor: mine ? theme.accent : theme.reactionLine,
    },
    pending && styles.pending,
  ];
  const content = (
    <>
      <Text style={styles.emoji}>{reaction.emoji}</Text>
      <Text style={[styles.reactionCount, { color: mine ? theme.accent : theme.ink }]}>
        {reaction.count}
      </Text>
    </>
  );
  const label = chatWords.reaction(reaction.emoji, reaction.count, mine);
  if (!onPress)
    return (
      <View style={style} accessible accessibilityLabel={label}>
        {content}
      </View>
    );
  return (
    <Pressable
      hitSlop={{ ...slopTo(26), left: 2, right: 2 }}
      android_ripple={ripple(theme)}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: mine, busy: pending, disabled }}
      style={style}
    >
      {content}
    </Pressable>
  );
}

function ReplyButton({ onPress, theme }: { onPress(): void; theme: Theme }) {
  return (
    <Pressable
      hitSlop={{ ...slopTo(26), left: 4, right: 4 }}
      android_ripple={ripple(theme)}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={chatWords.reply}
      style={[styles.reaction, styles.tool, { borderColor: theme.reactionLine }]}
    >
      <SymbolView
        name="arrowshape.turn.up.left"
        size={14}
        weight="medium"
        tintColor={theme.muted}
        fallback={<Reply size={15} color={theme.muted} strokeWidth={2} />}
      />
    </Pressable>
  );
}

/**
 * Under a message the server has: its reactions, Add reaction and Reply. Add reaction opens the choices under it, and
 * a choice or Cancel closes them and puts focus back on Add reaction. While a reaction of this phone's to the message
 * isn't settled, or while writes wait, its reactions take no tap.
 */
function MessageActions({
  message,
  react,
  blocked,
  onReply,
  theme,
}: {
  message: Message;
  react: ReactActions;
  blocked: boolean;
  onReply?(message: Message): void;
  theme: Theme;
}) {
  const [picking, setPicking] = useState(false);
  const opener = useRef<ViewInstance>(null);
  const reveal = useContext(RevealAboveComposer);
  const picker = useRef<ScrollViewInstance>(null);
  const disabled = blocked || message.reactionsBusy === true;
  const problem = react.problems.get(message.id);
  const close = () => {
    setPicking(false);
    requestAnimationFrame(() => {
      if (opener.current) AccessibilityInfo.sendAccessibilityEvent(opener.current, "focus");
    });
  };
  useBackCloses(picking, close);
  return (
    <>
      <View style={styles.reactions}>
        {(message.reactions ?? []).map((reaction) => (
          <ReactionChip
            key={reaction.emoji}
            reaction={reaction}
            disabled={disabled}
            onPress={() => react.react(message, reaction.emoji)}
            theme={theme}
          />
        ))}
        <Pressable
          ref={opener}
          hitSlop={{ ...slopTo(26), left: 4, right: 4 }}
          android_ripple={ripple(theme)}
          disabled={disabled}
          onPress={() => setPicking((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel={chatWords.addReaction}
          accessibilityState={{ disabled, expanded: picking }}
          style={[styles.reaction, styles.tool, { borderColor: theme.reactionLine }]}
        >
          <SymbolView
            name="face.smiling"
            size={15}
            weight="medium"
            tintColor={disabled ? theme.subtle : theme.muted}
            fallback={
              <SmilePlus size={15} color={disabled ? theme.subtle : theme.muted} strokeWidth={2} />
            }
          />
        </Pressable>
        {onReply ? (
          <ReplyButton
            onPress={() => {
              setPicking(false);
              onReply(message);
            }}
            theme={theme}
          />
        ) : null}
      </View>
      {picking ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.pickerScroll}
          contentContainerStyle={styles.picker}
          ref={picker}
          onLayout={() => {
            if (picker.current) reveal?.(picker.current);
          }}
        >
          <Pressable
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel={confirmWords.cancel}
            style={styles.choice}
          >
            <SymbolView
              name="xmark"
              size={14}
              weight="semibold"
              tintColor={theme.muted}
              fallback={<X size={16} color={theme.muted} strokeWidth={2.5} />}
            />
          </Pressable>
          {REACTION_CHOICES.map((emoji) => (
            <Pressable
              key={emoji}
              disabled={disabled}
              onPress={() => {
                react.react(message, emoji);
                close();
              }}
              accessibilityRole="button"
              accessibilityLabel={emoji}
              accessibilityState={{
                disabled,
                selected: message.reactions?.some((each) => each.emoji === emoji && each.mine),
              }}
              style={({ pressed }) => [
                styles.choice,
                { backgroundColor: pressed ? theme.panel2 : "transparent" },
              ]}
            >
              <Text style={styles.choiceEmoji}>{emoji}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {problem ? (
        <Text style={[styles.localText, { color: theme.danger }]} accessibilityRole="alert">
          {problem}
        </Text>
      ) : null}
    </>
  );
}

/**
 * The reactions this phone keeps for a message that need the person. A withheld one has Send and Discard; one still
 * sending, or saved but shown otherwise by a read since, has Discard, and its reaction stays pending; one the server
 * refused, or whose message it can't find, has Discard, and its reaction shows as the server has it.
 */
function ReactionFooter({
  marks,
  actions,
  theme,
}: {
  marks: readonly ReactionMark[];
  actions: LocalActions;
  theme: Theme;
}) {
  return (
    <View style={styles.local}>
      {marks.map(({ emoji, state, mark }) => {
        const problem = actions.problems.get(mark.operationId);
        const settling = mark.state.kind === "stalled" || mark.state.kind === "saved";
        return (
          <View key={mark.operationId} style={styles.local}>
            <Text style={[styles.localText, { color: settling ? theme.muted : theme.danger }]}>
              {mark.state.kind === "withheld"
                ? mark.maySendOnReopen
                  ? chatWords.reactionNotSentMaySendOnReopen(emoji)
                  : chatWords.reactionNotSent(emoji)
                : mark.state.kind === "stalled"
                  ? chatWords.reactionStillSending(emoji)
                  : mark.state.kind === "saved"
                    ? chatWords.reactionUnconfirmed(emoji, state)
                    : chatWords.reactionRefused(emoji)}
            </Text>
            {problem ? (
              <Text style={[styles.localText, { color: theme.danger }]} accessibilityRole="alert">
                {problem}
              </Text>
            ) : null}
            <View style={styles.localActions}>
              {mark.state.kind === "withheld" ? (
                <ActionPill
                  label={chatWords.send}
                  disabled={actions.blocked}
                  onPress={() => actions.send(mark)}
                />
              ) : null}
              <ActionPill
                label={chatWords.discard}
                disabled={actions.blocked}
                onPress={() => actions.discardReaction(mark)}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

// An agent's mark and name are one tap target, as the desktop's badge is: a tap opens the agent's card. One button lies
// over both, taking touches only on the mark and the name, so a tap on the message's words beside the mark doesn't open
// it. VoiceOver hears it once, framed around both, as the name and "connected agent" or "agent".
function AgentTarget({ author, top, name }: { author: Author; top: number; name: Box | null }) {
  const router = useRouter();
  // The byline starts after the 36 pt mark and the row's 10 pt gap.
  const nameLeft = name ? 46 + name.x : 36;
  const width = name ? nameLeft + name.width : 36;
  // At large text sizes the name is taller than the mark; the frame VoiceOver draws must hold all of it.
  const height = name ? Math.max(36, name.y + name.height) : 36;
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/agent-card", params: { id: author.id } })}
      pointerEvents="box-none"
      accessibilityRole="button"
      accessibilityLabel={`${author.name}, ${author.connected ? "connected agent" : "agent"}`}
      style={[styles.target, { top, width, height }]}
    >
      {/* Empty views are flattened away unless kept, and then nothing under the button would take the touch. */}
      {/* With a name, the mark's area reaches it, so no dead strip lies between them. */}
      <View collapsable={false} style={[styles.targetMark, name ? { width: nameLeft } : null]} />
      {name ? (
        <View
          collapsable={false}
          style={{
            position: "absolute",
            left: nameLeft - 4,
            top: name.y - 4,
            width: name.width + 8,
            height: name.height + 8,
          }}
        />
      ) : null}
    </Pressable>
  );
}

function Body({ segments, theme }: { segments: readonly Segment[]; theme: Theme }) {
  return (
    <Text style={[styles.body, { color: theme.ink }]}>
      {segments.map((segment, index) =>
        "mention" in segment ? (
          <Text
            key={index}
            style={[
              styles.mention,
              segment.agent
                ? { backgroundColor: theme.agentTint, color: theme.agent }
                : { backgroundColor: theme.mention, color: theme.accent },
            ]}
          >
            {"\u200A"}@{segment.mention}
            {"\u200A"}
          </Text>
        ) : (
          segment.text
        ),
      )}
    </Text>
  );
}

// The agent is running: a small dot that breathes, still when Reduce Motion is on.
function Working({ label, theme }: { label: string; theme: Theme }) {
  const reduced = useReducedMotion();
  const level = useSharedValue(1);
  useEffect(() => {
    if (!reduced) level.value = withRepeat(withTiming(0.55, { duration: 1100 }), -1, true);
  }, [level, reduced]);
  const pulse = useAnimatedStyle(() => ({ opacity: level.value }));
  return (
    <View style={styles.working}>
      <Animated.View style={[styles.pulse, { backgroundColor: theme.agent }, pulse]} />
      <Text style={[styles.workingText, { color: theme.muted }]}>{label}…</Text>
    </View>
  );
}

export function Avatar({ author, theme, size }: { author: Author; theme: Theme; size: number }) {
  if (author.kind === "agent")
    return <AgentMark hue={author.agentHue} connected={author.connected} size={size} />;
  return (
    <View
      style={[
        styles.fill,
        {
          width: size,
          height: size,
          flex: 0,
          borderRadius: size / 2,
          backgroundColor: author.hue ?? theme.subtle,
        },
      ]}
    >
      <Text style={[styles.initials, { fontSize: size * 0.36 }]} allowFontScaling={false}>
        {author.initials}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", paddingHorizontal: 16, gap: 10 },
  gutter: { width: 36 },
  target: { position: "absolute", left: 16 },
  targetMark: { position: "absolute", left: 0, top: 0, width: 36, height: 36 },
  main: { flex: 1, gap: 2 },
  byline: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  author: { fontSize: 15, fontWeight: "600" },
  time: { fontSize: 12 },
  body: { fontSize: 16, lineHeight: 22 },
  postTitle: { fontSize: 16, lineHeight: 22, fontWeight: "600" },
  local: { gap: 6, marginTop: 6 },
  localText: { fontSize: 15, lineHeight: 20 },
  localActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  mention: { fontWeight: "600" },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  reaction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    minHeight: 26,
    borderRadius: 13,
    borderWidth: 1,
  },
  emoji: { fontSize: 14 },
  reactionCount: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  /** Not settled: the border dashes, beside the button's busy state. */
  pending: { borderStyle: "dashed" },
  /** Add reaction and Reply: as wide as the touch needs, with no count. */
  tool: { minWidth: 36, justifyContent: "center" },
  pickerScroll: { marginTop: 4 },
  picker: { flexDirection: "row", gap: 2 },
  choice: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  choiceEmoji: { fontSize: 22 },
  replies: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
    alignSelf: "flex-start",
    minHeight: 22,
  },
  pile: { flexDirection: "row", gap: 3, marginRight: 2 },
  repliesText: { fontSize: 14, fontWeight: "600" },
  working: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 22 },
  pulse: { width: 7, height: 7, borderRadius: 3.5, marginTop: 1 },
  workingText: { fontSize: 14 },
  fill: { flex: 1, alignItems: "center", justifyContent: "center" },
  initials: { color: "#fff", fontWeight: "700" },
});
