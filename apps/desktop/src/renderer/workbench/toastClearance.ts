import { useLayoutEffect, type RefObject } from "react";

// A chat's message box pinned to the bottom of its view keeps the toasts above
// it, so Send stays in reach while a toast shows. NoticeCenter's stack starts at
// --dohc-composer-room, how far the highest shown box reaches up from the
// window's bottom edge. A box in a hidden view has no height and counts none.
// Only pinned boxes count: one inside scrolling content moves without resizing.
const boxes = new Set<HTMLElement>();
const listeners = new Set<() => void>();
let lastRoom = 0;

function measure() {
  let room = 0;
  for (const box of boxes) {
    const rect = box.getBoundingClientRect();
    if (rect.height > 0) room = Math.max(room, Math.ceil(window.innerHeight - rect.top));
  }
  const root = document.documentElement;
  if (room > 0) root.style.setProperty("--dohc-composer-room", `${room}px`);
  else root.style.removeProperty("--dohc-composer-room");
  if (room === lastRoom) return;
  lastRoom = room;
  for (const listener of listeners) listener();
}

// The toast stack moves without resizing when the room changes.
export function onComposerRoomChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let observer: ResizeObserver | null = null;

export function useToastsAbove(ref: RefObject<HTMLElement | null>, enabled = true) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!enabled || !box) return;
    if (boxes.size === 0) window.addEventListener("resize", measure);
    boxes.add(box);
    if (!observer && typeof ResizeObserver !== "undefined") observer = new ResizeObserver(measure);
    observer?.observe(box);
    measure();
    return () => {
      boxes.delete(box);
      observer?.unobserve(box);
      if (boxes.size === 0) window.removeEventListener("resize", measure);
      measure();
    };
  }, [ref, enabled]);
}
