import { shortcutKeys } from "../../shortcuts/shortcutRegistry";
import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import { FILE_KIND_RECORDS, type FileDisplayKind } from "@dohc/workspace-contracts/kinds";
import { SAVED_HERE, SAVING, saveProblem, type SaveState } from "@dohc/workspace-contracts/save-state";
import { AlertTriangle, Bot, CheckCircle2, Diff, Globe2, Merge, MessageSquare, MoreHorizontal, Plus, SearchX } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import type {
  ActorPresentation,
  ChannelThreadRecord,
  ChatChannelRecord,
  ChatFileMentionRecord,
  ChatMessageRecord,
  ChatThreadRecord,
  CloudStatusResult,
  DatabaseSnapshotResult,
  EngineMomentRecord,
  HistoryPolicyUnreadableResult,
  SitePackageInfo,
  SyncStatusResult,
  TimelineEntry,
  UsageRecordResult,
  UsageRecordRow,
  WorkspaceFileEntry,
} from "../../ipc/bridgeContract";
import { collectionsElsewhereWords, readError, withErrorWords } from "../../ipc/errorWords";
import { CsvPreviewBound, CsvTable, CsvViewActions, csvColumns } from "../CsvView";
import { DatabaseGrid, DatabaseViewActions, editOf } from "../DatabaseStudioView";
import { DocumentMenu } from "../DocumentMenu";
import { FrontmatterAsWritten } from "../FrontmatterAsWritten";
import { PageIdentity } from "../PageIdentity";
import { PropertiesPanel } from "../PropertiesPanel";
import { TextViewActions } from "../TextEditorView";
import { DocumentControls, OPENING_TITLE, OpeningState, ViewActions } from "../fileInspectorUi";
import { BlockMenu } from "../editor/blockControls";
import { UrlPasteOfferRow } from "../editor/UrlPasteOffer";
import { SlashCommandMenu, type SlashCommandState } from "../editor/slashCommands";
import { buildTableMenu, type TableMenuRow } from "../editor/tableControls";
import { OverlayFrame } from "../Overlay";
import { CollectionUnavailable } from "../TransactionalCollectionPage";
import { CloudSyncSettings, ProtectedFilesRow, type CloudSettings } from "../settings/CloudSyncSettings";
import { KeyboardSettings } from "../settings/KeyboardSettings";
import { ColorControl, HueControl, SettingRow, StepperControl, SwitchControl, TextControl, ThemeControl } from "../settings/SettingRow";
import { PreferredNameControl } from "../settings/PreferredNameControl";
import { SettingsNav } from "../settings/SettingsNav";
import { SETTINGS_SECTIONS } from "../settings/settingsRegistry";
import { UsageRecordCard, UsageRecordClearConfirm, type UsageRecordView } from "../settings/UsageRecordSettings";
import { ConfirmDialogCard } from "../ui/ConfirmDialog";
import { CopyButton, CopyField } from "../ui/CopyButton";
import { DangerButton, EmptyState, IconButton, Pill, PrimaryButton, RetryRow, SecondaryButton, SectionLabel } from "../ui/controls";
import { ObjectGlyph, type ObjectKind } from "../ui/KindGlyph";
import { MENU_FRAME, MENU_SEPARATOR, Menu, type MenuEntry } from "../ui/Menu";
import { MoreMenu } from "../ui/MoreMenu";
import { Ref } from "../ui/Ref";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SkeletonRows } from "../ui/SkeletonRows";
import { SAVE_STATE, StateMark, type SaveStateKey } from "../ui/StateMark";
import { FolderChip, Step } from "../ui/Step";
import { Titlebar } from "../Titlebar";
import { ActivityBar } from "../workbench/ActivityBar";
import { AgentBadge } from "../workbench/AgentBadge";
import { AgentColorContext, AgentColorSwatches } from "../workbench/AgentColorPicker";
import { AppRows } from "../workbench/AppsView";
import { chatTabPath, collectionTabPath, HISTORY_TAB_PATH, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, siteTabPath, VIEW_IDS } from "../workbench/workbenchState";
import { AutomationBadge } from "../workbench/AutomationBadge";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { neutralPresentation, relayPresentation } from "../workbench/actorPresentation";
import { ThreadMessages } from "../workbench/ChatPosts";
import { ChatComposer, ChatMessageList, type ChatReactionControls } from "../workbench/chatMessages";
import { ComposerModeBar } from "../workbench/ChatsControls";
import { ComposerCatalogOptions, MentionComposer } from "../workbench/MentionComposer";
import type { AgentAddressedOffer, AgentOfferState } from "../offers/agentAddressed";
import { PostCard, type PostData } from "../workbench/PostCard";
import { EditorGroupLayout } from "../workbench/EditorGroupLayout";
import { EditorTabs } from "../workbench/EditorTabs";
import { EditorGroupFrame } from "../workbench/tabRowActions";
import { HistoryHiddenState, HistoryUntrackedState, historyHiddenWords } from "../workbench/HistoryPolicyStates";
import { CollectionsElsewhereRow, CollectionsRefusalRow, TreeRow, type VisibleRow } from "../workbench/Explorer";
import { LocalNoticeRow, WorkspaceErrorToast } from "../workbench/NoticeCenter";
import { EngineHistoryView, MomentRow } from "../workbench/EngineHistory";
import { DiffCounts, UnifiedDiffLines, buildUnifiedDiffLines, computeTextDiff } from "../workbench/unifiedDiff";
import {
  AboutAccessView,
  AboutChatRow,
  AboutHeader,
  AboutHistoryView,
  AboutLinksView,
  AboutSection,
  type AccessReason,
  type AccessSetup,
  type AccessView,
  type ChatLinksView,
  type LinksView,
} from "../workbench/About";
import type { AboutConversation } from "../workbench/aboutConversation";
import { AboutConversationLinksView, type ConversationLinksView, type MentionedFile } from "../workbench/AboutConversationPanel";
import type { PresencePeer } from "../collab/presenceChannel";
import { SharingPanel, type ShareMount, type SharingActions, type SkipView } from "../workbench/SharingView";
import { CAPTURE_RECOVERY_TITLE, captureRecoveryMessage } from "../shell/useCaptureRecoveryNotices";
import { DismissConfirm, RecoveryList } from "../RecoveryList";
import type { OrphanedDraftRow } from "../orphanedDrafts";
import { WorkspaceSyncStatus } from "../workbench/WorkspaceSyncStatus";
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

// Specimens ignore this installation and live account colour choices.
const SAMPLE_ADA: ActorPresentation = { group: "states-ada", hue: "teal", self: false };
const SAM_PALETTE_SLOT = 1;
const SAMPLE_SAM: ActorPresentation = { ...relayPresentation(SAM_PALETTE_SLOT), group: "states-sam" };
const SAMPLE_NOVA: ActorPresentation = { group: "states-nova", hue: null, self: false };
const SAMPLE_ORBIT: ActorPresentation = { group: "states-orbit", hue: "plum", self: false };

const KBD = "rounded border border-line bg-bg px-1 font-mono text-[10px] text-subtle";

// A floating part draws a shadow up to 41px below and 31px beside itself in
// the dark theme, and its whole shadow must stay in its own capture, which
// takes 16px around its part. So a part needs at least 25px of its own room
// below a floating box and 15px beside it. The toasts get this 40px padding;
// the shell's menus get the room from their taller boxes, and the editor's
// menus from EDITOR_MENU_BOX's margin and their boxes' heights.
const SHADOW_ROOM = "p-10";

// The parts the page renders, when it renders only some.
const ShownParts = createContext<ReadonlySet<string> | undefined>(undefined);

// A part whose subject is not a menu but which holds one, such as a header
// with its document menu, is captured with its menus closed (`menusAtRest`).
function Section(props: { part: string; title: string; children: ReactNode; menusAtRest?: boolean }) {
  const shown = useContext(ShownParts);
  if (shown && !shown.has(props.part)) return null;
  return (
    <section data-part={props.part} data-menus={props.menusAtRest ? "rest" : undefined} className="flex flex-col gap-3">
      <SectionLabel as="h3" className="m-0">
        {props.title}
      </SectionLabel>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">{props.children}</div>
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

// A URL pasted on its own line, on a strip of paper, with the offer's row
// where the editor floats it: under the line. A pasted URL is already a link,
// so Link is pressed before a choice. Only Plain text changes it: the URL is
// then plain text and the row offers Undo.
function UrlOfferSpecimen(props: { force?: string; chosen?: boolean }) {
  return (
    <div className="w-[420px] rounded-lg border border-line bg-bg px-4 pb-10 pt-3 text-[15px] text-ink">
      <p className={`m-0 ${props.chosen ? "" : "underline"}`}>https://example.com/trip/itinerary</p>
      <div
        className="mt-1"
        data-force-state={props.force ? "focus-visible" : undefined}
        data-force-target={props.force ? `[data-testid="${props.force}"]` : undefined}
      >
        <UrlPasteOfferRow form={props.chosen ? "plain" : "link"} chosen={props.chosen ?? false} />
      </div>
    </div>
  );
}

// One group's tab row carrying an open document's actions, as the shell lays
// it out, over a strip of paper.
function TabRowActionsSpecimen(props: { width: string; testId?: string; path?: string; children: ReactNode }) {
  const path = props.path ?? "trip/plan.md";
  return (
    <div data-testid={props.testId} className={`${props.width} rounded-lg border border-line`}>
      <EditorGroupFrame
        tabs={(actionsRef) => (
          <EditorTabs
            actionsRef={actionsRef}
            groupId="states"
            groupNumber={1}
            tabs={[{ path }]}
            activeTab={path}
            activeTabDirty={false}
            recoveryPaths={NO_RECOVERY}
            onActivate={noop}
            onClose={noop}
            onContextMenu={noop}
            onMove={noop}
            onMoveToGroup={noop}
            onCreateGroupRight={noop}
          />
        )}
      >
        {props.children}
        <div className="h-4 rounded-b-lg bg-bg" />
      </EditorGroupFrame>
    </div>
  );
}

// Two groups side by side, each with one file open and that file's actions
// in its own tab row.
function FileViewSplitSpecimen(props: { left: { path: string; actions: ReactNode }; right: { path: string; actions: ReactNode } }) {
  const group = (id: string, groupNumber: number, file: { path: string; actions: ReactNode }) => ({
    id,
    size: 1,
    content: (
      <EditorGroupFrame
        tabs={(actionsRef) => (
          <EditorTabs
            actionsRef={actionsRef}
            groupId={id}
            groupNumber={groupNumber}
            tabs={[{ path: file.path }]}
            activeTab={file.path}
            activeTabDirty={false}
            recoveryPaths={NO_RECOVERY}
            onActivate={noop}
            onClose={noop}
            onContextMenu={noop}
            onMove={noop}
            onMoveToGroup={noop}
            onCreateGroupRight={noop}
          />
        )}
      >
        {file.actions}
        <div className="h-4 bg-bg" />
      </EditorGroupFrame>
    ),
  });
  return (
    <div className="flex w-full overflow-hidden rounded-lg border border-line">
      <EditorGroupLayout
        groups={[group("left", 1, props.left), group("right", 2, props.right)]}
        activeGroupId="left"
        onFocusGroup={noop}
        onResizeGroups={noop}
      />
    </div>
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

// More tabs than a narrow strip holds.
const OVERFLOW_TABS = ["itinerary.md", "budget.csv", "packing-list.md", "flights.md", "restaurants.md", "notes.md"].map(
  (path) => ({ path }),
);

// One group's overflowing strip over a strip of paper. The strip scrolls
// itself to reveal its active tab when it mounts.
function OverflowStripSpecimen(props: { groupId: string; groupNumber: number; active: string; testId?: string }) {
  return (
    <div data-testid={props.testId}>
      <EditorTabs
        groupId={props.groupId}
        groupNumber={props.groupNumber}
        tabs={OVERFLOW_TABS}
        activeTab={props.active}
        activeTabDirty={false}
        recoveryPaths={NO_RECOVERY}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
      />
      <div className="h-6 bg-bg" />
    </div>
  );
}

// The sidebar's Collections section, at a width the sidebar takes.
function CollectionsSectionSpecimen(props: { width: number; children: ReactNode }) {
  return (
    <div style={{ width: props.width }} className="rounded-lg border border-line bg-panel px-1 py-1">
      <SectionLabel as="div" className="px-2 py-1">Collections</SectionLabel>
      {props.children}
    </div>
  );
}

const STUDIO_MAC = { label: "Studio Mac", sameName: false };
const UNCLAIMED_REFUSAL = { kind: "unclaimed", words: "dohc doesn't know which computer keeps this workspace's Collections." } as const;
const ELSEWHERE_REFUSAL = { kind: "elsewhere", computer: STUDIO_MAC.label, words: collectionsElsewhereWords(STUDIO_MAC) } as const;
const OTHERS_ELSEWHERE = { computer: STUDIO_MAC.label, others: true, words: collectionsElsewhereWords(STUDIO_MAC, true) };

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
  app?: boolean;
  selected?: boolean;
  active?: boolean;
  drop?: boolean;
  force?: string;
}) {
  return (
    <div data-force-state={props.force} data-force-target="button">
      <TreeRow
        row={treeRow(props.name, props.folder || props.app)}
        collection={false}
        app={props.app ?? false}
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
          app={false}
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

// Every object that is not a file, by the name its tab shows, each glyph in
// a row the way a list draws it. A `Record` over the kinds, so a new kind is
// a compile error here until the page shows it.
const OBJECT_SAMPLES: Record<ObjectKind, string> = {
  app: "trip-planner",
  collection: "Registrations",
  group: "trip",
  chat: "Home",
  compare: "Compare with Main",
  change: "Diff: plan.md",
  graph: "Graph",
  history: "History",
};
const OBJECTS = Object.keys(OBJECT_SAMPLES) as ObjectKind[];
// The kind and object name columns share one width, wider than the longest
// name, so the rows beside each start at the same place on both lines.
const KIND_NAMES = "m-0 w-36 list-none border border-transparent py-1 font-mono text-[11px] text-subtle";

function ObjectRows(props: { label: string; selected: boolean }) {
  return (
    <ul aria-label={props.label} className="m-0 w-52 list-none rounded-lg border border-line bg-panel py-1">
      {OBJECTS.map((kind) => (
        <li key={kind} className="px-1">
          <span
            className={`flex h-7 items-center gap-1.5 rounded-md pl-7 pr-2 text-[13px] ${
              props.selected ? "bg-selected text-ink" : "text-muted"
            }`}
          >
            <ObjectGlyph kind={kind} size={15} className={props.selected ? "text-ink" : "text-subtle"} />
            <span className="min-w-0 flex-1 truncate">{OBJECT_SAMPLES[kind]}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// Tabs of every kind, as the listing describes their files: a database by
// its header, whatever its name, and a page with an emoji.
const STRIP_GROUP = chatTabPath({ kind: "channel", id: "trip" });
const STRIP_COLLECTION = collectionTabPath("registrations");
const STRIP_LONG = "notes/offsite-retrospective-and-next-quarter-planning.md";
const STRIP_FILES: ReadonlyMap<string, WorkspaceFileEntry> = new Map(
  [
    { path: "trip/plan.md", kind: "file" as const },
    { path: "budget.csv", kind: "file" as const },
    { path: "map.excalidraw", kind: "file" as const },
    { path: "ledger.db", kind: "database" as const },
    { path: "launch.md", kind: "file" as const, icon: "🚀" },
    { path: STRIP_LONG, kind: "file" as const },
  ].map((entry) => [entry.path, entry]),
);
const STRIP_LABELS: ReadonlyMap<string, string> = new Map([[STRIP_GROUP, "trip"]]);

// One group's strip over a strip of paper, its tab list at rest.
function GlyphStrip(props: { groupId: string; groupNumber: number; tabs: string[]; active: string; dirty?: boolean }) {
  return (
    <>
      <EditorTabs
        groupId={props.groupId}
        groupNumber={props.groupNumber}
        tabs={props.tabs.map((path) => ({ path }))}
        activeTab={props.active}
        activeTabDirty={props.dirty ?? false}
        tabLabels={STRIP_LABELS}
        files={STRIP_FILES}
        recoveryPaths={NO_RECOVERY}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
      />
      <div className="h-4 bg-bg" />
    </>
  );
}

function GlyphStripBox(props: { tabs: string[]; active: string; dirty?: boolean }) {
  return (
    <div className="w-full overflow-hidden rounded-lg border border-line">
      <GlyphStrip groupId="states" groupNumber={1} {...props} />
    </div>
  );
}

const RELAY_ERROR ="dohc could not reach the sync relay. Check your connection.";
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

// Typing capture kept when its file changed outside dohc: the toast and the
// rows the shell builds for it, and its change in History. The time is
// local, so the row reads the same in every time zone.
const RECOVERY_PATH = "trip/plan.md";
const RECOVERY_DETAILS = `Notice: ${captureRecoveryMessage(RECOVERY_PATH, false)}\nTitle: ${CAPTURE_RECOVERY_TITLE}\nFile: ${RECOVERY_PATH}`;
const RECOVERY_TOAST = {
  id: "capture-recovery",
  tone: "warning" as const,
  title: CAPTURE_RECOVERY_TITLE,
  message: captureRecoveryMessage(RECOVERY_PATH, false),
  details: RECOVERY_DETAILS,
  atMs: 0,
  canRetry: false,
  actionLabel: "Open History",
  seen: false,
};
function recoveryNotice(id: string, shared: boolean) {
  return {
    id,
    tone: "warning" as const,
    title: CAPTURE_RECOVERY_TITLE,
    body: captureRecoveryMessage(RECOVERY_PATH, shared),
    Icon: AlertTriangle,
    actions: [{ label: "Open History", onClick: noop }],
    copyText: RECOVERY_DETAILS,
    copyLabel: "Copy notice details",
    onDismiss: noop,
  };
}
// Set-aside edits with their workspace's name: one that survives a restart,
// and one that lives only in this window.
const SET_ASIDE_ROWS: OrphanedDraftRow[] = [
  { workspaceId: "states", workspaceLabel: "Trip planning", path: RECOVERY_PATH, persisted: true, draft: { id: 1, text: "# Plan\n", capturedAtMs: 0 } },
  { workspaceId: "states", workspaceLabel: "Trip planning", path: "trip/.env", persisted: false, draft: { id: 2, text: "KEY=1\n", capturedAtMs: 0 } },
];
const RECOVERY_MOMENT: EngineMomentRecord = {
  id: "moment-capture-recovery",
  versionId: "main",
  path: RECOVERY_PATH,
  recordedAtMs: new Date(2026, 6, 8, 9, 41).getTime(),
  operation: "write",
  origin: "capture-recovery",
  momentOrder: 7,
};

// One History timeline across two days: a file change, a version starting,
// a labelled record change by an automation, a rules change an agent
// approved that main could not date, the workspace starting, and an
// unlabelled record change with no date or place. Only a rules change can
// carry its approving agent. Local times, as above.
const TIMELINE_BUDGET = "00000000-0000-4000-8000-0000000000b1";
const TIMELINE_GUESTS = "00000000-0000-4000-8000-0000000000b2";
const TIMELINE_FILE: TimelineEntry = { kind: "file", moment: {
  id: "moment-timeline-plan", versionId: "main", path: "trip/plan.md", recordedAtMs: new Date(2026, 6, 8, 10, 12).getTime(),
  operation: "write", origin: "local-file", momentOrder: 9, summary: "Added the ferry times",
} };
function timelineVersion(id: string, kind: "main" | "named", name: string, createdAtMs: number): TimelineEntry {
  return { kind: "version", version: { id, workspaceId: "states", kind, name, createdAtMs } };
}
function timelineChange(datasetId: string, name: string, revision: number, recordedAtMs: number | null, sortAtMs: number | null,
  by?: { automation?: string; rulesApprovedBy?: string }): TimelineEntry {
  const rules = by?.rulesApprovedBy;
  return { kind: "collection", datasetId, name, sortAtMs, change: {
    revision, operation: rules ? "Fields and rules" : "addGuest", callerReference: null, recordedAtMs, approvedRevisionHash: "a".repeat(64),
    changesetBytes: rules ? 0 : 120, attachmentCount: 0,
    ...(by?.automation ? { automation: { automationId: `automations.yaml#${by.automation}`, depth: 1, name: by.automation } } : {}),
    ...(rules ? {
      approvalAgent: { kind: "agent" as const, label: rules, labelSource: "agent-declared" as const },
      schema: { previousRevisionHash: "b".repeat(64), revisionHash: "a".repeat(64) },
    } : {}),
  } };
}
const TIMELINE_DATED = timelineChange(TIMELINE_BUDGET, "Budget", 12, new Date(2026, 6, 8, 9, 44).getTime(), new Date(2026, 6, 8, 9, 44).getTime(), { automation: "Stamp the date" });
const TIMELINE_MIXED: TimelineEntry[] = [
  TIMELINE_FILE,
  timelineVersion("version-draft", "named", "Draft itinerary", new Date(2026, 6, 8, 9, 58).getTime()),
  TIMELINE_DATED,
  timelineChange(TIMELINE_GUESTS, "Guests", 3, null, new Date(2026, 6, 8, 9, 30).getTime(), { rulesApprovedBy: "trip-agent" }),
  timelineVersion("main", "main", "Main", new Date(2026, 6, 7, 18, 0).getTime()),
  timelineChange(TIMELINE_GUESTS, "Guests", 1, null, null),
];
// One afternoon in History, one line per change: Nova's three edits to one
// file fold into one row, a person's edit shows their face, and the machine's
// show their origin. Local times, as above.
const storyAt = (hour: number, minute: number) => new Date(2026, 6, 8, hour, minute).getTime();
function storyMoment(id: string, recordedAtMs: number, fields: Partial<EngineMomentRecord> = {}): EngineMomentRecord {
  return { id, versionId: "main", path: "notes/product-plan.md", recordedAtMs, operation: "write", origin: "ydoc", momentOrder: 0, ...fields };
}
const novaEdit = (id: string, recordedAtMs: number) => storyMoment(id, recordedAtMs, {
  agentAuthorName: "Nova", authors: [{ kind: "agent", agentId: "nova", agentRunId: "run-nova", onBehalfOf: "ice" }],
  authorPresentations: [{ group: "states-nova", hue: null, self: false }],
});
const STORY_RUN = [novaEdit("story-nova-3", storyAt(14, 51)), novaEdit("story-nova-2", storyAt(14, 47)), novaEdit("story-nova-1", storyAt(14, 44))];
const TIMELINE_STORY: TimelineEntry[] = [
  ...STORY_RUN,
  storyMoment("story-sam", storyAt(14, 40), { path: "research/competitors.md", origin: "sync", namedAuthor: { userId: "sam", label: "Sam Rivera" },
    authors: [{ kind: "named", userId: "sam", grantId: "grant-sam", grantGeneration: 1 }], authorPresentations: [SAMPLE_SAM] }),
  storyMoment("story-local", storyAt(14, 31), { path: "data/funnel.csv", origin: "local-file" }),
  storyMoment("story-restore", storyAt(14, 12), { origin: "restore", summary: "Restored notes/product-plan.md" }),
  storyMoment("story-env", storyAt(13, 20), { path: ".env", origin: "local-file", protected: true }),
  storyMoment("story-unknown", storyAt(12, 58), { origin: "unknown" }),
].map((moment) => ({ kind: "file", moment }));

// Budget's definition labels its operation; Guests' is not loaded here.
const TIMELINE_COLLECTIONS = new Map([
  [TIMELINE_BUDGET, { name: "Budget", operationLabels: new Map([["addGuest", "Add guest"]]), openHistory: noop }],
  [TIMELINE_GUESTS, { name: "Guests" }],
]);

// The About tab on the drawing's document: who wrote what, who has it.
const ABOUT_PATH = "notes/product-plan.md";
const ABOUT_THREADS: ChatThreadRecord[] = [
  { id: "thread-scope", title: "Launch scope", createdAtMs: new Date(2026, 6, 6, 14, 5).getTime(), updatedAtMs: new Date(2026, 6, 8, 9, 12).getTime() },
  { id: "thread-pricing", title: "Pricing questions", createdAtMs: new Date(2026, 6, 2, 11, 0).getTime(), updatedAtMs: new Date(2026, 6, 7, 16, 40).getTime() },
];
const aboutMoment = (moment: Partial<EngineMomentRecord> & { id: string; recordedAtMs: number; momentOrder: number }): EngineMomentRecord => ({
  versionId: "main",
  path: ABOUT_PATH,
  operation: "write",
  origin: "ydoc",
  ...moment,
});
const ABOUT_MOMENTS: EngineMomentRecord[] = [
  aboutMoment({ id: "about-agent", recordedAtMs: new Date(2026, 6, 8, 9, 30).getTime(), momentOrder: 9, agentAuthorName: "Nova", summary: "Tightened the launch list",
    authors: [{ kind: "agent", agentId: "nova", agentRunId: "run-nova", onBehalfOf: "ice" }],
    authorPresentations: [{ group: "states-nova", hue: null, self: false }] }),
  aboutMoment({ id: "about-person", recordedAtMs: new Date(2026, 6, 8, 8, 55).getTime(), momentOrder: 8, namedAuthor: { userId: "sam", label: "Sam Rivera" },
    authors: [{ kind: "named", userId: "sam", grantId: "grant-sam", grantGeneration: 1 }], authorPresentations: [SAMPLE_SAM] }),
  aboutMoment({ id: "about-local", recordedAtMs: new Date(2026, 6, 7, 17, 20).getTime(), momentOrder: 6, origin: "local-file" }),
];
const aboutGrant = (grant: Partial<AccessShareRow> & { grantId: string }): AccessShareRow => ({
  kind: "share",
  shareId: "share-plan",
  via: "named",
  granterUserId: "ice",
  granterEmail: "ice@example.com",
  recipientUserId: null,
  recipientEmail: null,
  subjectName: null,
  sharerName: null,
  selector: { paths: ["notes"], versionId: null },
  access: "edit",
  status: "active",
  generation: 1,
  ...grant,
});
const ABOUT_ACCESS: AccessAnswer = {
  ref: { kind: "path", path: ABOUT_PATH, versionId: null },
  rows: [
    aboutGrant({ grantId: "grant-sam", recipientUserId: "sam", recipientEmail: "sam@example.com" }),
    aboutGrant({ grantId: "grant-link", via: "link", access: "view" }),
    aboutGrant({ grantId: "grant-kim", recipientUserId: "kim", recipientEmail: "kim@example.com", status: "revoked", access: null }),
  ],
  visibility: "visible",
  unknownReason: null, coverage: { kind: "granted", complete: true, observation: "interval" },
  checkedAtMs: new Date(2026, 6, 8, 9, 40).getTime(),
  freshness: "fresh",
  nextCursor: null,
};
const ABOUT_ACCESS_UNKNOWN: AccessAnswer = {
  ...ABOUT_ACCESS,
  rows: [],
  unknownReason: "not-listed-yet", coverage: { kind: "unavailable", complete: false, observation: "interval" },
  checkedAtMs: null,
  freshness: "unknown",
};

// About for the drawing's #general: Sam and Nova here, and the Group's grants.
const aboutPeer = (faceToken: string, displayName: string, paletteSlot: number): PresencePeer => ({
  faceToken, sessionToken: `${faceToken}-session`, isSelf: false, displayName, paletteSlot, state: null, updatedAtMs: 0,
});
const ABOUT_PRESENT = [aboutPeer("face-sam", "Sam Rivera", SAM_PALETTE_SLOT), aboutPeer("face-nova", "Nova", 4)];
const ABOUT_GROUP: AboutConversation = {
  kind: "group", name: "general", channelWireId: "wire-general", received: false, present: ABOUT_PRESENT,
};
const ABOUT_CHAT_ACCESS: AccessAnswer = {
  ...ABOUT_ACCESS,
  ref: { kind: "chat", channelWireId: "wire-general" },
  rows: [
    aboutGrant({ shareId: "share-general", grantId: "grant-sam", recipientUserId: "sam", recipientEmail: "sam@example.com",
      selector: { kind: "chat", channelWireId: "wire-general" }, access: "read-write" }),
    aboutGrant({ shareId: "share-general", grantId: "grant-kim", recipientUserId: "kim", recipientEmail: "kim@example.com",
      selector: { kind: "chat", channelWireId: "wire-general" }, access: "read-only" }),
  ],
};
// The files #general mentions: the funnel by Nova, the landscape by Sam, and
// the plan by both.
const mentionedBy = (displayName: string, presentation: ActorPresentation, kind: "human" | "agent" = "human") =>
  ({ kind, displayName, presentation });
const ABOUT_MENTIONED: MentionedFile[] = [
  { objectId: "states-funnel", path: "data/funnel.csv", authors: [mentionedBy("Nova", SAMPLE_NOVA, "agent")] },
  { objectId: "states-competitors", path: "research/competitors.md", authors: [mentionedBy("Sam Rivera", SAMPLE_SAM)] },
  { objectId: "states-plan", path: ABOUT_PATH, authors: [mentionedBy("Sam Rivera", SAMPLE_SAM), mentionedBy("Nova", SAMPLE_NOVA, "agent")] },
];
const ABOUT_MENTIONS: Extract<ConversationLinksView, { status: "ready" }> = {
  status: "ready", files: ABOUT_MENTIONED, more: false, building: false, partial: false,
};
function ConversationLinks(props: { view: ConversationLinksView }) {
  return <AboutConversationLinksView view={props.view} expanded onToggle={noop} onOpenFile={noop} onMore={noop} onRetry={noop} />;
}

// A group's feed and a thread, from the drawing's #general.
const CHAT_AT = new Date(2026, 6, 8, 14, 43).getTime();
const CHAT_REACTIONS: ChatReactionControls = { reactions: [], viewerAuthorId: "you", onToggle: noop };
const CHAT_CHANNEL: ChatChannelRecord = {
  id: "general", name: "general", slug: "general", kind: "channel", type: "posts",
  createdAtMs: CHAT_AT, updatedAtMs: CHAT_AT, threadCount: 3, unreadCount: 0,
};
const chatPost = (
  id: string,
  author: { authorKind: "human" | "agent"; authorDisplayName: string; presentation: ActorPresentation },
  title: string,
  bodySnippet: string,
  counts: Partial<Pick<ChannelThreadRecord, "messageCount" | "unreadCount" | "openDecisionCount">> = {},
): { thread: ChannelThreadRecord; data: PostData } => ({
  thread: {
    id, title, createdAtMs: CHAT_AT, updatedAtMs: CHAT_AT, channelId: CHAT_CHANNEL.id,
    messageCount: 1, lastReadSequence: 0, unreadCount: 0, ...counts,
  },
  data: { openingMessage: { id: `${id}-opening`, createdAtMs: CHAT_AT, bodySnippet, ...author }, reactions: [], viewerAuthorId: "you" },
});
const SAM = { authorKind: "human", authorDisplayName: "Sam", presentation: SAMPLE_SAM } as const;
const CHAT_POSTS = [
  chatPost("post-plain", SAM, "Pricing page copy", "Pricing page copy\nDraft is in research/competitors.md for now. Comments welcome."),
  chatPost("post-hover", { authorKind: "agent", authorDisplayName: "Agent", presentation: neutralPresentation }, "The funnel numbers changed since last week.",
    "The funnel numbers changed since last week.", { unreadCount: 1 }),
  chatPost("post-poll", SAM, "Can we get the launch checklist into shape before Friday?",
    "Can we get the launch checklist into shape before Friday?", { messageCount: 5, unreadCount: 2, openDecisionCount: 1 }),
  chatPost("post-unkeyed", { authorKind: "human", authorDisplayName: "Kim", presentation: neutralPresentation },
    "Launch checklist notes", "Launch checklist notes\nI added the remaining review notes."),
];
// The feed's rows, then two kept rows with keyboard focus: on the row, and
// on Comment inside its toolbar.
const CHAT_FEED_SPECIMENS: { key: string; post: (typeof CHAT_POSTS)[number]; force?: { row?: string; button?: string }; last?: boolean }[] = [
  { key: "titled", post: CHAT_POSTS[0]! },
  { key: "unkeyed", post: CHAT_POSTS[3]! },
  { key: "hovered", post: CHAT_POSTS[1]!, force: { row: "hover" } },
  { key: "poll", post: CHAT_POSTS[2]! },
  { key: "row-focus", post: CHAT_POSTS[0]!, force: { row: "focus focus-visible" } },
  { key: "toolbar-focus", post: CHAT_POSTS[0]!, force: { row: "focus-within", button: "focus focus-visible" }, last: true },
];
const chatMessage = (id: string, body: string, minutes: number, parentMessageId?: string): ChatMessageRecord => ({
  id, threadId: "post-plain", ...SAM, body, createdAtMs: CHAT_AT + minutes * 60_000,
  ...(parentMessageId ? { parentMessageId } : {}),
});
const CHAT_THREAD_MESSAGES = [
  chatMessage("opening", "Draft is in research/competitors.md for now. Comments welcome.", 0),
  chatMessage("comment-1", "The second section reads well.", 1, "opening"),
  chatMessage("comment-2", "Can we cut the last paragraph?", 2, "opening"),
];
const CHAT_THREAD_NAV = { level: "thread", channel: CHAT_CHANNEL, thread: CHAT_POSTS[0]!.thread } as const;
const NO_BOOKMARKS = new Set<string>();

// A thread at the drawing's column, its second comment hovered. Its
// toolbar's shadow takes the room below.
function ChatThreadSpecimen() {
  return (
    <div className="w-[560px] pb-6" data-force-state="hover" data-force-target='[data-message-id="comment-2"] > [data-testid="chats-comment-bubble"]'>
      <ThreadMessages
        nav={CHAT_THREAD_NAV}
        messages={CHAT_THREAD_MESSAGES}
        messagesLoading={false}
        threadLocked={false}
        flashMessageId={null}
        runRecords={{}}
        reactionsByMessage={new Map()}
        decisionsByMessage={new Map()}
        attachmentsByMessage={new Map()}
        reactionControls={CHAT_REACTIONS}
        mentionCandidates={[]}
        bookmarkFor={() => undefined}
        bookmarkBusy={NO_BOOKMARKS}
        toggleBookmark={async () => undefined}
        beginReply={noop}
        beginResolve={noop}
        scrollToMessage={noop}
        setMessageNode={noop}
      />
    </div>
  );
}

const COMPOSER_DRAFT = "Can we cut the last paragraph?";

// The agent picked from the roster, in each state its offer says. The
// specimen agent takes the default agent colour, not a chosen one.
const AGENT_OFFER_STATES: readonly AgentOfferState[] = ["runs", "working", "paused", "runner-off", "no-command", "unknown"];
const AGENT_DRAFT = "@agent can you check funnel.csv against last week?";
function agentOffer(state: AgentOfferState): AgentAddressedOffer {
  return {
    kind: "agent-addressed",
    agent: { id: "agent:default", kind: "agent", handle: "agent", label: "Nova" },
    presentation: { group: "states-agent", hue: null, self: false },
    state,
    working: state === "working",
    reach: "C:\\Users\\ada\\trip-planner",
  };
}

function AgentOfferComposer(props: {
  state: AgentOfferState;
  surface: "post" | "stream";
  id: string;
  width?: string;
  focus?: boolean;
  replying?: boolean;
}) {
  const composer = (
    <MentionComposer testIdPrefix={props.id} composerId={props.id} value={AGENT_DRAFT} sending={false}
      surface={props.surface} authorName="Ada" authorPresentation={SAMPLE_ADA}
      placeholder={props.surface === "post" ? "What's happening in #general?" : "Message #general"}
      sendLabel={props.surface === "post" ? "Start post" : "Send message"} candidates={[]} onChange={noop} onSend={noop}
      agentOffer={agentOffer(props.state)} onSetUpAgent={noop}
      above={props.replying ? (
        <ComposerModeBar testId={`${props.id}-replying-mode`} cancelTestId={`${props.id}-replying-cancel`}
          cancelLabel="Cancel reply" onCancel={noop}>Replying to Sam ·</ComposerModeBar>
      ) : undefined} />
  );
  const focused = props.focus ? (
    <div data-force-state="focus-visible" data-force-target='[data-testid="composer-agent-offer-setup"]'>{composer}</div>
  ) : composer;
  // A stream composer floats its offer above its top edge, into the room the
  // end of its conversation keeps, so it gets that room here.
  return props.surface === "post"
    ? <div id={`${props.id}-specimen`} className={props.width ?? "w-[560px]"}>{focused}</div>
    : <div id={`${props.id}-specimen`} className={`${props.width ?? "w-[400px]"} rounded-lg border border-line bg-panel pt-9`}>{focused}</div>;
}

// The About rail at the drawing's 290px, on the chrome.
function AboutPanelSpecimen(props: { children: ReactNode }) {
  return <div className="flex w-[290px] flex-col rounded-lg border border-line bg-panel pb-2">{props.children}</div>;
}

// A run in a file's chats, the narrowest conversation. From an earlier year,
// so its day divider reads the same whenever the page is drawn.
const CHAT_RUN_AT = new Date(2025, 6, 8, 12, 43).getTime();
const CHAT_RUN: ChatMessageRecord[] = [
  { id: "run-1", threadId: "about-chat", ...SAM, body: "The second section reads well.", createdAtMs: CHAT_RUN_AT },
  { id: "run-2", threadId: "about-chat", ...SAM, body: "Can we cut the last paragraph?", createdAtMs: CHAT_RUN_AT + 2 * 60_000 },
];

// A person, an agent in the default olive, and an agent with a chosen color.
const AGENT_COLOR_CHAT: ChatMessageRecord[] = [
  { id: "color-sam", threadId: "about-chat", ...SAM, body: "Can you two check the funnel numbers?", createdAtMs: CHAT_RUN_AT },
  { id: "color-nova", threadId: "about-chat", authorKind: "agent", authorDisplayName: "Nova", presentation: SAMPLE_NOVA,
    body: "The signups match last week.", createdAtMs: CHAT_RUN_AT + 60_000 },
  { id: "color-orbit", threadId: "about-chat", authorKind: "agent", authorDisplayName: "Orbit", presentation: SAMPLE_ORBIT,
    body: "Checkout dropped 4%.", createdAtMs: CHAT_RUN_AT + 2 * 60_000 },
];

// Its second message hovered, so "12:45" shows in the avatar's column.
function ChatRunSpecimen() {
  return (
    <div data-force-state="hover" data-force-target='[data-message-id="run-2"] > .group'>
      <AboutPanelSpecimen>
        <div className="flex h-[180px] flex-col">
          <ChatMessageList testIdPrefix="states-chat" messages={CHAT_RUN} loading={false} emptyLabel="No messages yet." />
        </div>
      </AboutPanelSpecimen>
    </div>
  );
}

// The drawing's document, linked from the meeting notes twice and from the
// research, and named in #general.
const aboutLink = (source: string, title: string, line: number, snippet: string, ordinal = 0) => {
  const start = snippet.indexOf("[[");
  const end = snippet.indexOf("]]") + 2;
  return { source, title, ordinal, span: [start, end] as [number, number], line, snippet, highlightStart: start, highlightEnd: end };
};
const ABOUT_LINK_ROWS = [
  aboutLink("notes/meeting-2026-07-08.md", "Meeting 2026-07-08", 4, "Agreed to ship the beta from [[product-plan]] on Friday."),
  aboutLink("notes/meeting-2026-07-08.md", "Meeting 2026-07-08", 12, "Sam owns the pricing section of [[product-plan]].", 1),
  aboutLink("research/competitors.md", "Competitor landscape", 7,
    "Their launch list is shorter than the one in [[product-plan]], and their pricing has three tiers."),
];
const ABOUT_LINKS: Extract<LinksView, { status: "ready" }> = { status: "ready", rows: ABOUT_LINK_ROWS, next: "states-next", gathering: 0 };
const ABOUT_CHAT_LINK: ChatFileMentionRecord = {
  attachment: {
    attachmentId: "states-attachment", threadId: "states-thread", messageId: "states-message", targetKind: "file",
    objectId: "states-plan", pathHint: ABOUT_PATH, createdAtMs: new Date(2026, 6, 8, 9, 12).getTime(),
  },
  message: {
    id: "states-message", authorDisplayName: "Sam Rivera", createdAtMs: new Date(2026, 6, 8, 9, 12).getTime(),
    preview: "Can we get the launch checklist into shape before Friday? It's in product-plan.md.",
  },
  thread: { id: "states-thread", title: "Launch checklist", createdAtMs: CHAT_AT, updatedAtMs: CHAT_AT },
  channelKind: "channel", channelName: "general",
};
const ABOUT_CHAT_LINKS: Extract<ChatLinksView, { status: "ready" }> = { status: "ready", rows: [ABOUT_CHAT_LINK], next: null, gathering: 0 };

function LinksSpecimen(props: { links: LinksView | null; chats?: ChatLinksView | null }) {
  return (
    <AboutPanelSpecimen>
      <AboutLinksView links={props.links} chats={props.chats ?? null} expanded onToggle={noop} onOpenLink={noop}
        onOpenChat={noop} onMoreLinks={noop} onMoreChats={noop} onRetryLinks={noop} onRetryChats={noop} />
    </AboutPanelSpecimen>
  );
}

const accessSetup = (reason: AccessReason): AccessSetup => ({ reason, openSyncSettings: noop, connect: noop });
const ACCESS_UNEXPLAINED = accessSetup("unexplained");

function AccessSpecimen(props: { view: AccessView; reason?: AccessReason }) {
  return (
    <AboutPanelSpecimen>
      <AboutAccessView view={props.view} expanded onToggle={noop} onRetry={noop} onMore={noop}
        setup={props.reason ? accessSetup(props.reason) : ACCESS_UNEXPLAINED} />
    </AboutPanelSpecimen>
  );
}

// The Sharing view's lists, as the drawing fills them.
const SHARING_CHECKED_AT = new Date(2026, 6, 8, 9, 40).getTime();
const SHARING_GRANTED: AccessAnswer = {
  ...ABOUT_ACCESS,
  ref: null,
  rows: [
    aboutGrant({ shareId: "share-plan", grantId: "grant-sam", recipientUserId: "sam", recipientEmail: "sam@hollis.studio",
      selector: { paths: ["notes/product-plan.md"], versionId: null } }),
    aboutGrant({ shareId: "share-research", grantId: "grant-link", via: "link", recipientUserId: null, recipientEmail: null,
      selector: { paths: ["research/competitors.md"], versionId: null }, access: "view" }),
    aboutGrant({ shareId: "share-old", grantId: "grant-kim", recipientUserId: "kim", recipientEmail: "kim@example.com",
      subjectName: "budget.csv", selector: null, access: null, status: "revoked" }),
  ],
  checkedAtMs: SHARING_CHECKED_AT,
};
const SHARING_RECEIVED: AccessAnswer = {
  ...SHARING_GRANTED,
  unknownReason: null, coverage: { kind: "received-account", complete: true, observation: "interval" },
  rows: [
    aboutGrant({ shareId: "in-funnel", grantId: "in-1", via: "received", sharerName: "Sam", granterEmail: "sam@hollis.studio",
      recipientUserId: "me", recipientEmail: null, subjectName: "funnel.csv", selector: { paths: ["data/funnel.csv"], versionId: null }, access: "view" }),
    aboutGrant({ shareId: "in-research", grantId: "in-2", via: "received", sharerName: "Sam", granterEmail: "sam@hollis.studio",
      recipientUserId: "me", recipientEmail: null, subjectName: "research", selector: { kind: "chat", channelWireId: "wire-research" }, access: "read-only" }),
  ],
};
const SHARING_UNKNOWN: Partial<AccessAnswer> = {
  rows: [],
  visibility: "unknown",
  unknownReason: "not-listed-yet", coverage: { kind: "unavailable", complete: false, observation: "interval" },
  checkedAtMs: null,
  freshness: "unknown",
};
const SHARING_MOUNTS: ShareMount[] = [{ shareId: "in-funnel", label: "funnel", granterEmail: "sam@hollis.studio", access: "view" }];
// A mount the relay no longer lists, and one whose pulls skipped changes.
const SHARING_SKIPPED = {
  ops: [{ originId: "origin-sam", originSeq: 4, opKind: "write", code: "share-boundary-violation", detail: "notes/draft.md", atMs: SHARING_CHECKED_AT }],
  more: 0, generation: 3,
};
const SHARING_REMOVED_MOUNTS: ShareMount[] = [
  { ...SHARING_MOUNTS[0]!, skippedOps: SHARING_SKIPPED },
  { shareId: "in-notes", label: "notes", granterEmail: "kim@example.com", access: "view" },
];
const SHARING_REMOVED: AccessAnswer = {
  ...SHARING_RECEIVED,
  rows: [
    SHARING_RECEIVED.rows[0]!,
    aboutGrant({ shareId: "in-budget", grantId: "in-3", via: "received", sharerName: null, granterEmail: null, recipientUserId: "me",
      recipientEmail: null, selector: null, access: null, status: "removed", removalMessage: "Sam removed your access." }),
  ],
};
const SHARING_WAITING = new Map([["share-plan", { count: 2, senders: ["sam@hollis.studio"], oldestProposalId: "proposal-1" }]]);
const SHARING_ACTIONS: SharingActions = {
  retry: noop, more: noop, reviewChanges: noop, startEnd: noop, cancelEnd: noop, end: noop, mount: noop, unmount: noop,
  copy: async () => null, dismissSkips: noop, showSkips: noop, reviewConflicts: noop,
};
const ready = (answer: AccessAnswer): AccessView => ({ status: "ready", answer });

// The Sharing view at the drawing's 280px, on the chrome.
function SharingSpecimen(props: {
  granted: AccessView;
  received: AccessView;
  grantedReason?: AccessReason;
  receivedReason?: AccessReason;
  conflictCount?: number;
  confirmShareId?: string;
  mounts?: ShareMount[];
  skipView?: SkipView;
}) {
  return (
    <div className="flex w-[280px] flex-col rounded-lg border border-line bg-panel">
      <SharingPanel
        granted={props.granted}
        received={props.received}
        grantedSetup={props.grantedReason ? accessSetup(props.grantedReason) : ACCESS_UNEXPLAINED}
        receivedSetup={props.receivedReason ? accessSetup(props.receivedReason) : ACCESS_UNEXPLAINED}
        conflictCount={props.conflictCount ?? null}
        waiting={SHARING_WAITING}
        mounts={props.mounts ?? SHARING_MOUNTS}
        skipView={props.skipView ?? new Map()}
        invitations
        confirmShareId={props.confirmShareId ?? null}
        busyShareId={null}
        actions={SHARING_ACTIONS}
      />
    </div>
  );
}

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
            They move to the system trash, or this workspace's .dohc/local/trash if that fails, and you can
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

const avatarSizes = ["post", "row", "comment", "strip"] as const;

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
  { id: "new", label: "New version…", icon: <Plus size={14} aria-hidden />, onSelect: noop },
  { id: "compare", label: "Compare with Main", icon: <Diff size={14} aria-hidden />, onSelect: noop },
  { id: "merge", label: "Merge into Main…", icon: <Merge size={14} aria-hidden />, disabled: true, onSelect: noop },
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
// they land in their part. The box's 24px margin leaves room for the shadow
// beside; each box's height leaves room below.
const EDITOR_MENU_BOX = "relative ml-6 [contain:layout]";

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

// The section shows file text only. After `budget` is renamed `cost`, the
// file holds the old name until the save lands.
function AsWrittenSpecimen(props: { name: string }) {
  return (
    <div className="w-[420px] rounded-lg border border-line bg-bg">
      <FrontmatterAsWritten markdown={`---\n# Monthly\n${props.name}: 100 # euros\n---\n\nBody`} propertiesShown />
    </div>
  );
}

// A page's top matter on paper, at the editor's font size, as a document
// pane holds it. The pane is the hover zone that shows a lone +.
function TopmatterSpecimen(props: { children: ReactNode }) {
  return (
    <div className="group/topmatter w-[560px] rounded-lg border border-line bg-bg pb-5 text-[length:var(--dohc-editor-font-size)]">
      {props.children}
    </div>
  );
}

const PILLS = "---\nowner: Sam\nrelease: September launch\nstatus: In progress\n---\n";
const LONG_PILL = "---\nowner: Sam\nbrief: https://example.com/plans/2026/q3/product-plan-with-every-goal-and-owner\n---\n";

// A reserved name shows only while a person types it, so the specimen types
// it into the second pill's name once, as a keystroke would.
function ReservedPillSpecimen() {
  const pills = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const name = pills.current?.querySelectorAll<HTMLInputElement>('[data-testid="property-key"]')[1];
    if (!name) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "title");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  }, []);
  return (
    <div ref={pills}>
      <PropertiesPanel body={PILLS} onChange={noop} />
    </div>
  );
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
        <Specimen label="human: post, row, comment, strip">
          {avatarSizes.map((size) => (
            <ChatAvatar presentation={neutralPresentation} key={size} name="Ice de Vera" kind="human" size={size} />
          ))}
        </Specimen>
        <Specimen label="coloured person: post, row, comment, strip">
          {avatarSizes.map((size) => (
            <ChatAvatar presentation={SAMPLE_SAM} key={size} name="Sam Rivera" kind="human" size={size} />
          ))}
        </Specimen>
        <Specimen label="agent: post, row, comment, strip">
          {avatarSizes.map((size) => (
            <ChatAvatar presentation={neutralPresentation} key={size} name="Agent" kind="agent" size={size} />
          ))}
        </Specimen>
        <Specimen label="coloured agent: post, row, comment, strip">
          {avatarSizes.map((size) => (
            <ChatAvatar presentation={SAMPLE_ORBIT} key={size} name="Orbit" kind="agent" size={size} />
          ))}
        </Specimen>
        <Specimen label="automation: post, row, comment, strip">
          {avatarSizes.map((size) => (
            <ChatAvatar presentation={neutralPresentation} key={size} name="Nightly digest" kind="automation" size={size} />
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
        <Specimen label="person, rose chosen">
          <HueControl label="Your color" value="rose" shape="person" onChange={noop} />
        </Specimen>
        <Specimen label="agent, Default chosen">
          <HueControl label="Your agent's color" value={null} shape="agent" onChange={noop} />
        </Specimen>
        <Specimen label="agent, teal chosen">
          <HueControl label="Your agent's color" value="teal" shape="agent" onChange={noop} />
        </Specimen>
      </Section>

      <Section part="color-control" title="Color control">
        <ColorControl label="Accent" value="#6b7230" onChange={noop} />
      </Section>

      <Section part="native-controls" title="Native controls">
        <Specimen label="checkboxes and radios in the theme's colors, checked ones in the accent (Explorer's archived toggle)">
          <div className="flex flex-col">
            <label className="flex h-7 items-center gap-2 px-2 text-[11px] text-muted"><input type="checkbox" defaultChecked={false} />Archived collections</label>
            <label className="flex h-7 items-center gap-2 px-2 text-[11px] text-muted"><input type="checkbox" defaultChecked />Archived collections</label>
            <label className="flex h-7 items-center gap-2 px-2 text-[11px] text-muted"><input type="radio" name={`native-radio-${theme}`} defaultChecked={false} />Off</label>
            <label className="flex h-7 items-center gap-2 px-2 text-[11px] text-muted"><input type="radio" name={`native-radio-${theme}`} defaultChecked />On</label>
          </div>
        </Specimen>
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

      <Section part="collections-rows" title="Collections rows">
        {[SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH].map((width) => (
          <Specimen key={width} label={`no computer keeps them; another one does; others beside the server's, ${width}px`}>
            <div className="flex flex-col gap-2">
              <CollectionsSectionSpecimen width={width}>
                <CollectionsRefusalRow refusal={UNCLAIMED_REFUSAL} onKeep={noop} onRetry={noop} />
              </CollectionsSectionSpecimen>
              <CollectionsSectionSpecimen width={width}>
                <CollectionsRefusalRow refusal={ELSEWHERE_REFUSAL} onKeep={noop} onRetry={noop} />
              </CollectionsSectionSpecimen>
              <CollectionsSectionSpecimen width={width}>
                <CollectionsElsewhereRow elsewhere={OTHERS_ELSEWHERE} onKeep={noop} />
              </CollectionsSectionSpecimen>
            </div>
          </Specimen>
        ))}
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
        <Specimen label="Collection waiting, Try again in focus">
          <EmptyPanel>
            <div className="contents" data-force-state="focus-visible" data-force-target="button">
              <CollectionUnavailable waiting words="This Collection is waiting to reopen. Try again in 10 seconds." onRetry={noop} />
            </div>
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

      {/* The shell's menus, one part each. */}
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
        <Specimen label="field: focus, Enter at its end">
          <div className="flex h-52 w-72 items-start justify-end" data-force-state="focus" data-force-target="input">
            <MenuSpecimen label="Versions" items={fieldMenuItems} width={240} testId={`states-menu-field-${theme}`} />
          </div>
        </Specimen>
      </Section>

      <Section part="menu-overflow" title="Overflow menu">
        {/* Focus without focus-visible, as a pointer leaves it: the active
            row still shows apart from the current one. */}
        <Specimen label="current; long name: active from the pointer; rest">
          <div
            className="flex h-56 w-72 items-start justify-end"
            data-force-state="focus"
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

      {/* The capture opens each part's tab list. */}
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

      <Section part="kind-glyph" title="Kind glyph">
        <Specimen label="kind">
          <ul className={KIND_NAMES}>
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
        <Specimen label="object">
          <ul className={KIND_NAMES}>
            {OBJECTS.map((kind) => (
              <li key={kind} className="flex h-7 items-center">
                {kind}
              </li>
            ))}
          </ul>
        </Specimen>
        <Specimen label="object, rest">
          <ObjectRows label="Objects" selected={false} />
        </Specimen>
        <Specimen label="object, selected">
          <ObjectRows label="Objects, selected" selected />
        </Specimen>
      </Section>

      {/* The editor's menus. Their active row is the one Enter acts on,
          keyboard or pointer, and always draws the outline. */}
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

      <Section part="history-timeline" title="History timeline">
        <Specimen label="one line per change: an agent's folded edits, holding the open one; a person; origins; a protected file">
          <div className="flex h-[300px] w-[240px] flex-col overflow-hidden rounded-lg border border-line bg-panel">
            <EngineHistoryView entries={TIMELINE_STORY} hasMore={false} loadingMore={false} onLoadMore={noop} onOpenMoment={noop}
              openMomentId="story-nova-2" onRetry={noop} />
          </div>
        </Specimen>
        <Specimen label="the agent's run, listed: its earlier edit open; count hovered">
          <ul className="m-0 w-[240px] list-none rounded-lg border border-line bg-panel p-1">
            <li data-force-state="hover" data-force-target="[data-testid=engine-moment-run-toggle]">
              <MomentRow moment={STORY_RUN[0]!} fold={{ count: 3, expanded: true, onToggle: noop }} onOpenMoment={noop} />
              <MomentRow moment={STORY_RUN[1]!} nested="run" selected onOpenMoment={noop} />
              <MomentRow moment={STORY_RUN[2]!} nested="run" onOpenMoment={noop} />
            </li>
          </ul>
        </Specimen>
        <Specimen label="files, versions and Collections, with day headings">
          <div className="flex h-[500px] w-[300px] flex-col overflow-hidden rounded-lg border border-line bg-panel">
            <EngineHistoryView entries={TIMELINE_MIXED} hasMore={false} loadingMore={false} onLoadMore={noop} onOpenMoment={noop}
              collections={TIMELINE_COLLECTIONS} onRetry={noop} />
          </div>
        </Specimen>
        <Specimen label="partial: a Collection did not load">
          <div className="flex h-[260px] w-[300px] flex-col overflow-hidden rounded-lg border border-line bg-panel">
            <EngineHistoryView entries={[TIMELINE_FILE, TIMELINE_DATED]} hasMore={false} loadingMore={false} onLoadMore={noop} onOpenMoment={noop}
              unavailableSources={[{ datasetId: TIMELINE_GUESTS }]} collections={TIMELINE_COLLECTIONS} onRetry={noop} />
          </div>
        </Specimen>
        <Specimen label="Collections left out by the limit">
          <div className="flex h-[240px] w-[300px] flex-col overflow-hidden rounded-lg border border-line bg-panel">
            <EngineHistoryView entries={[TIMELINE_FILE]} hasMore={false} loadingMore={false} onLoadMore={noop} onOpenMoment={noop}
              omittedSources={14} collections={TIMELINE_COLLECTIONS} onRetry={noop} />
          </div>
        </Specimen>
        <Specimen label="one Collection, unavailable">
          <div className="flex h-48 w-[300px] flex-col rounded-lg border border-line bg-panel">
            <EngineHistoryView entries={[]} hasMore={false} loadingMore={false} onLoadMore={noop} onOpenMoment={noop}
              unavailableSources={[{ datasetId: TIMELINE_GUESTS }]} collections={TIMELINE_COLLECTIONS} onRetry={noop} />
          </div>
        </Specimen>
        <Specimen label="loading">
          <div className="flex h-48 w-[300px] flex-col rounded-lg border border-line bg-panel">
            <SkeletonRows layout="panel" label="Loading history..." />
          </div>
        </Specimen>
      </Section>

      <Section part="tab-row-actions" title="Document actions in the tab row" menusAtRest>
        {/* One document loading, saved, saving, pending share, held,
            failed, and changed on disk in a narrow pane: Share, the toggle
            and the menu keep their places, and the save state gives way
            before the tab name. Opening, saved and saving say so only to
            screen readers, so loading and ready draw the same width. No box
            clips them, so an overflow shows. */}
        <Specimen label="loading" className="w-full">
          <TabRowActionsSpecimen width="w-full">
            <ViewActions
              onShare={noop}
              status={<OpeningState />}
              actions={
                <DocumentControls
                  toggle={{ label: "Edit", disabled: true, title: OPENING_TITLE }}
                  menu={{ workspaceId: "states", suggestedName: "plan", getMarkdown: () => null }}
                />
              }
            />
          </TabRowActionsSpecimen>
        </Specimen>
        <Specimen label="saved" className="w-full">
          <TabRowActionsSpecimen width="w-full">
            <ViewActions
              onShare={noop}
              status={<StateMark testId={`states-tab-row-actions-state-${theme}`} truncate quietWhenCalm state="saved" shown="saved" />}
              actions={
                <DocumentControls
                  toggle={{ label: "Source", title: "Toggle markdown source (Ctrl+/)", onClick: noop }}
                  menu={{ workspaceId: "states", suggestedName: "plan", getMarkdown: () => "# Plan" }}
                />
              }
            />
          </TabRowActionsSpecimen>
        </Specimen>
        <Specimen label="saving" className="w-full">
          <TabRowActionsSpecimen width="w-full">
            <ViewActions
              onShare={noop}
              status={<StateMark testId={`states-tab-row-actions-saving-${theme}`} truncate quietWhenCalm state="saving" shown="saving" />}
              actions={
                <DocumentControls
                  toggle={{ label: "Source", title: "Toggle markdown source (Ctrl+/)", onClick: noop }}
                  menu={{ workspaceId: "states", suggestedName: "plan", getMarkdown: () => "# Plan" }}
                />
              }
            />
          </TabRowActionsSpecimen>
        </Specimen>
        <Specimen label="pending share" className="w-full">
          <TabRowActionsSpecimen width="w-full">
            <ViewActions
              onShare={noop}
              status={<StateMark testId={`states-tab-row-actions-pending-${theme}`} truncate quietWhenCalm state="pending-share" shown="pending-share" />}
              actions={
                <DocumentControls
                  toggle={{ label: "Source", title: "Toggle markdown source (Ctrl+/)", onClick: noop }}
                  menu={{ workspaceId: "states", suggestedName: "plan", getMarkdown: () => "# Plan" }}
                />
              }
            />
          </TabRowActionsSpecimen>
        </Specimen>
        <Specimen label="held: file in use" className="w-full">
          <TabRowActionsSpecimen width="w-full">
            <ViewActions
              onShare={noop}
              status={<StateMark testId={`states-tab-row-actions-held-${theme}`} truncate quietWhenCalm state="file-locked" shown="file-locked" />}
              actions={
                <DocumentControls
                  toggle={{ label: "Source", title: "Toggle markdown source (Ctrl+/)", onClick: noop }}
                  menu={{ workspaceId: "states", suggestedName: "plan", getMarkdown: () => "# Plan" }}
                />
              }
            />
          </TabRowActionsSpecimen>
        </Specimen>
        <Specimen label="failed" className="w-full">
          <TabRowActionsSpecimen width="w-full">
            <ViewActions
              onShare={noop}
              actions={
                <DocumentControls
                  toggle={{ label: "Edit", disabled: true }}
                  menu={{ workspaceId: "states", suggestedName: "plan", getMarkdown: () => null, disabled: true }}
                />
              }
            />
          </TabRowActionsSpecimen>
        </Specimen>
        <Specimen label="narrow, changed on disk">
          <TabRowActionsSpecimen width="w-[360px]" testId={`states-tab-row-actions-narrow-${theme}`}>
            <ViewActions
              onShare={noop}
              status={
                <StateMark testId={`states-tab-row-actions-cut-${theme}`} truncate quietWhenCalm state="changed-on-disk" shown="changed-on-disk" />
              }
              actions={
                <DocumentControls
                  toggle={{ label: "Source", title: "Toggle markdown source (Ctrl+/)", onClick: noop }}
                  menu={{ workspaceId: "states", suggestedName: "plan", getMarkdown: () => "# Plan" }}
                />
              }
            />
          </TabRowActionsSpecimen>
        </Specimen>
      </Section>

      {/* The editor's listboxes share these rows. The editor keeps focus,
          and the option Enter acts on draws the outline. The page link and
          emoji pickers are not here: an open picker takes Enter from the
          whole window, which would take it from this page's other parts. */}
      <Section part="slash-menu" title="Slash menu">
        <Specimen label="third option active; the list scrolls">
          <div className={`${EDITOR_MENU_BOX} h-[290px] w-[330px]`}>
            <SlashCommandMenu state={SLASH_MENU_OPEN} onSelect={noop} onHover={noop} />
          </div>
        </Specimen>
      </Section>

      {/* The group a keyboard close leaves empty takes focus, and its ring
          shows on all four edges above its tab strip. */}
      <Section part="editor-group-focus" title="Editor group, focused" menusAtRest>
        <Specimen label="split: the focused active group, empty, then one with tabs">
          <div data-force-state="focus focus-visible" data-force-target='[data-editor-group-id="first"]'>
            <EditorGroupsSpecimen activeHasTabs={false} />
          </div>
        </Specimen>
      </Section>

      <Section part="frontmatter-as-written" title="Frontmatter as written">
        <Specimen label="rename saved">
          <AsWrittenSpecimen name="cost" />
        </Specimen>
        <Specimen label="rename saving: the file keeps the old name">
          <AsWrittenSpecimen name="budget" />
        </Specimen>
      </Section>

      {/* On the title bar's own fill. */}
      <Section part="title-bar-status" title="Title bar status">
        {/* The saved dot alone while nothing needs the person, and its words
            once something does. */}
        {TITLE_BAR_STATUSES.map(({ label, syncStatus, failedSaves }) => (
          <Specimen key={label} label={label}>
            <span className="flex h-8 items-center rounded-md border border-line bg-panel px-3">
              <WorkspaceSyncStatus syncStatus={syncStatus} failedSaves={failedSaves} />
            </span>
          </Specimen>
        ))}
      </Section>

      <Section part="capture-recovery" title="Text kept in History">
        <Specimen label="toast">
          <div className={SHADOW_ROOM}>
            <WorkspaceErrorToast error={RECOVERY_TOAST} onAction={noop} onHide={noop} />
          </div>
        </Specimen>
        <Specimen label="Notices: History Restore, then a shared live file">
          <div className="w-[360px] rounded-lg border border-line bg-panel text-xs text-ink">
            <ul className="m-0 list-none p-0">
              <LocalNoticeRow notice={recoveryNotice("capture-recovery", false)} onKeyDown={noop} onAction={noop} onDismiss={noop} />
              <LocalNoticeRow notice={recoveryNotice("capture-recovery-shared", true)} onKeyDown={noop} onAction={noop} onDismiss={noop} />
            </ul>
          </div>
        </Specimen>
        <Specimen label="History at its default width: the recovery change">
          <ul className="m-0 w-[240px] list-none rounded-lg border border-line bg-panel p-1">
            <li>
              <MomentRow moment={RECOVERY_MOMENT} onOpenMoment={noop} />
            </li>
          </ul>
        </Specimen>
      </Section>

      <Section part="recovery-row" title="Set-aside edits">
        <Specimen label="rows with their workspace: kept across a restart; only in this window">
          <div className="w-[440px] rounded-lg border border-line bg-panel px-3">
            <RecoveryList rows={SET_ASIDE_ROWS} showWorkspace />
          </div>
        </Specimen>
        <Specimen label="Dismiss asks first, at the row's height">
          <div className="flex w-[440px] items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 py-1.5 text-[11px]">
            <span className="min-w-0 flex-1 truncate font-mono text-muted">{SET_ASIDE_ROWS[0]!.path}</span>
            <div className="flex shrink-0 items-center gap-2">
              <CopyButton testId={`states-recovery-copy-${theme}`} getText={() => null} />
              <DismissConfirm dismissing={false} onDismiss={noop} onKeep={noop} />
            </div>
          </div>
        </Specimen>
      </Section>

      <Section part="about" title="About">
        <Specimen label="a document: chats, history, access checked">
          <AboutPanelSpecimen>
            <AboutHeader subject={{ path: ABOUT_PATH }} />
            <AboutSection id="chats" icon={MessageSquare} label="Chats" count="2" expanded onToggle={noop}>
              <ul className="m-0 list-none p-0">
                {ABOUT_THREADS.map((thread) => (
                  <li key={thread.id}>
                    <AboutChatRow thread={thread} onOpen={noop} />
                  </li>
                ))}
              </ul>
            </AboutSection>
            <AboutHistoryView
              view={{ status: "ready", moments: ABOUT_MOMENTS, more: true }}
              expanded
              onToggle={noop}
              onOpenMoment={noop}
            />
            <AboutAccessView view={{ status: "ready", answer: ABOUT_ACCESS }} expanded onToggle={noop} onRetry={noop}
              onMore={noop} setup={ACCESS_UNEXPLAINED} />
          </AboutPanelSpecimen>
        </Specimen>
        <Specimen label="access may be out of date">
          <AccessSpecimen view={{ status: "ready", answer: { ...ABOUT_ACCESS, freshness: "stale" } }} />
        </Specimen>
        <Specimen label="no share within its coverage">
          <AccessSpecimen view={{ status: "ready", answer: { ...ABOUT_ACCESS, rows: [] } }} />
        </Specimen>
        <Specimen label="unknown: the workspace does not sync">
          <AccessSpecimen view={{ status: "ready", answer: ABOUT_ACCESS_UNKNOWN }} reason="not-synced" />
        </Specimen>
        <Specimen label="unknown: signed out">
          <AccessSpecimen view={{ status: "ready", answer: ABOUT_ACCESS_UNKNOWN }} reason="signed-out" />
        </Specimen>
        <Specimen label="unknown: no cause dohc can name">
          <AccessSpecimen view={{ status: "ready", answer: ABOUT_ACCESS_UNKNOWN }} />
        </Specimen>
        <Specimen label="loading, then failed reads: words in Notices">
          <AboutPanelSpecimen>
            <AboutHistoryView view={{ status: "loading" }} expanded onToggle={noop} onOpenMoment={noop} />
            <AboutHistoryView view={{ status: "failed", retry: noop }} expanded onToggle={noop} onOpenMoment={noop} />
            <AboutAccessView view={{ status: "failed" }} expanded onToggle={noop} onRetry={noop} onMore={noop} setup={ACCESS_UNEXPLAINED} />
          </AboutPanelSpecimen>
        </Specimen>
        <Specimen label="History held back by its rules: drawn here, no row">
          <AboutPanelSpecimen>
            <AboutHistoryView
              view={{ status: "held", words: historyHiddenWords([".dohc/files.toml"]), retry: noop }}
              expanded
              onToggle={noop}
              onOpenMoment={noop}
            />
          </AboutPanelSpecimen>
        </Specimen>
        <Specimen label="keyboard focus on a closed section">
          <div data-force-state="focus focus-visible" data-force-target='[data-testid="about-access-toggle"]'>
            <AboutPanelSpecimen>
              <AboutHistoryView view={{ status: "untracked" }} expanded onToggle={noop} onOpenMoment={noop} />
              <AboutAccessView view={{ status: "loading" }} expanded={false} onToggle={noop} onRetry={noop} onMore={noop}
                setup={ACCESS_UNEXPLAINED} />
            </AboutPanelSpecimen>
          </div>
        </Specimen>
      </Section>

      {/* Its rows' menus rest; the menu part draws an open one. */}
      <Section part="about-links" title="About: Links">
        <Specimen label="files that link here, a chat that does, and more to read">
          <LinksSpecimen links={ABOUT_LINKS} chats={ABOUT_CHAT_LINKS} />
        </Specimen>
        <Specimen label="a link hovered, and keyboard focus on a chat's link">
          <div data-force-state="hover" data-force-target='[data-line="12"]'>
            <div data-force-state="focus focus-visible" data-force-target='[data-testid="chat-file-mention"]'>
              <LinksSpecimen links={{ ...ABOUT_LINKS, next: null }} chats={ABOUT_CHAT_LINKS} />
            </div>
          </div>
        </Specimen>
        <Specimen label="gathering while the workspace's link index builds">
          <LinksSpecimen links={{ ...ABOUT_LINKS, rows: ABOUT_LINK_ROWS.slice(0, 1), next: null, gathering: 1 }} />
        </Specimen>
        <Specimen label="nothing links here yet">
          <LinksSpecimen links={{ ...ABOUT_LINKS, rows: [], next: null }} chats={{ ...ABOUT_CHAT_LINKS, rows: [] }} />
        </Specimen>
        <Specimen label="failed reads: words in Notices">
          <LinksSpecimen links={{ status: "failed" }} />
        </Specimen>
        <Specimen label="a file shared with you">
          <LinksSpecimen links={null} />
        </Specimen>
      </Section>

      <Section part="sharing" title="Sharing" menusAtRest>
        <Specimen label="both lists, a conflict, and changes waiting">
          <SharingSpecimen granted={ready(SHARING_GRANTED)} received={ready(SHARING_RECEIVED)} conflictCount={2} />
        </Specimen>
        <Specimen label="may be out of date">
          <SharingSpecimen granted={ready({ ...SHARING_GRANTED, freshness: "stale" })}
            received={ready({ ...SHARING_RECEIVED, freshness: "stale" })} />
        </Specimen>
        <Specimen label="no share within each coverage">
          <SharingSpecimen granted={ready({ ...SHARING_GRANTED, rows: [] })} received={ready({ ...SHARING_RECEIVED, rows: [] })} />
        </Specimen>
        <Specimen label="unknown: no cause dohc can name, and signed out">
          <SharingSpecimen granted={ready({ ...SHARING_GRANTED, ...SHARING_UNKNOWN })}
            received={ready({ ...SHARING_RECEIVED, ...SHARING_UNKNOWN })} receivedReason="signed-out" />
        </Specimen>
        <Specimen label="unknown: the workspace does not sync">
          <SharingSpecimen granted={ready({ ...SHARING_GRANTED, ...SHARING_UNKNOWN })} grantedReason="not-synced"
            received={ready(SHARING_RECEIVED)} />
        </Specimen>
        <Specimen label="loading, then failed reads: words in Notices">
          <SharingSpecimen granted={{ status: "loading" }} received={{ status: "failed" }} />
        </Specimen>
        <Specimen label="ending a share asks first">
          <SharingSpecimen granted={ready(SHARING_GRANTED)} received={ready({ ...SHARING_RECEIVED, rows: [] })}
            confirmShareId="share-plan" />
        </Specimen>
        <Specimen label="keyboard focus on a row's actions">
          <div data-force-state="focus-within" data-force-target='[data-testid="sharing-granted-actions"]'>
            <div data-force-state="focus focus-visible" data-force-target='[data-testid="sharing-granted-menu"]'>
              <SharingSpecimen granted={ready({ ...SHARING_GRANTED, rows: SHARING_GRANTED.rows.slice(0, 1) })}
                received={ready({ ...SHARING_RECEIVED, rows: [] })} />
            </div>
          </div>
        </Specimen>
        <Specimen label="keyboard focus on a row's code copy">
          <div data-force-state="focus-within" data-force-target='[data-testid="sharing-granted-actions"]'>
            <div data-force-state="focus focus-visible" data-force-target='[data-testid="sharing-copy-code"]'>
              <SharingSpecimen granted={ready({ ...SHARING_GRANTED, rows: SHARING_GRANTED.rows.slice(0, 1) })}
                received={ready({ ...SHARING_RECEIVED, rows: [] })} />
            </div>
          </div>
        </Specimen>
        <Specimen label="removed shares still on this computer, and skipped changes">
          <SharingSpecimen granted={ready({ ...SHARING_GRANTED, rows: [] })} received={ready(SHARING_REMOVED)}
            mounts={SHARING_REMOVED_MOUNTS} />
        </Specimen>
      </Section>

      <Section part="usage-record" title="Usage record">
        <Specimen label="counts, with a row and a door this version does not count">
          <UsageRecordSpecimen view={USAGE_RECORD} />
        </Specimen>
        <Specimen label="off, with saved counts">
          <UsageRecordSpecimen view={{ ...USAGE_RECORD, enabled: false }} />
        </Specimen>
        <Specimen label="nothing counted yet">
          <UsageRecordSpecimen view={{ ...USAGE_RECORD, since: USAGE_TODAY, rows: [] }} />
        </Specimen>
        <Specimen label="a record dohc cannot open, with Try again">
          <UsageRecordSpecimen view={{ status: "unreadable", file: USAGE_RECORD.file, code: "EACCES", setAside: null }} />
        </Specimen>
        <Specimen label="a record dohc cannot decode, with Start a new record">
          <UsageRecordSpecimen view={{ status: "unreadable", file: USAGE_RECORD.file, code: "INVALID_USAGE_RECORD", setAside: null }} />
        </Specimen>
        <Specimen label="a new record, Off, with the old one set aside">
          <UsageRecordSpecimen view={{ ...USAGE_RECORD, enabled: false, since: USAGE_TODAY, rows: [], setAside: "dohc-usage.set-aside-1.json" }} />
        </Specimen>
        <Specimen label="loading, then a failed read: words in Notices">
          <div className="flex flex-col gap-3">
            <UsageRecordSpecimen view={{ status: "loading" }} />
            <UsageRecordSpecimen view={{ status: "failed" }} />
          </div>
        </Specimen>
        <Specimen label="Clear's confirm, with Copy first">
          <div className={SHADOW_ROOM}>
            <UsageRecordClearConfirm card record={USAGE_RECORD} onCancel={noop} onConfirm={noop} />
          </div>
        </Specimen>
        <Specimen label="keyboard focus on the switch">
          <div data-force-state="focus focus-visible" data-force-target='[role="switch"]'>
            <UsageRecordSpecimen view={{ ...USAGE_RECORD, rows: USAGE_RECORD.rows.slice(0, 2) }} />
          </div>
        </Specimen>
      </Section>

      <Section part="word-diff" title="Word diff">
        {WORD_DIFFS.map((specimen) => (
          <Specimen key={specimen.label} label={specimen.label}>
            <div className="w-[520px] rounded-lg border border-line bg-bg">
              <div className="flex h-9 items-center gap-2 border-b border-line px-4 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-mono text-ink">{specimen.path}</span>
                {specimen.diff.counts ? <DiffCounts counts={specimen.diff.counts} /> : null}
              </div>
              <UnifiedDiffLines lines={buildUnifiedDiffLines(specimen.diff)} />
            </div>
          </Specimen>
        ))}
      </Section>

      {/* Its empty and loading states are the shared ones above, in Empty
          ("create") and Loading. */}
      <Section part="apps-shelf" title="Apps shelf">
        <Specimen label="pinned; selected, with a warning; shared, hovered; low confidence">
          <div className="w-60 rounded-lg border border-line bg-panel" data-force-state="hover" data-force-target="li:nth-child(3)">
            <AppRows apps={SHELF_APPS} pinnedApps={["trip-planner"]} activePath={siteTabPath("apps/funnel-dashboard")}
              onOpenPath={noop} onSetPinned={noop} />
          </div>
        </Specimen>
        <Specimen label="keyboard focus: a row, then a pin">
          <div className="w-60 rounded-lg border border-line bg-panel" data-force-state="focus focus-visible"
            data-force-target='li:nth-child(1) [data-testid="sites-row"]'>
            <div data-force-state="focus focus-visible" data-force-target='li:nth-child(3) [data-testid="sites-pin"]'>
              <AppRows apps={SHELF_APPS} pinnedApps={[]} activePath={null} onOpenPath={noop} onSetPinned={noop} />
            </div>
          </div>
        </Specimen>
        <Specimen label="failed read: words in Notices">
          <div className="w-60 rounded-lg border border-line bg-panel p-1">
            <RetryRow testId={`states-apps-failed-${theme}`} onRetry={noop} />
          </div>
        </Specimen>
      </Section>

      <Section part="chat-rows" title="Chat rows">
        <Specimen label="feed: identified and unknown authors; hovered, unread; untitled, unread, poll, comments; focus on a row; focus in its toolbar">
          <div className="w-[560px]">
            {CHAT_FEED_SPECIMENS.map(({ key, post, force, last }) => (
              // Each row is painted in its own box, as the feed list's items are.
              <div key={key} data-feed-last={last ? "" : undefined} className="[contain:paint_layout_style]">
                <div data-force-state={force?.row} data-force-target='[data-testid="chats-post-card"]'>
                  <div data-force-state={force?.button} data-force-target='[data-testid="chats-post-comment"]'>
                    <PostCard thread={post.thread} data={post.data} reactionControls={CHAT_REACTIONS} onOpen={noop} onToggleBookmark={noop} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Specimen>
        <Specimen label="thread: opening post, divider, a run of two comments, the second hovered">
          <ChatThreadSpecimen />
        </Specimen>
      </Section>

      <Section part="settings-frame" title="Settings frame">
        <Specimen label="General chosen, Appearance hovered, keyboard focus on Files; a changed row">
          <div
            className="flex h-[420px] w-[688px] overflow-hidden rounded-xl border border-line bg-bg"
            data-force-state="hover"
            data-force-target='[data-testid="settings-nav-appearance"]'
          >
            <div className="flex" data-force-state="focus focus-visible" data-force-target='[data-testid="settings-nav-files"]'>
              <SettingsNav workspacePath={SETTINGS_WORKSPACE} sections={SETTINGS_SECTIONS} activeSection="general"
                onSelect={noop} query="" onQuery={noop} />
            </div>
            {/* No close button here, so no room is kept for one. */}
            <div className="min-w-0 flex-1 px-8 py-7">
              <div className="max-w-[640px]">
                <SettingRow title="Your name">
                  <PreferredNameControl presentation={SAMPLE_ADA} value="Ada" onChange={async () => undefined} testIdPrefix={`states-name-${theme}`} />
                </SettingRow>
                <SettingRow title="Editor font" modified onReset={noop}>
                  <SegmentedControl label="Editor font" value="serif" options={EDITOR_FONT_OPTIONS} onChange={noop} />
                </SettingRow>
              </div>
            </div>
          </div>
        </Specimen>
      </Section>

      <Section part="theme-picker" title="Theme picker">
        <Specimen label="System chosen">
          <ThemeControl value="system" onChange={noop} />
        </Specimen>
        <Specimen label="Dark chosen, Light hovered">
          <div data-force-state="hover" data-force-target='[role="radio"]:nth-child(2)'>
            <ThemeControl value="dark" onChange={noop} />
          </div>
        </Specimen>
        <Specimen label="keyboard focus on the chosen">
          <div data-force-state="focus focus-visible" data-force-target='[aria-checked="true"]'>
            <ThemeControl value="light" onChange={noop} />
          </div>
        </Specimen>
        <Specimen label="changed, in its row: the dot and the reset">
          <div className="w-[560px]">
            <SettingRow title="Theme" modified onReset={noop}>
              <ThemeControl value="dark" onChange={noop} />
            </SettingRow>
          </div>
        </Specimen>
      </Section>

      <Section part="zoom-stepper" title="Zoom stepper">
        <Specimen label="100%">
          <ZoomSpecimen percent={100} />
        </Specimen>
        <Specimen label="+ hovered">
          <div data-force-state="hover" data-force-target='[aria-label="Zoom in"]'>
            <ZoomSpecimen percent={100} />
          </div>
        </Specimen>
        <Specimen label="keyboard focus on the value">
          <div data-force-state="focus focus-visible" data-force-target='[aria-label^="Reset zoom"]'>
            <ZoomSpecimen percent={110} />
          </div>
        </Specimen>
        <Specimen label="at the largest: + disabled">
          <ZoomSpecimen percent={300} atMost />
        </Specimen>
        <Specimen label="changed, in its row: the dot and the reset">
          <div className="w-[560px]">
            <SettingRow title="Zoom" modified onReset={noop}>
              <ZoomSpecimen percent={110} />
            </SettingRow>
          </div>
        </Specimen>
      </Section>

      {/* The page at Settings' content width, whatever this host's keys. */}
      <Section part="settings-keyboard" title="Settings: Keyboard">
        <Specimen label="Windows keys">
          <div className="w-[640px]">
            <KeyboardSettings platform="win32" devTools={false} />
          </div>
        </Specimen>
        <Specimen label="macOS keys, with dev tools">
          <div className="w-[640px]">
            <KeyboardSettings platform="darwin" devTools />
          </div>
        </Specimen>
      </Section>

      {/* Privacy's rows in the narrowest pane, an 840px window's, and the widest. */}
      <Section part="settings-privacy" title="Settings: Privacy">
        <Specimen label="narrowest pane: Diagnostics' buttons under its text; usage reports changed, keyboard focus on its switch">
          <div className="w-[504px]" data-force-state="focus focus-visible" data-force-target='[role="switch"][aria-label="Send usage reports"]'>
            <PrivacyRowsSpecimen />
          </div>
        </Specimen>
        <Specimen label="widest pane: every control beside its text">
          <div className="w-[640px]">
            <PrivacyRowsSpecimen />
          </div>
        </Specimen>
      </Section>

      <Section part="rails" title="Rails">
        <Specimen label="activity bar: Chats beside Files, selected; Search hovered; Graph focused">
          <div className="flex h-[400px] overflow-hidden rounded-lg border border-line">
            <div className="flex" data-force-state="hover" data-force-target={`[data-testid="activity-search"]`}>
              <div className="flex" data-force-state="focus-visible" data-force-target={`[data-testid="activity-graph"]`}>
                <ActivityBar views={VIEW_IDS} activeView="chats" sidebarVisible hasConflict={false} onSelectView={noop} onOpenSettings={noop} />
              </div>
            </div>
          </div>
        </Specimen>
        <Specimen label="layout toggles: side panel and About shown; About hidden">
          <div className="flex w-[480px] flex-col gap-2">
            <div className="overflow-hidden rounded-lg border border-line">
              <Titlebar primarySidebar={{ visible: true, onToggle: noop }} aboutSidebar={{ visible: true, onToggle: noop }} />
            </div>
            <div className="overflow-hidden rounded-lg border border-line">
              <Titlebar primarySidebar={{ visible: true, onToggle: noop }} aboutSidebar={{ visible: false, onToggle: noop }} />
            </div>
          </div>
        </Specimen>
      </Section>

      {/* A send shows only once it has taken a second, so the capture waits
          for the ring. */}
      <Section part="composer-sending" title="Composer sending">
        <Specimen label="at rest">
          <div className="w-[400px] rounded-lg border border-line bg-panel">
            <MentionComposer testIdPrefix={`states-composer-rest-${theme}`} composerId={`states-composer-rest-${theme}`}
              value={COMPOSER_DRAFT} sending={false} placeholder="Message #general" sendLabel="Send message"
              candidates={[]} onChange={noop} onSend={noop} />
          </div>
        </Specimen>
        <Specimen label="cannot send yet, or a send under a second">
          <div className="w-[400px] rounded-lg border border-line bg-panel">
            <MentionComposer testIdPrefix={`states-composer-disabled-${theme}`} composerId={`states-composer-disabled-${theme}`}
              value={COMPOSER_DRAFT} sending={false} disabled placeholder="Message #general" sendLabel="Send message"
              candidates={[]} onChange={noop} onSend={noop} />
          </div>
        </Specimen>
        <Specimen label="sending, after a second: a group, a message or a post's comments">
          <div className="w-[400px] rounded-lg border border-line bg-panel">
            <MentionComposer testIdPrefix={`states-composer-stream-${theme}`} composerId={`states-composer-stream-${theme}`}
              value={COMPOSER_DRAFT} sending placeholder="Message #general" sendLabel="Send message"
              candidates={[]} onChange={noop} onSend={noop} />
          </div>
        </Specimen>
        <Specimen label="sending, after a second: a new post">
          <div className="w-[560px]">
            <MentionComposer testIdPrefix={`states-composer-post-${theme}`} composerId={`states-composer-post-${theme}`}
              value={COMPOSER_DRAFT} sending surface="post" authorName="Ada" authorPresentation={SAMPLE_ADA} placeholder="What's happening in #general?"
              sendLabel="Start post" candidates={[]} onChange={noop} onSend={noop} />
          </div>
        </Specimen>
        <Specimen label="sending, after a second: a file's chats in About">
          <AboutPanelSpecimen>
            <ChatComposer testIdPrefix={`states-composer-about-${theme}`} composerId={`states-composer-about-${theme}`}
              value={COMPOSER_DRAFT} sending placeholder="Write a message…" sendLabel="Send message"
              onChange={noop} onSend={noop} />
          </AboutPanelSpecimen>
        </Specimen>
      </Section>

      <Section part="about-conversation" title="About a conversation">
        <Specimen label="a Group: who is here, the files it mentions, and its access checked">
          <AboutPanelSpecimen>
            <AboutHeader subject={ABOUT_GROUP} />
            <ConversationLinks view={ABOUT_MENTIONS} />
            <AboutAccessView view={{ status: "ready", answer: ABOUT_CHAT_ACCESS }} expanded onToggle={noop} onRetry={noop}
              onMore={noop} setup={ACCESS_UNEXPLAINED} noun="chat" />
          </AboutPanelSpecimen>
        </Specimen>
        <Specimen label="a person, with Access closed">
          <AboutPanelSpecimen>
            <AboutHeader subject={{ ...ABOUT_GROUP, kind: "person", name: "Sam Rivera", present: ABOUT_PRESENT.slice(0, 1) }} />
            <ConversationLinks view={{ ...ABOUT_MENTIONS, files: ABOUT_MENTIONED.slice(1, 2) }} />
            <AboutAccessView view={{ status: "loading" }} expanded={false} onToggle={noop} onRetry={noop} onMore={noop}
              setup={ACCESS_UNEXPLAINED} noun="chat" />
          </AboutPanelSpecimen>
        </Specimen>
        <Specimen label="an agent, alone: no file mentioned and no share includes it">
          <AboutPanelSpecimen>
            <AboutHeader subject={{ ...ABOUT_GROUP, kind: "agent", name: "Nova", present: [] }} />
            <ConversationLinks view={{ ...ABOUT_MENTIONS, files: [] }} />
            <AboutAccessView view={{ status: "ready", answer: { ...ABOUT_CHAT_ACCESS, rows: [] } }} expanded onToggle={noop}
              onRetry={noop} onMore={noop} setup={ACCESS_UNEXPLAINED} noun="chat" />
          </AboutPanelSpecimen>
        </Specimen>
        <Specimen label="unknown, then gone">
          <AboutPanelSpecimen>
            <AboutAccessView view={{ status: "ready", answer: ABOUT_ACCESS_UNKNOWN }} expanded onToggle={noop} onRetry={noop}
              onMore={noop} setup={ACCESS_UNEXPLAINED} noun="chat" />
            <AboutAccessView view={{ status: "ready", answer: { ...ABOUT_ACCESS_UNKNOWN, visibility: "missing", unknownReason: null } }} expanded
              onToggle={noop} onRetry={noop} onMore={noop} setup={ACCESS_UNEXPLAINED} noun="chat" />
          </AboutPanelSpecimen>
        </Specimen>
      </Section>

      <Section part="about-conversation-links" title="About a conversation: Links">
        <Specimen label="a file hovered, keyboard focus on another, and more to read">
          <div data-force-state="hover" data-force-target='[data-path="data/funnel.csv"]'>
            <div data-force-state="focus focus-visible" data-force-target={`[data-path="${ABOUT_PATH}"]`}>
              <AboutPanelSpecimen>
                <ConversationLinks view={{ ...ABOUT_MENTIONS, more: true }} />
              </AboutPanelSpecimen>
            </div>
          </div>
        </Specimen>
        <Specimen label="gathering while the conversation's link index builds">
          <AboutPanelSpecimen>
            <ConversationLinks view={{ ...ABOUT_MENTIONS, files: ABOUT_MENTIONED.slice(0, 1), building: true, partial: true }} />
          </AboutPanelSpecimen>
        </Specimen>
        <Specimen label="a list that may be missing files">
          <AboutPanelSpecimen>
            <ConversationLinks view={{ ...ABOUT_MENTIONS, files: ABOUT_MENTIONED.slice(0, 2), partial: true }} />
          </AboutPanelSpecimen>
        </Specimen>
        <Specimen label="loading, a failed read with its words in Notices, then a conversation dohc does not list">
          <AboutPanelSpecimen>
            <ConversationLinks view={{ status: "loading" }} />
            <ConversationLinks view={{ status: "failed" }} />
            <ConversationLinks view={{ status: "unlisted" }} />
          </AboutPanelSpecimen>
        </Specimen>
      </Section>

      {/* A CSV and a text file draw their save state, Share and controls in
          the tab row, as a document does: a calm save state says so only to
          screen readers. */}
      <Section part="file-view-actions" title="File view actions" menusAtRest>
        {FILE_VIEW_CSV_STATES.map((specimen) => (
          <Specimen key={specimen.label} label={`CSV ${specimen.label}`} className="w-full">
            <TabRowActionsSpecimen width="w-full" path="data/funnel.csv">
              <CsvViewActions onShare={noop} onModeChange={noop} onImport={noop} {...specimen.view} />
            </TabRowActionsSpecimen>
          </Specimen>
        ))}
        {FILE_VIEW_TEXT_STATES.map((specimen) => (
          <Specimen key={specimen.label} label={`text ${specimen.label}`} className="w-full">
            <TabRowActionsSpecimen width="w-full" path="src/useFunnel.ts">
              <TextViewActions testId="view-text" onShare={noop} saveState={specimen.saveState} />
            </TabRowActionsSpecimen>
          </Specimen>
        ))}
        <Specimen label="split: text failed beside a CSV in Raw" className="w-full">
          <FileViewSplitSpecimen
            left={{ path: "src/useFunnel.ts", actions: <TextViewActions testId="view-text" onShare={noop} saveState={FILE_VIEW_FAILED} /> }}
            right={{
              path: "data/funnel.csv",
              actions: <CsvViewActions onShare={noop} onModeChange={noop} onImport={noop} saveState={SAVED_HERE} mode="raw" />,
            }}
          />
        </Specimen>
      </Section>

      {/* Offers sit in space already there: a folder row's glyph, the tab
          row's end, a row floating under a pasted line, the space before a
          post's Send, and above a message composer's Send. */}
      <Section part="offers" title="Offers" menusAtRest>
        <Specimen label="an app folder in Files: at rest, selected, focused">
          <ul role="tree" aria-label="App folders" className="m-0 w-64 list-none rounded-lg border border-line bg-panel py-1">
            <Row name="trip-planner" app />
            <Row name="signup" app selected />
            <Row name="dashboard" app force="focus-visible" />
          </ul>
        </Specimen>
        <Specimen label="Run in the tab row of an app's entry file" className="w-full">
          <TabRowActionsSpecimen width="w-full" path="trip-planner/index.html">
            <ViewActions onShare={noop} onRun={noop} />
          </TabRowActionsSpecimen>
        </Specimen>
        <Specimen label="a URL pasted on its own line, Link pressed: Link focused, Plain text focused, then Undo after Plain text">
          <div className="flex flex-col gap-3">
            {(["link", "plain"] as const).map((focused) => (
              <UrlOfferSpecimen key={focused} force={focused === "link" ? "url-paste-link" : "url-paste-plain"} />
            ))}
            <UrlOfferSpecimen chosen />
          </div>
        </Specimen>
        <Specimen label="the agent picked in a new post: runs, working, paused, dispatch off, no runner, unknown">
          <div className="flex flex-col gap-3">
            {AGENT_OFFER_STATES.map((state) => (
              <AgentOfferComposer key={state} state={state} surface="post" id={`states-agent-post-${state}-${theme}`} />
            ))}
          </div>
        </Specimen>
        <Specimen label="the agent picked in a message or comment: the same states, above Send">
          <div className="flex flex-col gap-3">
            {AGENT_OFFER_STATES.map((state) => (
              <AgentOfferComposer key={state} state={state} surface="stream" id={`states-agent-stream-${state}-${theme}`} />
            ))}
          </div>
        </Specimen>
        <Specimen label="Set up focused; above a reply bar; then a narrow pane">
          <div className="flex flex-col gap-3">
            <AgentOfferComposer state="no-command" surface="post" id={`states-agent-post-focus-${theme}`} focus />
            <AgentOfferComposer state="runner-off" surface="stream" id={`states-agent-stream-focus-${theme}`} focus />
            <AgentOfferComposer state="runs" surface="stream" id={`states-agent-stream-replying-${theme}`} replying />
            <AgentOfferComposer state="runs" surface="post" id={`states-agent-post-narrow-${theme}`} width="w-[300px]" />
            <AgentOfferComposer state="paused" surface="stream" id={`states-agent-stream-narrow-${theme}`} width="w-[300px]" />
            <AgentOfferComposer state="no-command" surface="stream" id={`states-agent-stream-narrow-setup-${theme}`} width="w-[300px]" />
          </div>
        </Specimen>
      </Section>

      {/* A workspace CSV past the preview's cap: the count, then Import to
          SQLite, which runs the tab row's import and is busy as it is. */}
      <Section part="csv-bound" title="CSV offer">
        <Specimen label="at rest">
          <CsvPreviewBound rowCount={1240} onImport={noop} />
        </Specimen>
        <Specimen label="hovered">
          <div data-force-state="hover" data-force-target="button">
            <CsvPreviewBound rowCount={1240} onImport={noop} />
          </div>
        </Specimen>
        <Specimen label="keyboard focus">
          <div data-force-state="focus-visible" data-force-target="button">
            <CsvPreviewBound rowCount={1240} onImport={noop} />
          </div>
        </Specimen>
        <Specimen label="busy: the import running">
          <CsvPreviewBound rowCount={1240} onImport={noop} importing />
        </Specimen>
      </Section>

      {/* The body's H1 is the editor's, so the folded specimens show the
          row above it alone. */}
      <Section part="page-identity" title="Page identity">
        <Specimen label="an H1 opens the body: the title folds, at rest">
          <TopmatterSpecimen>
            <PageIdentity body={"# Q3 product plan\n"} onChange={noop} filenameStem="product-plan" />
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="folded, hovered: Add icon and Add title">
          <TopmatterSpecimen>
            <div data-force-state="hover" data-force-target={`[data-testid="page-identity"]`}>
              <PageIdentity body={"# Q3 product plan\n"} onChange={noop} filenameStem="product-plan" />
            </div>
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="folded, focused: Add icon and Add title in place, so nothing below moves">
          <TopmatterSpecimen>
            <div data-force-state="focus-within" data-force-target={`[data-testid="page-identity"]`}>
              <div data-force-state="focus" data-force-target={`[data-testid="page-title"]`}>
                <PageIdentity body={"# Q3 product plan\n"} onChange={noop} filenameStem="product-plan" />
              </div>
            </div>
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="a title property">
          <TopmatterSpecimen>
            <PageIdentity body={"---\ntitle: Q3 product plan\n---\n\n# Goals\n"} onChange={noop} filenameStem="product-plan" />
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="no H1: the file name in place of a title">
          <TopmatterSpecimen>
            <PageIdentity body={"Q3 notes\n"} onChange={noop} filenameStem="product-plan" />
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="pills at rest">
          <TopmatterSpecimen>
            <PropertiesPanel body={PILLS} onChange={noop} />
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="pill hovered: its ×">
          <TopmatterSpecimen>
            <div data-force-state="hover" data-force-target={`[data-testid="property-row"]`}>
              <PropertiesPanel body={PILLS} onChange={noop} />
            </div>
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="pill focused: its value, and its ×">
          <TopmatterSpecimen>
            <div data-force-state="focus-within" data-force-target={`[data-testid="property-row"]`}>
              <div data-force-state="focus" data-force-target={`[data-testid="property-value"]`}>
                <PropertiesPanel body={PILLS} onChange={noop} />
              </div>
            </div>
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="a long value: an ellipsis, all of it in the tooltip">
          <TopmatterSpecimen>
            <PropertiesPanel body={LONG_PILL} onChange={noop} />
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="reserved name, typed">
          <TopmatterSpecimen>
            <ReservedPillSpecimen />
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="duplicate name">
          <TopmatterSpecimen>
            <PropertiesPanel body={"---\nowner: Sam\nOwner: Ada\n---\n"} onChange={noop} />
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="locked: the block must be edited as text">
          <TopmatterSpecimen>
            {/* Written on one line, the block cannot change one property
                without rewriting the others. */}
            <PropertiesPanel body={"---\n{owner: Sam, status: Draft}\n---\n"} onChange={noop} />
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="set by an automation">
          <TopmatterSpecimen>
            <PropertiesPanel body={PILLS} onChange={noop} fieldMarks={new Map([["status", ["Stamp the status"]]])} />
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="+ keyboard focus">
          <TopmatterSpecimen>
            <div data-force-state="focus-visible" data-force-target={`[data-testid="property-add"]`}>
              <PropertiesPanel body={PILLS} onChange={noop} />
            </div>
          </TopmatterSpecimen>
        </Specimen>
        <Specimen label="the + alone, the pointer over the page's top">
          <div data-force-state="hover" data-force-target=".group\/topmatter">
            <TopmatterSpecimen>
              <PropertiesPanel body={"Q3 notes\n"} onChange={noop} />
            </TopmatterSpecimen>
          </div>
        </Specimen>
      </Section>

      <Section part="settings-sync" title="Settings: Sync and sharing">
        <Specimen label="signed in, syncing, on a private server; keyboard focus on Disconnect">
          <div className="w-[640px]" data-force-state="focus focus-visible" data-force-target='[data-testid="cloud-disconnect"]'>
            <CloudSyncSettings workspaceId="ws-trip" cloud={settingsCloud({ ...CLOUD_SIGNED_IN, networkAccess: "private", workspaceSynced: true, workspaceSyncConnected: true })} />
          </div>
        </Specimen>
        <Specimen label="signed in, not syncing">
          <div className="w-[640px]">
            <CloudSyncSettings workspaceId="ws-trip" cloud={settingsCloud(CLOUD_SIGNED_IN)} />
          </div>
        </Specimen>
        <Specimen label="sync off: paused by you">
          <div className="w-[640px]">
            <CloudSyncSettings workspaceId="ws-trip" cloud={settingsCloud({ ...CLOUD_SIGNED_IN, syncPause: SYNC_PAUSED_BY_YOU })} />
          </div>
        </Specimen>
        <Specimen label="sync off: paused by an agent">
          <div className="w-[640px]">
            <CloudSyncSettings workspaceId="ws-trip" cloud={settingsCloud({ ...CLOUD_SIGNED_IN, syncPause: SYNC_PAUSED_BY_AGENT })} />
          </div>
        </Specimen>
        <Specimen label="sync off: paused under this computer's earlier id">
          <div className="w-[640px]">
            <CloudSyncSettings workspaceId="ws-trip" cloud={settingsCloud({ ...CLOUD_SIGNED_IN, syncPause: SYNC_PAUSED_BY_ANOTHER })} />
          </div>
        </Specimen>
        <Specimen label="turning sync off: the switch holds until main answers">
          <div className="w-[640px]">
            <SettingRow title="Sync this workspace">
              <SwitchControl label="Sync this workspace" checked={false} busy disabled onChange={noop} />
            </SettingRow>
          </div>
        </Specimen>
        <Specimen label="sync on, account unconfirmed: not syncing, with Try again">
          <div className="w-[640px]">
            <CloudSyncSettings workspaceId="ws-trip" cloud={settingsCloud({ ...CLOUD_SIGNED_IN, workspaceSynced: true })} />
          </div>
        </Specimen>
        <Specimen label="protected files: the passphrase field and its error">
          <div className="w-[640px]">
            <ProtectedFilesRow
              secretState="protected-key-present"
              purpose="protect"
              passphrase="1234567"
              error="Enter at least 8 characters to protect synced secrets."
              busy={false}
              onStart={noop}
              onPassphrase={noop}
              onSubmit={noop}
            />
          </div>
        </Specimen>
        <Specimen label="a shared view: the account, no switch">
          <div className="w-[640px]">
            <CloudSyncSettings workspaceId="ws-trip" sharedView cloud={settingsCloud(CLOUD_SIGNED_IN)} />
          </div>
        </Specimen>
        <Specimen label="signed out">
          <div className="w-[640px]">
            <CloudSyncSettings workspaceId="ws-trip" cloud={settingsCloud({ connected: false })} />
          </div>
        </Specimen>
        <Specimen label="signed out, paused by you: turning sync on needs the server">
          <div className="w-[640px]">
            <CloudSyncSettings
              workspaceId="ws-trip"
              cloud={settingsCloud({ connected: false, workspaceSyncOwned: true, workspaceSynced: false, syncPause: SYNC_PAUSED_BY_YOU })}
            />
          </div>
        </Specimen>
        <Specimen label="the status still loading">
          <div className="w-[640px]">
            <CloudSyncSettings workspaceId="ws-trip" cloud={settingsCloud(null)} />
          </div>
        </Specimen>
        <Specimen label="the status unreadable">
          <div className="w-[640px]">
            <CloudSyncSettings workspaceId="ws-trip" cloud={{ ...settingsCloud(null), unreadable: true }} />
          </div>
        </Specimen>
      </Section>

      {/* A CSV's rows and columns: numbers at the right in mono, row
          numbers in the gutter, and each row's and column's actions only on
          hover or focus. A database table: each column's type as an icon,
          the active cell, the editing cell, a sort, and the read-only mark. */}
      <Section part="data-grid" title="Data grid" menusAtRest>
        <Specimen label="CSV at rest: numbers, Add row and Add column">
          <CsvGridSpecimen />
        </Specimen>
        <Specimen label="CSV a hovered row, pointer on Delete row">
          <div data-force-state="hover" data-force-target="tbody tr:nth-child(2)">
            <div data-force-state="hover" data-force-target="tbody tr:nth-child(2) [data-testid=csv-delete-row]">
              <CsvGridSpecimen />
            </div>
          </div>
        </Specimen>
        <Specimen label="CSV a hovered header">
          <div data-force-state="hover" data-force-target="thead th:nth-child(2)">
            <CsvGridSpecimen />
          </div>
        </Specimen>
        {/* The input holds focus, so its row and cell hold it within: the
            same three states a person's click or Tab gives. */}
        <Specimen label="CSV a focused cell">
          <div data-force-state="focus-within" data-force-target="tbody tr:nth-child(1)">
            <div data-force-state="focus-within" data-force-target="tbody tr:nth-child(1) td:nth-child(2)">
              <div data-force-state="focus focus-visible" data-force-target="tbody tr:nth-child(1) td:nth-child(2) input">
                <CsvGridSpecimen />
              </div>
            </div>
          </div>
        </Specimen>
        <Specimen label="CSV read-only">
          <CsvGridSpecimen locked />
        </Specimen>
        <Specimen label="CSV empty">
          <div className="flex h-44 w-80 flex-col">
            <CsvGridSpecimen rows={[]} />
          </div>
        </Specimen>
        <Specimen label="CSV the preview's bound">
          <CsvPreviewBound rowCount={1240} />
        </Specimen>
        <Specimen label="database at rest: text, numbers, bytes and an untyped column">
          <DatabaseGridSpecimen />
        </Specimen>
        <Specimen label="database sorted by count, descending">
          <DatabaseGridSpecimen sort={{ column: "count", direction: "desc" }} />
        </Specimen>
        {/* The cell holds focus itself, as an arrow key or a click leaves it. */}
        <Specimen label="database the active cell">
          <div data-force-state="focus focus-visible focus-within" data-force-target="tbody tr:nth-child(2) td:nth-child(2)">
            <DatabaseGridSpecimen />
          </div>
        </Specimen>
        <Specimen label="database the editing cell">
          <div data-force-state="focus-within" data-force-target="tbody tr:nth-child(2) td:nth-child(2)">
            <div data-force-state="focus focus-visible" data-force-target="tbody tr:nth-child(2) td:nth-child(2) input">
              <DatabaseGridSpecimen editing />
            </div>
          </div>
        </Specimen>
        <Specimen label="database read-only, shared with you to read" className="w-full">
          <TabRowActionsSpecimen width="w-full" path="data/funnel.sqlite">
            <DatabaseViewActions onShare={noop} readOnlyReason="This database is shared with you to read." />
            <div className="bg-bg px-4 pt-3">
              <DatabaseGridSpecimen readOnly />
            </div>
          </TabRowActionsSpecimen>
        </Specimen>
      </Section>

      {/* Last, so the parts above keep their places. A strip too narrow for
          its tabs fades each edge it can still scroll past, and none it has
          reached; its active tab sits clear of the fades. */}
      <Section part="tab-strip-overflow" title="Tab strip, overflowing" menusAtRest>
        {(
          [
            ["start", "at the start: the end fades", "itinerary.md"],
            ["middle", "scrolled to the middle: both edges fade", "flights.md"],
            ["end", "at the end: the start fades", "notes.md"],
          ] as const
        ).map(([at, label, active]) => (
          <Specimen key={at} label={label} className="w-full">
            <div className="w-[360px] overflow-hidden rounded-lg border border-line">
              <OverflowStripSpecimen
                groupId={`overflow-${at}`}
                groupNumber={1}
                active={active}
                testId={`states-tab-strip-overflow-${at}-${theme}`}
              />
            </div>
          </Specimen>
        ))}
        <Specimen label="split: the active group's line over its fades, then the other group">
          <div className="flex w-[640px] overflow-hidden rounded-lg border border-line">
            <EditorGroupLayout
              groups={[
                { id: "first", size: 1, content: <OverflowStripSpecimen groupId="first" groupNumber={1} active="packing-list.md" /> },
                { id: "second", size: 1, content: <OverflowStripSpecimen groupId="second" groupNumber={2} active="flights.md" /> },
              ]}
              activeGroupId="first"
              onFocusGroup={noop}
              onResizeGroups={noop}
            />
          </div>
        </Specimen>
      </Section>

      {/* Last, so the parts above keep their places. Each strip holds a tab
          list, so the part holds them at rest. */}
      <Section part="tab-glyphs" title="Tab glyphs" menusAtRest>
        <Specimen label="files: a document, active and unsaved; a CSV; a drawing; a database" className="w-full">
          <GlyphStripBox tabs={["trip/plan.md", "budget.csv", "map.excalidraw", "ledger.db"]} active="trip/plan.md" dirty />
        </Specimen>
        <Specimen label="objects: a group, active; an app; a Collection; History" className="w-full">
          <GlyphStripBox tabs={[STRIP_GROUP, siteTabPath("trip-planner"), STRIP_COLLECTION, HISTORY_TAB_PATH]} active={STRIP_GROUP} />
        </Specimen>
        <Specimen label="a page with an emoji, active; a long name, cut off" className="w-full">
          <GlyphStripBox tabs={["launch.md", STRIP_LONG]} active="launch.md" />
        </Specimen>
        <Specimen label="split: the active group, then one whose active tab recedes" className="w-full">
          <div className="flex w-full overflow-hidden rounded-lg border border-line">
            <EditorGroupLayout
              groups={[
                { id: "first", size: 1, content: <GlyphStrip groupId="first" groupNumber={1} tabs={["trip/plan.md", "ledger.db"]} active="trip/plan.md" /> },
                { id: "second", size: 1, content: <GlyphStrip groupId="second" groupNumber={2} tabs={[STRIP_GROUP, siteTabPath("trip-planner")]} active={STRIP_GROUP} /> },
              ]}
              activeGroupId="first"
              onFocusGroup={noop}
              onResizeGroups={noop}
            />
          </div>
        </Specimen>
      </Section>

      {/* The catalog is a listbox the textarea controls, not a menu, so it
          is drawn open here under its composer instead of being opened. */}
      <Section part="composer-poll" title="Composer catalog and poll">
        <Specimen label="/ in a new post: Poll active">
          <ComposerCatalogSpecimen theme={theme} surface="post" />
        </Specimen>
        <Specimen label="/ in a group's chat">
          <ComposerCatalogSpecimen theme={theme} surface="stream" />
        </Specimen>
        <Specimen label="a new post with a poll; the second choice repeats the first">
          <div className="w-[560px]">
            <MentionComposer testIdPrefix={`states-poll-post-${theme}`} composerId={`states-poll-post-${theme}`}
              value={POLL_QUESTION} sending={false} surface="post" authorName="Ada" authorPresentation={SAMPLE_ADA}
              placeholder="What's happening in #general?" sendLabel="Start post" candidates={[]} fileCandidates={STATES_FILES}
              onChange={noop} onSend={noop} poll={{ choices: ["Porto", "Porto ", "Lisbon"], open: true }} onPollChange={noop} />
          </div>
        </Specimen>
        <Specimen label="a narrow new post with a poll: Poll without its label">
          <div className="w-[400px]">
            <MentionComposer testIdPrefix={`states-poll-narrow-${theme}`} composerId={`states-poll-narrow-${theme}`}
              value={POLL_QUESTION} sending={false} surface="post" authorName="Ada" authorPresentation={SAMPLE_ADA}
              placeholder="What's happening in #general?" sendLabel="Start post" candidates={[]} fileCandidates={STATES_FILES}
              onChange={noop} onSend={noop} poll={{ choices: ["Lisbon", "Porto"], open: true }} onPollChange={noop} />
          </div>
        </Specimen>
        <Specimen label="a comment asking the agent, with a poll, replying to a message: the offer floats over the stack">
          {/* A stream composer floats its offer above its top edge, into the
              room the end of its conversation keeps, so it gets that room. */}
          <div className="w-[400px] rounded-lg border border-line bg-panel pt-9">
            <MentionComposer testIdPrefix={`states-poll-stream-${theme}`} composerId={`states-poll-stream-${theme}`}
              value={`@agent ${POLL_QUESTION.toLowerCase()}`} sending={false} placeholder="Write a comment…  @ to mention"
              sendLabel="Send message" candidates={[]} fileCandidates={STATES_FILES} onChange={noop} onSend={noop}
              agentOffer={agentOffer("runs")} onSetUpAgent={noop}
              above={
                <ComposerModeBar testId={`states-poll-stream-${theme}-replying-mode`} cancelTestId={`states-poll-stream-${theme}-replying-cancel`}
                  cancelLabel="Cancel reply" onCancel={noop}>Replying to Sam ·</ComposerModeBar>
              }
              poll={{ choices: ["Lisbon", "Porto", "Madeira"], open: true }} onPollChange={noop} />
          </div>
        </Specimen>
      </Section>

      {/* Last, so the parts above keep their places. A new part goes after. */}
      <Section part="chat-messages" title="Chat messages">
        <Specimen label="a file's chats in About: a run, its second message hovered at 12:45 PM">
          <ChatRunSpecimen />
        </Specimen>
      </Section>

      <Section part="ref" title="Reference">
        <Specimen label="rest, hover, keyboard focus, selected, missing">
          <Ref path="data/funnel.csv" onOpen={noop} />
          <span data-force-state="hover" data-force-target="button"><Ref path="data/funnel.csv" onOpen={noop} /></span>
          <span data-force-state="focus-visible" data-force-target="button"><Ref path="data/funnel.csv" onOpen={noop} /></span>
          <Ref path="data/funnel.csv" selected onOpen={noop} />
          <Ref path="research/competitors.md" missing onOpen={noop} />
        </Specimen>
        <Specimen label="a title, with and without its folder; a heading">
          <Ref path="research/competitors.md" title="Competitor landscape" />
          <Ref path="research/competitors.md" title="Competitor landscape" folder />
          <Ref path="research/competitors.md" heading="pricing" />
        </Specimen>
        <Specimen label="a long name in a narrow row" className="w-56">
          <Ref path={STRIP_LONG} folder />
        </Specimen>
        <Specimen label="in a sentence">
          <p className="m-0 w-[420px] text-[14px] leading-[22px] text-ink">
            Numbers are in <Ref path="data/funnel.csv" onOpen={noop} /> and the flow is sketched in{" "}
            <Ref path="sketches/flow.excalidraw" onOpen={noop} />.
          </p>
        </Specimen>
        <Specimen label="kind">
          <div className="flex w-[420px] flex-wrap gap-1.5">
            {KINDS.map((kind) => (
              <Ref key={kind.displayKind} path={KIND_SAMPLES[kind.displayKind]} kind={kind} />
            ))}
          </div>
        </Specimen>
      </Section>

      <Section part="agent-color" title="Agent color">
        <Specimen label="a person and two agents, Default and plum; keyboard focus on the plum agent's avatar">
          <div data-force-state="focus-visible" data-force-target='[data-message-id="color-orbit"] [data-testid="agent-color-trigger"]'>
            <AgentColorContext.Provider value={noop}>
              <AboutPanelSpecimen>
                <div className="flex h-[220px] flex-col">
                  <ChatMessageList testIdPrefix={`states-agent-color-${theme}`} messages={AGENT_COLOR_CHAT} loading={false} emptyLabel="No messages yet." />
                </div>
              </AboutPanelSpecimen>
            </AgentColorContext.Provider>
          </div>
        </Specimen>
        <Specimen label="open, plum chosen, keyboard focus on Default">
          <div className={`w-fit ${SHADOW_ROOM}`} data-force-state="focus-visible" data-force-target='[aria-label="Default"]'>
            <AgentColorSwatches label="Color for Orbit" value="plum" onChange={noop} />
          </div>
        </Specimen>
      </Section>
    </section>
  );
}

const POLL_QUESTION = "Where should we hold the offsite?";
const STATES_FILES = [{ path: "Plans/offsite.md", label: "offsite" }];

function ComposerCatalogSpecimen(props: { theme: "light" | "dark"; surface: "post" | "stream" }) {
  const id = `states-catalog-${props.surface}-${props.theme}`;
  const composer = (
    <MentionComposer testIdPrefix={id} composerId={id} value={`${POLL_QUESTION} /`} sending={false}
      surface={props.surface} authorName="Ada" authorPresentation={SAMPLE_ADA}
      placeholder="Message #general" sendLabel="Send message" candidates={[]} fileCandidates={STATES_FILES}
      onChange={noop} onSend={noop} poll={null} onPollChange={noop} />
  );
  return (
    <div className={`flex flex-col gap-1.5 pb-10 ${props.surface === "post" ? "w-[560px]" : "w-[400px]"}`}>
      {props.surface === "post" ? composer : <div className="flex flex-col rounded-lg border border-line bg-panel">{composer}</div>}
      <ul role="listbox" aria-label="Add to message" className={`${MENU_FRAME} w-64`}>
        <ComposerCatalogOptions listboxId={`${id}-mentions`} testIdPrefix={id} rows={["poll", "mention", "file"]}
          highlight={0} onPick={noop} onHover={() => noop} />
      </ul>
    </div>
  );
}

const GRID_FUNNEL = [
  ["stage", "count", "conversion"],
  ["Visited", "4820", "1.00"],
  ["Signed up", "1290", "0.27"],
  ["Created doc", "860", "0.18"],
  ["Invited agent", "340", "0.07"],
];

function CsvGridSpecimen(props: { rows?: string[][]; locked?: boolean }) {
  const rows = props.rows ?? GRID_FUNNEL;
  return (
    <CsvTable rows={rows} columns={csvColumns(rows)} locked={props.locked ?? false}
      onUpdateCell={noop} onEndEdit={noop} onDeleteRow={noop} onDeleteColumn={noop} onAddRow={noop} onAddColumn={noop} />
  );
}

const GRID_DATABASE: DatabaseSnapshotResult["tables"][number] = {
  name: "funnel",
  columns: [
    { name: "stage", type: "TEXT" },
    { name: "count", type: "INTEGER", nullable: false },
    { name: "conversion", type: "REAL" },
    { name: "export", type: "BLOB" },
    { name: "note", type: "" },
  ],
  rows: [
    { __dohc_rowid: 1, stage: "Visited", count: 4820, conversion: 1, export: "<blob 16 bytes>", note: null },
    { __dohc_rowid: 2, stage: "Signed up", count: 1290, conversion: 0.27, export: "<blob 16 bytes>", note: "trial" },
    { __dohc_rowid: 3, stage: "Created doc", count: 860, conversion: 0.18, export: null, note: null },
    { __dohc_rowid: 4, stage: "Invited agent", count: 340, conversion: 0.07, export: null, note: "team" },
  ],
  nextOffset: null,
};
const GRID_DATABASE_ROWS = GRID_DATABASE.rows.map((row, sourceIndex) => ({ row, sourceIndex }));

function DatabaseGridSpecimen(props: {
  sort?: ComponentProps<typeof DatabaseGrid>["sort"];
  editing?: boolean;
  readOnly?: boolean;
}) {
  // The rows are already in descending count, as the sort specimen shows them.
  return (
    <DatabaseGrid
      table={GRID_DATABASE}
      rows={GRID_DATABASE_ROWS}
      readOnly={props.readOnly ?? false}
      editing={props.editing ? editOf(GRID_DATABASE, GRID_DATABASE.rows[1]!, "stage") : null}
      draftRef={{ current: "Signed in" }}
      sort={props.sort ?? null}
      onSort={noop}
      onBeginEdit={noop}
      onCommit={noop}
      onCancel={noop}
    />
  );
}

const FILE_VIEW_FAILED = saveProblem("error", "dohc couldn't write the file.");

const FILE_VIEW_CSV_STATES: {
  label: string;
  view: Pick<ComponentProps<typeof CsvViewActions>, "saveState" | "mode" | "readOnly" | "truncated" | "importing">;
}[] = [
  { label: "saved, as a table", view: { saveState: SAVED_HERE, mode: "table" } },
  { label: "saving", view: { saveState: SAVING, mode: "table" } },
  { label: "failed", view: { saveState: FILE_VIEW_FAILED, mode: "table" } },
  { label: "read-only", view: { saveState: SAVED_HERE, mode: "table", readOnly: true } },
  { label: "too large", view: { saveState: SAVED_HERE, mode: "table", truncated: true } },
  { label: "raw", view: { saveState: SAVED_HERE, mode: "raw" } },
  { label: "importing", view: { saveState: SAVED_HERE, mode: "table", importing: true } },
];

const FILE_VIEW_TEXT_STATES: { label: string; saveState: SaveState }[] = [
  { label: "saved", saveState: SAVED_HERE },
  { label: "failed", saveState: FILE_VIEW_FAILED },
];

const CLOUD_SIGNED_IN: CloudStatusResult = {
  connected: true,
  email: "sam@hollis.studio",
  // Fixed, so the account avatar doesn't take this run's installation colour.
  ownPresentation: { group: "own", hue: "amber", self: true },
  serverUrl: "https://dohc.hollis.studio",
  relayUrl: "https://relay.hollis.studio",
  workspaceSynced: false,
  workspaceSyncConnected: false,
};
const SYNC_PAUSED_BY_YOU: CloudStatusResult["syncPause"] = {
  atMs: new Date(2026, 6, 8, 8, 42).getTime(),
  author: { kind: "person", personId: "local-sam", self: true },
};
// This computer's id file was unreadable, so it took a new id after the pause.
const SYNC_PAUSED_BY_ANOTHER: CloudStatusResult["syncPause"] = {
  atMs: new Date(2026, 6, 8, 8, 42).getTime(),
  author: { kind: "person", personId: "local-old", self: false },
};
const SYNC_PAUSED_BY_AGENT: CloudStatusResult["syncPause"] = {
  atMs: new Date(2026, 6, 8, 8, 42).getTime(),
  author: { kind: "agent", agentId: "codex", onBehalfOf: "human-sam", depth: 1 },
};
const settingsCloud = (status: CloudStatusResult | null): CloudSettings => ({
  status, unreadable: false, onChanged: noop, onConnect: noop, onError: noop, onAccountError: noop, onDeleteAccount: noop,
});

const SETTINGS_WORKSPACE = "C:\\Users\\ada\\Documents\\trip";
const EDITOR_FONT_OPTIONS = [
  { value: "sans", label: "Sans" },
  { value: "serif", label: "Serif" },
  { value: "mono", label: "Mono" },
];

// Appearance's zoom stepper keeps its existing Windows specimen text on every host.
function ZoomSpecimen(props: { percent: number; atMost?: boolean }) {
  return (
    <StepperControl
      setting="zoom"
      value={`${props.percent}%`}
      decrease={{ label: "Zoom out", keys: shortcutKeys("zoom-out", "win32"), onClick: noop }}
      reset={{ label: "Reset to 100%", to: "100%", keys: shortcutKeys("zoom-reset", "win32"), onClick: noop }}
      increase={{ label: "Zoom in", keys: shortcutKeys("zoom-in", "win32"), disabled: props.atMost, onClick: noop }}
    />
  );
}

const TRUST_OPTIONS = [
  { value: "trusted", label: "Trusted" },
  { value: "restricted", label: "Restricted Mode" },
];
const DIAGNOSTICS_BUTTON =
  "rounded-md border border-line bg-transparent px-3 py-1.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink";

// Privacy's rows as Settings draws them: a segmented control, two switches,
// and Diagnostics' three buttons, the widest controls in Settings.
function PrivacyRowsSpecimen() {
  return (
    <>
      <SettingRow title="Workspace trust" description="A trusted workspace runs its apps' dev and build commands, and starts agents, on this computer.">
        <div className="shrink-0 whitespace-nowrap">
          <SegmentedControl label="Workspace trust" value="trusted" options={TRUST_OPTIONS} onChange={noop} />
        </div>
      </SettingRow>
      <SettingRow
        title="Send usage reports"
        description="Counts when you open dohc, create or open a workspace, share, publish an app, or send a chat message. Includes a random ID for this installation. No names, content, or links."
        modified
        onReset={noop}
      >
        <SwitchControl label="Send usage reports" checked={false} onChange={noop} />
      </SettingRow>
      <SettingRow title="Send error reports" description="Sends an error's type and where in dohc's code it happened. No messages, file names, or other paths.">
        <SwitchControl label="Send error reports" checked onChange={noop} />
      </SettingRow>
      <SettingRow title="Diagnostics" description="Version, system, report settings, and recent problems. They stay on this computer until you copy or save them.">
        <button type="button" className={DIAGNOSTICS_BUTTON}>Show</button>
        <CopyButton label="Copy diagnostics" getText={() => ""} />
        <button type="button" className={DIAGNOSTICS_BUTTON}>Save…</button>
      </SettingRow>
    </>
  );
}

// A fixed day, so "today" and "since" never move the capture.
const USAGE_TODAY = "2026-10-07";
const usageCell = (count: number, counted = true) => ({ count, counted });
const usageRow = (capabilityId: string, label: string, doors: Partial<UsageRecordRow["doors"]>, lastUsed: string | null = null): UsageRecordRow => ({
  capabilityId, label, lastUsed,
  doors: { renderer: usageCell(0, false), cli: usageCell(0, false), mcp: usageCell(0, false), automation: usageCell(0, false), ...doors },
});
const USAGE_RECORD: Extract<UsageRecordResult, { status: "readable" }> = {
  status: "readable", enabled: true, file: "C:\\Users\\ada\\AppData\\Roaming\\dohc\\dohc-usage.json",
  since: "2026-09-12", incompleteDays: 1,
  rows: [
    usageRow("version.create", "Create a workspace version", { renderer: usageCell(41), cli: usageCell(2, false) }, "2026-10-07"),
    usageRow("file.kept.save", "Save a kept copy beside its file", { renderer: usageCell(3), cli: usageCell(1), mcp: usageCell(0) }, "2026-10-06"),
    usageRow("version.try", "Try changes in a workspace version", { renderer: usageCell(1) }, "2026-09-03"),
    usageRow("chat.post", "Post a chat message", { cli: usageCell(0), mcp: usageCell(0) }),
    usageRow("chat.export", "Export a chat", {}),
  ],
  setAside: null,
};

// Privacy's width for the card.
function UsageRecordSpecimen(props: { view: UsageRecordView }) {
  return (
    <div className="w-[560px] [&>section]:mt-0">
      <UsageRecordCard view={props.view} today={USAGE_TODAY} onSwitch={noop} onClear={noop} onRetry={noop}
        onStart={noop} onRestore={noop} />
    </div>
  );
}

// The drawing's prose edit, a code edit, and a rewrite that keeps its lines
// whole, through the same diff the History page runs.
const WORD_DIFFS = [
  {
    label: "prose: a word replaced, words added",
    path: "notes/product-plan.md",
    before: "## Goals\n\n- Ship the chats feed to the first beta group\n- Get a new person to their first document in under 30 seconds\n- Make agent activity readable at a glance\n\n## Workstreams\n",
    after: "## Goals\n\n- Ship the chats feed to the first beta group\n- Get a new person to their first document in under 20 seconds\n- Make agent activity readable at a glance, with who changed what\n\n## Workstreams\n",
  },
  {
    label: "code: changed tokens",
    path: "src/limits.ts",
    before: "export function limitFor(kind: string) {\n  const limit = 800;\n  return kind === \"history\" ? limit : limit / 2;\n}\n",
    after: "export function limitFor(kind: string, displayLimit?: number) {\n  const limit = displayLimit ?? 800;\n  return kind === \"history\" ? limit : Math.floor(limit / 2);\n}\n",
  },
  {
    label: "a rewritten line stays whole; a new line has no pair",
    path: "notes/trip.md",
    before: "# Trip\n\nThe meeting moved to Tuesday.\n",
    after: "# Trip\n\nBring snacks for everyone!\nTickets are in the shared folder.\n",
  },
].map((specimen) => ({ ...specimen, diff: computeTextDiff(specimen.before, specimen.after, 800) }));

const SHELF_APP: SitePackageInfo = {
  root: "trip-planner",
  title: "Trip planner",
  kind: "static",
  confidence: "high",
  entryPath: "trip-planner/index.html",
  configPath: null,
  packagePath: null,
  packageManager: null,
  scripts: {},
  configuredScripts: {},
  configuredPreviewMode: null,
  configuredBuildOutput: null,
  buildOutputs: [],
  sourceFiles: ["trip-planner/index.html"],
  shareManifest: { ok: false, reason: "no-runnable-artifact" },
  diagnostics: [],
  authority: { kind: "workspace" },
};

const SHELF_APPS: SitePackageInfo[] = [
  SHELF_APP,
  {
    ...SHELF_APP,
    root: "apps/funnel-dashboard",
    title: "Funnel dashboard",
    diagnostics: [{
      path: "apps/funnel-dashboard/dohc.json",
      severity: "warning",
      code: "invalid-config",
      message: "Configured preview commands run only in dev mode.",
    }],
  },
  {
    ...SHELF_APP,
    root: "shared-with-me/sam/signup-form",
    title: "Signup form",
    authority: { kind: "share", mountRoot: "shared-with-me/sam" },
  },
  { ...SHELF_APP, root: "notes/reading-list", title: "Reading list", confidence: "low" },
];

const SYNCED_STATUS: SyncStatusResult = {
  state: "synced",
  pendingChangeCount: 0,
  lastSyncedAtMs: null,
  liveSessionsGeneration: 0,
  historyRecordingUnavailable: false,
  historyShareView: false,
};

const TITLE_BAR_STATUSES: { label: string; syncStatus: SyncStatusResult; failedSaves: number }[] = [
  { label: "saved", syncStatus: SYNCED_STATUS, failedSaves: 0 },
  { label: "syncing", syncStatus: { ...SYNCED_STATUS, state: "syncing" }, failedSaves: 0 },
  { label: "a file couldn't save", syncStatus: SYNCED_STATUS, failedSaves: 1 },
  { label: "files couldn't save, during a sync pass", syncStatus: { ...SYNCED_STATUS, state: "syncing" }, failedSaves: 2 },
  { label: "server disconnected", syncStatus: { ...SYNCED_STATUS, state: "cloud-disconnected" }, failedSaves: 0 },
];

// `parts` renders only those parts, so a test renders only what it checks.
export function StatesPage(props: { parts?: ReadonlySet<string> }) {
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
        <ShownParts.Provider value={props.parts}>
          <Pane theme="light" />
          <Pane theme="dark" />
        </ShownParts.Provider>
      </div>
    </div>
  );
}
