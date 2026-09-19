import { useEffect, useState } from "react";
import {
  MAX_PREFERRED_NAME_LENGTH,
  preferredNameFromInput,
} from "@dohc/workspace-contracts/chat-identity-values";

export function AgentNameControl(props: {
  value?: string;
  onChange: (name: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(props.value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(props.value ?? ""), [props.value]);
  async function save() {
    try {
      const name = preferredNameFromInput(draft);
      if (!name) {
        setError("Enter an agent name.");
        return;
      }
      setDraft(name);
      setError(null);
      if (name === props.value) return;
      setSaving(true);
      await props.onChange(name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the agent name.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="runner-agent-name" className="text-[11px] font-medium text-ink">Agent name</label>
      <input
        id="runner-agent-name"
        data-testid="runner-agent-name-input"
        value={draft}
        maxLength={MAX_PREFERRED_NAME_LENGTH}
        disabled={saving}
        autoComplete="off"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
      />
      {error ? <span role="alert" className="text-[11px] text-danger">{error}</span> : null}
    </div>
  );
}
