import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../bridge";
import { parseChatTabPath } from "../workbench/workbenchState";
import type { ChatsDrafts, ChatsNav } from "../workbench/ChatsView";
import { chatEditorPath, chatEditorTitle, chatsNavigationChangesDestination, chatsNavigationLeavesConversation, chatsNavigationRequiresRemount } from "./chatsNav";

type ChatEditor = {
  nav: ChatsNav | undefined;
  drafts: ChatsDrafts | undefined;
  revision: number;
  generation: number;
  onNavChange: (nav: ChatsNav) => void;
  onNavCommand: (nav: ChatsNav) => void;
  onDraftsChange: (drafts: ChatsDrafts) => void;
};

// Inactive editors unmount. Keep only their navigation and unsent input here;
// they do not need a second presence lease or background poller.
export function useChatEditorTabs(input: {
  workspaceId: string;
  onOpen: (path: string) => void;
  onNavigate: () => void;
  paths: readonly string[];
  enabled: boolean;
  agentName?: string;
}) {
  const callbacks = useRef(input);
  callbacks.current = input;
  const store = useRef({ workspaceId: input.workspaceId, entries: new Map<string, ChatEditor>() });
  if (store.current.workspaceId !== input.workspaceId) {
    store.current = { workspaceId: input.workspaceId, entries: new Map() };
  }
  const [revision, render] = useState(0);
  const session = useRef({ key: undefined as string | null | undefined, generation: 0 });
  useEffect(() => {
    if (!input.enabled) return;
    return bridge().onCloudSessionChanged(({ sessionKey }) => {
      if (session.current.key === sessionKey) return;
      session.current = { key: sessionKey, generation: session.current.generation + 1 };
      for (const path of store.current.entries.keys()) {
        const kind = parseChatTabPath(path)?.kind;
        if (kind !== "dm" && kind !== "new") continue;
        store.current.entries.delete(path);
      }
      render((value) => value + 1);
    });
  }, [input.enabled, input.workspaceId]);
  const get = useCallback((path: string): ChatEditor => {
    const owner = store.current;
    const existing = owner.entries.get(path);
    if (existing) return existing;
    const entry: ChatEditor = {
      nav: undefined,
      drafts: undefined,
      revision: 0,
      generation: session.current.generation,
      onNavChange(nav) {
        if (store.current !== owner || owner.entries.get(path) !== entry || entry.nav === nav) return;
        const changed = chatsNavigationChangesDestination(entry.nav ?? null, nav);
        entry.nav = nav;
        if (changed) callbacks.current.onNavigate();
        render((value) => value + 1);
      },
      onNavCommand(nav) {
        if (store.current !== owner || owner.entries.get(path) !== entry) return;
        callbacks.current.onNavigate();
        entry.onNavChange(nav);
      },
      onDraftsChange(drafts) {
        if (store.current === owner && owner.entries.get(path) === entry) entry.drafts = drafts;
      },
    };
    owner.entries.set(path, entry);
    return entry;
  }, []);
  const open = useCallback((nav: ChatsNav) => {
    callbacks.current.onNavigate();
    const path = chatEditorPath(nav);
    const entry = get(path);
    // A sidebar channel click focuses its tab, including its current thread.
    // A message link still commands a jump inside that tab.
    const focusOnly = entry.nav && entry.nav.level !== "channels" && chatEditorPath(entry.nav) === path &&
      (nav.level === "channel" || nav.level === "feed" ||
        (nav.level === "dm" && !nav.focusMessageId));
    if (!focusOnly) {
      if (chatsNavigationLeavesConversation(entry.nav ?? null, nav)) entry.drafts = undefined;
      if (chatsNavigationRequiresRemount(entry.nav ?? null, nav)) entry.revision += 1;
      entry.nav = nav;
      render((value) => value + 1);
    }
    callbacks.current.onOpen(path);
  }, [get]);
  useEffect(() => {
    if (!input.enabled) return;
    const owner = store.current;
    const generation = session.current.generation;
    let cancelled = false;
    const targets = input.paths
      .filter((path) => !get(path).nav)
      .map((path) => ({ path, target: parseChatTabPath(path) }));
    const remember = (path: string, nav: ChatsNav) => {
      if (cancelled || store.current !== owner || session.current.generation !== generation || get(path).nav) return;
      get(path).nav = nav;
      render((value) => value + 1);
    };
    if (targets.some(({ target }) => target?.kind === "channel")) {
      void bridge().listChatChannels({ workspaceId: input.workspaceId }).then(({ channels }) => {
        for (const { path, target } of targets) {
          if (target?.kind !== "channel") continue;
          const channel = channels.find((entry) => entry.id === target.id);
          if (channel) remember(path, { level: "channel", channel });
        }
      }).catch(() => undefined);
    }
    if (targets.some(({ target }) => target?.kind === "dm")) {
      void bridge().syncDms({ workspaceId: input.workspaceId }).then(({ dms }) => {
        for (const { path, target } of targets) {
          if (target?.kind !== "dm") continue;
          const dm = dms.find((entry) => entry.channelId === target.id);
          if (dm) remember(path, { level: "dm", dm });
        }
      }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [get, input.enabled, input.paths, input.workspaceId]);
  const titles = useMemo(() => new Map(
    [...store.current.entries].filter(([, entry]) => entry.nav).map(([path, entry]) =>
      [path, chatEditorTitle(entry.nav!, input.agentName)] as const),
  ), [revision, input.agentName, input.workspaceId]);
  return { get, open, titles };
}
