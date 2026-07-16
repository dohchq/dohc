import { useEffect, useState, type KeyboardEvent } from "react";
import {
  MAX_PREFERRED_NAME_LENGTH,
  agentDisplayLabel,
  preferredNameFromInput,
} from "@dohc/workspace-contracts/chat-identity";

export function PreferredNameControl(props: {
  value?: string;
  onChange: (preferredName: string | undefined) => Promise<void>;
  testIdPrefix?: string;
}) {
  const prefix = props.testIdPrefix ?? "preferred-name";
  const [draft, setDraft] = useState(props.value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(props.value ?? ""), [props.value]);

  const candidate = draft.trim();
  const preview = candidate.length > 0 ? agentDisplayLabel(candidate) : "Your agent";

  const commit = async () => {
    let preferredName: string | undefined;
    try {
      preferredName = preferredNameFromInput(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid name.");
      return;
    }
    setDraft(preferredName ?? "");
    if (preferredName === props.value) {
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await props.onChange(preferredName);
    } catch {
      setDraft(props.value ?? "");
      setError("Could not save your name.");
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(props.value ?? "");
      setError(null);
    }
  };

  return (
    <div className="flex min-w-[230px] flex-col gap-1.5">
      <input
        type="text"
        aria-label="Your name"
        data-testid={`${prefix}-input`}
        value={draft}
        maxLength={MAX_PREFERRED_NAME_LENGTH}
        disabled={saving}
        placeholder="Ice"
        autoComplete="name"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => void commit()}
        onKeyDown={onKeyDown}
        className="h-8 w-full rounded-md border border-line bg-bg px-2.5 text-[12px] text-ink placeholder:text-subtle focus:border-ink focus-visible:outline-none disabled:opacity-60"
      />
      <span data-testid={`${prefix}-preview`} className="text-[10px] text-subtle">
        Messages will appear as <span className="font-medium text-ink">{preview}</span>.
      </span>
      {error ? (
        <span data-testid={`${prefix}-error`} role="alert" className="text-[10px] text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}
