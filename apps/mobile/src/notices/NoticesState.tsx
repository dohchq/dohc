import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { demoMode } from "../demo";
import type { PhoneNotice } from "./sample";

// The sample's notices, in a sample build only (src/sampleBuild.ts).
const sample = __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? (require("./sample") as typeof import("./sample")) : null;

interface NoticesState {
  readonly notices: readonly PhoneNotice[];
  readonly unread: number;
  /** A new notice goes on top, unread, replacing an earlier one with its id. */
  add(notice: PhoneNotice): void;
  dismiss(id: string): void;
  markAllRead(): void;
}

const State = createContext<NoticesState | null>(null);

// One list for the Notices tab and its badge, so marking read clears both.
export function NoticesProvider({ children }: { children: ReactNode }) {
  // A signed-in build reads no notices from the server yet: it lists only what failed on this phone.
  const [notices, setNotices] = useState<readonly PhoneNotice[]>(!sample ? [] :
    demoMode === "empty" || demoMode === "band-empty" ? [] : demoMode === "notice-end-failed" || demoMode === "notice-clipped" || demoMode === "notice-clipped-open" ? [sample.endFailedSample, ...sample.sampleNotices] : sample.sampleNotices);
  const add = useCallback((notice: PhoneNotice) => setNotices(previous => [notice, ...previous.filter(entry => entry.id !== notice.id)]), []);
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
