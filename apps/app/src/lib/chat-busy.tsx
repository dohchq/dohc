/**
 * Chat busy state context (F1 — multiplayer-and-h-followups §7).
 *
 * The chat panel writes its in-flight-stream signal here; the
 * WorkspaceSwitcher reads it to disable the switcher button while a
 * message is mid-stream. Otherwise switching workspace mid-send would
 * navigate away (per R1 commit 3), causing the chat to rebind to the
 * new workspace's thread mid-stream — the orphan-stream bug F1 fixes.
 *
 * Scope: deliberately tiny. v1 just blocks the switcher click while
 * busy + shows a tooltip. v2 (deferred) is the full abandon-confirm +
 * AbortController plumbing through the agent action (which is the
 * proper fix but requires Convex action lifecycle work).
 *
 * When the chat panel is CLOSED there's no writer, `busy` stays false,
 * and the switcher behaves normally — important so the switcher isn't
 * gratuitously disabled for users who never open the chat.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

type Ctx = {
  /** True while the Chat panel has a streaming assistant turn in flight. */
  busy: boolean
  /** Setter — called by the Chat panel from its busy-derivation effect. */
  setBusy: (b: boolean) => void
}

const ChatBusyContext = createContext<Ctx | null>(null)

export function ChatBusyProvider({ children }: { children: ReactNode }) {
  const [busy, setBusyState] = useState(false)
  const setBusy = useCallback((b: boolean) => setBusyState(b), [])
  const value = useMemo(() => ({ busy, setBusy }), [busy, setBusy])
  return (
    <ChatBusyContext.Provider value={value}>{children}</ChatBusyContext.Provider>
  )
}

/** Read the busy signal (for the switcher / other gating UIs). */
export function useChatBusy(): boolean {
  const ctx = useContext(ChatBusyContext)
  // Defensive: if a consumer mounts outside the provider, default to
  // false (don't gratuitously disable). Less strict than the
  // active-workspace hooks (which throw) — this signal is advisory.
  return ctx?.busy ?? false
}

/** Set the busy signal (for the chat panel). No-op when provider missing. */
export function useSetChatBusy(): (b: boolean) => void {
  const ctx = useContext(ChatBusyContext)
  return ctx?.setBusy ?? (() => {})
}
