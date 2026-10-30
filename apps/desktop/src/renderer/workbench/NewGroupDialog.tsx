import { Layers, MessagesSquare, Newspaper, TriangleAlert, type LucideIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Overlay } from "../Overlay";
import { PrimaryButton, SecondaryButton } from "../ui/controls";
import { useRadioGroup } from "../ui/SegmentedControl";
import { isComposingKey } from "../ui/keys";

export type GroupType = "chat" | "posts" | "both";

const TYPES: ReadonlyArray<{ value: GroupType; label: string; line: string; icon: LucideIcon }> = [
  { value: "chat", label: "Chat", line: "One conversation, with threads.", icon: MessagesSquare },
  { value: "posts", label: "Posts", line: "Topics, each with its replies.", icon: Newspaper },
  { value: "both", label: "Both", line: "Posts and a chat in one group.", icon: Layers },
];

const FIELD =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle aria-invalid:border-danger aria-invalid:focus:border-danger! aria-invalid:focus:shadow-[inset_0_-1px_0_var(--dohc-danger)]!";

// Name a group, say what it's for, and pick how people talk in it. A failed
// create stays in the dialog with what was typed, and says why above Create.
export function NewGroupDialog(props: {
  // Resolves to null once the group exists, or to why it couldn't be made.
  onCreate: (input: { name: string; type: GroupType; purpose: string }) => Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [type, setType] = useState<GroupType>("chat");
  const [nameMissing, setNameMissing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const group = useRadioGroup({ value: type, options: TYPES, onChange: setType, disabled: busy });
  const id = useId();
  const named = name.trim().length > 0;

  async function create() {
    if (busyRef.current) return;
    if (!named) {
      setNameMissing(true);
      nameRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const failed = await props.onCreate({ name: name.trim(), type, purpose: purpose.trim() });
      if (failed !== null) setFailure(failed);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={() => { if (!busyRef.current) props.onClose(); }}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        data-testid="chats-new-channel-dialog"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        // Enter creates from any field or card. A disabled Create would
        // swallow it, and an empty name should say what's missing.
        onKeyDown={(event) => {
          const { target } = event;
          const field = target instanceof HTMLInputElement || (target instanceof HTMLElement && target.getAttribute("role") === "radio");
          if (event.key !== "Enter" || isComposingKey(event) || !field) return;
          event.preventDefault();
          void create();
        }}
        className="dohc-elevated flex w-[480px] max-w-[calc(100vw-2rem)] flex-col gap-6 rounded-xl border border-line bg-panel p-6"
      >
        <h2 id={`${id}-title`} className="m-0 text-base font-semibold text-ink">New group</h2>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-name`} className="dohc-section-label">Name</label>
            <input
              ref={nameRef}
              id={`${id}-name`}
              data-testid="chats-new-channel-name"
              autoFocus
              value={name}
              maxLength={80}
              disabled={busy}
              aria-invalid={nameMissing && !named}
              aria-describedby={nameMissing && !named ? `${id}-name-error` : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setNameMissing(false);
              }}
              className={FIELD}
            />
            {nameMissing && !named ? (
              <p id={`${id}-name-error`} data-testid="chats-new-channel-name-error" className="m-0 text-[12px] text-danger">
                Give the group a name.
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-purpose`} className="dohc-section-label">What it&apos;s for</label>
            <input
              id={`${id}-purpose`}
              data-testid="chats-new-channel-purpose"
              value={purpose}
              maxLength={200}
              placeholder="Optional"
              disabled={busy}
              onChange={(event) => setPurpose(event.target.value)}
              className={FIELD}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span id={`${id}-type`} className="dohc-section-label">How people talk</span>
            <div role="radiogroup" aria-labelledby={`${id}-type`} onKeyDown={group.onKeyDown} className="grid grid-cols-3 gap-2">
              {TYPES.map((option, index) => {
                const checked = type === option.value;
                const Icon = option.icon;
                return (
                  <button
                    key={option.value}
                    {...group.radio(index)}
                    data-testid={`chats-new-channel-type-${option.value}`}
                    aria-labelledby={`${id}-type-${option.value}-label`}
                    aria-describedby={`${id}-type-${option.value}`}
                    className={`flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors duration-75 disabled:opacity-60 ${
                      checked ? "border-accent bg-selected text-ink ring-1 ring-accent" : "border-line text-muted hover:bg-hover hover:text-ink"
                    }`}
                  >
                    <Icon size={16} strokeWidth={1.9} aria-hidden className={checked ? "text-accent" : ""} />
                    <span className="flex flex-col gap-1">
                      <span id={`${id}-type-${option.value}-label`} className="text-[13px] font-medium text-ink">{option.label}</span>
                      <span id={`${id}-type-${option.value}`} className="text-[12px] leading-4 text-muted">{option.line}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          {failure ? (
            <p role="alert" data-testid="chats-new-channel-error" className="m-0 flex items-start gap-2 text-[12px] text-danger">
              <TriangleAlert size={14} aria-hidden className="mt-px shrink-0" />
              {failure}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <SecondaryButton data-testid="chats-new-channel-cancel" disabled={busy} onClick={props.onClose}>
              Cancel
            </SecondaryButton>
            <PrimaryButton type="submit" data-testid="chats-new-channel-submit" disabled={!named || busy}>
              Create group
            </PrimaryButton>
          </div>
        </div>
      </form>
    </Overlay>
  );
}
