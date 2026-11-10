import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { isComposingKey } from "../ui/keys";
import {
  MAX_PREFERRED_NAME_LENGTH,
  preferredNameFromInput,
} from "@dohc/workspace-contracts/chat-identity-values";
import type { ActorPresentation } from "../../ipc/bridgeContract";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { ownPresentation } from "../workbench/actorPresentation";

/**
 * Who you are in chats: your avatar, your name as an editable heading, and
 * beside them the controls for the rest of your look, such as your color.
 * Clearing the name puts back the default.
 */
export function ProfileHeader(props: {
  value?: string;
  onChange: (preferredName: string | undefined) => Promise<void>;
  testIdPrefix?: string;
  presentation?: ActorPresentation;
  children?: ReactNode;
}) {
  const prefix = props.testIdPrefix ?? "preferred-name";
  const [draft, setDraft] = useState(props.value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(props.value ?? ""), [props.value]);

  const candidate = draft.trim();
  const preview = candidate || "You";

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
    if (isComposingKey(event)) return;
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(props.value ?? "");
      setError(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      {/* The avatar is your next chat message's, as chat will draw it. */}
      <span data-testid={`${prefix}-preview`} className="flex shrink-0">
        <ChatAvatar presentation={props.presentation ?? ownPresentation} name={preview} kind="human" size="post" />
        <span className="sr-only">Your messages appear as {preview}</span>
      </span>
      <div className="min-w-0 flex-[1_1_14rem]">
        <input
          type="text"
          aria-label="Your name"
          data-testid={`${prefix}-input`}
          data-unsaved={draft.trim() !== (props.value ?? "") ? true : undefined}
          // A changed name takes the first Escape, which puts it back.
          data-edit-in-place={draft !== (props.value ?? "") ? true : undefined}
          value={draft}
          maxLength={MAX_PREFERRED_NAME_LENGTH}
          disabled={saving}
          placeholder="Enter your name"
          autoComplete="name"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={() => void commit()}
          onKeyDown={onKeyDown}
          // A heading until you point at it or type in it, then a field.
          className="-ml-2 h-8 w-full max-w-[280px] rounded-md border border-transparent bg-transparent px-2 text-base font-semibold text-ink transition-colors placeholder:font-normal placeholder:text-subtle hover:border-line hover:bg-bg focus:border-ink focus:bg-bg disabled:opacity-60"
        />
        <p className="m-0 mt-0.5 text-[12px] text-muted">Shown beside your chat messages.</p>
        {error ? (
          <p data-testid={`${prefix}-error`} role="alert" className="m-0 mt-1 text-[12px] text-danger">
            {error}
          </p>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}
