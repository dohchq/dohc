import { useRef, type ReactNode } from "react";
import { isContextMenuKey } from "../ui/keys";

// One row of the chat nav: an icon, a name, and what is waiting on the right.
// The active row is the one the panel currently shows.
export function NavRow(props: {
  testId: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  muted?: boolean;
  // Any unread message: the name goes bold on every row. A count beside it
  // means the user was addressed.
  unread?: boolean;
  labelTestId?: string;
  // A muted line after the name, such as a conversation's last message.
  detail?: string;
  // A small mark right after the name, such as a Group's access.
  mark?: ReactNode;
  // The row's tooltip, for what the row has no room to show.
  title?: string;
  trailing?: ReactNode;
  data?: Record<`data-${string}`, string>;
  className?: string;
  // A right-click, the Menu key or Shift+F10 opens the row's menu.
  onMenu?: (at: { x: number; y: number }, fromKeyboard: boolean) => void;
  // The row whose menu is open keeps its hover fill.
  menuOpen?: boolean;
}) {
  const { onMenu } = props;
  // Set when a key opened the menu. The browser may follow the key with its
  // own contextmenu event, which must not open the menu again at the pointer.
  const keyedMenu = useRef(false);
  return (
    <button
      type="button"
      data-testid={props.testId}
      data-active={props.active ? "true" : "false"}
      aria-current={props.active ? "page" : undefined}
      aria-haspopup={onMenu ? "menu" : undefined}
      title={props.title}
      onClick={props.onClick}
      onKeyDown={
        onMenu
          ? (event) => {
              if (!isContextMenuKey(event)) return;
              event.preventDefault();
              if (!keyedMenu.current) {
                keyedMenu.current = true;
                window.addEventListener(
                  "pointerdown",
                  () => {
                    keyedMenu.current = false;
                  },
                  { capture: true, once: true },
                );
              }
              const box = event.currentTarget.getBoundingClientRect();
              onMenu({ x: box.left, y: box.bottom }, true);
            }
          : undefined
      }
      onContextMenu={
        onMenu
          ? (event) => {
              event.preventDefault();
              if (keyedMenu.current) {
                keyedMenu.current = false;
                return;
              }
              onMenu({ x: event.clientX, y: event.clientY }, false);
            }
          : undefined
      }
      {...props.data}
      className={`dohc-focus-row mx-1 flex h-8 w-[calc(100%-0.5rem)] cursor-pointer items-center gap-2 rounded-md px-2 text-left transition-colors duration-75 ${
        props.active ? "bg-selected font-medium" : props.menuOpen ? "bg-hover" : "hover:bg-hover"
      } ${props.className ?? ""}`}
    >
      {props.icon}
      <span
        data-testid={props.labelTestId}
        // With a detail, the name keeps its width and the detail truncates first.
        className={`min-w-0 truncate text-[13px] ${props.detail || props.mark ? "shrink" : "flex-1"} ${
          props.active || props.unread
            ? "font-medium text-ink"
            : props.muted
              ? "text-muted"
              : "text-ink"
        }`}
      >
        {props.label}
      </span>
      {props.mark}
      {props.detail ? (
        <span className="min-w-0 flex-1 truncate text-[11px] text-subtle">{props.detail}</span>
      ) : props.mark ? (
        <span className="flex-1" />
      ) : null}
      {props.trailing}
    </button>
  );
}

// The action a section label offers on the right, always visible like the
// explorer's section actions so a new user can find it.
export function SectionActionButton(props: {
  testId?: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-subtle transition-colors hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-40"
    >
      {props.children}
    </button>
  );
}
