import { useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { AgentMark } from "../src/AgentMark";
import { AS_REPORTED, agentCard, agentCardLabel } from "../src/chats/agentCard";
import { sampleAgent } from "../src/conversation/sample";
import { useTheme } from "../src/theme";

// An agent's card, as the desktop shows it from the agent's badge: a small sheet that closes by swiping down or tapping
// outside it. It paints no background of its own, so the sheet's surface fills it to the bottom edge.
// It shows the name; the agent's kind, or its owner; what its client reported, marked as reported.
export default function AgentCardSheet() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = sampleAgent(id);
  if (!agent) return null;
  const card = agentCard({
    name: agent.name,
    named: agent.name.trim() !== "",
    kind: agent.connected ? "connected" : "own",
    owner: agent.owner,
    reported: agent.reported,
  });
  return (
    <View style={styles.sheet} accessible accessibilityLabel={agentCardLabel(card)}>
      <AgentMark hue={agent.agentHue} connected={agent.connected} size={36} />
      <View style={styles.lines}>
        <Text style={[styles.name, { color: theme.ink }]}>
          {card.name}
          {card.nameAsReported ? <Text style={[styles.line, { color: theme.muted }]}>{` ${noBreak(AS_REPORTED)}`}</Text> : null}
        </Text>
        {card.kindLine ? <Text style={[styles.line, { color: theme.muted }]}>{card.kindLine}</Text> : null}
        {card.reported ? <Text style={[styles.line, { color: theme.muted }]}>{`${card.reported} ${noBreak(AS_REPORTED)}`}</Text> : null}
      </View>
    </View>
  );
}

// "(as reported)" never breaks: the rest of a line may wrap anywhere, the mark stays whole.
function noBreak(text: string): string {
  return text.replace(/ /g, " ");
}

const styles = StyleSheet.create({
  sheet: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 12 },
  lines: { flex: 1, gap: 4 },
  name: { fontSize: 17, fontWeight: "600", lineHeight: 22 },
  line: { fontSize: 15, fontWeight: "400", lineHeight: 20 },
});
