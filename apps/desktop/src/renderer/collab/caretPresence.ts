import type { Awareness } from "y-protocols/awareness";
import type { DocPresenceUser } from "./docPresence";

// Remote collaboration carets (CollaborationCaret, editor/MarkdownEditor.tsx).
// docPresence.ts already binds an Awareness to the doc for exactly this:
// "the Awareness lives on the doc so a future CollaborationCaret can render
// remote cursors." This module is the small, pure piece that extension needs
// from us — a stable color per Yjs clientID, and a friendly fallback name for
// a peer whose awareness user field has no real display name yet — kept
// separate from docPresence.ts so it has no dependency on the presence
// transport and is trivial to unit test.

// Muted, brand-adjacent hues (warm paper + graphite) — deliberately NOT
// rainbow. Picked at a saturation/lightness band that reads as a clear
// border on both the light paper background and the dark graphite
// background, and gives the extension's white caret-label text comfortable
// contrast against every entry (verified >= 3.9:1 white-on-color).
export const CARET_PALETTE = [
  "#767e44", // olive
  "#905d47", // clay
  "#52697a", // slate
  "#446a50", // moss
  "#725478", // plum
  "#806d42", // sand
] as const;

// A small avalanche mix (Murmur3-style finalizer) so adjacent Yjs clientIDs —
// which are random 32-bit ints but can land close together by chance — don't
// cluster on the same palette slot or the same fallback number.
function hashClientId(clientId: number): number {
  let x = clientId | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x ^= x >>> 16;
  return x >>> 0;
}

// Stable for the life of the awareness session: the same clientID always
// lands on the same palette entry.
export function caretColorForClientId(clientId: number): string {
  return CARET_PALETTE[hashClientId(clientId) % CARET_PALETTE.length]!;
}

// "Editor 7" style stand-in for a peer with no real display name yet. Stable
// for the session; drifts across app restarts, same as the color, because
// Yjs mints a fresh random clientID per Y.Doc instantiation.
export function caretFallbackName(clientId: number): string {
  return `Editor ${(hashClientId(clientId) % 97) + 2}`;
}

// The LOCAL user object CollaborationCaret publishes into awareness. Reuses
// a name already sitting on the local awareness state (e.g. one a future
// docPresence-driven identity set before the caret extension attached) so
// this never clobbers a real display name; otherwise falls back to a stable
// "Editor N". Color is always the hash — never trusts an existing value, so
// every client agrees on the same peer's color from the clientID alone.
export function resolveCaretUser(awareness: Awareness): DocPresenceUser {
  const existing = (awareness.getLocalState() as { user?: Partial<DocPresenceUser> } | null)
    ?.user;
  const name =
    typeof existing?.name === "string" && existing.name.trim()
      ? existing.name
      : caretFallbackName(awareness.clientID);
  return { name, color: caretColorForClientId(awareness.clientID) };
}

// A remote peer's `color` arrives from its own awareness state — untrusted
// input we interpolate into an inline `style` attribute below. Constrain it to
// a known palette entry or a strict `#rgb`/`#rrggbb` hex literal so a hostile
// peer can't smuggle extra declarations (e.g. `red; position:fixed; inset:0`)
// into the selection decoration's style. Anything else falls back to a palette
// color.
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function safeCaretColor(color: unknown): string {
  if (typeof color === "string") {
    if ((CARET_PALETTE as readonly string[]).includes(color)) return color;
    if (HEX_COLOR_RE.test(color)) return color;
  }
  return CARET_PALETTE[0];
}

// CollaborationCaret's default selectionRender (`@tiptap/y-tiptap`'s
// defaultSelectionBuilder) bakes an alpha suffix onto the peer's hex color
// and stamps a bare `ProseMirror-yjs-selection` class. We use the class name
// Tiptap's own docs style (`collaboration-carets__selection`) and set only
// `color`, so styles.css owns the tint opacity centrally instead of it being
// baked per-peer into a hex string.
export function caretSelectionRender(user: { color?: unknown }): {
  nodeName: string;
  class: string;
  style: string;
} {
  const color = safeCaretColor(user.color);
  return { nodeName: "span", class: "collaboration-carets__selection", style: `color: ${color}` };
}
