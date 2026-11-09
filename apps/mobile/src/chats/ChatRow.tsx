import { SymbolView } from "expo-symbols";
import { memo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AgentMark } from "../AgentMark";
import { useTheme, type Theme } from "../theme";
import { chatWords, countText } from "./chatLabels";
import type { ChatRowData } from "./sample";

// One line per chat, as in Slack: the leading mark says what it is, bold says unread, grey says muted.
export const ChatRow = memo(function ChatRow({ row, onPress }: { row: ChatRowData; onPress(row: ChatRowData): void }) {
  const theme = useTheme();
  const [pressed, setPressed] = useState(false);
  // An agent that gave no name is "Agent", as on the desktop.
  const name = row.kind === "agent" && row.name.trim() === "" ? chatWords.unnamedAgent : row.name;
  return (
    <Pressable
      onPress={() => onPress(row)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[styles.row, pressed && { backgroundColor: theme.panel2 }]}
      accessibilityRole="button"
      accessibilityLabel={`${name}${row.kind === "agent" ? row.connected ? ", connected agent" : ", agent" : ""}${row.unread ? ", unread" : ""}${row.count ? `, ${row.count} new` : ""}${row.muted ? ", muted" : ""}`}
    >
      <Leading row={row} theme={theme} pressed={pressed} />
      <Text numberOfLines={1} style={[styles.name, { color: row.muted ? theme.subtle : theme.ink, fontWeight: row.unread ? "600" : "400" }]}>
        {name}
      </Text>
      {row.muted ? <View style={styles.trailing}><SymbolView name="bell.slash" size={15} tintColor={theme.subtle} fallback={null} /></View> : null}
      {row.count ? <Count count={row.count} addressed={row.kind === "person" || row.kind === "agent"} theme={theme} /> : null}
    </Pressable>
  );
});

function Leading({ row, theme, pressed }: { row: ChatRowData; theme: Theme; pressed: boolean }) {
  if (row.kind === "group" || row.kind === "comment") {
    return (
      <View style={styles.lead}>
        <SymbolView name={row.kind === "group" ? "number" : "doc.text"} size={17} weight={row.unread ? "semibold" : "regular"}
          tintColor={row.muted ? theme.subtle : theme.ink}
          fallback={<Text style={{ color: theme.subtle, fontSize: 17 }}>{row.kind === "group" ? "#" : "▤"}</Text>} />
      </View>
    );
  }
  if (row.kind === "agent") return <View style={styles.lead}><AgentMark hue={row.agentHue} connected={row.connected} size={30} /></View>;
  return (
    <View style={styles.lead}>
      <View style={[styles.person, { backgroundColor: row.hue ?? theme.subtle }]}>
        <Text style={styles.initials}>{row.initials}</Text>
      </View>
      {row.online ? <View style={[styles.presence, { backgroundColor: theme.presence, borderColor: pressed ? theme.panel2 : theme.bg }]} /> : null}
    </View>
  );
}

// The desktop's unread count in its two tones: ink when you were addressed (a direct message or your agent), quiet for
// a group you only follow. Past 99 it says 99+.
function Count({ count, addressed, theme }: { count: number; addressed: boolean; theme: Theme }) {
  return (
    <View style={[styles.count, { backgroundColor: addressed ? theme.ink : theme.quietCount }]}>
      <Text style={[styles.countText, { color: addressed ? theme.bg : theme.ink }]}>{countText(count)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 16 },
  lead: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  person: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  initials: { color: "#fff", fontSize: 11, fontWeight: "700" },
  presence: { position: "absolute", right: -1, bottom: -1, width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
  name: { flex: 1, fontSize: 17 },
  // Trailing marks (count, bell, section chevron) share one centre line.
  trailing: { width: 20, alignItems: "center" },
  count: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  countText: { fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] },
});
