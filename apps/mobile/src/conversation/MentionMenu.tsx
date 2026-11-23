import { chatWords } from "@dohc/interface-words/notices";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useTheme, workspaceMarkFills } from "../theme";
import type { PhoneMention } from "./mentionDraft";
import { Avatar } from "./MessageRow";
import { personAuthor } from "./serverMessages";

/** The most of the window's height the menu takes before it scrolls inside itself. */
const MENU_SHARE = 0.3;

// The @name menu above the composer's field: who matches the `@` the caret is typing, best first, each by name, with
// the handle when it reads differently, and a round mark for a person or a square one for an agent. A tap only asks the
// field to complete the text: the keyboard stays up, and nothing sends.
export function MentionMenu({
  matches,
  onPick,
}: {
  matches: readonly PhoneMention[];
  onPick(candidate: PhoneMention): void;
}) {
  const theme = useTheme();
  const { height } = useWindowDimensions();
  if (matches.length === 0)
    return <Text style={[styles.empty, { color: theme.muted }]}>{chatWords.noMentionMatch}</Text>;
  return (
    <ScrollView
      keyboardShouldPersistTaps="always"
      style={{ maxHeight: height * MENU_SHARE }}
      contentContainerStyle={styles.list}
    >
      {matches.map((candidate) => {
        const person = candidate.kind === "user";
        const handleShown =
          candidate.handle.toLocaleLowerCase() !== candidate.label.toLocaleLowerCase();
        return (
          <Pressable
            key={candidate.id}
            accessibilityRole="button"
            accessibilityLabel={
              person
                ? chatWords.mentionPerson(candidate.label)
                : chatWords.mentionAgent(candidate.label)
            }
            onPress={() => onPick(candidate)}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.panel2 }]}
          >
            <Avatar
              author={
                person
                  ? personAuthor(candidate.id, candidate.label, workspaceMarkFills)
                  : {
                      id: candidate.id,
                      name: candidate.label,
                      kind: "agent",
                      connected: candidate.connected,
                    }
              }
              theme={theme}
              size={28}
            />
            <View style={styles.names}>
              <Text style={[styles.label, { color: theme.ink }]} numberOfLines={1}>
                {candidate.label}
              </Text>
              {handleShown ? (
                <Text style={[styles.handle, { color: theme.muted }]} numberOfLines={1}>
                  @{candidate.handle}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 8,
    borderRadius: 10,
  },
  names: { flex: 1, flexDirection: "row", alignItems: "baseline", gap: 6 },
  label: { flexShrink: 1, fontSize: 16, fontWeight: "500" },
  handle: { flexShrink: 1, fontSize: 14 },
  empty: { fontSize: 15, lineHeight: 20, paddingVertical: 12, paddingHorizontal: 8 },
});
