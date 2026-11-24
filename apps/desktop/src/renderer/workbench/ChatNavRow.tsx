import { MoreHorizontal } from "lucide-react";
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
    <div className={`group/nav relative mx-1 ${props.className ?? ""}`}>
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
        className={`dohc-focus-row flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left transition-colors duration-75 ${
          onMenu ? "group-hover/nav:pr-8 group-focus-within/nav:pr-8" : ""
        } ${props.menuOpen ? "pr-8" : ""} ${
          props.active
            ? "bg-selected font-medium"
            : props.menuOpen
              ? "bg-hover"
              : "hover:bg-hover group-hover/nav:bg-hover"
        }`}
      >
        {props.icon}
        <span
          data-testid={props.labelTestId}
          // With a detail, the name keeps its width and the detail truncates first.
          className={`min-w-0 truncate text-[13px] ${props.detail ? "shrink" : "flex-1"} ${
            props.unread
              ? "font-semibold text-ink"
              : props.active
                ? "font-medium text-ink"
                : props.muted
                  ? "text-muted"
                  : "text-ink"
          }`}
        >
          {props.label}
        </span>
        {props.detail ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-subtle">{props.detail}</span>
        ) : null}
        {props.trailing}
      </button>
      {onMenu ? (
        <button
          type="button"
          aria-label={`More actions for ${props.label}`}
          title="More actions"
          onClick={(event) => {
            event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect();
            onMenu({ x: box.left, y: box.bottom }, event.detail === 0);
          }}
          className={`absolute right-1 top-1 grid size-6 place-items-center rounded-md text-subtle transition-opacity duration-75 hover:bg-hover hover:text-ink ${
            props.menuOpen
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-hover/nav:pointer-events-auto group-hover/nav:opacity-100 group-focus-within/nav:pointer-events-auto group-focus-within/nav:opacity-100"
          }`}
        >
          <MoreHorizontal size={14} aria-hidden />
        </button>
      ) : null}
    </div>
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
