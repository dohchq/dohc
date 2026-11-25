import { useEffect, useRef, useState } from "react";

export function usePopover<T extends HTMLElement>(controlled?: [boolean, (open: boolean) => void]) {
  const own = useState(false);
  const [open, setOpen] = controlled ?? own;
  const box = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const onKeyDown = (event: { key: string; stopPropagation: () => void }) => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    setOpen(false);
    box.current?.querySelector("button")?.focus();
  };
  return { open, setOpen, box, onKeyDown };
}

export function useSticky<T>(value: T | undefined, key: string) {
  const last = useRef<{ key: string; value: T } | null>(null);
  if (value !== undefined) last.current = { key, value };
  return last.current?.key === key ? last.current.value : undefined;
}

export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function typing(target: EventTarget | null) {
  if (target instanceof HTMLInputElement)
    return !/^(checkbox|radio|range|button|submit|reset)$/.test(target.type);
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(TEXTAREA|SELECT)$/.test(target.tagName))
  );
}
