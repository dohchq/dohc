import { useMemo } from "react";
import { relayPresentation } from "../workbench/actorPresentation";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { resolvePeerDisplayName, type PresencePeer } from "./presenceChannel";

// MU-C1 — calm presence UI. Small initials for who's here and a subtle typing
// line. Deliberately quiet: no layout thrash, no noisy badges, and it renders
// nothing when nobody else is around (solo stays solo). Presence changes are
// announced politely (aria-live="polite"), never as a spam of alerts.

const MAX_FACES = 3;

// An agent publishes presence with `agent: true` in its state.
function isAgentPeer(peer: PresencePeer): boolean {
  return (peer.state as { agent?: unknown } | null)?.agent === true;
}

// `live` false draws the same faces with the same name but no live region,
// for a second copy beside one that already announces them.
export function PresenceFaces(props: { others: PresencePeer[]; className?: string; live?: boolean }) {
  // Collapse a user's multiple devices/tabs into one face.
  const unique = useMemo(() => {
    const byUser = new Map<string, PresencePeer>();
    for (const peer of props.others) {
      if (!byUser.has(peer.faceToken)) byUser.set(peer.faceToken, peer);
    }
    return [...byUser.values()];
  }, [props.others]);

  if (unique.length === 0) return null;

  const shown = unique.slice(0, MAX_FACES);
  const overflow = unique.length - shown.length;
  const names = unique.map(resolvePeerDisplayName);
  const label = unique.length === 1 ? `${names[0]} is here` : `${unique.length} people here`;

  return (
    <div
      className={`dohc-presence-faces flex items-center gap-1 ${props.className ?? ""}`}
      {...(props.live === false ? { role: "img" } : { role: "status", "aria-live": "polite" as const })}
      aria-label={label}
      title={names.join(", ")}
    >
      {/* Each face as its author draws in the conversation: an agent's mark,
          a person's initial. Side by side, so none hides another. */}
      {shown.map((peer) => (
        <ChatAvatar
          key={peer.faceToken}
          name={resolvePeerDisplayName(peer)}
          kind={isAgentPeer(peer) ? "agent" : "human"}
          presentation={relayPresentation(peer.paletteSlot, peer.isSelf)}
          size="strip"
        />
      ))}
      {overflow > 0 ? (
        <span
          className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-line bg-panel px-1 text-[9px] font-semibold text-subtle"
          aria-hidden="true"
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}

function typingLabel(names: string[]): string {
  if (names.length === 0) return "";
  // Collapse duplicate names (a person typing from two tabs).
  const unique = [...new Set(names)];
  if (unique.length === 1) return `${unique[0]} is typing…`;
  if (unique.length === 2) return `${unique[0]} and ${unique[1]} are typing…`;
  return "Several people are typing…";
}

export function TypingIndicator(props: { names: string[]; className?: string }) {
  const label = typingLabel(props.names);
  // Reserve nothing when idle — no layout thrash, just a polite live region.
  return (
    <div
      className={`dohc-typing-indicator text-[11px] italic text-muted ${props.className ?? ""}`}
      role="status"
      aria-live="polite"
      data-testid="presence-typing"
    >
      {label}
    </div>
  );
}
