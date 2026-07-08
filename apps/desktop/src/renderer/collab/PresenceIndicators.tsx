import { useMemo } from "react";
import { resolvePeerDisplayName, type PresencePeer } from "./presenceChannel";

// MU-C1 — calm presence UI. Small initials for who's here and a subtle typing
// line. Deliberately quiet: no layout thrash, no noisy badges, and it renders
// NOTHING when nobody else is around (solo stays solo). Presence changes are
// announced politely (aria-live="polite"), never as a spam of alerts.

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/u);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

// A deterministic, muted hue per user so the same person keeps the same face
// color across renders without a palette dependency.
function hueFor(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) % 360;
  return hash;
}

const MAX_FACES = 3;

export function PresenceFaces(props: {
  others: PresencePeer[];
  className?: string;
}) {
  // Collapse a user's multiple devices/tabs into one face.
  const unique = useMemo(() => {
    const byUser = new Map<string, PresencePeer>();
    for (const peer of props.others) {
      if (!byUser.has(peer.userId)) byUser.set(peer.userId, peer);
    }
    return [...byUser.values()];
  }, [props.others]);

  if (unique.length === 0) return null;

  const shown = unique.slice(0, MAX_FACES);
  const overflow = unique.length - shown.length;
  const names = unique.map(resolvePeerDisplayName);
  const label =
    unique.length === 1 ? `${names[0]} is here` : `${unique.length} people here`;

  return (
    <div
      className={`dohc-presence-faces flex items-center ${props.className ?? ""}`}
      role="status"
      aria-live="polite"
      aria-label={label}
      title={names.join(", ")}
    >
      {shown.map((peer) => {
        const name = resolvePeerDisplayName(peer);
        const hue = hueFor(peer.userId);
        return (
          <span
            key={peer.userId}
            className="-ml-1 flex h-5 w-5 items-center justify-center rounded-full border border-bg text-[9px] font-semibold first:ml-0"
            style={{
              backgroundColor: `hsl(${hue} 45% 88%)`,
              color: `hsl(${hue} 45% 30%)`,
            }}
            aria-hidden="true"
          >
            {initials(name)}
          </span>
        );
      })}
      {overflow > 0 ? (
        <span
          className="-ml-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-bg bg-paper px-1 text-[9px] font-semibold text-subtle"
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
      className={`dohc-typing-indicator text-[11px] italic text-subtle ${props.className ?? ""}`}
      role="status"
      aria-live="polite"
      data-testid="presence-typing"
    >
      {label}
    </div>
  );
}
