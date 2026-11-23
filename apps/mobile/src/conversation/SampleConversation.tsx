import { chatWords } from "@dohc/interface-words/notices";
import { workspaceWords } from "@dohc/interface-words/workspace";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { documentWords } from "@dohc/interface-words/documents";
import type { PhoneChatWake } from "@dohc/workspace-contracts/chat-wakes";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FileText } from "lucide-react-native";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Composer } from "./Composer";
import {
  blockedBy,
  chatWrite,
  replyWrite,
  type Lanes,
  type ReplyTarget,
  type SubmitOutcome,
} from "./conversationWrites";
import {
  answerPlace,
  answerRecords,
  answerTarget,
  answerWrite,
  decisionOf,
} from "./decisionAnswers";
import { MessageRow } from "./MessageRow";
import { streamRows, threadRows } from "./outboxMessages";
import { reactionRecords, withReactions } from "./reactions";
import { UNSHOWN_QUESTION, type ReplyTo } from "./ReplyContext";
import {
  createSampleOutbox,
  createSampleWakes,
  sampleAsks,
  sampleConversation,
  sampleLanes,
  sampleMessagesFor,
  sampleScope,
  sampleThreadFor,
  sampleYou,
} from "./sample";
import { confirmTryElsewhere } from "./wakeRetryAlert";
import { localMessage } from "./serverMessages";
import type { Message } from "./types";
import { useShowing, useVisible } from "./useVisible";
import {
  useChoose,
  useConversationWrites,
  useLocalActions,
  useOutboxState,
  useReact,
  type AnswerActions,
} from "./useOutbox";
import { HeaderButton } from "../AndroidHeader";
import { chatSubtitle, chatTitle } from "../chats/chatLabels";
import { sampleChat } from "../chats/sample";
import { demoMode } from "../demo";
import { pagePathForFile } from "../pages/sample";
import { useTheme } from "../theme";

type Item =
  | { type: "day"; key: string; label: string }
  | { type: "message"; key: string; message: Message; continued: boolean; afterExtras: boolean };

const always = () => true;
/** A thread takes replies, and never a post. */
const REPLY_LANES: Lanes = { post: false, send: true };

/** The message a reply answers: in its thread, or an outbox post or send whose thread isn't known yet. */
interface Chosen {
  readonly target: ReplyTarget;
  readonly to: ReplyTo;
}

const excerptOf = (message: Message) =>
  message.body
    .map((segment) => ("text" in segment ? segment.text : `@${segment.mention}`))
    .join("");

/** A reply under `message`, which the sample's thread `threadId` shows. */
const replyingTo = (message: Message, threadId: string): Chosen => ({
  target: { kind: "thread", threadId, parentMessageId: message.id },
  to: { name: message.author.name, excerpt: excerptOf(message) },
});

// A conversation, as in Slack: newest at the bottom, the composer riding the keyboard. The composer writes to an
// outbox in memory, which never reaches a server, so the composer and its message states can be seen without one.
// A thread (`thread=1`) replies in its composer. Reply on a message in a chat opens its thread; on a post or send
// still in the outbox, the composer replies to it in place. A poll's choice answers it at once; Answer on a question
// opens its thread with the composer answering it.
export function SampleConversation() {
  const theme = useTheme();
  const router = useRouter();
  const { id, name, thread, reply, answer } = useLocalSearchParams<{
    id: string;
    name?: string;
    thread?: string;
    reply?: string;
    answer?: string;
  }>();
  const inThread = thread === "1";
  const title = name ?? sampleConversation.name;
  // "#" only for a chat known to be a group; one this sample doesn't know goes by its name.
  const chat = sampleChat(id) ?? { kind: "comment" as const };
  const shown = inThread ? workspaceWords.thread : chatTitle(chat.kind, title);
  const subtitle = inThread ? null : chatSubtitle(chat, sampleConversation.members);
  // A file's chat opens its page from the header; the page's header comes back here.
  const pagePath = name && !inThread ? pagePathForFile[name] : undefined;
  const [composerHeight, setComposerHeight] = useState(90);
  const [outbox] = useState(() => createSampleOutbox(demoMode));
  const state = useOutboxState(outbox);
  const writes = useConversationWrites(outbox, true, always);
  const blocked = state ? blockedBy(state, true) : "loading";
  const actions = useLocalActions(writes, blocked !== null);
  const react = useReact(writes, sampleScope);
  const chooser = useChoose(writes, sampleScope.workspaceId);
  // `talk-wakes`'s wakes, shown as a server read's would be, with Try again where the sample's writes aren't blocked.
  const [sampleWakes] = useState(() => createSampleWakes(demoMode));
  useEffect(() => () => sampleWakes.stop(), [sampleWakes]);
  const wakes = useSyncExternalStore(sampleWakes.subscribe, sampleWakes.byMessage);
  const wakeRetries = useSyncExternalStore(sampleWakes.subscribe, sampleWakes.retries);
  const writable = blocked === null;
  // As a server conversation's: the screen still shows the chat it was pressed in, and the outbox, read when called,
  // isn't blocked.
  const showing = useShowing(useVisible());
  const retryWake = useCallback(
    (wake: PhoneChatWake) => {
      const shown = showing();
      sampleWakes.retry(wake, {
        allowed: () => shown() && blockedBy(outbox.state(), true) === null,
        confirm: confirmTryElsewhere,
      });
    },
    [sampleWakes, showing, outbox],
  );
  const wakesFor = (message: Message) => {
    const own = message.local === undefined ? wakes?.get(message.id) : undefined;
    return own ? { wakes: own, wakeRetries, ...(writable ? { onRetryWake: retryWake } : {}) } : {};
  };
  const wakeData = useMemo(
    () => ({ wakes, wakeRetries, writable }),
    [wakes, wakeRetries, writable],
  );
  const messages = useMemo(
    () => (inThread ? sampleThreadFor(id, demoMode) : sampleMessagesFor(id, demoMode)),
    [inThread, id],
  );
  // A thread opened to reply to one of its messages, or answer its question, starts with it chosen.
  const [chosen, setChosen] = useState<Chosen | null>(() => {
    const message = inThread && reply ? messages.find((each) => each.id === reply) : undefined;
    return message ? replyingTo(message, id) : null;
  });
  const [answering, setAnswering] = useState<string | null>(inThread ? (answer ?? null) : null);
  const answersByQuestion = useMemo(
    () => (state ? answerRecords(state, sampleScope) : null),
    [state],
  );
  // The sample's messages have no parents, and every one is in #planning's chat or the Porto thread.
  const parentOf = useCallback(
    (messageId: string) => (messages.some((each) => each.id === messageId) ? null : undefined),
    [messages],
  );
  const decisionFor = useCallback(
    (message: Message) => {
      const ask = sampleAsks.get(message.id);
      if (!ask) return null;
      return decisionOf(ask, answersByQuestion?.get(ask.id), (shownId) => {
        const entry = messages.find((each) => each.id === shownId);
        return entry ? { authorName: entry.author.name, body: excerptOf(entry) } : undefined;
      });
    },
    [answersByQuestion, messages],
  );
  // While Answer names a question, the text only ever answers it, as in a live thread: once the question no longer takes
  // an answer, Send stays off until the person cancels Answer or chooses another message.
  const question = useMemo(() => {
    if (answering === null) return null;
    const message = messages.find((each) => each.id === answering);
    const ask = message && sampleAsks.get(message.id);
    const to: ReplyTo = message
      ? { name: message.author.name, excerpt: excerptOf(message), answers: true }
      : UNSHOWN_QUESTION;
    return {
      id: answering,
      target: answerTarget(ask, answersByQuestion?.get(answering), parentOf, false),
      to,
    };
  }, [answering, messages, answersByQuestion, parentOf]);

  const items = useMemo<Item[]>(() => {
    const byMessage = state ? reactionRecords(state, sampleScope) : null;
    const shownMessages = messages.map((message) => {
      const made = withReactions(message, message.reactions ?? [], byMessage?.get(message.id));
      const decision = decisionFor(message);
      return decision ? { ...made, decision } : made;
    });
    const questions = new Set(
      messages.filter((each) => sampleAsks.has(each.id)).map((each) => each.id),
    );
    const rows = state
      ? inThread
        ? threadRows(state, sampleScope, id, new Set())
        : streamRows(state, sampleScope, id, new Set(), questions)
      : [];
    const local = rows.map((row) => localMessage(row, sampleYou));
    return [
      { type: "day", key: "today", label: "Today" },
      ...shownMessages.map((message, index) => {
        const previous = shownMessages[index - 1];
        const continued =
          previous !== undefined &&
          previous.author.id === message.author.id &&
          message.minute - previous.minute <= 5;
        // A follow-up after reactions or a thread link sits a little further away, so it doesn't read as part of them.
        const afterExtras =
          (previous?.reactions?.length ?? 0) > 0 || previous?.replies !== undefined;
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
  }, [id, inThread, messages, state, decisionFor]);

  // A poll's choice answers at once. Answer on a question opens its thread to answer there, or names it in a thread.
  const answers = useMemo<AnswerActions>(
    () => ({
      blocked: actions.blocked,
      problems: chooser.problems,
      choose: (message, option) => {
        const ask = sampleAsks.get(message.id);
        if (ask)
          chooser.choose(answerPlace(ask, parentOf, { post: false, poll: true }), ask.id, option);
      },
      answer: (message) => {
        const ask = sampleAsks.get(message.id);
        if (!ask) return;
        if (inThread) {
          setAnswering(ask.id);
          setChosen(null);
          return;
        }
        router.push({
          pathname: "/chat/[id]",
          params: { id: ask.threadId, thread: "1", answer: ask.id },
        });
      },
    }),
    [actions.blocked, chooser, parentOf, inThread, router],
  );

  const onReply = useCallback(
    (message: Message) => {
      if (inThread) {
        if (!message.local) {
          setChosen(replyingTo(message, id));
          setAnswering(null);
        }
        return;
      }
      const parent = message.replyable;
      if (message.local) {
        if (!parent) return;
        if (parent.threadId !== null)
          router.push({
            pathname: "/chat/[id]",
            params: { id: parent.threadId, thread: "1", reply: parent.messageId },
          });
        else
          setChosen({
            target: {
              kind: "outbox",
              operationId: parent.operationId,
              messageId: parent.messageId,
            },
            to: { name: message.author.name, excerpt: excerptOf(message) },
          });
        return;
      }
      if (message.threadId)
        router.push({
          pathname: "/chat/[id]",
          params: { id: message.threadId, thread: "1", reply: message.id },
        });
    },
    [inThread, id, router],
  );
  const onOpenReplies = useCallback(
    (message: Message) => {
      if (message.threadId)
        router.push({ pathname: "/chat/[id]", params: { id: message.threadId, thread: "1" } });
    },
    [router],
  );

  const submit = async (
    kind: "send" | "post" | "reply",
    body: string,
    postTitle: string,
  ): Promise<SubmitOutcome> => {
    if (kind === "reply" && question) {
      const { target } = question;
      const write = target.kind === "answer" ? answerWrite(target.place, question.id, body) : null;
      if (!write) return { kind: "blocked" };
      const outcome = await writes.submit(sampleScope.workspaceId, write);
      if (outcome.kind === "kept" || outcome.kind === "withheld")
        setAnswering((current) => (current === question.id ? null : current));
      return outcome;
    }
    if (kind === "reply") {
      // In a thread with none chosen, the reply goes at the top of the thread.
      const target: ReplyTarget | null =
        chosen?.target ??
        (inThread ? { kind: "thread", threadId: id, parentMessageId: null } : null);
      const next = target && replyWrite(target, body);
      if (!next) return { kind: "blocked" };
      const answered = chosen;
      const outcome = await writes.submit(sampleScope.workspaceId, next.write, next.dependsOn);
      // One whose post or send can't take it stays chosen, with Send off, until the person cancels Reply.
      if (outcome.kind === "kept" || outcome.kind === "withheld")
        setChosen((current) => (current === answered ? null : current));
      return outcome;
    }
    const write = chatWrite(
      kind === "send" ? { kind, streamId: id } : { kind, groupId: id },
      body,
      postTitle,
    );
    return write ? writes.submit(sampleScope.workspaceId, write) : { kind: "blocked" };
  };

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
            ? () => {
                const openPage = () =>
                  router.push({
                    pathname: "/page",
                    params: { path: pagePath, t0: String(Date.now()) },
                  });
                return Platform.OS === "ios" ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={documentWords.openPage(title)}
                    hitSlop={8}
                    onPress={openPage}
                  >
                    <SymbolView
                      name="doc.text"
                      size={20}
                      weight="medium"
                      tintColor={theme.ink}
                      fallback={null}
                    />
                  </Pressable>
                ) : (
                  <HeaderButton
                    icon={FileText}
                    label={documentWords.openPage(title)}
                    onPress={openPage}
                  />
                );
              }
            : undefined,
        }}
      />
      <KeyboardAwareLegendList
        data={items}
        // Wakes and their Try again states change apart from the messages: their rows draw again.
        extraData={wakeData}
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
              react={react}
              onReply={onReply}
              onOpenReplies={onOpenReplies}
              answers={answers}
              {...wakesFor(item.message)}
            />
          )
        }
      />
      <Composer
        placeholder={inThread ? chatWords.reply : chatWords.messageTo(shown)}
        lanes={inThread ? REPLY_LANES : sampleLanes(chat.kind)}
        blocked={blocked}
        problem={null}
        replies={inThread || chosen !== null}
        replyTo={question?.to ?? chosen?.to ?? null}
        closed={question?.target.kind === "closed" ? chatWords.answerClosed : null}
        onCancelReply={() => {
          setChosen(null);
          setAnswering(null);
        }}
        onSubmit={submit}
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
