import { chatWords } from "@dohc/interface-words/notices";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { documentWords } from "@dohc/interface-words/documents";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Composer } from "./Composer";
import { blockedBy, chatWrite } from "./conversationWrites";
import { MessageRow } from "./MessageRow";
import { streamRows } from "./outboxMessages";
import {
  createSampleOutbox,
  sampleConversation,
  sampleLanes,
  sampleMessagesFor,
  sampleScope,
  sampleYou,
} from "./sample";
import { localMessage } from "./serverMessages";
import type { Message } from "./types";
import { useConversationWrites, useLocalActions, useOutboxState } from "./useOutbox";
import { chatSubtitle, chatTitle } from "../chats/chatLabels";
import { sampleChat } from "../chats/sample";
import { demoMode } from "../demo";
import { pagePathForFile } from "../pages/sample";
import { useTheme } from "../theme";

type Item =
  | { type: "day"; key: string; label: string }
  | { type: "message"; key: string; message: Message; continued: boolean; afterExtras: boolean };

const always = () => true;

// A conversation, as in Slack: newest at the bottom, the composer riding the keyboard. The composer writes to an
// outbox in memory, which never reaches a server, so the composer and its message states can be seen without one.
export function SampleConversation() {
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
  const [outbox] = useState(() => createSampleOutbox(demoMode));
  const state = useOutboxState(outbox);
  const writes = useConversationWrites(outbox, true, always);
  const blocked = state ? blockedBy(state, true) : "loading";
  const actions = useLocalActions(writes, blocked !== null);
  const items = useMemo<Item[]>(() => {
    const messages = sampleMessagesFor(id);
    const local = state
      ? streamRows(state, sampleScope, id, new Set()).map((row) => localMessage(row, sampleYou))
      : [];
    return [
      { type: "day", key: "today", label: "Today" },
      ...messages.map((message, index) => {
        const previous = messages[index - 1];
        const continued =
          previous !== undefined &&
          previous.author.id === message.author.id &&
          message.minute - previous.minute <= 5;
        // A follow-up after reactions or a thread link sits a little further away, so it doesn't read as part of them.
        const afterExtras = previous?.reactions !== undefined || previous?.replies !== undefined;
        return { type: "message" as const, key: message.id, message, continued, afterExtras };
      }),
      ...local.map((message) => ({
        type: "message" as const,
        key: message.id,
        message,
        continued: false,
        afterExtras: false,
      })),
    ];
  }, [id, state]);

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.title}>
              <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
                {shown}
              </Text>
              {subtitle ? (
                <Text style={[styles.members, { color: theme.muted }]}>{subtitle}</Text>
              ) : null}
            </View>
          ),
          headerStyle: { backgroundColor: theme.bg },
          headerShadowVisible: true,
          headerTintColor: theme.ink,
          // A file's chat opens its page from the header. It has no "Members and details", which did nothing.
          headerRight: pagePath
            ? () => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={documentWords.openPage(title)}
                  hitSlop={8}
                  onPress={() =>
                    router.push({
                      pathname: "/page",
                      params: { path: pagePath, t0: String(Date.now()) },
                    })
                  }
                >
                  <SymbolView
                    name="doc.text"
                    size={20}
                    weight="medium"
                    tintColor={theme.ink}
                    fallback={null}
                  />
                </Pressable>
              )
            : undefined,
        }}
      />
      <KeyboardAwareLegendList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.type}
        estimatedItemSize={64}
        alignItemsAtEnd
        initialScrollAtEnd
        maintainScrollAtEnd
        keyboardDismissMode="interactive"
        contentContainerStyle={{ paddingBottom: composerHeight + 16 }}
        renderItem={({ item }) =>
          item.type === "day" ? (
            <View style={styles.dayRow}>
              <Text style={[styles.day, { color: theme.muted, backgroundColor: theme.panel2 }]}>
                {item.label}
              </Text>
            </View>
          ) : (
            <MessageRow
              message={item.message}
              continued={item.continued}
              afterExtras={item.afterExtras}
              actions={actions}
            />
          )
        }
      />
      <Composer
        placeholder={chatWords.messageTo(shown)}
        lanes={sampleLanes(chat.kind)}
        blocked={blocked}
        problem={null}
        onSubmit={(kind, body, postTitle) => {
          const write = chatWrite(
            kind === "send" ? { kind, streamId: id } : { kind, groupId: id },
            body,
            postTitle,
          );
          return write
            ? writes.submit(sampleScope.workspaceId, write)
            : Promise.resolve({ kind: "blocked" as const });
        }}
        onLayoutHeight={setComposerHeight}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  title: { alignItems: "center" },
  name: { fontSize: 17, fontWeight: "600" },
  members: { fontSize: 12 },
  dayRow: { alignItems: "center", paddingTop: 12, paddingBottom: 6 },
  day: {
    fontSize: 12,
    fontWeight: "600",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 11,
    overflow: "hidden",
  },
});
