import { AlertTriangle, CheckCircle2, MoreHorizontal } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { DocumentMenu } from "../DocumentMenu";
import { OverlayFrame } from "../Overlay";
import { ColorControl, HueControl, SwitchControl, TextControl } from "../settings/SettingRow";
import { CopyDetailsButton } from "../shell/copyDetails";
import { ConfirmDialogCard } from "../ui/ConfirmDialog";
import { CopyButton } from "../ui/CopyButton";
import { EmptyState, IconButton, Pill, PrimaryButton, SecondaryButton, SectionLabel } from "../ui/controls";
import { MoreMenu } from "../ui/MoreMenu";
import { SegmentedControl } from "../ui/SegmentedControl";
import { FolderChip, Step } from "../ui/Step";
import { AgentBadge } from "../workbench/AgentBadge";
import { AutomationBadge } from "../workbench/AutomationBadge";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { TreeRow, type VisibleRow } from "../workbench/Explorer";
import { LocalNoticeRow, WorkspaceErrorToast } from "../workbench/NoticeCenter";
import { PanelLoading } from "../workbench/PanelLoading";
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

function Section(props: { part: string; title: string; children: ReactNode }) {
  const { section, content } = useWholePixelHeight();
  return (
    <section ref={section} data-part={props.part}>
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

function Swatch(props: { label: string; className: string }) {
  return (
    <Specimen label={props.label}>
      <span className={`block size-8 rounded-md border border-line ${props.className}`} />
    </Specimen>
  );
}

const noop = () => undefined;

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
  focused?: boolean;
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
        focused={props.focused ?? false}
        tabbable={false}
        dropPreview={props.drop ? { kind: "move", role: "target" } : null}
        {...treeRowCallbacks}
      />
    </div>
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

      {/* The copied and refused ones are pressed by the capture; press them
          yourself on the page. */}
      <Section part="copy" title="Copy">
        <Specimen label="copy: rest, hover, copied, refused">
          <CopyButton getText={() => ""} testId={`states-copy-${theme}`} />
          <span data-force-state="hover" data-force-target="button">
            <CopyButton getText={() => ""} testId={`states-copy-hover-${theme}`} />
          </span>
          <CopyButton getText={() => "wss://relay.dohc.dev"} testId={`states-copy-copied-${theme}`} />
          <CopyButton
            getText={() => {
              throw new Error("nothing to copy");
            }}
            testId={`states-copy-refused-${theme}`}
          />
        </Specimen>
        <Specimen label="copy details: rest, icon, copied, icon copied">
          <CopyDetailsButton label="Copy details" details={() => ""} />
          <CopyDetailsButton iconOnly label="Copy details" details={() => ""} />
          <CopyDetailsButton
            label="Copy details"
            details={() => RELAY_ERROR}
            data-testid={`states-copy-details-copied-${theme}`}
          />
          <CopyDetailsButton
            iconOnly
            label="Copy details"
            details={() => RELAY_ERROR}
            data-testid={`states-copy-details-icon-copied-${theme}`}
          />
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
          <Row name="selected" selected />
          <Row name="active" active />
          <Row name="focused" focused />
          <Row name="drop target" folder drop />
        </ul>
      </Section>

      {/* Both menus are opened by the capture, and their boxes are tall
          enough for the open menu and its shadow. The ••• menu's first row
          takes keyboard focus when it opens; forcing focus there draws the
          same row the same way whether or not focus has since moved on. */}
      <Section part="menu" title="Menu">
        <Specimen label="rows: keyboard-active, hover, rest, disabled">
          <div
            className="flex h-56 w-56 items-start justify-end"
            data-force-state="focus"
            data-force-target="[role=menuitem]:nth-child(1)"
          >
            <div data-force-state="hover" data-force-target="[role=menuitem]:nth-child(2)">
              <MoreMenu label="More for Research" items={menuItems} testId={`states-menu-${theme}`} />
            </div>
          </div>
        </Specimen>
      </Section>

      <Section part="document-menu" title="Document menu">
        <div className="flex h-64 w-56 items-start justify-end">
          <DocumentMenu workspaceId="states" suggestedName="states" getMarkdown={() => null} />
        </div>
      </Section>

      <Section part="empty" title="Empty">
        <div className="flex h-40 w-64 flex-col rounded-lg border border-line bg-panel">
          <EmptyState title='No files match "budget".' hint="Try a shorter search.">
            <button type="button" className={KBD}>Clear search</button>
          </EmptyState>
        </div>
      </Section>

      <Section part="loading" title="Loading">
        <div className="flex h-40 w-64 flex-col rounded-lg border border-line bg-panel">
          <PanelLoading label="files" />
        </div>
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
