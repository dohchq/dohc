import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../bridge";
import { parseChatTabPath } from "../workbench/workbenchState";
import type { ChatsDrafts, ChatsNav } from "../workbench/ChatsView";
import { chatEditorPath, chatEditorTitle, chatsNavigationLeavesConversation, chatsNavigationRequiresRemount } from "./chatsNav";

type ChatEditor = {
  nav: ChatsNav | undefined;
  drafts: ChatsDrafts | undefined;
  // A prefill waits in the new-post composer, which takes focus until the
  // page first reports its drafts.
  focusNewPost: boolean;
  revision: number;
  generation: number;
  restoreAttempted: boolean;
  onNavChange: (nav: ChatsNav) => void;
  onNavCommand: (nav: ChatsNav) => void;
  onDraftsChange: (drafts: ChatsDrafts) => void;
};

const EMPTY_DRAFTS: ChatsDrafts = {
  composer: "",
  newThreadBody: "",
  dmRecipients: "",
  dmDraft: "",
  replyTarget: null,
  resolveTargetMessageId: null,
};

// Inactive editors unmount. Keep only their navigation and unsent input here;
// they do not need a second presence lease or background poller.
export function useChatEditorTabs(input: {
  workspaceId: string;
  onOpen: (path: string) => void;
  onNavigate: () => void;
  paths: readonly string[];
  activePaths?: readonly string[];
  enabled: boolean;
  agentName?: string;
}) {
  const callbacks = useRef(input);
  callbacks.current = input;
  const store = useRef({ workspaceId: input.workspaceId, active: true, entries: new Map<string, ChatEditor>() });
  if (store.current.workspaceId !== input.workspaceId) {
    store.current = { workspaceId: input.workspaceId, active: true, entries: new Map() };
  }
  useEffect(() => {
    const owner = store.current;
    owner.active = true;
    return () => { owner.active = false; };
  }, [input.workspaceId]);
  const [revision, render] = useState(0);
  const session = useRef({ key: undefined as string | null | undefined, generation: 0, ready: true });
  const [sessionRevision, refreshSession] = useState(0);
  useEffect(() => {
    return bridge().onCloudSessionChanged(({ sessionKey, phase }) => {
      session.current.ready = phase === "ready";
      if (session.current.key !== sessionKey) {
        session.current.key = sessionKey;
        session.current.generation += 1;
        for (const path of store.current.entries.keys()) {
          const kind = parseChatTabPath(path)?.kind;
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
  const get = useCallback((path: string): ChatEditor => {
    const owner = store.current;
    const existing = owner.entries.get(path);
    if (existing) return existing;
    const entry: ChatEditor = {
      nav: undefined,
      drafts: undefined,
      focusNewPost: false,
      revision: 0,
      generation: session.current.generation,
      restoreAttempted: false,
      onNavChange(nav) {
        if (store.current !== owner || owner.entries.get(path) !== entry || entry.nav === nav) return;
        entry.nav = nav;
        render((value) => value + 1);
      },
      onNavCommand(nav) {
        if (store.current !== owner || owner.entries.get(path) !== entry) return;
        callbacks.current.onNavigate();
        entry.onNavChange(nav);
      },
      onDraftsChange(drafts) {
        if (store.current !== owner || owner.entries.get(path) !== entry) return;
        entry.drafts = drafts;
        entry.focusNewPost = false;
      },
    };
    owner.entries.set(path, entry);
    return entry;
  }, []);
  // A prefill lands in the conversation's new-post composer, after anything
  // the person already typed there, and remounts the tab so it shows. It
  // never leaves a reply the person has not sent: the tab keeps its thread
  // and the answer is false.
  const open = useCallback((nav: ChatsNav, prefill?: string): boolean => {
    callbacks.current.onNavigate();
    const path = chatEditorPath(nav);
    const entry = get(path);
    if (prefill !== undefined) {
      if (chatsNavigationLeavesConversation(entry.nav ?? null, nav)) {
        if (entry.drafts?.composer.trim()) {
          callbacks.current.onOpen(path);
          return false;
        }
        // A thread in this tab belongs to this channel, whose new post the
        // person may have started before opening the thread.
        entry.drafts = entry.drafts && { ...EMPTY_DRAFTS, newThreadBody: entry.drafts.newThreadBody };
      }
      const typed = entry.drafts?.newThreadBody.trim() ? `${entry.drafts.newThreadBody}\n\n` : "";
      entry.drafts = { ...(entry.drafts ?? EMPTY_DRAFTS), newThreadBody: `${typed}${prefill}` };
      entry.focusNewPost = true;
      entry.nav = nav;
      entry.revision += 1;
      render((value) => value + 1);
      callbacks.current.onOpen(path);
      return true;
    }
    // A sidebar channel click focuses its tab, including its current thread.
    // A message link still commands a jump inside that tab.
    const focusOnly = entry.nav && entry.nav.level !== "channels" && chatEditorPath(entry.nav) === path &&
      (nav.level === "channel" || nav.level === "feed" ||
        (nav.level === "dm" && !nav.focusMessageId));
    if (focusOnly && nav.level === "dm" && entry.nav?.level === "dm" &&
      JSON.stringify(entry.nav.dm) !== JSON.stringify(nav.dm)) {
      entry.nav = { ...entry.nav, dm: nav.dm };
      entry.revision += 1;
      render((value) => value + 1);
    } else if (!focusOnly) {
      if (chatsNavigationLeavesConversation(entry.nav ?? null, nav)) entry.drafts = undefined;
      if (chatsNavigationRequiresRemount(entry.nav ?? null, nav)) entry.revision += 1;
      entry.nav = nav;
      render((value) => value + 1);
    }
    callbacks.current.onOpen(path);
    return true;
  }, [get]);
  // Mounted pages resolve their own destinations. Hydrate only hidden tabs.
  const pathsKey = JSON.stringify(input.paths.filter((path) => !input.activePaths?.includes(path)));
  useEffect(() => {
    if (!input.enabled || !session.current.ready) return;
    const owner = store.current;
    const generation = session.current.generation;
    const paths: string[] = JSON.parse(pathsKey);
    const targets = paths
      .filter((path) => !get(path).nav && !get(path).restoreAttempted)
      .map((path) => {
        const entry = get(path);
        entry.restoreAttempted = true;
        return { path, entry, target: parseChatTabPath(path) };
      });
    const remember = (path: string, entry: ChatEditor, nav?: ChatsNav) => {
      if (!owner.active || store.current !== owner || !session.current.ready ||
        session.current.generation !== generation || owner.entries.get(path) !== entry || entry.nav) return;
      if (!nav) return;
      entry.nav = nav;
      render((value) => value + 1);
    };
    if (targets.some(({ target }) => target?.kind === "channel")) {
      void bridge().listChatChannels({ workspaceId: input.workspaceId }).then(({ channels }) => {
        for (const { path, entry, target } of targets) {
          if (target?.kind !== "channel") continue;
          const channel = channels.find((entry) => entry.id === target.id);
          remember(path, entry, channel ? { level: "channel", channel } : undefined);
        }
      }).catch(() => undefined);
    }
    if (targets.some(({ target }) => target?.kind === "dm")) {
      void bridge().syncDms({ workspaceId: input.workspaceId }).then(({ dms }) => {
        for (const { path, entry, target } of targets) {
          if (target?.kind !== "dm") continue;
          const dm = dms.find((entry) => entry.channelId === target.id);
          remember(path, entry, dm ? { level: "dm", dm } : undefined);
        }
      }).catch(() => undefined);
    }
  }, [get, input.enabled, pathsKey, input.workspaceId, sessionRevision]);
  const titles = useMemo(() => new Map(
    [...store.current.entries].filter(([, entry]) => entry.nav).map(([path, entry]) =>
      [path, chatEditorTitle(entry.nav!, input.agentName)] as const),
  ), [revision, input.agentName, input.workspaceId]);
  return { get, open, titles };
}
