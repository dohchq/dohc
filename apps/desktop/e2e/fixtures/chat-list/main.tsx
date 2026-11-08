import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { chatListMarkdown, chatListMessage } from "./messages";
import { ChatMessageList, type ChatMessageListHandle } from "../../../src/renderer/workbench/chatMessages";
import type {} from "./api";
import "./styles.css";

const sparse = new URLSearchParams(location.search).has("sparse");
const message = (index: number) => chatListMessage(index, sparse);

function ChatFixture() {
  const listRef = useRef<ChatMessageListHandle | null>(null);
  const [messages, setMessages] = useState(() => Array.from({ length: 500 }, (_, index) => message(index)));
  const [opened, setOpened] = useState("");
  window.chatListFixture = {
    append: () => setMessages((current) => [...current, message(current.length)]),
    appendMarkdown: () => setMessages((current) => [
      ...current,
      { ...message(current.length), authorKind: "agent", body: chatListMarkdown(current.length) },
    ]),
    markdown: (id) => setMessages((current) => current.map((item, index) => item.id === id
      ? { ...item, body: chatListMarkdown(index) }
      : item)),
    grow: (id) => setMessages((current) => current.map((item) => item.id === id
      ? { ...item, body: item.body + "\nExpanded content. ".repeat(40) }
      : item)),
    prepend: () => setMessages((current) => [
      ...Array.from({ length: 20 }, (_, index) => message(index - 20)),
      ...current,
    ]),
    reorder: () => setMessages((current) => {
      const moved = current.find((item) => item.id === "m-400")!;
      const remaining = current.filter((item) => item.id !== moved.id);
      const before = remaining.findIndex((item) => item.id === "m-100");
      return [...remaining.slice(0, before), moved, ...remaining.slice(before)];
    }),
    jump: (id) => listRef.current?.scrollToMessage(id) ?? false,
    end: () => listRef.current?.scrollToEnd(),
  };
  return <main className="flex h-screen flex-col bg-panel text-ink">
    <output aria-label="Message count">{messages.length}</output>
    <output aria-label="Opened file">{opened}</output>
    <ChatMessageList
      listRef={listRef}
      testIdPrefix="fixture-chat"
      messages={messages}
      loading={false}
      emptyLabel="No messages"
      onOpenPath={sparse ? setOpened : undefined}
      reactionControls={{ reactions: [], viewerAuthorId: "viewer", readOnly: sparse, onToggle: () => {} }}
    />
  </main>;
}

createRoot(document.getElementById("root")!).render(<ChatFixture />);
