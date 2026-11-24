import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentMark } from "../AgentMark";
import { AS_REPORTED, agentCard, agentCardLabel } from "./agentCard";
import { sampleAgent } from "../conversation/sample";
import { useTheme } from "../theme";

// An agent's card, as the desktop shows it from the agent's badge: a small sheet that closes by swiping down or tapping
// outside it. It paints no background of its own, so the sheet's surface fills it to the bottom edge. Android's sheet
// reaches under the navigation bar, so there its lines stop above it.
// It shows the name; the agent's kind, or its owner; what its client reported, marked as reported.
export function SampleAgentCard() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = sampleAgent(id);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // A link to an agent the sample doesn't have opens nothing: the sheet closes rather than stand empty, or opens Chats
  // when the link started the app.
  useEffect(() => {
    if (agent) return;
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [agent, router]);
  if (!agent) return null;
  const card = agentCard({
    name: agent.name,
    named: agent.name.trim() !== "",
    kind: agent.connected ? "connected" : "own",
    owner: agent.owner,
    reported: agent.reported,
  });
  return (
    <View
      style={[
        styles.sheet,
        { paddingBottom: 12 + (Platform.OS === "android" ? insets.bottom : 0) },
      ]}
      accessible
      accessibilityLabel={agentCardLabel(card)}
    >
      <AgentMark hue={agent.agentHue} connected={agent.connected} size={36} />
      <View style={styles.lines}>
        <Text style={[styles.name, { color: theme.ink }]}>
          {card.name}
          {card.nameAsReported ? (
            <Text style={[styles.line, { color: theme.muted }]}>{` ${noBreak(AS_REPORTED)}`}</Text>
          ) : null}
        </Text>
        {card.kindLine ? (
          <Text style={[styles.line, { color: theme.muted }]}>{card.kindLine}</Text>
        ) : null}
        {card.reported ? (
          <Text
            style={[styles.line, { color: theme.muted }]}
          >{`${card.reported} ${noBreak(AS_REPORTED)}`}</Text>
        ) : null}
      </View>
    </View>
  );
}

// "(as reported)" never breaks: the rest of a line may wrap anywhere, the mark stays whole.
function noBreak(text: string): string {
  return text.replace(/ /g, " ");
}

const styles = StyleSheet.create({
  sheet: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 24,
  },
  lines: { flex: 1, gap: 4 },
  name: { fontSize: 17, fontWeight: "600", lineHeight: 22 },
  line: { fontSize: 15, fontWeight: "400", lineHeight: 20 },
});
