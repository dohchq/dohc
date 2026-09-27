import { AlertTriangle, CheckCircle2, MoreHorizontal } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { DocumentMenu } from "../DocumentMenu";
import { OverlayFrame } from "../Overlay";
import { SegmentedControl, SwitchControl, TextControl } from "../settings/SettingRow";
import { CopyDetailsButton } from "../shell/copyDetails";
import { ConfirmDialogCard } from "../ui/ConfirmDialog";
import { CopyButton } from "../ui/CopyButton";
import { EmptyState, IconButton, Pill, PrimaryButton, SecondaryButton, SectionLabel } from "../ui/controls";
import { TreeRow, type VisibleRow } from "../workbench/Explorer";
import { LocalNoticeRow, WorkspaceErrorToast } from "../workbench/NoticeCenter";
import { PanelLoading } from "../workbench/PanelLoading";
import { closeStatesPage } from "./statesRoute";

// Every shared part in every state, light beside dark, on one development
// page. It is the gallery for a person changing a part and the subject of the
// pixel baselines in e2e/states-page.spec.ts. Nothing here is product.
//
// The parts are the real ones, so a change to a part changes the capture.
// A state a part reaches through a prop (selected, active, disabled) is
// passed as that prop. A state the browser owns (hover, focus-visible,
// focus) is marked with `data-force-state`, and the capture forces it on
// that element through the browser's own pseudo-class forcing, so the
// part's own rules apply. `data-force-target` names a descendant when the
// part does not take the attribute itself. On the page itself, hover the
// parts.

const KBD = "rounded border border-line bg-bg px-1 font-mono text-[10px] text-subtle";

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
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

function DialogSpecimen() {
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
          testId="states-dialog"
          cancelTestId="states-dialog-cancel"
          confirmTestId="states-dialog-confirm"
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

const themeOptions = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function Pane(props: { theme: "light" | "dark" }) {
  return (
    <section
      data-theme={props.theme}
      data-testid={`states-${props.theme}`}
      aria-label={`${props.theme} theme`}
      className="flex min-w-0 flex-col gap-8 bg-bg p-6 text-ink"
    >
      <Section title="Surfaces and states">
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

      <Section title="Buttons">
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
        <Specimen label="copy: rest, hover">
          <CopyButton getText={() => ""} testId={`states-copy-${props.theme}`} />
          <span data-force-state="hover" data-force-target="button">
            <CopyButton getText={() => ""} testId={`states-copy-hover-${props.theme}`} />
          </span>
          <CopyDetailsButton label="Copy details" details={() => ""} />
          <CopyDetailsButton iconOnly label="Copy details" details={() => ""} />
        </Specimen>
        <Specimen label="segmented: rest, hover on first">
          <SegmentedControl label="Theme" value="dark" options={themeOptions} onChange={noop} />
          <span data-force-state="hover" data-force-target="[role=radio]">
            <SegmentedControl label="Theme" value="dark" options={themeOptions} onChange={noop} />
          </span>
        </Specimen>
        <Specimen label="switch: on, off, focus-visible, disabled">
          <SwitchControl label="Sync" checked onChange={noop} />
          <SwitchControl label="Sync" checked={false} onChange={noop} />
          <span data-force-state="focus-visible" data-force-target="[role=switch]">
            <SwitchControl label="Sync" checked onChange={noop} />
          </span>
          <SwitchControl label="Sync" checked disabled onChange={noop} />
        </Specimen>
      </Section>

      <Section title="Chips">
        <Specimen label="pill: neutral, success, warning, danger, agent">
          <Pill>12</Pill>
          <Pill className="text-success">Synced</Pill>
          <Pill className="text-warning">Waiting</Pill>
          <Pill className="text-danger">2 conflicts</Pill>
          <Pill className="text-agent">Agent</Pill>
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

      <Section title="Text inputs">
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

      <Section title="List rows">
        <ul role="tree" aria-label="Rows" className="m-0 w-64 list-none rounded-lg border border-line bg-panel py-1">
          <Row name="rest" folder />
          <Row name="hover" force="hover" />
          <Row name="selected" selected />
          <Row name="active" active />
          <Row name="focused" focused />
          <Row name="drop target" folder drop />
        </ul>
        <Specimen label="document menu">
          <div className="flex h-48 w-56 items-start justify-end">
            <DocumentMenu workspaceId="states" suggestedName="states" getMarkdown={() => null} />
          </div>
        </Specimen>
      </Section>

      <Section title="Empty and loading">
        <div className="flex h-40 w-64 flex-col rounded-lg border border-line bg-panel">
          <EmptyState title='No files match "budget".' hint="Try a shorter search.">
            <button type="button" className={KBD}>Clear search</button>
          </EmptyState>
        </div>
        <div className="flex h-40 w-64 flex-col rounded-lg border border-line bg-panel">
          <PanelLoading label="files" />
        </div>
      </Section>

      <Section title="Toasts">
        <WorkspaceErrorToast error={toast("danger")} onRetry={noop} onHide={noop} />
        <div data-force-state="hover" data-force-target="[data-testid='workspace-shell-error-retry']">
          <WorkspaceErrorToast error={toast("danger")} onRetry={noop} onHide={noop} />
        </div>
        <WorkspaceErrorToast error={toast("success")} onHide={noop} />
      </Section>

      <Section title="Notices">
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

      <Section title="Dialog">
        <DialogSpecimen />
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
