import { AlertTriangle, CheckCircle2, FileText, Folder, MoreHorizontal, X } from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { SegmentedControl } from "../settings/SettingRow";
import { CopyDetailsButton } from "../shell/copyDetails";
import { CopyButton } from "../ui/CopyButton";
import { EmptyState, IconButton, Pill, PrimaryButton, SecondaryButton, SectionLabel } from "../ui/controls";
import { PanelLoading } from "../workbench/PanelLoading";
import { closeStatesPage } from "./statesRoute";

// Every shared part in every state, light beside dark, on one development
// page. It is the gallery for a person changing a part and the subject of the
// pixel baselines in e2e/states-page.spec.ts. Nothing here is product.
//
// States are forced with the classes the parts' own hover, focus-visible and
// selected rules would apply, never with pointer events, so a capture is the
// same on every run. When a part's recipe changes, change its forced classes
// here in the same PR.

const HOVER = "bg-hover text-ink";
const FOCUS = "outline-2 outline-accent outline-offset-1";

const INPUT =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle";
// What the unlayered input:focus rule in styles.css draws.
const INPUT_FOCUS = "border-muted shadow-[inset_0_-1px_0_var(--dohc-muted)]";

const ROW =
  "flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors duration-75";
const ROW_REST = "text-muted";

const KBD = "rounded border border-line bg-bg px-1 font-mono text-[10px] text-subtle";

const TOAST =
  "dohc-popover relative flex w-[420px] items-start gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-ink";
const TOAST_ACTION =
  "h-6 shrink-0 rounded border border-line px-2 text-[11px] text-muted transition-colors";
const NOTICE_ROW = "flex gap-2 border-b border-line px-3 py-2 last:border-b-0";
const NOTICE_ACTION = "shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors";

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

function Row(props: { state: string; className: string; disabled?: boolean; folder?: boolean }) {
  const Icon = props.folder ? Folder : FileText;
  return (
    <button type="button" disabled={props.disabled} className={`${ROW} ${props.className}`}>
      <Icon size={14} aria-hidden className="shrink-0" />
      <span className="flex-1 truncate">{props.state}</span>
      <span className="font-mono text-[11px] text-subtle">.md</span>
    </button>
  );
}

function Toast(props: { tone: "danger" | "success"; message: string; retry?: boolean; hover?: boolean }) {
  return (
    <div className={TOAST}>
      {props.tone === "success" ? (
        <CheckCircle2 size={14} aria-hidden className="mt-0.5 shrink-0 text-success" />
      ) : (
        <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0 text-danger" />
      )}
      <span className="min-w-0 flex-1 break-words leading-snug">{props.message}</span>
      {props.retry ? (
        <button type="button" className={`${TOAST_ACTION} ${props.hover ? HOVER : ""}`}>
          Try again
        </button>
      ) : null}
      <CopyDetailsButton iconOnly label="Copy error details" details={() => props.message} />
      <IconButton aria-label="Dismiss">
        <X size={12} aria-hidden />
      </IconButton>
    </div>
  );
}

function NoticeRow(props: {
  tone: "danger" | "success";
  title: string;
  body: string;
  retry?: boolean;
  className?: string;
}) {
  const Icon = props.tone === "success" ? CheckCircle2 : AlertTriangle;
  return (
    <div className={`${NOTICE_ROW} ${props.className ?? ""}`}>
      <Icon
        size={14}
        aria-hidden
        className={`mt-0.5 shrink-0 ${props.tone === "success" ? "text-success" : "text-danger"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[12px] font-medium text-ink">{props.title}</span>
          {props.retry ? (
            <button type="button" className={`ml-auto ${NOTICE_ACTION}`}>
              Try again
            </button>
          ) : null}
          <CopyDetailsButton iconOnly label="Copy error details" details={() => props.body} />
          <IconButton aria-label="Dismiss">
            <X size={12} aria-hidden />
          </IconButton>
        </div>
        <p className="m-0 mt-0.5 text-[11px] leading-snug text-muted">{props.body}</p>
      </div>
    </div>
  );
}

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
        <Specimen label="primary: rest, hover, focus, disabled">
          <PrimaryButton>Save</PrimaryButton>
          <PrimaryButton className="opacity-90">Save</PrimaryButton>
          <PrimaryButton className={FOCUS}>Save</PrimaryButton>
          <PrimaryButton disabled>Save</PrimaryButton>
        </Specimen>
        <Specimen label="primary compact">
          <PrimaryButton size="compact">Save</PrimaryButton>
          <PrimaryButton size="compact" className="opacity-90">Save</PrimaryButton>
          <PrimaryButton size="compact" className={FOCUS}>Save</PrimaryButton>
          <PrimaryButton size="compact" disabled>Save</PrimaryButton>
        </Specimen>
        <Specimen label="secondary: rest, hover, focus, disabled">
          <SecondaryButton>Cancel</SecondaryButton>
          <SecondaryButton className={HOVER}>Cancel</SecondaryButton>
          <SecondaryButton className={FOCUS}>Cancel</SecondaryButton>
          <SecondaryButton disabled>Cancel</SecondaryButton>
        </Specimen>
        <Specimen label="secondary compact">
          <SecondaryButton size="compact">Cancel</SecondaryButton>
          <SecondaryButton size="compact" className={HOVER}>Cancel</SecondaryButton>
          <SecondaryButton size="compact" className="outline-2 outline-accent -outline-offset-2">Cancel</SecondaryButton>
          <SecondaryButton size="compact" disabled>Cancel</SecondaryButton>
        </Specimen>
        <Specimen label="secondary row: rest, hover, aria-disabled">
          <SecondaryButton size="row">Open</SecondaryButton>
          <SecondaryButton size="row" className={HOVER}>Open</SecondaryButton>
          <SecondaryButton size="row" aria-disabled="true">Open</SecondaryButton>
        </Specimen>
        <Specimen label="icon: rest, hover, focus, disabled">
          <IconButton aria-label="More"><MoreHorizontal size={14} aria-hidden /></IconButton>
          <IconButton aria-label="More" className={HOVER}><MoreHorizontal size={14} aria-hidden /></IconButton>
          <IconButton aria-label="More" className={FOCUS}><MoreHorizontal size={14} aria-hidden /></IconButton>
          <IconButton aria-label="More" disabled><MoreHorizontal size={14} aria-hidden /></IconButton>
        </Specimen>
        <Specimen label="copy: rest, hover">
          <CopyButton getText={() => ""} testId={`states-copy-${props.theme}`} />
          <CopyDetailsButton label="Copy details" details={() => ""} />
          <CopyDetailsButton iconOnly label="Copy details" details={() => ""} />
        </Specimen>
        <Specimen label="segmented">
          <SegmentedControl
            label="Theme"
            value="dark"
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "System" },
            ]}
            onChange={() => undefined}
          />
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
        <Specimen label="rest" className="w-56">
          <input className={INPUT} placeholder="Search files" readOnly />
        </Specimen>
        <Specimen label="filled" className="w-56">
          <input className={INPUT} defaultValue="notes/product-plan.md" readOnly />
        </Specimen>
        <Specimen label="focus" className="w-56">
          <input className={`${INPUT} ${INPUT_FOCUS}`} defaultValue="Q3 product plan" readOnly />
        </Specimen>
        <Specimen label="mono" className="w-56">
          <input className={`${INPUT} font-mono`} defaultValue="wss://relay.dohc.dev" readOnly />
        </Specimen>
        <Specimen label="disabled" className="w-56">
          <input className={`${INPUT} opacity-50`} defaultValue="Read only" disabled />
        </Specimen>
        <Specimen label="error" className="w-56">
          <div className="flex w-full flex-col gap-1">
            <input className={`${INPUT} border-danger`} defaultValue="notes/" readOnly />
            <span className="text-xs text-danger">A file needs a name after the folder.</span>
          </div>
        </Specimen>
      </Section>

      <Section title="List rows">
        <div className="flex w-64 flex-col gap-0.5 rounded-lg border border-line bg-panel px-1 py-1">
          <Row state="rest" className={ROW_REST} folder />
          <Row state="hover" className={HOVER} />
          <Row state="selected" className="bg-selected/85 text-ink" />
          <Row state="active" className="bg-selected text-ink" />
          <Row state="focus-visible" className={`${ROW_REST} ring-1 ring-inset ring-ink/30`} />
          <Row state="disabled" className={`${ROW_REST} opacity-50`} disabled />
        </div>
        <div role="menu" aria-label="Document actions" className="dohc-document-menu-list static!">
          <div role="menuitem" className="dohc-document-menu-item">Copy as Markdown</div>
          <div role="menuitem" className="dohc-document-menu-item is-selected">Export as Markdown…</div>
          <div role="menuitem" className="dohc-document-menu-item">Export as HTML…</div>
          <div role="menuitem" className="dohc-document-menu-item">Export as PDF…</div>
          <div className="dohc-document-menu-status">Open the document to export it.</div>
        </div>
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
        <Toast tone="danger" message="dohc could not reach the sync relay. Check your connection." retry />
        <Toast tone="danger" message="dohc could not reach the sync relay. Check your connection." retry hover />
        <Toast tone="success" message="Moved 4 files to Archived" />
      </Section>

      <Section title="Notices">
        <div className="w-[420px] rounded-lg border border-line bg-panel text-xs text-ink">
          <SectionLabel as="h3" className="m-0 px-3 pb-1 pt-2">
            On this computer
          </SectionLabel>
          <NoticeRow
            tone="danger"
            title="Sync stopped"
            body="dohc could not reach the sync relay. Check your connection."
            retry
          />
          <NoticeRow
            tone="danger"
            title="Sync stopped"
            body="Focus-visible row."
            retry
            className="outline-2 outline-accent -outline-offset-2"
          />
          <NoticeRow tone="success" title="Moved 4 files to Archived" body="2 minutes ago" />
        </div>
      </Section>

      <Section title="Dialog">
        <div className="relative h-72 w-full overflow-hidden rounded-lg border border-line bg-bg">
          <div className="flex flex-col gap-2 p-4 text-[13px] text-muted">
            <span>Research</span>
            <span>competitors.md</span>
            <span>meeting-2026-07-08.md</span>
          </div>
          <div className="absolute inset-0 flex items-start justify-center bg-scrim p-4 pt-12 backdrop-blur-[1.5px]">
            <div className="w-[min(420px,calc(100%-32px))] rounded border border-line bg-panel p-4 shadow-xl">
              <h3 className="m-0 text-sm font-semibold text-ink">Delete 12 files from Research?</h3>
              <p className="m-0 mt-2 text-[13px] text-muted">
                They move to the system trash, or this workspace's .dohc/trash if that fails, and you
                can restore them.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <SecondaryButton className="h-8 py-0">Cancel</SecondaryButton>
                <PrimaryButton className="h-8 py-0 text-xs">Delete files</PrimaryButton>
              </div>
            </div>
          </div>
        </div>
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
