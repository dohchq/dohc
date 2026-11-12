import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronsRight, Maximize2 } from "lucide-react";
import { IconButton, SecondaryButton } from "../ui/controls";
import { isComposingKey } from "../ui/keys";
import { Menu, type MenuItem } from "../ui/Menu";
import { SkeletonRows } from "../ui/SkeletonRows";
import { useCommitOnRelease } from "../workbench/useCommitOnRelease";
import { RECORD_PANEL_MAX_WIDTH, RECORD_PANEL_MIN_WIDTH } from "../workbench/workbenchState";

// One record, in a panel at the right of its Collection's view. The panel is
// not a dialog: the view beside it stays in use, and focus is never held
// here. Both kinds of Collection draw their record in it. The panel owns the
// frame, the name and the width. Its host gives it the record's fields and
// whatever else the record holds, and says what each control does.

/** The room the panel leaves the view beside it. Narrower than that, the panel lies over the view. */
const VIEW_MIN_WIDTH = 360;
const KEYBOARD_RESIZE_STEP = 16;
const KEYBOARD_RESIZE_PAGE_STEP = KEYBOARD_RESIZE_STEP * 8;

export interface RecordPanelCommand {
  id: string;
  label: string;
  icon?: ReactNode;
  /** A command that deletes or loses work. */
  danger?: boolean;
  disabled?: boolean;
  /** Why a disabled command cannot run, on a second line. */
  reason?: string;
  onSelect: () => void;
}

export interface RecordPanelProps {
  /** What people call the record: the panel's accessible name, and its heading. */
  name: string;
  /**
   * The name as its field holds it, where that is not what people call the
   * record: the heading, and what the open input starts from. Empty, the
   * heading says so.
   */
  nameText?: string;
  /** The Collection's name, beside the top bar's controls. */
  collectionName: string;
  /**
   * Saves a new name, by a cell's rules: Enter or a press away saves, and
   * Escape cancels. Absent, the name cannot change here.
   */
  onNameChange?: (name: string) => void;
  /** The name field's own name, which the open input takes. */
  nameLabel?: string;
  /** Receives a name still being typed when the panel goes, neither saved nor cancelled. */
  onNameAbandoned?: (text: string) => void;
  /** What shows under the name, such as a change to it the host has not confirmed. */
  nameNote?: ReactNode;
  /** Opens the record as a page. Absent, the record has no page. */
  onOpenAsPage?: () => void;
  /** The host's commands for the record, in the panel's menu. */
  commands?: readonly RecordPanelCommand[];
  /** The panel is reading the record, so it shows no name and no fields yet. */
  loading?: boolean;
  /** Why the panel cannot show the record, in one line, as for a record deleted since it opened. It replaces what is under the top bar. */
  unavailable?: string;
  /** The record's fields. */
  properties?: ReactNode;
  /** What the record holds under its fields, such as a page's text. */
  body?: ReactNode;
  /** One quiet line at the bottom. */
  footer?: ReactNode;
  width: number;
  /** Receives the width once a resize ends. */
  onWidthChange: (width: number) => void;
  onClose: () => void;
  /** The panel's own element, for a host that moves focus to it. */
  panelRef?: RefObject<HTMLElement | null>;
}

/** The record's name: a heading, and where the host lets it change, the control that opens it for typing. */
function PanelName(props: Pick<RecordPanelProps, "name" | "nameText" | "onNameChange" | "nameLabel" | "onNameAbandoned">) {
  const { onNameChange } = props;
  const name = props.nameText ?? props.name;
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Enter closes the input, which can blur it. One edit saves once.
  const done = useRef(false);
  const typed = useRef(false);
  const abandoned = useRef(props.onNameAbandoned);
  abandoned.current = props.onNameAbandoned;
  // Focus goes back to the name once the input is gone, unless the person has moved on.
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    button.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (!editing) return;
    const node = input.current;
    // The input is off the page with text in it only when the panel went first.
    return () => {
      if (node && !node.isConnected && typed.current && !done.current) abandoned.current?.(node.value);
    };
  }, [editing]);
  const heading = "m-0 min-w-0 text-base font-semibold text-ink";
  const shown = name === "" ? <span className="text-subtle">Untitled</span> : name;
  if (!onNameChange) return <h2 className={`${heading} whitespace-pre-wrap break-words`}>{shown}</h2>;
  const close = (focused: boolean) => {
    done.current = true;
    refocus.current = focused;
    setEditing(false);
  };
  const save = (value: string, focused: boolean) => {
    if (done.current) return;
    close(focused);
    if (value !== name) onNameChange(value);
  };
  return (
    <h2 className={heading}>
      {editing ? (
        <input
          ref={input}
          autoFocus
          type="text"
          aria-label={props.nameLabel ?? "Name"}
          defaultValue={name}
          onChange={() => {
            typed.current = true;
          }}
          onKeyDown={(event) => {
            if (isComposingKey(event)) return;
            if (event.key === "Enter") save(event.currentTarget.value, true);
            else if (event.key === "Escape") {
              // One Escape closes one surface: the open name took this one.
              event.stopPropagation();
              close(true);
            }
          }}
          onBlur={(event) => save(event.currentTarget.value, false)}
          className="-mx-1 w-[calc(100%+0.5rem)] rounded border border-line bg-bg px-1 text-base font-semibold text-ink focus:border-ink"
        />
      ) : (
        <button
          ref={button}
          type="button"
          title={`Edit ${props.nameLabel ?? "name"}`}
          onClick={() => {
            done.current = false;
            typed.current = false;
            setEditing(true);
          }}
          className="-mx-1 block w-[calc(100%+0.5rem)] cursor-text whitespace-pre-wrap break-words rounded border border-transparent px-1 text-left transition-colors duration-75 hover:bg-hover"
        >
          {shown}
        </button>
      )}
    </h2>
  );
}

export function RecordPanel(props: RecordPanelProps) {
  const { collectionName, commands, unavailable, loading = false, onClose } = props;
  const panel = useRef<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // The width of the row the panel shares with its view. It sets the widest the panel goes, and whether it lies over the view.
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const row = panel.current?.parentElement;
    if (!row) return;
    const measure = () => setRoom(row.clientWidth > 0 ? row.clientWidth : null);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const over = room !== null && room < RECORD_PANEL_MIN_WIDTH + VIEW_MIN_WIDTH;
  const widest = room === null ? RECORD_PANEL_MAX_WIDTH : Math.max(Math.min(RECORD_PANEL_MAX_WIDTH, over ? room : room - VIEW_MIN_WIDTH), Math.min(RECORD_PANEL_MIN_WIDTH, room));
  const narrowest = Math.min(RECORD_PANEL_MIN_WIDTH, widest);
  const clamp = (width: number) => Math.round(Math.min(widest, Math.max(narrowest, width)));
  const dragRight = useRef<number | null>(null);
  const resize = useCommitOnRelease(props.onWidthChange);
  const width = clamp(resize.previewValue ?? props.width);

  const name = props.name || "Record";
  const items: MenuItem[] = (unavailable === undefined && !loading ? commands ?? [] : []).map((command) => ({
    id: command.id,
    label: command.label,
    icon: command.icon,
    danger: command.danger,
    disabled: command.disabled,
    description: command.disabled ? command.reason : undefined,
    onSelect: command.onSelect,
  }));

  return (
    <aside
      ref={(element) => {
        panel.current = element;
        if (props.panelRef) props.panelRef.current = element;
      }}
      role="complementary"
      aria-label={name}
      aria-busy={loading || undefined}
      data-testid="collection-record-panel"
      // Focus lands here when a record opens, so Escape closes it and Tab goes on to its fields.
      tabIndex={-1}
      data-focus-surface="panel"
      style={{ width }}
      // Beside the view where both fit. Over it, from the right, where they do not.
      className={`flex shrink-0 flex-col border-l border-line bg-bg ${over ? "dohc-popover absolute inset-y-0 right-0 z-20" : "relative"}`}
      onKeyDown={(event) => {
        // An open editor, the open name and the menu each take their own Escape first.
        if (event.key !== "Escape" || event.defaultPrevented || isComposingKey(event)) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div
        data-testid="collection-record-panel-resize"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize record"
        aria-valuemin={narrowest}
        aria-valuemax={widest}
        aria-valuenow={width}
        onKeyDown={(event) => {
          const next =
            event.key === "Home" ? narrowest
            : event.key === "End" ? widest
            : event.key === "PageUp" ? clamp(width + KEYBOARD_RESIZE_PAGE_STEP)
            : event.key === "PageDown" ? clamp(width - KEYBOARD_RESIZE_PAGE_STEP)
            : event.key === "ArrowLeft" ? clamp(width + KEYBOARD_RESIZE_STEP)
            : event.key === "ArrowRight" ? clamp(width - KEYBOARD_RESIZE_STEP)
            : null;
          if (next === null) return;
          event.preventDefault();
          props.onWidthChange(next);
        }}
        onPointerDown={(event) => {
          // Left button only: a right or middle press never starts a resize.
          if (event.button !== 0) return;
          dragRight.current = panel.current?.getBoundingClientRect().right ?? window.innerWidth;
          resize.begin(event.pointerId, width);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragRight.current === null || !resize.isActive(event.pointerId)) return;
          resize.update(event.pointerId, clamp(dragRight.current - event.clientX), event.buttons);
        }}
        onPointerUp={(event) => resize.commit(event.pointerId)}
        onPointerCancel={(event) => resize.commit(event.pointerId)}
        onLostPointerCapture={(event) => resize.commit(event.pointerId)}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize bg-transparent transition-colors hover:bg-line/80 keyboard:focus-visible:bg-focus"
      />
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <IconButton aria-label="Close record" title="Close record" onClick={onClose}>
          <ChevronsRight size={14} strokeWidth={1.9} aria-hidden />
        </IconButton>
        {props.onOpenAsPage && unavailable === undefined ? (
          <IconButton aria-label="Open as page" title="Open as page" onClick={props.onOpenAsPage}>
            <Maximize2 size={13} strokeWidth={1.9} aria-hidden />
          </IconButton>
        ) : null}
        <span className="min-w-0 flex-1 truncate px-1 text-[12px] text-muted">{collectionName}</span>
        {items.length > 0 ? <Menu label="Record actions" open={menuOpen} onOpenChange={setMenuOpen} width={208} items={items} /> : null}
      </div>
      {unavailable !== undefined ? (
        <div className="flex flex-col items-start gap-3 px-3 py-2">
          <p role="status" className="m-0 text-[13px] text-muted">{unavailable}</p>
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
        </div>
      ) : loading ? (
        <SkeletonRows label="Opening record…" layout="panel" />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4">
            <div className="flex flex-col gap-1 pb-3 pt-1">
              <PanelName name={name} nameText={props.nameText} onNameChange={props.onNameChange} nameLabel={props.nameLabel} onNameAbandoned={props.onNameAbandoned} />
              {props.nameNote}
            </div>
            {props.properties}
            {props.body}
          </div>
          {props.footer ? <footer className="shrink-0 border-t border-line px-3 py-2 text-[12px] text-muted">{props.footer}</footer> : null}
        </>
      )}
    </aside>
  );
}
