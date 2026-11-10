import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useRouter } from "expo-router";
import { memo, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { workspaceWords } from "@dohc/interface-words/workspace";
import { AgentMark } from "../AgentMark";
import { sampleBuild } from "../sampleBuild";
import { useTheme, type Theme } from "../theme";
import type { Author, Message, Segment } from "./sample";

// One message, as in Slack: an author line starts a group; follow-ups from the same author within a few minutes don't repeat it.
export const MessageRow = memo(function MessageRow({ message, continued, afterExtras, onOpenReplies }: {
  message: Message; continued: boolean; afterExtras: boolean; onOpenReplies?(message: Message): void;
}) {
  const theme = useTheme();
  const paddingTop = continued ? (afterExtras ? 12 : 8) : 14;
  // An agent's mark and name open its card, which only the sample has yet.
  const agent = sampleBuild && !continued && message.author.kind === "agent";
  const [name, setName] = useState<Box | null>(null);
  return (
    <View style={[styles.row, { paddingTop }]}>
      <View style={styles.gutter}>{continued ? null : <Avatar author={message.author} theme={theme} size={36} />}</View>
      <View style={styles.main}>
        {continued ? null : (
          <View style={styles.byline}>
            <Text style={[styles.author, { color: theme.ink }]} accessibilityElementsHidden={agent}
              importantForAccessibility={agent ? "no-hide-descendants" : "auto"}
              onLayout={agent ? event => setName(event.nativeEvent.layout) : undefined}>
              {message.author.name}
            </Text>
            <Text style={[styles.time, { color: theme.subtle }]}>{message.at}</Text>
          </View>
        )}
        {message.working ? <Working label={message.working} theme={theme} /> : <Body segments={message.body} theme={theme} />}
        {message.question ? <Question options={message.question.options} initial={message.question.chosen} theme={theme} /> : null}
        {message.reactions ? (
          <View style={styles.reactions}>
            {message.reactions.map(reaction => (
              <Pressable key={reaction.emoji} hitSlop={{ top: 9, bottom: 9 }} accessibilityRole="button"
                accessibilityLabel={`${reaction.emoji} ${reaction.count}${reaction.mine ? ", yours" : ""}`} style={[styles.reaction, {
                backgroundColor: reaction.mine ? theme.mine : theme.reaction,
                borderColor: reaction.mine ? theme.accent : theme.reactionLine,
              }]}>
                <Text style={styles.emoji}>{reaction.emoji}</Text>
                <Text style={[styles.reactionCount, { color: reaction.mine ? theme.accent : theme.ink }]}>{reaction.count}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {message.replies ? (
          <Pressable style={styles.replies} hitSlop={{ top: 11, bottom: 11 }} accessibilityRole="button"
            onPress={onOpenReplies ? () => onOpenReplies(message) : undefined}
            accessibilityLabel={`${message.replies.count} replies, last at ${message.replies.last}`}>
            <View style={styles.pile}>{message.replies.people.map(person => <Avatar key={person.id} author={person} theme={theme} size={20} />)}</View>
            <Text style={[styles.repliesText, { color: theme.accent }]}>{workspaceWords.replies(message.replies.count)}</Text>
            <Text style={[styles.time, { color: theme.subtle }]}>{workspaceWords.lastReply(message.replies.last)}</Text>
            <SymbolView name="chevron.right" size={11} weight="semibold" tintColor={theme.subtle} fallback={null} />
          </Pressable>
        ) : null}
      </View>
      {agent ? <AgentTarget author={message.author} top={paddingTop} name={name} /> : null}
    </View>
  );
});

type Box = { x: number; y: number; width: number; height: number };

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
    <Pressable onPress={() => router.push({ pathname: "/agent-card", params: { id: author.id } })}
      pointerEvents="box-none" accessibilityRole="button"
      accessibilityLabel={`${author.name}, ${author.connected ? "connected agent" : "agent"}`}
      style={[styles.target, { top, width, height }]}>
      {/* Empty views are flattened away unless kept, and then nothing under the button would take the touch. */}
      <View collapsable={false} style={styles.targetMark} />
      {name ? <View collapsable={false} style={{ position: "absolute", left: nameLeft - 4, top: name.y - 4, width: name.width + 8, height: name.height + 8 }} /> : null}
    </Pressable>
  );
}

function Body({ segments, theme }: { segments: readonly Segment[]; theme: Theme }) {
  return (
    <Text style={[styles.body, { color: theme.ink }]}>
      {segments.map((segment, index) => "mention" in segment
        ? <Text key={index} style={[styles.mention, segment.agent ? { backgroundColor: theme.agentTint, color: theme.agent } : { backgroundColor: theme.mention, color: theme.accent }]}>{"\u200A"}@{segment.mention}{"\u200A"}</Text>
        : segment.text)}
    </Text>
  );
}

// An agent's question: one tap answers it with the same record the desktop sends; the choice stays visible.
function Question({ options, initial, theme }: { options: readonly string[]; initial?: string; theme: Theme }) {
  const [chosen, setChosen] = useState<string | null>(initial ?? null);
  return (
    <View style={styles.options}>
      {options.map(option => {
        const selected = chosen === option;
        return (
          <Pressable key={option} disabled={chosen !== null} hitSlop={{ top: 2, bottom: 2 }}
            onPress={() => { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); setChosen(option); }}
            style={({ pressed }) => [styles.option, {
              backgroundColor: selected ? theme.accent : pressed ? theme.panel2 : "transparent",
              borderColor: selected ? theme.accent : theme.outline,
              opacity: chosen !== null && !selected ? 0.6 : 1,
            }]}
            accessibilityRole="button" accessibilityState={{ selected, disabled: chosen !== null }}>
            {selected ? <SymbolView name="checkmark" size={13} weight="bold" tintColor={theme.bg} fallback={null} /> : null}
            <Text style={[styles.optionText, { color: selected ? theme.bg : theme.ink }]}>{option}</Text>
          </Pressable>
        );
      })}
    </View>
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
  if (author.kind === "agent") return <AgentMark hue={author.agentHue} connected={author.connected} size={size} />;
  return (
    <View style={[styles.fill, { width: size, height: size, flex: 0, borderRadius: size / 2, backgroundColor: author.hue ?? theme.subtle }]}>
      <Text style={[styles.initials, { fontSize: size * 0.36 }]}>{author.initials}</Text>
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
  mention: { fontWeight: "600" },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  reaction: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, height: 26, borderRadius: 13, borderWidth: 1 },
  emoji: { fontSize: 14 },
  reactionCount: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  replies: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, alignSelf: "flex-start", minHeight: 22 },
  pile: { flexDirection: "row", gap: 3, marginRight: 2 },
  repliesText: { fontSize: 14, fontWeight: "600" },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  option: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 40, paddingHorizontal: 16, borderRadius: 20, borderWidth: 1 },
  optionText: { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
  working: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 22 },
  pulse: { width: 7, height: 7, borderRadius: 3.5, marginTop: 1 },
  workingText: { fontSize: 14 },
  fill: { flex: 1, alignItems: "center", justifyContent: "center" },
  initials: { color: "#fff", fontWeight: "700" },
});
