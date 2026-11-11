import { ArrowLeftRight, CircleAlert, Info, Layers, Lock, PenLine } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import type { WorkspaceVersionRecord } from "../../ipc/bridgeContract";
import { MAX_ENGINE_CAPTURE_BINARY_BYTES, MAX_ENGINE_CAPTURE_TEXT_BYTES } from "../../workspaces/workspaceEngineCaptureLimits";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import { relativeTime } from "../relativeTime";
import { ConfirmActions, ConfirmationCard, ConfirmationHead, FOCUS_RING, confirmPanel, useOpeningFocus } from "../ui/ConfirmDialog";
import { PrimaryButton, SecondaryButton } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import { versionDotClass } from "./versionHue";

export type VersionLastChange = { atMs: number; personName?: string };

// A no-break space keeps each number on the same line as its unit.
const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MB`;

// What a version leaves alone. The sizes are the engine's capture caps:
// larger files stay as they are on disk.
export const SAME_IN_EVERY_VERSION =
  `Chats are the same in every version. Files over ${megabytes(MAX_ENGINE_CAPTURE_BINARY_BYTES)} (text over ${megabytes(MAX_ENGINE_CAPTURE_TEXT_BYTES)}) aren't copied, so changing one here changes it in Main too.`;

type CardProps = {
  // The version you're in, which the new one starts from.
  start: WorkspaceVersionRecord | null;
  name: string;
  error: ReactNode;
  busy: boolean;
  // The open tab has edits dohc saves before it creates the version.
  saveFirst: boolean;
  onNameChange(name: string): void;
  onCreate(): void;
  onCancel(): void;
};

function Fact(props: { icon: typeof Info; tone?: "warning"; testId?: string; children: ReactNode }) {
  const Icon = props.icon;
  return (
    <li data-testid={props.testId} className={`flex items-start gap-2.5 ${props.tone === "warning" ? "text-warning" : "text-muted"}`}>
      <Icon size={14} aria-hidden className={`mt-[3px] shrink-0 ${props.tone === "warning" ? "" : "text-subtle"}`} />
      <span className="min-w-0">{props.children}</span>
    </li>
  );
}

// The card alone. NewVersionDialog puts it in an Overlay; the states page
// renders it over a frame with no keyboard behavior.
export function NewVersionCard(props: CardProps & {
  idBase: string;
  // When the start version last changed, once dohc has read it.
  lastChange: VersionLastChange | null;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const id = props.idBase;
  const startName = props.start?.name ?? "Main";
  const fromMain = (props.start?.kind ?? "main") === "main";
  const errorId = `${id}-error`;
  const invalid = props.error !== null && props.error !== undefined;
  return (
    <ConfirmationCard icon={Layers} testId="version-new-dialog">
      <ConfirmationHead titleId={`${id}-title`} bodyId={`${id}-body`} title="New version">
        <p className="m-0">Try changes without touching {startName}.</p>
      </ConfirmationHead>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!props.busy) props.onCreate();
        }}
      >
        <div>
          <label htmlFor={`${id}-name`} className="mb-1.5 block text-[12px] font-medium text-muted">
            Name
          </label>
          <input
            ref={props.inputRef}
            id={`${id}-name`}
            data-testid="version-new-input"
            value={props.name}
            maxLength={80}
            readOnly={props.busy}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => props.onNameChange(event.target.value)}
            className={`h-8 w-full rounded-md border bg-bg px-2.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink ${invalid ? "border-danger" : "border-line"}`}
          />
          {invalid ? (
            <p id={errorId} data-testid="version-menu-error" role="alert" className="m-0 mt-1.5 text-[12px] leading-4 text-danger">
              {props.error}
            </p>
          ) : null}
        </div>
        <div>
          <span className="mb-1.5 block text-[12px] font-medium text-muted">Starts from</span>
          <div data-testid="version-new-start" className="flex min-w-0 items-center gap-2.5 rounded-lg border border-line bg-bg px-3 py-2">
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${fromMain || props.start === null ? "border-[1.5px] border-subtle" : versionDotClass(props.start.id)}`}
            />
            <span className="min-w-0 truncate text-[13px] font-medium text-ink">{startName}</span>
            {props.lastChange ? (
              <span data-testid="version-new-start-changed" className="ml-auto shrink-0 font-mono text-[11px] text-subtle">
                Changed {relativeTime(props.lastChange.atMs)}
                {props.lastChange.personName === undefined ? "" : ` by ${props.lastChange.personName}`}
              </span>
            ) : null}
          </div>
        </div>
        <ul data-testid="version-new-facts" className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
          {props.saveFirst ? <Fact icon={PenLine}>dohc saves your changes in {startName} first.</Fact> : null}
          <Fact icon={ArrowLeftRight}>dohc switches you to it. Your edits go there.</Fact>
          <Fact icon={Lock}>{startName} stays as it is{fromMain ? " until you merge" : ""}.</Fact>
          {fromMain ? null : (
            <Fact icon={CircleAlert} tone="warning" testId="version-new-no-merge">
              It can't merge into Main, because it starts from {startName}.
            </Fact>
          )}
          <Fact icon={Info} testId="version-new-same">{SAME_IN_EVERY_VERSION}</Fact>
        </ul>
        <ConfirmActions>
          <SecondaryButton data-testid="version-new-cancel" className={FOCUS_RING} disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </SecondaryButton>
          <PrimaryButton type="submit" data-testid="version-new-create" className={FOCUS_RING} disabled={props.busy}>
            {props.busy ? "Creating…" : "Create and switch"}
          </PrimaryButton>
        </ConfirmActions>
      </form>
    </ConfirmationCard>
  );
}

// The New version dialog: one name to choose, and what dohc already knows
// about the version it makes. It starts from the version you're in, dohc
// switches you to it, and the version it starts from stays as it is.
// Escape and Cancel close it, except while dohc creates the version.
export function NewVersionDialog(props: CardProps & { workspaceId: string }) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useOpeningFocus(() => inputRef.current);
  const startId = props.start?.id ?? null;

  // A failed read leaves the line out.
  const [lastChange, setLastChange] = useState<VersionLastChange | null>(null);
  const reads = useRequestSequence([props.workspaceId, startId]);
  useEffect(() => {
    setLastChange(null);
    if (startId === null) return;
    const token = reads.next();
    bridge().listVersionLastChanges({ workspaceId: props.workspaceId }).then(
      (result) => {
        if (!reads.isCurrent(token)) return;
        setLastChange(result.versions.find((version) => version.versionId === startId)?.lastChange ?? null);
      },
      () => undefined,
    );
  }, [props.workspaceId, startId]);

  const cancel = () => {
    if (!props.busy) props.onCancel();
  };
  return (
    <Overlay onClose={cancel} panelRef={panelRef} panelProps={confirmPanel(`${id}-title`, `${id}-body`)}>
      <NewVersionCard {...props} onCancel={cancel} idBase={id} lastChange={lastChange} inputRef={inputRef} />
    </Overlay>
  );
}
