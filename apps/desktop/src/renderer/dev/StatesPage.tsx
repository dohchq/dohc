import { FILE_KIND_RECORDS, type FileDisplayKind } from "@dohc/workspace-contracts/kinds";
import { AlertTriangle, Bot, CheckCircle2, Globe2, MoreHorizontal, SearchX } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { HistoryPolicyUnreadableResult } from "../../ipc/bridgeContract";
import { readError, withErrorWords } from "../../ipc/errorWords";
import { DocumentMenu } from "../DocumentMenu";
import { DocumentControls, OPENING_TITLE, ViewHeader } from "../fileInspectorUi";
import { BlockMenu } from "../editor/blockControls";
import { SlashCommandMenu, type SlashCommandState } from "../editor/slashCommands";
import { buildTableMenu, type TableMenuRow } from "../editor/tableControls";
import { OverlayFrame } from "../Overlay";
import { ColorControl, HueControl, SwitchControl, TextControl } from "../settings/SettingRow";
import { ConfirmDialogCard } from "../ui/ConfirmDialog";
import { CopyButton, CopyField } from "../ui/CopyButton";
import { DangerButton, EmptyState, IconButton, Pill, PrimaryButton, SecondaryButton, SectionLabel } from "../ui/controls";
import { MENU_SEPARATOR, Menu, type MenuEntry } from "../ui/Menu";
import { MoreMenu } from "../ui/MoreMenu";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SkeletonRows } from "../ui/SkeletonRows";
import { SAVE_STATE, StateMark, type SaveStateKey } from "../ui/StateMark";
import { FolderChip, Step } from "../ui/Step";
import { AgentBadge } from "../workbench/AgentBadge";
import { AutomationBadge } from "../workbench/AutomationBadge";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { EditorGroupLayout } from "../workbench/EditorGroupLayout";
import { EditorTabs } from "../workbench/EditorTabs";
import { HistoryHiddenState, HistoryUntrackedState } from "../workbench/HistoryPolicyStates";
import { TreeRow, type VisibleRow } from "../workbench/Explorer";
import { LocalNoticeRow, WorkspaceErrorToast } from "../workbench/NoticeCenter";
import { closeStatesPage } from "./statesRoute";

// Every shared part in every state, light beside dark, on one development
// page. It is the gallery for a person changing a part and the subject of the
// pixel baselines in e2e/states-page.spec.ts. Nothing here is product.
//
// The parts are the real ones, so a change to a part changes the capture.
// Each section is one part, named by `data-part`, and the capture takes one
// baseline per part per theme: a PR that changes one part updates that
// part's pair of PNGs and no other.
//
// A state a part reaches through a prop (selected, active, disabled) is
// passed as that prop. A state the browser owns (hover, focus-visible,
// focus) is marked with `data-force-state`, and the capture forces it on
// that element through the browser's own pseudo-class forcing, so the
// part's own rules apply. `data-force-target` names a descendant when the
// part does not take the attribute itself. A state a part reaches by being
// used (a menu open, a copy acknowledged) is reached that way: the capture
// opens the menu or presses the button. On the page itself, hover and press
// the parts.

const KBD = "rounded border border-line bg-bg px-1 font-mono text-[10px] text-subtle";

// A floating part draws a shadow up to 38px below and 28px beside itself,
// and its whole shadow must stay in its own capture. The toasts get this
// padding; the menus get the same room from their taller boxes.
const SHADOW_ROOM = "p-10";

// A part's pixels depend on where in a pixel it starts, and Chromium lays
// out in 1/64 px, so a section whose content ends on a fraction would move
// every section below it off the pixel grid and change their captures. Each
// section takes the next whole pixel above its content's height; with whole
// gaps and padding around them, every part then starts on one. The content
// is measured, not the section: the section's own height is what is set,
// so measuring it would never let it shrink and would resize inside its own
// observer's callback.
function useWholePixelHeight() {
  const section = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const measured = content.current;
    const sized = section.current;
    if (!measured || !sized) return;
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize[0];
      if (size) sized.style.height = `${Math.ceil(size.blockSize)}px`;
    });
    observer.observe(measured, { box: "border-box" });
    return () => observer.disconnect();
  }, []);
  return { section, content };
}

// A part whose subject is not a menu but which holds one, such as a header
// with its document menu, is captured with its menus closed (`menusAtRest`).
function Section(props: { part: string; title: string; children: ReactNode; menusAtRest?: boolean }) {
  const { section, content } = useWholePixelHeight();
  return (
    <section ref={section} data-part={props.part} data-menus={props.menusAtRest ? "rest" : undefined}>
      <div ref={content} className="flex flex-col gap-3">
        <SectionLabel as="h3" className="m-0">
          {props.title}
        </SectionLabel>
        <div className="flex flex-wrap items-start gap-x-6 gap-y-4">{props.children}</div>
      </div>
    </section>
  );
}

function Specimen(props: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-1.5 ${props.className ?? ""}`}>
      <span className="font-mono text-[10px] text-subtle">{props.label}</span>
      <div className="flex items-center gap-2">{props.children}</div>
    </div>
  );
}

// A side panel's width, as Search, Apps and Chats give their empty states.
function EmptyPanel(props: { children: ReactNode }) {
  return <div className="flex h-44 w-64 flex-col rounded-lg border border-line bg-panel">{props.children}</div>;
}

function Swatch(props: { label: string; className: string }) {
  return (
    <Specimen label={props.label}>
      <span className={`block size-8 rounded-md border border-line ${props.className}`} />
    </Specimen>
  );
}

const noop = () => undefined;

const NO_RECOVERY: ReadonlySet<string> = new Set();

// One group's strip over a strip of paper, as the shell lays a group out.
function EditorGroupSpecimen(props: { groupId: string; groupNumber: number; tabs: string[]; active: string | null }) {
  return (
    <>
      <EditorTabs
        groupId={props.groupId}
        groupNumber={props.groupNumber}
        tabs={props.tabs.map((path) => ({ path }))}
        activeTab={props.active}
        activeTabDirty={false}
        recoveryPaths={NO_RECOVERY}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
        onCloseGroup={noop}
      />
      {/* Tall enough to hold the tab list, which the capture opens, and its
          shadow. */}
      <div className="h-28 bg-bg" />
    </>
  );
}

// A split of two groups where one has tabs and the other none. A strip with
// tabs carries the tab-list menu, and a part opens one menu, so each part
// holds one strip with tabs.
function EditorGroupsSpecimen(props: { activeHasTabs: boolean }) {
  const tabbed = { tabs: ["plan.md", "notes.md"], active: "plan.md" };
  const empty = { tabs: [], active: null };
  const [first, second] = props.activeHasTabs ? [tabbed, empty] : [empty, tabbed];
  return (
    <div className="flex w-[640px] overflow-hidden rounded-lg border border-line">
      <EditorGroupLayout
        groups={[
          { id: "first", size: 1, content: <EditorGroupSpecimen groupId="first" groupNumber={1} {...first} /> },
          { id: "second", size: 1, content: <EditorGroupSpecimen groupId="second" groupNumber={2} {...second} /> },
        ]}
        activeGroupId="first"
        onFocusGroup={noop}
        onResizeGroups={noop}
      />
    </div>
  );
}

function treeRow(name: string, folder = false): VisibleRow {
  return {
    fullPath: name,
    isFolder: folder,
    isExpanded: false,
    depth: 0,
    parentPath: null,
    kind: folder ? null : "file",
    positionInSet: 1,
    setSize: 1,
  };
}

const treeRowCallbacks = {
  registerRef: noop,
  onRowFocus: noop,
  onRowClick: noop,
  onRowChevronClick: noop,
  onRowContextMenu: noop,
  onRowDragStart: noop,
  onRowDragOver: noop,
  onRowDrop: noop,
  onRowDragLeave: noop,
  onRowDragEnd: noop,
};

function Row(props: {
  name: string;
  folder?: boolean;
  selected?: boolean;
  active?: boolean;
  drop?: boolean;
  force?: string;
}) {
  return (
    <div data-force-state={props.force} data-force-target="button">
      <TreeRow
        row={treeRow(props.name, props.folder)}
        collection={false}
        selected={props.selected ?? false}
        active={props.active ?? false}
        tabbable={false}
        dropPreview={props.drop ? { kind: "move", role: "target" } : null}
        {...treeRowCallbacks}
      />
    </div>
  );
}

// A file of every kind in the registry, so each glyph is drawn the way the
// Explorer draws it. A `Record` over the kinds, so a new kind is a compile
// error here until the page shows it.
const KIND_SAMPLES: Record<FileDisplayKind, string> = {
  markdown: "plan.md",
  drawing: "flow.excalidraw",
  csv: "budget.csv",
  json: "package.json",
  text: "notes.txt",
  code: "app.ts",
  image: "photo.png",
  audio: "memo.m4a",
  pdf: "report.pdf",
  database: "ledger.sqlite",
  binary: "archive.bin",
};
const KINDS = Object.values(FILE_KIND_RECORDS);

function KindRows(props: { label: string; selected: boolean }) {
  return (
    <ul role="tree" aria-label={props.label} className="m-0 w-52 list-none rounded-lg border border-line bg-panel py-1">
      {KINDS.map((kind) => (
        <TreeRow
          key={kind.displayKind}
          row={{
            ...treeRow(KIND_SAMPLES[kind.displayKind]),
            kind: kind.displayKind === "database" ? "database" : "file",
          }}
          collection={false}
          selected={props.selected}
          active={false}
          tabbable={false}
          dropPreview={null}
          {...treeRowCallbacks}
        />
      ))}
    </ul>
  );
}

const RELAY_ERROR = "dohc could not reach the sync relay. Check your connection.";
const FOLDER = "C:\\Users\\ice\\Research";

function toast(tone: "danger" | "success") {
  return {
    id: tone,
    message: tone === "success" ? "Moved 4 files to Archived" : RELAY_ERROR,
    details: `Error: ${RELAY_ERROR}`,
    atMs: 0,
    canRetry: tone === "danger",
    seen: false,
    ...(tone === "success" ? { tone } : {}),
  };
}

const PARSER_TEXT = "visibility.toml: TOML parse error at line 3, column 9";
const HIDDEN_HISTORY: HistoryPolicyUnreadableResult = {
  status: "policy-unreadable",
  unreadable: [".dohc/visibility.toml"],
  policyErrors: [PARSER_TEXT],
};
// The toast a refused restore raises, in the words the shell builds for it.
const REFUSED_RESTORE = new Error(
  `Error invoking remote method 'desktop:restore-engine-moment-file': RestorePolicyRefusalError [policy-unreadable]: .dohc/visibility.toml: ${PARSER_TEXT}`,
);
const REFUSED_RESTORE_TOAST = {
  id: "refused-restore",
  message: withErrorWords("dohc could not restore notes/plan.md.", REFUSED_RESTORE),
  details: `Cause: ${readError(REFUSED_RESTORE).cause ?? ""}`,
  atMs: 0,
  canRetry: true,
  seen: false,
};

function notice(id: string, tone: "danger" | "success") {
  return {
    id,
    tone,
    title: tone === "success" ? "Moved 4 files to Archived" : "Sync stopped",
    body: tone === "success" ? "The files are in Archived." : RELAY_ERROR,
    Icon: tone === "success" ? CheckCircle2 : AlertTriangle,
    ...(tone === "danger" ? { actions: [{ label: "Try again", onClick: noop }], copyText: RELAY_ERROR } : {}),
    onDismiss: noop,
  };
}

function DialogSpecimen(props: { theme: "light" | "dark" }) {
  const panelRef = useRef<HTMLDivElement>(null);
  return (
    // `contain: paint` makes this box the containing block of the frame's
    // fixed backdrop, so the dialog sits over these rows and not the window.
    <div className="relative h-72 w-full overflow-hidden rounded-lg border border-line bg-bg [contain:paint]">
      <div className="flex flex-col gap-2 p-4 text-[13px] text-muted">
        <span>Research</span>
        <span>competitors.md</span>
        <span>meeting-2026-07-08.md</span>
      </div>
      <OverlayFrame panelRef={panelRef}>
        <ConfirmDialogCard
          intent="danger"
          title="Delete 12 files from Research?"
          confirmLabel="Delete files"
          onCancel={noop}
          onConfirm={noop}
          testId={`states-dialog-${props.theme}`}
          cancelTestId={`states-dialog-cancel-${props.theme}`}
          confirmTestId={`states-dialog-confirm-${props.theme}`}
        >
          <p className="m-0 mt-2 text-[13px] text-muted">
            They move to the system trash, or this workspace's .dohc/trash if that fails, and you can
            restore them.
          </p>
        </ConfirmDialogCard>
      </OverlayFrame>
    </div>
  );
}

// Two options, so five controls fit on one row of the segmented part.
const themeOptions = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const themeOptionsLightDisabled = [{ ...themeOptions[0]!, disabled: true }, themeOptions[1]!];

const menuItems = [
  { label: "Rename", onSelect: noop },
  { label: "Duplicate", onSelect: noop },
  { label: "Move to…", onSelect: noop },
  { label: "Delete", onSelect: noop, disabled: true },
];

const avatarSizes = ["post", "comment", "strip"] as const;

const SYNC_CODE = "dohc-sync:ws_7f3a:wss://relay.dohc.dev";

function failToCopy(): never {
  throw new Error("nothing to copy");
}

// One row per form: rest, hover, keyboard focus, then the two answers.
function CopySpecimens(props: { theme: "light" | "dark"; form: "icon" | "words" }) {
  const { theme, form } = props;
  const iconOnly = form === "icon";
  return (
    <Specimen label={`${iconOnly ? "icon only" : "with words"}: rest, hover, focus-visible, copied, failed`}>
      <CopyButton iconOnly={iconOnly} label="Copy details" pinName getText={() => RELAY_ERROR} />
      <span data-force-state="hover" data-force-target="button">
        <CopyButton iconOnly={iconOnly} label="Copy details" pinName getText={() => RELAY_ERROR} />
      </span>
      <span data-force-state="focus-visible" data-force-target="button">
        <CopyButton iconOnly={iconOnly} label="Copy details" pinName getText={() => RELAY_ERROR} />
      </span>
      <CopyButton
        iconOnly={iconOnly}
        label="Copy details" pinName
        getText={() => RELAY_ERROR}
        testId={`states-copy-${form}-copied-${theme}`}
      />
      <CopyButton
        iconOnly={iconOnly}
        label="Copy details" pinName
        getText={failToCopy}
        testId={`states-copy-${form}-failed-${theme}`}
      />
    </Specimen>
  );
}

// A shell menu as its owner holds it: the open state here, the rows given.
function MenuSpecimen(props: { label: string; items: readonly MenuEntry[]; width: number; testId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      label={props.label}
      testId={props.testId}
      open={open}
      onOpenChange={setOpen}
      items={props.items}
      width={props.width}
      closeOnPick={false}
    />
  );
}

const versionRows: MenuEntry[] = [
  { id: "main", label: "Main", checked: true, onSelect: noop },
  { id: "draft", label: "Draft two", checked: false, onSelect: noop },
  MENU_SEPARATOR,
];
const radioMenuItems: MenuEntry[] = [
  ...versionRows,
  { id: "try", label: "Try in a version…", icon: <Bot size={14} aria-hidden />, onSelect: noop },
  { id: "compare", label: "Compare with Main", onSelect: noop },
  { id: "merge", label: "Merge into Main…", disabled: true, onSelect: noop },
];
const fieldMenuItems: MenuEntry[] = [
  ...versionRows,
  {
    id: "new",
    field: {
      label: "New version name",
      value: "Draft three",
      onChange: noop,
      onSubmit: noop,
      onCancel: noop,
      hint: "Press Enter to create and start working in it.",
    },
  },
];
const overflowMenuItems: MenuEntry[] = [
  { id: "plan", label: "plan.md", current: true, onSelect: noop },
  { id: "long", label: "quarterly-planning-notes-for-the-whole-team.md", onSelect: noop },
  { id: "notes", label: "notes.md", onSelect: noop },
  { id: "budget", label: "budget.csv", onSelect: noop },
];
const dangerMenuItems: MenuEntry[] = [
  { id: "reveal", label: "Reveal in folder", onSelect: noop },
  { id: "forget", label: "Forget", danger: true, onSelect: noop },
];

// The editor's menus draw themselves at fixed places. Laid out inside a box
// with `contain: layout`, which is the containing block for fixed children,
// they land in their part. The box leaves room for the shadow.
const EDITOR_MENU_BOX = "relative [contain:layout]";

const BLOCK_MENU_OPEN = {
  open: true,
  pos: 0,
  x: 0,
  y: 0,
  maxHeight: 420,
  placement: "below",
  trigger: null,
} as const;

const SLASH_MENU_OPEN: SlashCommandState = {
  open: true,
  from: 1,
  to: 1,
  query: "",
  selected: 2,
  x: 0,
  y: 0,
  bottom: null,
  maxHeight: 260,
  placement: "below",
};

const TABLE_MENU_ROWS: readonly TableMenuRow[] = [
  { label: "Insert column left" },
  { label: "Insert column right" },
  { label: "Align left", separatorBefore: true },
  { label: "Align center" },
  { label: "Align right" },
  { label: "Duplicate column" },
  { label: "Delete column", destructive: true, separatorBefore: true },
];

// The grip menu is built from the DOM, as the table controls build it, with
// its destructive row active.
function TableMenuSpecimen(props: { menuId: string }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const { menu, buttons } = buildTableMenu(element.ownerDocument, TABLE_MENU_ROWS, props.menuId);
    menu.style.left = "0px";
    menu.style.top = "0px";
    const active = buttons.at(-1);
    if (active) {
      active.toggleAttribute("data-active", true);
      menu.setAttribute("aria-activedescendant", active.id);
    }
    element.append(menu);
    return () => menu.remove();
  }, [props.menuId]);
  return <div ref={host} className={`${EDITOR_MENU_BOX} h-[300px] w-[260px]`} />;
}

function Pane(props: { theme: "light" | "dark" }) {
  const { theme } = props;
  return (
    <section
      data-theme={theme}
      data-testid={`states-${theme}`}
      aria-label={`${theme} theme`}
      className="flex min-w-0 flex-col gap-8 bg-bg p-6 text-ink"
    >
      <Section part="surfaces" title="Surfaces and states">
        <Swatch label="bg" className="bg-bg" />
        <Swatch label="panel" className="bg-panel" />
        <Swatch label="panel-2" className="bg-panel-2" />
        <Swatch label="line" className="bg-line" />
        <Swatch label="hover" className="bg-hover" />
        <Swatch label="selected" className="bg-selected" />
        <Swatch label="scrim" className="bg-scrim" />
        <Swatch label="accent" className="bg-accent" />
        <Swatch label="agent" className="bg-agent" />
      </Section>

      <Section part="buttons" title="Buttons">
        <Specimen label="primary: rest, hover, focus-visible, disabled">
          <PrimaryButton>Save</PrimaryButton>
          <PrimaryButton data-force-state="hover">Save</PrimaryButton>
          <PrimaryButton data-force-state="focus-visible">Save</PrimaryButton>
          <PrimaryButton disabled>Save</PrimaryButton>
        </Specimen>
        <Specimen label="primary compact">
          <PrimaryButton size="compact">Save</PrimaryButton>
          <PrimaryButton size="compact" data-force-state="hover">Save</PrimaryButton>
          <PrimaryButton size="compact" data-force-state="focus-visible">Save</PrimaryButton>
          <PrimaryButton size="compact" disabled>Save</PrimaryButton>
        </Specimen>
        <Specimen label="danger: rest, hover, focus-visible, disabled">
          <DangerButton>Delete</DangerButton>
          <DangerButton data-force-state="hover">Delete</DangerButton>
          <DangerButton data-force-state="focus-visible">Delete</DangerButton>
          <DangerButton disabled>Delete</DangerButton>
        </Specimen>
        <Specimen label="danger compact">
          <DangerButton size="compact">Delete</DangerButton>
          <DangerButton size="compact" data-force-state="hover">Delete</DangerButton>
          <DangerButton size="compact" data-force-state="focus-visible">Delete</DangerButton>
          <DangerButton size="compact" disabled>Delete</DangerButton>
        </Specimen>
        <Specimen label="secondary: rest, hover, focus-visible, disabled">
          <SecondaryButton>Cancel</SecondaryButton>
          <SecondaryButton data-force-state="hover">Cancel</SecondaryButton>
          <SecondaryButton data-force-state="focus-visible">Cancel</SecondaryButton>
          <SecondaryButton disabled>Cancel</SecondaryButton>
        </Specimen>
        <Specimen label="secondary compact">
          <SecondaryButton size="compact">Cancel</SecondaryButton>
          <SecondaryButton size="compact" data-force-state="hover">Cancel</SecondaryButton>
          <SecondaryButton size="compact" data-force-state="focus-visible">Cancel</SecondaryButton>
          <SecondaryButton size="compact" disabled>Cancel</SecondaryButton>
        </Specimen>
        <Specimen label="secondary row: rest, hover, aria-disabled">
          <SecondaryButton size="row">Open</SecondaryButton>
          <SecondaryButton size="row" data-force-state="hover">Open</SecondaryButton>
          <SecondaryButton size="row" aria-disabled="true">Open</SecondaryButton>
        </Specimen>
        <Specimen label="icon: rest, hover, focus-visible, disabled">
          <IconButton aria-label="More"><MoreHorizontal size={14} aria-hidden /></IconButton>
          <IconButton aria-label="More" data-force-state="hover"><MoreHorizontal size={14} aria-hidden /></IconButton>
          <IconButton aria-label="More" data-force-state="focus-visible"><MoreHorizontal size={14} aria-hidden /></IconButton>
          <IconButton aria-label="More" disabled><MoreHorizontal size={14} aria-hidden /></IconButton>
        </Specimen>
      </Section>

      {/* The copied and failed ones are pressed by the capture; press them
          yourself on the page. A failed copy here says so in place only:
          the page has no notice owner to report to. */}
      <Section part="copy" title="Copy">
        <CopySpecimens theme={theme} form="icon" />
        <CopySpecimens theme={theme} form="words" />
        <Specimen label="field: rest, copied">
          <div className="w-64">
            <CopyField getText={() => SYNC_CODE}>
              <code title={SYNC_CODE}>{SYNC_CODE}</code>
            </CopyField>
          </div>
          <div className="w-64">
            <CopyField copyTestId={`states-copy-field-copied-${theme}`} getText={() => SYNC_CODE}>
              <code title={SYNC_CODE}>{SYNC_CODE}</code>
            </CopyField>
          </div>
        </Specimen>
      </Section>

      <Section part="segmented" title="Segmented control">
        <Specimen label="rest, hover on first, focus-visible on checked, one option disabled, group disabled">
          <SegmentedControl label="Theme" value="dark" options={themeOptions} onChange={noop} />
          <span data-force-state="hover" data-force-target="[role=radio]">
            <SegmentedControl label="Theme" value="dark" options={themeOptions} onChange={noop} />
          </span>
          <span data-force-state="focus-visible" data-force-target="[aria-checked=true]">
            <SegmentedControl label="Theme" value="dark" options={themeOptions} onChange={noop} />
          </span>
          <SegmentedControl label="Theme" value="dark" options={themeOptionsLightDisabled} onChange={noop} />
          <SegmentedControl label="Theme" value="dark" options={themeOptions} disabled onChange={noop} />
        </Specimen>
      </Section>

      <Section part="switch" title="Switch">
        <Specimen label="on, off, focus-visible, disabled">
          <SwitchControl label="Sync" checked onChange={noop} />
          <SwitchControl label="Sync" checked={false} onChange={noop} />
          <span data-force-state="focus-visible" data-force-target="[role=switch]">
            <SwitchControl label="Sync" checked onChange={noop} />
          </span>
          <SwitchControl label="Sync" checked disabled onChange={noop} />
        </Specimen>
      </Section>

      {/* Every row of the save-state map, keyed by the stored state it
          presents. Settings' idle state draws nothing, so its specimen is
          the empty space where the chip would be. */}
      <Section part="state-mark" title="State mark">
        {(Object.keys(SAVE_STATE) as SaveStateKey[]).map((key) => (
          <Specimen key={key} label={key}>
            <StateMark testId={`states-mark-${key}-${theme}`} state={key} shown={key} />
          </Specimen>
        ))}
        <Specimen label="settings idle">
          <span className="block h-4" />
        </Specimen>
      </Section>

      <Section part="chips" title="Chips">
        <Specimen label="pill: neutral, success, warning, danger, agent">
          <Pill>12</Pill>
          <Pill tone="success">Synced</Pill>
          <Pill tone="warning">Waiting</Pill>
          <Pill tone="danger">2 conflicts</Pill>
          <Pill tone="agent">Agent</Pill>
        </Specimen>
        <Specimen label="kbd">
          <kbd className={KBD}>Ctrl</kbd>
          <kbd className={KBD}>Shift</kbd>
          <kbd className={KBD}>D</kbd>
        </Specimen>
        <Specimen label="section label">
          <SectionLabel>On this computer</SectionLabel>
        </Specimen>
      </Section>

      <Section part="avatars" title="Avatars">
        <Specimen label="human: post, comment, strip">
          {avatarSizes.map((size) => (
            <ChatAvatar key={size} name="Ice de Vera" kind="human" size={size} />
          ))}
        </Specimen>
        <Specimen label="agent: post, comment, strip">
          {avatarSizes.map((size) => (
            <ChatAvatar key={size} name="Agent" kind="agent" size={size} />
          ))}
        </Specimen>
        <Specimen label="automation: post, comment, strip">
          {avatarSizes.map((size) => (
            <ChatAvatar key={size} name="Nightly digest" kind="automation" size={size} />
          ))}
        </Specimen>
      </Section>

      <Section part="badges" title="Badges">
        <Specimen label="agent, automation">
          <span className="text-[13px] font-medium text-ink">Agent</span>
          <AgentBadge testIdPrefix={`states-${theme}`} author={{ authorDisplayName: "Agent", authorOwnerDisplayName: "You" }} />
          <span className="ml-4 text-[13px] font-medium text-ink">Nightly digest</span>
          <AutomationBadge testIdPrefix={`states-${theme}`} author={{ authorDisplayName: "Nightly digest" }} />
        </Specimen>
      </Section>

      <Section part="text-inputs" title="Text inputs">
        <Specimen label="rest">
          <TextControl label="Relay" value="" placeholder="wss://relay.example" onChange={noop} />
        </Specimen>
        <Specimen label="filled">
          <TextControl label="Relay" value="wss://relay.dohc.dev" onChange={noop} />
        </Specimen>
        <Specimen label="focus">
          <span data-force-state="focus" data-force-target="input">
            <TextControl label="Relay" value="wss://relay.dohc.dev" onChange={noop} />
          </span>
        </Specimen>
      </Section>

      <Section part="steps" title="Steps">
        <div className="w-80">
          <Step number={1} title="Sign in on this machine" state="done" summary="ice@example.com" />
          <Step number={2} title="Choose an empty folder on this machine" state="current">
            <FolderChip folder={null} placeholder="Choose a folder" onClick={noop} />
          </Step>
          <Step number={3} title="Enter the code from your other machine" state="pending" last />
        </div>
      </Section>

      <Section part="folder-chip" title="Folder chip">
        <Specimen label="empty">
          <div className="w-64"><FolderChip folder={null} placeholder="Choose a folder" onClick={noop} /></div>
        </Specimen>
        <Specimen label="chosen">
          <div className="w-64"><FolderChip folder={FOLDER} placeholder="Choose a folder" onClick={noop} /></div>
        </Specimen>
        <Specimen label="hover">
          <div className="w-64" data-force-state="hover" data-force-target="button">
            <FolderChip folder={FOLDER} placeholder="Choose a folder" onClick={noop} />
          </div>
        </Specimen>
      </Section>

      <Section part="hue-control" title="Hue control">
        <Specimen label="person, olive chosen">
          <HueControl label="Your color" value="olive" shape="person" onChange={noop} />
        </Specimen>
        <Specimen label="agent, none chosen">
          <HueControl label="Your agent's color" value={null} shape="agent" onChange={noop} />
        </Specimen>
      </Section>

      <Section part="color-control" title="Color control">
        <ColorControl label="Accent" value="#6b7230" onChange={noop} />
      </Section>

      <Section part="list-rows" title="List rows">
        <ul role="tree" aria-label="Rows" className="m-0 w-64 list-none rounded-lg border border-line bg-panel py-1">
          <Row name="rest" folder />
          <Row name="hover" force="hover" />
          <Row name="focused" force="focus-visible" />
          <Row name="selected" selected />
          <Row name="focused, selected" selected force="focus-visible" />
          <Row name="active" active />
          <Row name="focused, hover" force="hover focus-visible" />
          <Row name="drop target" folder drop />
        </ul>
      </Section>

      {/* Both menus are opened by the capture, one at a time, and their
          boxes are tall enough for the open menu and its shadow. A menu's
          first row takes keyboard focus when it opens; forcing focus and
          focus-visible there draws the row as a keyboard user sees it,
          whether or not focus has since moved on. */}
      <Section part="menu" title="Menu">
        <Specimen label="rows: keyboard-active, hover, rest, disabled">
          <div
            className="flex h-56 w-56 items-start justify-end"
            data-force-state="focus focus-visible"
            data-force-target="[role=menuitem]:nth-child(1)"
          >
            <div data-force-state="hover" data-force-target="[role=menuitem]:nth-child(2)">
              <MoreMenu label="More for Research" items={menuItems} testId={`states-menu-${theme}`} />
            </div>
          </div>
        </Specimen>
      </Section>

      <Section part="document-menu" title="Document menu">
        <div
          className="flex h-64 w-56 items-start justify-end"
          data-force-state="focus focus-visible"
          data-force-target="[role=menuitem]:nth-child(1)"
        >
          <DocumentMenu workspaceId="states" suggestedName="states" getMarkdown={() => null} />
        </div>
      </Section>

      <Section part="empty" title="Empty">
        <Specimen label="glyph, line, action in focus">
          <EmptyPanel>
            <EmptyState icon={SearchX} title='No files or chats match "budget".'>
              <SecondaryButton data-force-state="focus-visible">Clear filters</SecondaryButton>
            </EmptyState>
          </EmptyPanel>
        </Specimen>
        <Specimen label="create">
          <EmptyPanel>
            <EmptyState icon={Globe2} title="No apps in this workspace yet.">
              <PrimaryButton>Create app</PrimaryButton>
            </EmptyState>
          </EmptyPanel>
        </Specimen>
        <Specimen label="mark, line, hint">
          <EmptyPanel>
            <EmptyState
              title="No live documents in this workspace."
              hint="Reload after a document starts live editing."
            />
          </EmptyPanel>
        </Specimen>
        <Specimen label="failed">
          <EmptyPanel>
            <EmptyState icon={AlertTriangle} tone="danger" title="Could not load Chats for this file.">
              <SecondaryButton>Try again</SecondaryButton>
            </EmptyState>
          </EmptyPanel>
        </Specimen>
        <Specimen label="a long query wraps">
          <EmptyPanel>
            <EmptyState icon={SearchX} title='No files or chats match "quarterly-revenue-forecast-final-v3".' />
          </EmptyPanel>
        </Specimen>
      </Section>

      <Section part="loading" title="Loading">
        <Specimen label="list">
          <div className="flex h-40 w-64 flex-col rounded-lg border border-line bg-panel">
            <SkeletonRows layout="panel" label="Loading files..." />
          </div>
        </Specimen>
        <Specimen label="editor">
          <div className="flex h-40 w-96 flex-col rounded-lg border border-line bg-bg">
            <SkeletonRows layout="document" label="Loading…" className="pt-12" />
          </div>
        </Specimen>
      </Section>

      <Section part="toasts" title="Toasts">
        <div className={`flex w-full flex-wrap items-start gap-x-6 gap-y-4 ${SHADOW_ROOM}`}>
          <WorkspaceErrorToast error={toast("danger")} onRetry={noop} onHide={noop} />
          <div data-force-state="hover" data-force-target="[data-testid='workspace-shell-error-retry']">
            <WorkspaceErrorToast error={toast("danger")} onRetry={noop} onHide={noop} />
          </div>
          <WorkspaceErrorToast error={toast("success")} onHide={noop} />
        </div>
      </Section>

      <Section part="notices" title="Notices">
        <div className="w-[420px] rounded-lg border border-line bg-panel text-xs text-ink">
          <SectionLabel as="h3" className="m-0 px-3 pb-1 pt-2">
            On this computer
          </SectionLabel>
          <ul className="m-0 list-none p-0" data-force-state="focus-visible" data-force-target="li:nth-child(2)">
            <LocalNoticeRow notice={notice("sync", "danger")} onKeyDown={noop} onAction={noop} onDismiss={noop} />
            <LocalNoticeRow notice={notice("sync-focused", "danger")} onKeyDown={noop} onAction={noop} onDismiss={noop} />
            <LocalNoticeRow notice={notice("moved", "success")} onKeyDown={noop} onAction={noop} onDismiss={noop} />
          </ul>
        </div>
      </Section>

      <Section part="dialog" title="Dialog">
        <DialogSpecimen theme={theme} />
      </Section>

      {/* The shell's menus, one part each, after the dialog so the parts
          above keep their places. */}
      <Section part="menu-radio" title="Menu with radio rows">
        <Specimen label="checked: keyboard-active; unchecked: hover; icon; disabled">
          <div
            className="flex h-64 w-64 items-start justify-end"
            data-force-state="focus focus-visible"
            data-force-target="[role=menuitemradio]:nth-child(1)"
          >
            <div data-force-state="hover" data-force-target="[role=menuitemradio]:nth-child(2)">
              <MenuSpecimen label="Versions" items={radioMenuItems} width={208} testId={`states-menu-radio-${theme}`} />
            </div>
          </div>
        </Specimen>
      </Section>

      <Section part="menu-field" title="Menu with a name field">
        <Specimen label="field: focus, hint">
          <div className="flex h-48 w-72 items-start justify-end" data-force-state="focus" data-force-target="input">
            <MenuSpecimen label="Versions" items={fieldMenuItems} width={240} testId={`states-menu-field-${theme}`} />
          </div>
        </Specimen>
      </Section>

      <Section part="menu-overflow" title="Overflow menu">
        <Specimen label="current; long name: keyboard-active; rest">
          <div
            className="flex h-56 w-72 items-start justify-end"
            data-force-state="focus focus-visible"
            data-force-target="[role=menuitem]:nth-child(2)"
          >
            <MenuSpecimen
              label="Tabs in editor group 1"
              items={overflowMenuItems}
              width={240}
              testId={`states-menu-overflow-${theme}`}
            />
          </div>
        </Specimen>
      </Section>

      <Section part="menu-danger" title="Menu with a destructive row">
        <Specimen label="rest; destructive: keyboard-active">
          <div
            className="flex h-36 w-56 items-start justify-end"
            data-force-state="focus focus-visible"
            data-force-target="[role=menuitem]:nth-child(2)"
          >
            <MenuSpecimen label="More for Research" items={dangerMenuItems} width={176} testId={`states-menu-danger-${theme}`} />
          </div>
        </Specimen>
      </Section>

      {/* After the menus, so the parts above keep their places. The capture
          opens each part's tab list. */}
      <Section part="editor-groups" title="Editor groups">
        <Specimen label="split: the active group with tabs, then an empty one">
          <EditorGroupsSpecimen activeHasTabs />
        </Specimen>
      </Section>

      <Section part="editor-groups-empty" title="Editor groups, empty active group">
        <Specimen label="split: an empty active group, then one with tabs">
          <EditorGroupsSpecimen activeHasTabs={false} />
        </Specimen>
      </Section>

      {/* After the editor groups, so the parts above keep their places. */}
      <Section part="kind-glyph" title="Kind glyph">
        <Specimen label="kind">
          <ul className="m-0 list-none border border-transparent py-1 font-mono text-[11px] text-subtle">
            {KINDS.map((kind) => (
              <li key={kind.displayKind} className="flex h-7 items-center">
                {kind.displayKind} · {kind.name}
              </li>
            ))}
          </ul>
        </Specimen>
        <Specimen label="rest">
          <KindRows label="Kinds" selected={false} />
        </Specimen>
        <Specimen label="selected">
          <KindRows label="Kinds, selected" selected />
        </Specimen>
      </Section>

      {/* The editor's menus, after the shell's so the parts above keep their
          places. Their active row is the one Enter acts on, keyboard or
          pointer, and always draws the outline. */}
      <Section part="block-menu" title="Block menu">
        <Specimen label="sections; first row active; destructive with Del">
          <div className={`${EDITOR_MENU_BOX} h-[410px] w-[270px]`}>
            <BlockMenu state={BLOCK_MENU_OPEN} onSelect={noop} onClose={noop} />
          </div>
        </Specimen>
      </Section>

      <Section part="table-menu" title="Table menu">
        <Specimen label="separators; destructive row active, with Del">
          <TableMenuSpecimen menuId={`states-table-menu-${theme}`} />
        </Specimen>
      </Section>

      {/* Near the end, so a change here moves only the file header below it. */}
      <Section part="history" title="History held back by its rules">
        <Specimen label="panel: rules can't be read">
          <div className="flex h-64 w-64 flex-col rounded-lg border border-line bg-panel">
            <HistoryHiddenState testId={`states-history-hidden-${theme}`} result={HIDDEN_HISTORY} onRetry={noop} />
          </div>
        </Specimen>
        <Specimen label="diff: file no longer tracked">
          <div className="flex h-64 w-96 flex-col rounded-lg border border-line bg-bg">
            <HistoryUntrackedState testId={`states-history-untracked-${theme}`} onRetry={noop} />
          </div>
        </Specimen>
        <Specimen label="restore refused">
          <div className={SHADOW_ROOM}>
            <WorkspaceErrorToast error={REFUSED_RESTORE_TOAST} onRetry={noop} onHide={noop} />
          </div>
        </Specimen>
      </Section>

      {/* After the history part, so the parts above keep their places. */}
      <Section part="file-header" title="File header" menusAtRest>
        {/* One document loading, ready, failed, and ready in a narrow pane:
            Share, the toggle and the menu keep their places, and only the
            save state gives way. No box clips them, so an overflow shows. */}
        <Specimen label="loading" className="w-full">
          <div className="w-full rounded-lg border border-line bg-bg">
            <ViewHeader
              path="trip/plan.md"
              onShare={noop}
              actions={
                <DocumentControls
                  toggle={{ label: "Edit", disabled: true, title: OPENING_TITLE }}
                  menu={{ workspaceId: "states", suggestedName: "plan", getMarkdown: () => null }}
                />
              }
            />
          </div>
        </Specimen>
        <Specimen label="ready" className="w-full">
          <div className="w-full rounded-lg border border-line bg-bg">
            <ViewHeader
              path="trip/plan.md"
              onShare={noop}
              status={<StateMark testId={`states-file-header-state-${theme}`} truncate state="saved" shown="saved" />}
              actions={
                <DocumentControls
                  toggle={{ label: "Source", title: "Toggle markdown source (Ctrl+/)", onClick: noop }}
                  menu={{ workspaceId: "states", suggestedName: "plan", getMarkdown: () => "# Plan" }}
                />
              }
            />
          </div>
        </Specimen>
        <Specimen label="failed" className="w-full">
          <div className="w-full rounded-lg border border-line bg-bg">
            <ViewHeader
              path="trip/plan.md"
              onShare={noop}
              actions={
                <DocumentControls
                  toggle={{ label: "Edit", disabled: true }}
                  menu={{ workspaceId: "states", suggestedName: "plan", getMarkdown: () => null, disabled: true }}
                />
              }
            />
          </div>
        </Specimen>
        <Specimen label="narrow, pending share">
          <div data-testid={`states-file-header-narrow-${theme}`} className="w-[400px] rounded-lg border border-line bg-bg">
            <ViewHeader
              path="trip/plan.md"
              onShare={noop}
              status={
                <StateMark testId={`states-file-header-pending-${theme}`} truncate state="pending-share" shown="pending-share" />
              }
              actions={
                <DocumentControls
                  toggle={{ label: "Source", title: "Toggle markdown source (Ctrl+/)", onClick: noop }}
                  menu={{ workspaceId: "states", suggestedName: "plan", getMarkdown: () => "# Plan" }}
                />
              }
            />
          </div>
        </Specimen>
      </Section>

      {/* The editor's listboxes share these rows, after History so no part
          above them moves. The editor keeps focus, and the option Enter acts
          on draws the outline. The page link and emoji pickers are not here:
          an open picker takes Enter from the whole window, which would take
          it from this page's other parts. */}
      <Section part="slash-menu" title="Slash menu">
        <Specimen label="third option active; the list scrolls">
          <div className={`${EDITOR_MENU_BOX} h-[272px] w-[330px]`}>
            <SlashCommandMenu state={SLASH_MENU_OPEN} onSelect={noop} onHover={noop} />
          </div>
        </Specimen>
      </Section>

      {/* After the file header, so the parts above keep their places. The
          group a keyboard close leaves empty takes focus, and its ring shows
          on all four edges above its tab strip. */}
      <Section part="editor-group-focus" title="Editor group, focused" menusAtRest>
        <Specimen label="split: the focused active group, empty, then one with tabs">
          <div data-force-state="focus focus-visible" data-force-target='[data-editor-group-id="first"]'>
            <EditorGroupsSpecimen activeHasTabs={false} />
          </div>
        </Specimen>
      </Section>
    </section>
  );
}

export function StatesPage() {
  // The light pane has no rule of its own: it reads the document's light
  // tokens. The document is held light while the page is open and given back
  // its theme on close.
  useEffect(() => {
    const previous = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = "light";
    return () => {
      if (previous === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = previous;
    };
  }, []);

  return (
    <div data-testid="states-page" className="flex min-h-full flex-col bg-bg text-ink">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-4">
        <span className="text-sm font-semibold">States</span>
        <span className="text-[11px] text-subtle">Every shared part in every state. Development only.</span>
        <SecondaryButton className="ml-auto" onClick={closeStatesPage}>
          Back to dohc
        </SecondaryButton>
      </header>
      <div className="grid grid-cols-2">
        <Pane theme="light" />
        <Pane theme="dark" />
      </div>
    </div>
  );
}
