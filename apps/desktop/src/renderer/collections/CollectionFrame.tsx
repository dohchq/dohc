import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { CalendarDays, ChevronDown, Database, Pencil, Plus, Search, SlidersHorizontal, SquareKanban, Table2, Trash2, Zap } from "lucide-react";
import { FieldError, GhostButton, IconButton, PrimaryButton, SecondaryButton } from "../ui/controls";
import { MENU_EDGE_PX, MENU_GAP_PX, Menu, type MenuEntry, type MenuItem } from "../ui/Menu";
import { useDismiss } from "../ui/useDismiss";
import { inputClass, selectClass } from "./FieldForm";

// The page both kinds of Collection draw in: the name and its status, the
// view tabs, the toolbar, and one actions menu. The frame owns the layout and
// the controls. Each page gives it what to show and what each control does,
// and keeps its own records, views and writes.
//
// Open menus and popovers are the frame's own state, so they draw the frame
// again and never the page: the page's children keep their identity.

export type CollectionViewKind = "table" | "board" | "calendar";

const VIEW_KINDS: ReadonlyArray<{ kind: CollectionViewKind; name: string; icon: typeof Table2 }> = [
  { kind: "table", name: "Table", icon: Table2 },
  { kind: "board", name: "Board", icon: SquareKanban },
  { kind: "calendar", name: "Calendar", icon: CalendarDays },
];
const kindOf = (kind: CollectionViewKind) => VIEW_KINDS.find((entry) => entry.kind === kind) ?? VIEW_KINDS[0]!;

export interface CollectionFrameTab {
  id: string;
  name: string;
  kind: CollectionViewKind;
  /** A saved view, which its menu renames, edits or deletes. */
  saved?: boolean;
}

export interface CollectionFrameField {
  id: string;
  name: string;
}

export interface NewCollectionView {
  name: string;
  kind: CollectionViewKind;
  /** The field a board groups by. */
  groupBy?: string;
  /** The date field a calendar places records by. */
  dateField?: string;
}

/** What someone who can save views does with them. Without it, the tabs only switch. */
export interface CollectionFrameViews {
  /** The fields a board can group by. */
  groupFields: readonly CollectionFrameField[];
  /** The fields a calendar can place records by. */
  dateFields: readonly CollectionFrameField[];
  /** Opens the way to add a date field, where this person can add one. */
  onAddDateField?: () => void;
  nameMaxLength?: number;
  /** Saves a new view and opens it. Answers what went wrong as a sentence, or null. */
  create: (view: NewCollectionView) => Promise<string | null>;
  /** Answers what went wrong as a sentence, or null. */
  rename: (id: string, name: string) => Promise<string | null>;
  /** Deletes a view. The page reports a failure, and offers Undo where it has one. */
  remove: (id: string) => void;
  /** Delete asks a second time in the menu, for a page whose deletion has no Undo. */
  confirmDelete: boolean;
  /** Opens the page's editor for a view's search, sort and filters. */
  onEdit?: (id: string) => void;
}

/** The field the open view groups or places records by, which its menu changes. */
export interface CollectionFrameViewField {
  /** What the choice is, such as "Group board by": the menu's name and the control's tooltip. */
  label: string;
  /** The words before the chosen field's name, such as "Group by". */
  prefix: string;
  value: string | undefined;
  options: readonly CollectionFrameField[];
  onChange: (id: string) => void;
  disabled?: boolean;
}

export interface CollectionFrameCommand {
  id: string;
  label: string;
  icon?: ReactNode;
  /** A count after the label, such as the Collection's automations. */
  count?: number;
  onSelect: () => void;
  disabled?: boolean;
  /** Why a disabled command cannot run, on a second line. */
  reason?: string;
  testId?: string;
}

export interface CollectionFrameMenuSection {
  label: string;
  /** A command this person cannot use is left out, as null, false or undefined. */
  commands: ReadonlyArray<CollectionFrameCommand | null | false | undefined>;
}

export interface CollectionFrameAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

export interface CollectionFrameProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  name: string;
  /** How many records, in the page's own true words, such as "7 records" or "50 records on this page". */
  count?: string;
  /** What the page says beside the name: a failed read with its Retry, paused writes, a failed write. */
  status?: ReactNode;
  tabs: readonly CollectionFrameTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  /** Holds the tabs and their controls, as while a form is open. */
  tabsDisabled?: boolean;
  views?: CollectionFrameViews;
  viewField?: CollectionFrameViewField;
  search?: { value: string; onChange: (value: string) => void; onSubmit: () => void; disabled?: boolean };
  /** The page's own buttons, between the search and the Automations button. */
  actions?: readonly CollectionFrameAction[];
  automations?: { open: boolean; count: number; onToggle: () => void };
  newRecord?: { onClick: (opener: HTMLElement) => void; disabled?: boolean };
  /** The actions menu's accessible name and tooltip. */
  menuLabel: string;
  menu: readonly CollectionFrameMenuSection[];
  /** A panel docked at the right of the view, such as automations. */
  panel?: ReactNode;
  children: ReactNode;
}

export function CollectionFrame({
  name, count, status, tabs, activeTabId, onSelectTab, tabsDisabled = false, views, viewField, search, actions, automations, newRecord, menuLabel, menu, panel, children, className, ...rest
}: CollectionFrameProps) {
  return (
    <section
      {...rest}
      data-testid="collection-page"
      aria-label={name}
      className={`flex min-h-0 min-w-0 flex-1 flex-col bg-bg${className ? ` ${className}` : ""}`}
    >
      <header className="flex shrink-0 items-center gap-2 px-5 pt-4">
        <h1 className="m-0 flex min-w-0 items-center gap-2 text-base font-semibold text-ink">
          <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md bg-panel-2 text-muted">
            <Database size={14} strokeWidth={1.9} />
          </span>
          <span className="truncate">{name}</span>
        </h1>
        {count !== undefined ? (
          <span data-testid="collection-record-count" className="shrink-0 font-mono text-[11px] tabular-nums text-subtle">{count}</span>
        ) : null}
        <span className="flex-1" />
        {status}
      </header>
      {/*
        One rule for every width: the toolbar sits at the right of the tabs, and takes a row under them once
        fewer than 192px would be left for the tabs. The tabs take the row's spare room, so they scroll last.
        Each part draws the hairline under itself, so the line is whole on one row and on two.
      */}
      <div className="flex shrink-0 flex-wrap items-stretch pt-2">
        <div className="flex min-w-48 flex-[999_1_0%] items-center gap-1 border-b border-line pl-3">
          <ViewTabs tabs={tabs} activeId={activeTabId} onSelect={onSelectTab} disabled={tabsDisabled} views={views} />
          <span className="flex-1" />
          {viewField && viewField.options.length > 0 ? <ViewFieldControl field={viewField} disabled={tabsDisabled} /> : null}
        </div>
        <div className="flex grow flex-wrap items-center justify-end gap-1 border-b border-line py-1 pl-2 pr-3">
          {search ? <SearchBox search={search} /> : null}
          {actions?.map((action) => (
            <SecondaryButton key={action.id} disabled={action.disabled} onClick={action.onClick} className="inline-flex shrink-0 items-center gap-2">
              {action.icon}
              {action.label}
            </SecondaryButton>
          ))}
          {automations && (automations.count > 0 || automations.open) ? (
            <GhostButton size="toolbar" data-testid="collection-automations-button" aria-pressed={automations.open} onClick={automations.onToggle}>
              <Zap size={14} strokeWidth={1.9} aria-hidden />
              Automations
              {automations.count > 0 ? <span className="text-[12px] tabular-nums text-subtle">{automations.count}</span> : null}
            </GhostButton>
          ) : null}
          <ActionsMenu label={menuLabel} sections={menu} />
          {newRecord ? (
            <PrimaryButton
              data-testid="collection-new-record"
              disabled={newRecord.disabled}
              onClick={(event) => newRecord.onClick(event.currentTarget)}
              className="ml-1 inline-flex shrink-0 items-center gap-2 pl-2"
            >
              <Plus size={14} strokeWidth={1.9} aria-hidden />
              New record
            </PrimaryButton>
          ) : null}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        {panel}
      </div>
    </section>
  );
}

function SearchBox({ search }: { search: NonNullable<CollectionFrameProps["search"]> }) {
  return (
    <form
      role="search"
      className="relative flex shrink-0 items-center"
      onSubmit={(event) => {
        event.preventDefault();
        search.onSubmit();
      }}
    >
      <input
        aria-label="Search collection"
        placeholder="Search records"
        type="search"
        maxLength={200}
        disabled={search.disabled}
        value={search.value}
        onChange={(event) => search.onChange(event.target.value)}
        className={`${inputClass.replace("w-full", "h-8 w-44").replace("px-2.5", "pl-8 pr-2")}`}
      />
      <IconButton type="submit" aria-label="Search" title="Search" disabled={search.disabled} className="absolute left-1">
        <Search size={14} strokeWidth={1.9} aria-hidden />
      </IconButton>
    </form>
  );
}

/** The one menu for everything else: its own open state, so opening it draws nothing else again. */
function ActionsMenu({ label, sections }: { label: string; sections: readonly CollectionFrameMenuSection[] }) {
  const [open, setOpen] = useState(false);
  const items: MenuEntry[] = sections.flatMap((section) => {
    const commands = section.commands.filter((command): command is CollectionFrameCommand => !!command);
    if (commands.length === 0) return [];
    return [{ section: section.label }, ...commands.map((command): MenuItem => ({
      id: command.id,
      label: command.count !== undefined && command.count > 0 ? (
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{command.label}</span>
          <span className="text-[12px] tabular-nums text-subtle">{command.count}</span>
        </span>
      ) : command.label,
      icon: command.icon,
      onSelect: command.onSelect,
      disabled: command.disabled,
      description: command.disabled ? command.reason : undefined,
      testId: command.testId,
    }))];
  });
  if (items.length === 0) return null;
  return <Menu label={label} open={open} onOpenChange={setOpen} width={224} items={items} />;
}

function ViewFieldControl({ field, disabled }: { field: CollectionFrameViewField; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const chosen = field.options.find((option) => option.id === field.value)?.name ?? "Choose a field";
  return (
    <Menu
      label={field.label}
      open={open}
      onOpenChange={setOpen}
      width={192}
      items={field.options.map((option) => ({ id: option.id, label: option.name, checked: option.id === field.value, onSelect: () => field.onChange(option.id) }))}
      trigger={(trigger) => (
        // The two parts read as one name. The tooltip says what the choice is for.
        <GhostButton {...trigger} aria-label={`${field.prefix} ${chosen}`} title={field.label} disabled={disabled || field.disabled} className="shrink-0">
          <span className="text-subtle">{field.prefix}</span>
          <span className="max-w-32 truncate">{chosen}</span>
          <ChevronDown size={12} strokeWidth={1.9} aria-hidden />
        </GhostButton>
      )}
    />
  );
}

type TabMenu = { id: string; at?: { x: number; y: number }; keyboard: boolean };

function ViewTabs(props: {
  tabs: readonly CollectionFrameTab[];
  activeId: string;
  onSelect: (id: string) => void;
  disabled: boolean;
  views?: CollectionFrameViews;
}) {
  const { tabs, activeId, views, disabled } = props;
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const addButton = useRef<HTMLButtonElement | null>(null);
  const renameAnchor = useRef<HTMLButtonElement | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  // Delete asks a second time in the menu. Closing the menu takes the question back.
  const [armed, setArmed] = useState(false);
  // A popover whose change is being saved stays until the answer comes.
  const [held, setHeld] = useState(false);
  const closeMenu = () => {
    setMenu(null);
    setArmed(false);
  };
  // Controls that are held close what they opened.
  useEffect(() => {
    if (!disabled) return;
    setMenu(null);
    setArmed(false);
  }, [disabled]);
  const names = tabs.map((tab) => tab.name);
  const renamed = renaming === null ? undefined : tabs.find((tab) => tab.id === renaming);
  useEffect(() => {
    if (renaming !== null && !renamed) setRenaming(null);
  }, [renaming, renamed]);
  // One tab stop for the strip: the open view's tab. The arrow keys move between tabs.
  const stop = tabs.some((tab) => tab.id === activeId) ? activeId : tabs[0]?.id;

  // A pick closes the menu and puts focus on the tab, so what the pick opens returns focus there.
  const picked = (tab: CollectionFrameTab) => {
    closeMenu();
    tabButtons.current.get(tab.id)?.focus();
  };
  const menuItems = (tab: CollectionFrameTab): MenuItem[] => {
    if (!views || !tab.saved) return [];
    const items: MenuItem[] = [{
      id: "rename", label: "Rename", icon: <Pencil size={14} strokeWidth={1.9} aria-hidden />,
      onSelect: () => {
        renameAnchor.current = tabButtons.current.get(tab.id) ?? null;
        picked(tab);
        setAdding(false);
        setRenaming(tab.id);
      },
    }];
    const onEdit = views.onEdit;
    if (onEdit) items.push({ id: "edit", label: "Edit view…", icon: <SlidersHorizontal size={14} strokeWidth={1.9} aria-hidden />, onSelect: () => { picked(tab); onEdit(tab.id); } });
    items.push({
      id: "delete", label: armed ? "Confirm delete" : "Delete", danger: true, icon: <Trash2 size={14} strokeWidth={1.9} aria-hidden />,
      onSelect: () => {
        if (views.confirmDelete && !armed) { setArmed(true); return; }
        picked(tab);
        views.remove(tab.id);
      },
    });
    return items;
  };
  const menuTab = menu ? tabs.find((tab) => tab.id === menu.id) : undefined;

  function onStripKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const at = tabs.findIndex((tab) => tabButtons.current.get(tab.id) === event.target);
    if (at < 0) return;
    const next = event.key === "ArrowRight" ? (at + 1) % tabs.length : event.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (next >= 0) {
      event.preventDefault();
      tabButtons.current.get(tabs[next]!.id)?.focus();
      return;
    }
    // The keyboard's context menu key opens a tab's menu under it.
    const tab = tabs[at]!;
    if ((event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) && !disabled && menuItems(tab).length > 0) {
      event.preventDefault();
      const box = tabButtons.current.get(tab.id)?.getBoundingClientRect();
      setMenu({ id: tab.id, at: { x: box?.left ?? 0, y: box?.bottom ?? 0 }, keyboard: true });
    }
  }

  return (
    <>
      <div
        role="toolbar"
        aria-label="Views"
        data-testid="collection-view-switcher"
        onKeyDown={onStripKeyDown}
        className="dohc-tab-strip flex min-w-0 items-center self-stretch overflow-x-auto overflow-y-hidden"
      >
        {tabs.map((tab, index) => {
          const Icon = kindOf(tab.kind).icon;
          const active = tab.id === activeId;
          const items = menuItems(tab);
          return (
            // Keyed by place, so a tab whose view is renamed keeps its button, and the focus on it.
            <span key={index} className={`flex h-10 shrink-0 items-center border-b-2 ${active ? "border-ink" : "border-transparent"}`}>
              <button
                ref={(element) => {
                  if (element) tabButtons.current.set(tab.id, element);
                  else tabButtons.current.delete(tab.id);
                }}
                type="button"
                aria-pressed={active}
                tabIndex={tab.id === stop ? 0 : -1}
                disabled={disabled}
                onClick={() => {
                  setRenaming(null);
                  props.onSelect(tab.id);
                }}
                onContextMenu={(event) => {
                  if (disabled || items.length === 0) return;
                  event.preventDefault();
                  setMenu({ id: tab.id, at: { x: event.clientX, y: event.clientY }, keyboard: false });
                }}
                className={`flex h-8 items-center gap-2 rounded-md px-2 text-[13px] font-medium transition-colors duration-75 disabled:text-subtle ${
                  active ? "text-ink" : "text-muted enabled:hover:text-ink"
                }`}
              >
                <Icon size={14} strokeWidth={1.9} aria-hidden className="shrink-0" />
                <span className="max-w-48 truncate">{tab.name}</span>
              </button>
              {active && items.length > 0 ? (
                <Menu
                  label="View actions"
                  open={menu?.id === tab.id && menu.at === undefined}
                  onOpenChange={(open) => (open ? setMenu({ id: tab.id, keyboard: false }) : closeMenu())}
                  closeOnPick={false}
                  align="start"
                  items={items}
                  trigger={(trigger) => (
                    <IconButton {...trigger} aria-label="View actions" title="View actions" disabled={disabled} className="shrink-0">
                      <ChevronDown size={12} strokeWidth={1.9} aria-hidden />
                    </IconButton>
                  )}
                />
              ) : null}
            </span>
          );
        })}
      </div>
      {views ? (
        <IconButton
          ref={addButton}
          aria-label="Add a view"
          title="Add a view"
          aria-haspopup="dialog"
          aria-expanded={adding}
          disabled={disabled}
          className="shrink-0"
          onClick={() => {
            setRenaming(null);
            setAdding((open) => !open);
          }}
        >
          <Plus size={14} strokeWidth={1.9} aria-hidden />
        </IconButton>
      ) : null}
      {/* A right press or the context menu key on any tab opens the same menu at that point. */}
      {menu?.at && menuTab ? (
        <Menu
          key={menu.id}
          label="View actions"
          at={menu.at}
          fromKeyboard={menu.keyboard}
          open
          onOpenChange={(open) => {
            if (!open) closeMenu();
          }}
          closeOnPick={false}
          items={menuItems(menuTab)}
        />
      ) : null}
      {views && adding ? (
        <Popover anchor={addButton} label="Add a view" held={held} onClose={() => setAdding(false)}>
          <AddViewForm views={views} taken={names} onHeld={setHeld} onDone={() => setAdding(false)} />
        </Popover>
      ) : null}
      {views && renamed ? (
        <Popover anchor={renameAnchor} label={`Rename ${renamed.name}`} held={held} onClose={() => setRenaming(null)}>
          <RenameViewForm key={renamed.id} views={views} tab={renamed} taken={names} onHeld={setHeld} onDone={() => setRenaming(null)} />
        </Popover>
      ) : null}
    </>
  );
}

const POPOVER_WIDTH_PX = 272;

/**
 * A panel anchored under the control that opened it, with no scrim. It
 * closes as a menu does: Escape, a press outside, focus leaving, or the
 * anchor again, and focus then returns to the anchor. While `held`, it stays.
 */
function Popover(props: { anchor: RefObject<HTMLElement | null>; label: string; held: boolean; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const held = useRef(props.held);
  held.current = props.held;
  useDismiss({ open: true, container: panel, trigger: props.anchor, onClose: () => { if (!held.current) props.onClose(); } });
  // Placed before the first paint, as a menu is.
  useLayoutEffect(() => {
    const box = props.anchor.current?.getBoundingClientRect();
    if (!box) return;
    const top = box.bottom + MENU_GAP_PX;
    setPlace({
      left: Math.max(MENU_EDGE_PX, Math.min(box.left, window.innerWidth - MENU_EDGE_PX - POPOVER_WIDTH_PX)),
      top,
      maxHeight: Math.max(0, window.innerHeight - top - MENU_EDGE_PX),
    });
  }, [props.anchor]);
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={props.label}
      style={{ width: POPOVER_WIDTH_PX, left: place?.left ?? 0, top: place?.top ?? 0, maxHeight: place?.maxHeight }}
      // One Escape closes one surface: useDismiss closed this one.
      onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
      className={`dohc-popover fixed z-40 overflow-y-auto rounded-xl border border-line bg-panel p-3 ${place ? "dohc-pop-in" : ""}`}
    >
      {props.children}
    </div>
  );
}

const NAME_MISSING = "Give the view a name.";
const nameTaken = (name: string) => `A view named "${name}" already exists. Choose another name.`;
/** A layout's own name, or the first numbered one no view has yet. */
function freeViewName(kind: CollectionViewKind, taken: readonly string[]): string {
  const base = kindOf(kind).name;
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

function useAlive(): RefObject<boolean> {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  return alive;
}

type Problem = { at: "name" | "group" | "date" | "form"; text: string };

function AddViewForm(props: { views: CollectionFrameViews; taken: readonly string[]; onHeld: (held: boolean) => void; onDone: () => void }) {
  const { views, taken } = props;
  const ids = useId();
  const alive = useAlive();
  const [kind, setKind] = useState<CollectionViewKind>("table");
  // Until the person types a name, the box shows the layout's.
  const [typed, setTyped] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState(views.groupFields[0]?.id ?? "");
  const [dateField, setDateField] = useState(views.dateFields[0]?.id ?? "");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState(false);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const tiles = useRef(new Map<CollectionViewKind, HTMLButtonElement>());
  const form = useRef<HTMLFormElement | null>(null);
  const name = typed ?? freeViewName(kind, taken);
  // A date field added while the popover is open is chosen.
  const chosenDate = views.dateFields.some((field) => field.id === dateField) ? dateField : views.dateFields[0]?.id ?? "";
  const chosenGroup = views.groupFields.some((field) => field.id === groupBy) ? groupBy : views.groupFields[0]?.id ?? "";
  useLayoutEffect(() => {
    nameInput.current?.focus();
    nameInput.current?.select();
  }, []);
  // Pressing Create view with something wrong moves focus to it.
  const focusProblem = useRef(false);
  useLayoutEffect(() => {
    if (!focusProblem.current) return;
    focusProblem.current = false;
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-problem]')?.focus();
  }, [problem]);
  function fail(next: Problem) {
    focusProblem.current = true;
    setProblem(next);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const trimmed = name.trim();
    if (trimmed === "") return fail({ at: "name", text: NAME_MISSING });
    if (taken.includes(trimmed)) return fail({ at: "name", text: nameTaken(trimmed) });
    if (kind === "board" && chosenGroup === "") return fail({ at: "group", text: "Choose a field to group by." });
    if (kind === "calendar" && chosenDate === "") return fail({ at: "date", text: "A calendar needs a date field. Add one first." });
    setProblem(null);
    setPending(true);
    props.onHeld(true);
    const failure = await views.create({ name: trimmed, kind, ...(kind === "board" ? { groupBy: chosenGroup } : {}), ...(kind === "calendar" ? { dateField: chosenDate } : {}) });
    props.onHeld(false);
    if (!alive.current) return;
    setPending(false);
    if (failure === null) props.onDone();
    else setProblem({ at: "form", text: failure });
  }
  const errorId = `${ids}-problem`;
  const invalid = (at: Problem["at"]) => (problem?.at === at ? { "aria-invalid": true, "aria-describedby": errorId } as const : {});
  const labelClass = "flex flex-col gap-1 text-[12px] text-muted";
  return (
    <form ref={form} className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      <label className={labelClass}>
        Name
        <input
          ref={nameInput}
          type="text"
          maxLength={views.nameMaxLength}
          disabled={pending}
          value={name}
          onChange={(event) => {
            setTyped(event.target.value);
            if (problem?.at === "name") setProblem(null);
          }}
          {...invalid("name")}
          className={inputClass}
        />
      </label>
      <div className="flex flex-col gap-1 text-[12px] text-muted">
        <span id={`${ids}-layout`}>Layout</span>
        <div
          role="radiogroup"
          aria-labelledby={`${ids}-layout`}
          className="grid grid-cols-3 gap-2"
          onKeyDown={(event) => {
            const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
            if (step === 0) return;
            event.preventDefault();
            const at = VIEW_KINDS.findIndex((entry) => entry.kind === kind);
            const next = VIEW_KINDS[(at + step + VIEW_KINDS.length) % VIEW_KINDS.length]!.kind;
            setKind(next);
            setProblem(null);
            tiles.current.get(next)?.focus();
          }}
        >
          {VIEW_KINDS.map((entry) => (
            <button
              key={entry.kind}
              ref={(element) => {
                if (element) tiles.current.set(entry.kind, element);
                else tiles.current.delete(entry.kind);
              }}
              type="button"
              role="radio"
              aria-checked={kind === entry.kind}
              tabIndex={kind === entry.kind ? 0 : -1}
              disabled={pending}
              onClick={() => {
                setKind(entry.kind);
                setProblem(null);
              }}
              className="flex flex-col items-center gap-1 rounded-lg border border-line px-1 py-2 text-[12px] text-muted transition-colors duration-75 enabled:hover:bg-hover enabled:hover:text-ink disabled:text-subtle aria-checked:border-ink aria-checked:bg-selected aria-checked:text-ink"
            >
              <entry.icon size={18} strokeWidth={1.9} aria-hidden />
              {entry.name}
            </button>
          ))}
        </div>
      </div>
      {kind === "board" ? (
        <label className={labelClass}>
          Group by
          <select disabled={pending} value={chosenGroup} onChange={(event) => { setGroupBy(event.target.value); setProblem(null); }} {...invalid("group")} className={selectClass}>
            {views.groupFields.length === 0 ? <option value="">No field to group by</option> : null}
            {views.groupFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
          </select>
        </label>
      ) : null}
      {kind === "calendar" && views.dateFields.length > 0 ? (
        <label className={labelClass}>
          Date field
          <select disabled={pending} value={chosenDate} onChange={(event) => { setDateField(event.target.value); setProblem(null); }} {...invalid("date")} className={selectClass}>
            {views.dateFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
          </select>
        </label>
      ) : null}
      {kind === "calendar" && views.dateFields.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
          <span>This Collection has no date field.</span>
          {views.onAddDateField ? (
            <SecondaryButton size="row" disabled={pending} {...(problem?.at === "date" ? { "data-problem": "", "aria-describedby": errorId } : {})} onClick={views.onAddDateField}>Add a date field</SecondaryButton>
          ) : null}
        </div>
      ) : null}
      {problem ? <FieldError id={errorId}>{problem.text}</FieldError> : null}
      <div className="flex justify-end">
        <PrimaryButton type="submit" disabled={pending}>{pending ? "Creating…" : "Create view"}</PrimaryButton>
      </div>
    </form>
  );
}

function RenameViewForm(props: { views: CollectionFrameViews; tab: CollectionFrameTab; taken: readonly string[]; onHeld: (held: boolean) => void; onDone: () => void }) {
  const { views, tab } = props;
  const ids = useId();
  const alive = useAlive();
  const [name, setName] = useState(tab.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const trimmed = name.trim();
    if (trimmed === tab.name) return props.onDone();
    const wrong = trimmed === "" ? NAME_MISSING : props.taken.includes(trimmed) ? nameTaken(trimmed) : null;
    if (wrong !== null) {
      setProblem(wrong);
      input.current?.focus();
      return;
    }
    setProblem(null);
    setPending(true);
    props.onHeld(true);
    const failure = await views.rename(tab.id, trimmed);
    props.onHeld(false);
    if (!alive.current) return;
    setPending(false);
    if (failure === null) props.onDone();
    else setProblem(failure);
  }
  const errorId = `${ids}-problem`;
  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      <label className="flex flex-col gap-1 text-[12px] text-muted">
        Name
        <input
          ref={input}
          type="text"
          maxLength={views.nameMaxLength}
          disabled={pending}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setProblem(null);
          }}
          {...(problem !== null ? { "aria-invalid": true, "aria-describedby": errorId } : {})}
          className={inputClass}
        />
      </label>
      {problem !== null ? <FieldError id={errorId}>{problem}</FieldError> : null}
      <div className="flex justify-end">
        <PrimaryButton type="submit" disabled={pending}>{pending ? "Renaming…" : "Rename"}</PrimaryButton>
      </div>
    </form>
  );
}
