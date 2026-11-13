import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ShareAccess } from "../ipc/bridgeContract";
import { Menu } from "./ui/Menu";
import { neutralPresentation } from "./workbench/actorPresentation";
import { ChatAvatar } from "./workbench/ChatAvatar";

// What a share's level lets its holder do, as Share's menus and rows say it.
export const SHARE_ACCESS_WORDS: Record<ShareAccess, string> = {
  view: "Can view",
  comment: "Can comment",
  edit: "Can edit",
};

const ACCESS_TRIGGER =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-hover disabled:text-subtle";

// A share's access, changed the way Docs and Notion change it: from the
// access itself.
export function ShareAccessMenu(props: {
  label: string;
  access: ShareAccess;
  options: ReadonlyArray<{ value: ShareAccess; description?: string; testId?: string }>;
  disabled: boolean;
  testId: string;
  width?: number;
  align?: "start" | "end";
  onPick: (access: ShareAccess) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      label={props.label}
      open={open}
      onOpenChange={setOpen}
      width={props.width ?? 224}
      topLayer
      align={props.align ?? "start"}
      items={props.options.map((option) => ({
        id: option.value,
        label: SHARE_ACCESS_WORDS[option.value],
        checked: option.value === props.access,
        ...(option.description ? { description: option.description } : {}),
        ...(option.testId ? { testId: option.testId } : {}),
        onSelect: () => props.onPick(option.value),
      }))}
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
    />
  );
}

// One person in Share's People list: who, what they can do and how they came
// to it, then the row's own action.
export function SharePersonRow(props: { name: string; detail: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <ChatAvatar presentation={neutralPresentation} name={props.name} kind="human" size="strip" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="break-all text-[13px] text-ink">{props.name}</span>
        <span className="text-[12px] text-subtle">{props.detail}</span>
      </span>
      {props.children}
    </div>
  );
}
