import { ChevronDown, Link2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ShareAccess } from "../ipc/bridgeContract";
import { Menu, MENU_SEPARATOR, type MenuEntry } from "./ui/Menu";
import { neutralPresentation } from "./workbench/actorPresentation";
import { ChatAvatar } from "./workbench/ChatAvatar";

// What a share's level lets its holder do, as Share's menus and rows say it.
export const SHARE_ACCESS_WORDS: Record<ShareAccess, string> = {
  view: "Can view",
  comment: "Can comment",
  edit: "Can edit",
};

const ACCESS_LEVEL =
  "flex h-7 shrink-0 items-center rounded-md px-2 text-[12px] font-medium text-muted";
const ACCESS_TRIGGER =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-hover disabled:text-subtle";

// A share's access, changed the way Docs and Notion change it: from the
// access itself.
export function ShareAccessMenu(props: {
  label: string;
  access: ShareAccess;
  options: ReadonlyArray<{ value: ShareAccess; description?: string; testId?: string }>;
  actions?: readonly MenuEntry[];
  note?: string;
  disabled: boolean;
  testId: string;
  width?: number;
  align?: "start" | "end";
  onPick: (access: ShareAccess) => void;
}) {
  const [open, setOpen] = useState(false);
  const actions = props.actions ?? [];
  const levels: MenuEntry[] = props.options.map((option) => ({
    id: option.value,
    label: SHARE_ACCESS_WORDS[option.value],
    checked: option.value === props.access,
    ...(option.description ? { description: option.description } : {}),
    ...(option.testId ? { testId: option.testId } : {}),
    onSelect: () => props.onPick(option.value),
  }));
  const items: MenuEntry[] = actions.length > 0 ? [...levels, MENU_SEPARATOR, ...actions] : levels;
  return (
    <Menu
      label={props.label}
      open={open}
      onOpenChange={setOpen}
      width={props.width ?? 224}
      topLayer
      align={props.align ?? "start"}
      items={items}
      trigger={(trigger) => (
        <button
          {...trigger}
          type="button"
          data-testid={props.testId}
          disabled={props.disabled}
          className={ACCESS_TRIGGER}
        >
          {SHARE_ACCESS_WORDS[props.access]}
          <ChevronDown size={12} aria-hidden className="text-subtle" />
        </button>
      )}
    >
      {props.note ? (
        <p className="m-0 mt-1 border-t border-line px-2 pb-1 pt-2 text-[12px] leading-4 text-muted">
          {props.note}
        </p>
      ) : null}
    </Menu>
  );
}

export function ShareAccessLevel(props: { title?: string; children: ReactNode }) {
  return (
    <span title={props.title} className={ACCESS_LEVEL}>
      {props.children}
    </span>
  );
}

export function ShareOptionsMenu(props: {
  label: string;
  items: readonly MenuEntry[];
  testId: string;
  width?: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="-mr-1 flex shrink-0">
      <Menu
        label={props.label}
        testId={props.testId}
        open={open}
        onOpenChange={setOpen}
        topLayer
        items={props.items}
        {...(props.width !== undefined ? { width: props.width } : {})}
        {...(props.disabled ? { disabled: true } : {})}
      />
    </span>
  );
}

const ROW = "flex min-h-10 items-center gap-2";
export const SHARE_ROW_INSET = "pl-9";

// One person in Share's list: who, a second line only for a fact about how
// they came to it, then the row's one control.
export function SharePersonRow(props: { name: string; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className={ROW}>
      <ChatAvatar
        presentation={neutralPresentation}
        name={props.name}
        kind="human"
        size="comment"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="break-all text-[13px] text-ink">{props.name}</span>
        {props.detail ? (
          <span className="text-[12px] leading-4 text-muted">{props.detail}</span>
        ) : null}
      </span>
      {props.children}
    </div>
  );
}

export function ShareLinkRow(props: { children: ReactNode; linkUrlFor?: string; testId?: string }) {
  return (
    <div data-testid={props.testId} data-link-url-for={props.linkUrlFor} className={ROW}>
      <span
        aria-hidden
        className="inline-grid size-7 shrink-0 place-items-center rounded-full border border-dashed border-subtle text-subtle"
      >
        <Link2 size={14} strokeWidth={1.9} />
      </span>
      {props.children}
    </div>
  );
}
