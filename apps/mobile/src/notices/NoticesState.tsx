import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { demoMode } from "../demo";
import { sampleBuild } from "../sampleBuild";
import { endFailedSample, sampleNotices, type PhoneNotice } from "./sample";

interface NoticesState {
  readonly notices: readonly PhoneNotice[];
  readonly unread: number;
  /** A new notice goes on top, unread. */
  add(notice: PhoneNotice): void;
  dismiss(id: string): void;
  markAllRead(): void;
}

const State = createContext<NoticesState | null>(null);

// One list for the Notices tab and its badge, so marking read clears both.
export function NoticesProvider({ children }: { children: ReactNode }) {
  // A signed-in build reads no notices from the server yet.
  const [notices, setNotices] = useState<readonly PhoneNotice[]>(!sampleBuild ? [] :
    demoMode === "empty" || demoMode === "band-empty" ? [] : demoMode === "notice-end-failed" || demoMode === "notice-clipped" || demoMode === "notice-clipped-open" ? [endFailedSample, ...sampleNotices] : sampleNotices);
  const add = useCallback((notice: PhoneNotice) => setNotices(previous => [notice, ...previous]), []);
  const dismiss = useCallback((id: string) => setNotices(previous => previous.filter(notice => notice.id !== id)), []);
  const markAllRead = useCallback(() => setNotices(previous => previous.map(notice => ({ ...notice, read: true }))), []);
  const value = useMemo(() => ({ notices, unread: notices.filter(notice => !notice.read).length, add, dismiss, markAllRead }), [notices, add, dismiss, markAllRead]);
  return <State value={value}>{children}</State>;
}

export function useNotices(): NoticesState {
  const state = useContext(State);
  if (!state) throw new Error("useNotices needs NoticesProvider");
  return state;
}
