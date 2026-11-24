import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { PhotoSource } from "./api";
import { Photo, type FileAccess } from "./photo";

export interface FilterOption {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
  readonly swatch?: string;
}

export function FilterBar({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly FilterOption[];
  value: string;
  onChange(id: string): void;
  label: string;
}) {
  return (
    <div className="lb-filters" role="toolbar" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`lb-chip${option.id === value ? " lb-chip-on" : ""}`}
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
          data-filter={option.id}
        >
          {option.swatch ? <span className={`lb-swatch lb-label-${option.swatch}`} aria-hidden="true" /> : null}
          {option.label}
          {option.count !== undefined ? <span className="lb-chip-count">{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function useViewer<T extends { readonly id: string }>(all: readonly T[]) {
  const [view, setView] = useState<{ ids: readonly string[]; index: number } | null>(null);
  const byId = new Map(all.map((item) => [item.id, item]));
  const items = view ? view.ids.flatMap((id) => byId.get(id) ?? []) : [];
  const index = Math.min(view?.index ?? 0, items.length - 1);
  return {
    items,
    index,
    current: view ? items[index] : undefined,
    open: (shown: readonly T[], at: number) => setView({ ids: shown.map((item) => item.id), index: at }),
    move: (at: number) => setView((current) => current && { ...current, index: at }),
    close: () => setView(null),
  };
}

export function PhotoGrid<T extends PhotoSource & { readonly mimeType?: string }>({
  items,
  access,
  cursor,
  onCursor,
  onOpen,
  onKey,
  badges,
  actions,
  muted,
  label,
}: {
  items: readonly T[];
  access: FileAccess;
  cursor: number;
  onCursor(index: number): void;
  onOpen(index: number): void;
  onKey(event: KeyboardEvent, item: T): boolean;
  badges(item: T): ReactNode;
  actions?(item: T): ReactNode;
  muted?(item: T): boolean;
  label: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusNext = useRef(false);
  const active = Math.min(Math.max(cursor, 0), items.length - 1);
  useEffect(() => {
    if (focusNext.current) {
      focusNext.current = false;
      refs.current[active]?.focus();
    }
  }, [active]);
  const move = (index: number) => {
    const next = Math.min(Math.max(index, 0), items.length - 1);
    focusNext.current = true;
    onCursor(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="lb-grid" role="list" aria-label={label}>
      {items.map((item, index) => {
        const ratio = item.width / item.height;
        return (
          <div
            key={item.id}
            role="listitem"
            className="lb-tile-wrap"
            style={{ flexGrow: ratio * 100, flexBasis: `${ratio * 230}px` }}
          >
            <button
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              className={`lb-tile${index === active ? " lb-tile-cursor" : ""}${muted?.(item) ? " lb-tile-muted" : ""}`}
              style={{ aspectRatio: `${item.width} / ${item.height}` }}
              tabIndex={index === active ? 0 : -1}
              aria-label={item.title}
              data-asset={item.id}
              onFocus={() => index !== active && onCursor(index)}
              onClick={() => {
                onCursor(index);
                onOpen(index);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") move(index + 1);
                else if (event.key === "ArrowLeft") move(index - 1);
                else if (event.key === "Home") move(0);
                else if (event.key === "End") move(items.length - 1);
                else if (event.key === "Enter") onOpen(index);
                else if (!onKey(event, item)) return;
                event.preventDefault();
              }}
            >
              <Photo photo={item} access={access} size="thumb" />
              <span className="lb-tile-shade" aria-hidden="true" />
              <span className="lb-tile-title">{item.title}</span>
              <span className="lb-tile-badges">{badges(item)}</span>
            </button>
            {actions ? <span className="lb-tile-actions">{actions(item)}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
