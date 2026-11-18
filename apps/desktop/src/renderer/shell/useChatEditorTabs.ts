import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../bridge";
import { parseTab, type DirectTabName } from "../workbench/workbenchState";
import type { ChatsDrafts, ChatsNav } from "../workbench/ChatsView";
import type { SettingsAgent } from "../workbench/agentChat";
import { directStore, directPersonName } from "../workbench/directConversations";
import {
  chatEditorPath,
  chatEditorTitle,
  chatsNavigationLeavesConversation,
  chatsNavigationRequiresRemount,
} from "./chatsNav";

function isAgentNav(nav: ChatsNav | undefined): boolean {
  return (nav?.level === "channel" || nav?.level === "thread") && nav.channel.kind === "agent";
}

type ChatEditor = {
  nav: ChatsNav | undefined;
  drafts: ChatsDrafts | undefined;
  revision: number;
  generation: number;
  restoreAttempted: boolean;
  onNavChange: (nav: ChatsNav) => void;
  onNavCommand: (nav: ChatsNav) => void;
  onDraftsChange: (drafts: ChatsDrafts) => void;
};

// Inactive editors unmount. Keep only their navigation and unsent input here;
// they do not need a second presence lease or background poller.
export function useChatEditorTabs(input: {
  workspaceId: string;
  onOpen: (path: string) => void;
  paths: readonly string[];
  activePaths?: readonly string[];
  // Whether the workspace's own chats can be read. Direct messages live on
  // the account's server, so their tabs restore and take names either way.
  enabled: boolean;
  // The agents in Settings, whose names agent chat tabs take.
  agents: readonly SettingsAgent[];
  // Moves when an open conversation marks messages read.
  readRevision: number;
  // Each open direct tab's saved person name, and where a name the list read is saved.
  directNames: Readonly<Record<string, DirectTabName>>;
  onDirectName: (conversationId: string, account: string, name: string) => void;
  // The account signed in at start, from the shell's status read: null when
  // signed out, undefined until it reads.
  accountKey: string | null | undefined;
}) {
  const callbacks = useRef(input);
  callbacks.current = input;
  const store = useRef({
    workspaceId: input.workspaceId,
    active: true,
    entries: new Map<string, ChatEditor>(),
  });
  if (store.current.workspaceId !== input.workspaceId) {
    store.current = { workspaceId: input.workspaceId, active: true, entries: new Map() };
  }
  useEffect(() => {
    const owner = store.current;
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [input.workspaceId]);
  const [revision, render] = useState(0);
  const session = useRef({
    key: undefined as string | null | undefined,
    generation: 0,
    ready: true,
  });
  const [sessionRevision, refreshSession] = useState(0);
  useEffect(() => {
    return bridge().onCloudSessionChanged(({ sessionKey, phase }) => {
      session.current.ready = phase === "ready";
      if (session.current.key !== sessionKey) {
        session.current.key = sessionKey;
        session.current.generation += 1;
        for (const path of store.current.entries.keys()) {
          const tab = parseTab(path);
          const kind = tab.kind === "chat" ? tab.target.kind : null;
          if (kind !== "dm" && kind !== "new") continue;
          store.current.entries.delete(path);
        }
        render((value) => value + 1);
      }
      if (phase === "ready") {
        for (const entry of store.current.entries.values()) {
          if (!entry.nav) entry.restoreAttempted = false;
        }
      }
      refreshSession((value) => value + 1);
    });
  }, [input.workspaceId]);
  // A saved name shows only to its own account. A session event that came
  // before the shell's status read already named the account.
  const startKey = input.accountKey;
  useEffect(() => {
    if (session.current.key !== undefined || startKey === undefined) return;
    session.current.key = startKey;
    refreshSession((value) => value + 1);
  }, [startKey]);
  const get = useCallback((path: string): ChatEditor => {
    const owner = store.current;
    const existing = owner.entries.get(path);
    if (existing) return existing;
    const entry: ChatEditor = {
      nav: undefined,
      drafts: undefined,
      revision: 0,
      generation: session.current.generation,
      restoreAttempted: false,
      onNavChange(nav) {
        if (store.current !== owner || owner.entries.get(path) !== entry || entry.nav === nav)
          return;
        entry.nav = nav;
        render((value) => value + 1);
      },
      onNavCommand(nav) {
        if (store.current !== owner || owner.entries.get(path) !== entry) return;
        entry.onNavChange(nav);
      },
      onDraftsChange(drafts) {
        if (store.current !== owner || owner.entries.get(path) !== entry) return;
        entry.drafts = drafts;
      },
    };
    owner.entries.set(path, entry);
    return entry;
  }, []);
  const open = useCallback(
    (nav: ChatsNav): void => {
      const path = chatEditorPath(nav);
      const entry = get(path);
      // A sidebar channel click focuses its tab, including its current thread.
      // A message link still commands a jump inside that tab.
      const focusOnly =
        entry.nav &&
        entry.nav.level !== "channels" &&
        chatEditorPath(entry.nav) === path &&
        (nav.level === "feed" ||
          nav.level === "direct" ||
          (nav.level === "direct-new" && nav.memberId === undefined) ||
          (nav.level === "channel" && !nav.focusMessageId && !nav.lane));
      if (
        focusOnly &&
        nav.level === "direct" &&
        entry.nav?.level === "direct" &&
        nav.title !== undefined &&
        entry.nav.title !== nav.title
      ) {
        // The tab takes the names the click knew.
        entry.nav = { ...entry.nav, title: nav.title };
        render((value) => value + 1);
      } else if (!focusOnly) {
        if (chatsNavigationLeavesConversation(entry.nav ?? null, nav)) entry.drafts = undefined;
        if (chatsNavigationRequiresRemount(entry.nav ?? null, nav)) entry.revision += 1;
        entry.nav = nav;
        render((value) => value + 1);
      }
      callbacks.current.onOpen(path);
    },
    [get],
  );
  // Mounted pages resolve their own destinations. Hydrate only hidden tabs.
  const pathsKey = JSON.stringify(input.paths.filter((path) => !input.activePaths?.includes(path)));
  useEffect(() => {
    if (!session.current.ready) return;
    const owner = store.current;
    const generation = session.current.generation;
    const paths: string[] = JSON.parse(pathsKey);
    const targets = paths.flatMap((path) => {
      const entry = get(path);
      if (entry.nav || entry.restoreAttempted) return [];
      const tab = parseTab(path);
      const target = tab.kind === "chat" ? tab.target : null;
      if (!input.enabled && target?.kind !== "dm" && target?.kind !== "new") return [];
      entry.restoreAttempted = true;
      return [{ path, entry, target }];
    });
    const remember = (path: string, entry: ChatEditor, nav?: ChatsNav) => {
      if (
        !owner.active ||
        store.current !== owner ||
        !session.current.ready ||
        session.current.generation !== generation ||
        owner.entries.get(path) !== entry ||
        entry.nav
      )
        return;
      if (!nav) return;
      entry.nav = nav;
      render((value) => value + 1);
    };
    if (targets.some(({ target }) => target?.kind === "channel")) {
      void bridge()
        .listChatChannels({ workspaceId: input.workspaceId })
        .then(({ channels }) => {
          for (const { path, entry, target } of targets) {
            if (target?.kind !== "channel") continue;
            const channel = channels.find((entry) => entry.id === target.id);
            remember(path, entry, channel ? { level: "channel", channel } : undefined);
          }
        })
        .catch(() => undefined);
    }
    // A direct conversation's tab needs no read: its path names it. The tab
    // takes the people's names when this window already knows them.
    const direct = directStore().snapshot();
    for (const { path, entry, target } of targets) {
      if (target?.kind === "new") remember(path, entry, { level: "direct-new" });
      if (target?.kind !== "dm") continue;
      const conversation =
        direct.status === "ready"
          ? direct.conversations.find((candidate) => candidate.conversationId === target.id)
          : undefined;
      remember(path, entry, {
        level: "direct",
        conversationId: target.id,
        ...(conversation ? { title: directPersonName(conversation.person) } : {}),
      });
    }
  }, [get, input.enabled, pathsKey, input.workspaceId, sessionRevision]);
  // Until the list reads, a direct tab shows the name saved with it, for the account that read it.
  // Once the list reads, each tab takes the person's name without waiting to be opened, and the saved one follows.
  const directIds = JSON.stringify(
    input.paths.flatMap((path) => {
      const tab = parseTab(path);
      return tab.kind === "chat" && tab.target.kind === "dm" ? [tab.target.id] : [];
    }),
  );
  const listReady = useRef(false);
  useEffect(() => {
    if (directIds === "[]") return;
    const owner = store.current;
    const direct = directStore();
    const open = new Set<string>(JSON.parse(directIds));
    const name = () => {
      const state = direct.snapshot();
      if (store.current !== owner) return;
      if (listReady.current !== (state.status === "ready")) {
        listReady.current = state.status === "ready";
        render((value) => value + 1);
      }
      if (state.status !== "ready") return;
      const account = session.current.key;
      if (account) {
        for (const conversation of state.conversations) {
          const { name } = conversation.person;
          if (name !== null && open.has(conversation.conversationId)) {
            callbacks.current.onDirectName(conversation.conversationId, account, name);
          }
        }
      }
      let named = false;
      for (const entry of owner.entries.values()) {
        const nav = entry.nav;
        if (nav?.level !== "direct") continue;
        const conversation = state.conversations.find(
          (candidate) => candidate.conversationId === nav.conversationId,
        );
        const title = conversation ? directPersonName(conversation.person) : undefined;
        if (title === undefined || nav.title === title) continue;
        entry.nav = { ...nav, title };
        named = true;
      }
      if (named) render((value) => value + 1);
    };
    const stop = direct.subscribe(name);
    name();
    return stop;
  }, [directIds, input.workspaceId, sessionRevision]);
  // revision and sessionRevision move with listReady and the account.
  const directNames = input.directNames;
  const savedDirectName = useCallback(
    (conversationId: string): string | undefined => {
      const account = session.current.key;
      const saved = directNames[conversationId];
      return account && !listReady.current && saved?.account === account ? saved.name : undefined;
    },
    [directNames, revision, sessionRevision],
  );
  // A hidden conversation's tab counts its unread messages, as Chats does.
  // One local read per workspace change, and none without a hidden one.
  const [unreadRead, setUnread] = useState({ workspaceId: input.workspaceId, counts: NO_UNREAD });
  // One read in flight across tab switches too; the latest tabs take the next.
  const unreadReads = useRef({
    reading: false,
    again: false,
    read: null as (() => Promise<void>) | null,
  });
  useEffect(() => {
    const byChannel = new Map<string, string>();
    for (const path of JSON.parse(pathsKey) as string[]) {
      const tab = parseTab(path);
      if (tab.kind === "chat" && tab.target.kind === "channel") {
        byChannel.set(tab.target.id, path);
      }
    }
    if (!input.enabled || byChannel.size === 0) {
      setUnread((current) =>
        current.counts === NO_UNREAD
          ? current
          : { workspaceId: input.workspaceId, counts: NO_UNREAD },
      );
      return;
    }
    const workspaceId = input.workspaceId;
    const reads = unreadReads.current;
    const read = async () => {
      const result = await bridge()
        .listChatUnread({ workspaceId })
        .catch(() => null);
      if (reads.read !== read || !result) return;
      const counts = new Map(
        result.chats.flatMap(({ channelId, unreadCount }) => {
          const path = byChannel.get(channelId);
          return path && unreadCount > 0 ? [[path, unreadCount] as const] : [];
        }),
      );
      // Most workspace changes are not messages: keep the shell's render.
      setUnread((current) =>
        current.workspaceId === workspaceId && sameCounts(current.counts, counts)
          ? current
          : { workspaceId, counts: counts.size === 0 ? NO_UNREAD : counts },
      );
    };
    const request = async () => {
      if (reads.reading) {
        reads.again = true;
        return;
      }
      reads.reading = true;
      try {
        do {
          reads.again = false;
          await reads.read?.();
        } while (reads.again);
      } finally {
        reads.reading = false;
      }
    };
    reads.read = read;
    void request();
    const unsubscribe = bridge().onWorkspaceActivity((event) => {
      if (event.workspaceId === workspaceId) void request();
    });
    return () => {
      if (reads.read === read) reads.read = null;
      unsubscribe();
    };
  }, [input.enabled, input.workspaceId, input.readRevision, pathsKey]);
  const unread = unreadRead.workspaceId === input.workspaceId ? unreadRead.counts : NO_UNREAD;
  const titles = useMemo(
    () =>
      new Map(
        [...store.current.entries]
          .filter(([, entry]) => entry.nav)
          .map(([path, entry]) => {
            const nav = entry.nav!;
            const saved =
              nav.level === "direct" && nav.title === undefined
                ? savedDirectName(nav.conversationId)
                : undefined;
            return [path, saved ?? chatEditorTitle(nav, input.agents)] as const;
          }),
      ),
    [revision, input.agents, input.workspaceId, savedDirectName],
  );
  // An agent's chat tab draws the agent's sparkle, as the sidebar does.
  const glyphs = useMemo(
    () =>
      new Map(
        [...store.current.entries]
          .filter(([, entry]) => isAgentNav(entry.nav))
          .map(([path]) => [path, "agent" as const]),
      ),
    [revision, input.workspaceId],
  );
  return { get, open, titles, glyphs, unread, savedDirectName };
}

const NO_UNREAD: ReadonlyMap<string, number> = new Map();

function sameCounts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  return a.size === b.size && [...a].every(([path, count]) => b.get(path) === count);
}
