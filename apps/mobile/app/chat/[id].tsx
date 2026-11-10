import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { documentWords } from "@dohc/interface-words/documents";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Composer } from "../../src/conversation/Composer";
import { MessageRow } from "../../src/conversation/MessageRow";
import { sampleConversation, sampleMessagesFor, type Message } from "../../src/conversation/sample";
import { chatSubtitle, chatTitle } from "../../src/chats/chatLabels";
import { sampleChat } from "../../src/chats/sample";
import { pagePathForFile } from "../../src/pages/sample";
import { useTheme } from "../../src/theme";
import { sampleOnly } from "../../src/sampleOnly";

type Item = { type: "day"; key: string; label: string } | { type: "message"; key: string; message: Message; continued: boolean; afterExtras: boolean };

// A conversation, as in Slack: newest at the bottom, the composer riding the keyboard.
function Conversation() {
  const theme = useTheme();
  const router = useRouter();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const title = name ?? sampleConversation.name;
  // "#" only for a chat known to be a group; one this sample doesn't know goes by its name.
  const chat = sampleChat(id) ?? { kind: "comment" as const };
  const shown = chatTitle(chat.kind, title);
  const subtitle = chatSubtitle(chat, sampleConversation.members);
  // A file's chat opens its page from the header; the page's header comes back here.
  const pagePath = name ? pagePathForFile[name] : undefined;
  const [composerHeight, setComposerHeight] = useState(90);
  const items = useMemo<Item[]>(() => {
    const messages = sampleMessagesFor(id);
    return [
      { type: "day", key: "today", label: "Today" },
      ...messages.map((message, index) => {
        const previous = messages[index - 1];
        const continued = previous !== undefined && previous.author.id === message.author.id && message.minute - previous.minute <= 5;
        // A follow-up after reactions or a thread link sits a little further away, so it doesn't read as part of them.
        const afterExtras = previous?.reactions !== undefined || previous?.replies !== undefined;
        return { type: "message" as const, key: message.id, message, continued, afterExtras };
      }),
    ];
  }, [id]);

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <Stack.Screen options={{
        headerTitle: () => (
          <View style={styles.title}>
            <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>{shown}</Text>
            {subtitle ? <Text style={[styles.members, { color: theme.muted }]}>{subtitle}</Text> : null}
          </View>
        ),
        headerStyle: { backgroundColor: theme.bg },
        headerShadowVisible: true,
        headerTintColor: theme.ink,
        // A file's chat opens its page from the header. It has no "Members and details", which did nothing.
        headerRight: pagePath ? () => (
          <Pressable accessibilityRole="button" accessibilityLabel={documentWords.openPage(title)} hitSlop={8}
            onPress={() => router.push({ pathname: "/page", params: { path: pagePath, t0: String(Date.now()) } })}>
            <SymbolView name="doc.text" size={20} weight="medium" tintColor={theme.ink} fallback={null} />
          </Pressable>
        ) : undefined,
      }} />
      <KeyboardAwareLegendList
        data={items}
        keyExtractor={item => item.key}
        getItemType={item => item.type}
        estimatedItemSize={64}
        alignItemsAtEnd
        initialScrollAtEnd
        maintainScrollAtEnd
        keyboardDismissMode="interactive"
        contentContainerStyle={{ paddingBottom: composerHeight + 16 }}
        renderItem={({ item }) => item.type === "day"
          ? <View style={styles.dayRow}><Text style={[styles.day, { color: theme.muted, backgroundColor: theme.panel2 }]}>{item.label}</Text></View>
          : <MessageRow message={item.message} continued={item.continued} afterExtras={item.afterExtras} />}
      />
      <Composer placeholder={`Message ${shown}`} onLayoutHeight={setComposerHeight} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  title: { alignItems: "center" },
  name: { fontSize: 17, fontWeight: "600" },
  members: { fontSize: 12 },
  dayRow: { alignItems: "center", paddingTop: 12, paddingBottom: 6 },
  day: { fontSize: 12, fontWeight: "600", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 11, overflow: "hidden" },
});

export default sampleOnly(Conversation);
