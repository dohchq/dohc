import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Bot, FlaskConical } from "lucide-react";
import {
  MAX_PREFERRED_NAME_LENGTH,
  agentDisplayLabel,
  preferredNameFromInput,
} from "@dohc/workspace-contracts/chat-identity-values";
import type { DesktopUserSettings } from "../../settings/userSettings";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";

const COMMAND_PLACEHOLDER = "The command that starts your agent";

type CheckState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok" | "failed"; detail: string };

// Adding an agent is like adding a person: a name, what runs it, and a
// check that it answers. It writes the runner settings that already exist;
// nothing new is stored. The name is the user's own, because an agent posts
// as "<name>'s agent".
export function AddAgentForm(props: {
  workspaceId: string;
  settings: DesktopUserSettings;
  // Saves the whole settings object, the way the settings dialog does.
  onSave: (settings: DesktopUserSettings) => Promise<void>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { settings, onSave } = props;
  const [name, setName] = useState(settings.profile.preferredName ?? "");
  const [command, setCommand] = useState(settings.runner.command);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<CheckState>({ status: "idle" });

  useEffect(() => {
    setName(settings.profile.preferredName ?? "");
    setCommand(settings.runner.command);
  }, [settings.profile.preferredName, settings.runner.command]);

  const trimmedName = name.trim();
  const trimmedCommand = command.trim();
  const preview = trimmedName.length > 0 ? agentDisplayLabel(trimmedName) : "Your agent";

  // Writes the name and the command, dispatch on. Returns false when the
  // input is not a name or the write failed; the message is on screen.
  const save = useCallback(async (): Promise<boolean> => {
    let preferredName: string | undefined;
    try {
      preferredName = preferredNameFromInput(name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid name.");
      return false;
    }
    if (!preferredName) {
      setError("Enter your name. Agent work is attributed to you.");
      return false;
    }
    if (trimmedCommand.length === 0) {
      setError("Enter the command that starts your agent.");
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...settings,
        profile: { preferredName },
        runner: { ...settings.runner, command: trimmedCommand, enabled: true },
      });
      return true;
    } catch (cause) {
      setError(ipcErrorMessage(cause, "Could not save the agent."));
      return false;
    } finally {
      setSaving(false);
    }
  }, [name, onSave, settings, trimmedCommand]);

  const runCheck = useCallback(async () => {
    if (!(await save())) return;
    setCheck({ status: "running" });
    try {
      const result = await bridge().runnerSelfTest({ workspaceId: props.workspaceId });
      setCheck({ status: result.ok ? "ok" : "failed", detail: result.detail });
    } catch (cause) {
      setCheck({
        status: "failed",
        detail: ipcErrorMessage(cause, "The check could not start."),
      });
    }
  }, [props.workspaceId, save]);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (saving || check.status === "running") return;
      if (await save()) props.onDone();
    },
    [check.status, props, save, saving],
  );

  const busy = saving || check.status === "running";

  return (
    <form
      data-testid="chats-add-agent"
      onSubmit={(event) => void submit(event)}
      className="mx-2 mb-2 rounded-md border border-line bg-panel-2/40 p-2.5"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-md border border-agent/30 bg-bg text-agent">
          <Bot size={13} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
          Add an agent
        </span>
      </div>
      <label className="sr-only" htmlFor="chats-add-agent-name">
        Your name
      </label>
      <input
        id="chats-add-agent-name"
        data-testid="chats-add-agent-name"
        value={name}
        maxLength={MAX_PREFERRED_NAME_LENGTH}
        disabled={busy}
        placeholder="Your name"
        autoComplete="name"
        onChange={(event) => setName(event.currentTarget.value)}
        className="h-7 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-ink placeholder:text-subtle dohc-focus-input"
      />
      <p data-testid="chats-add-agent-preview" className="m-0 mt-1 text-[10px] text-subtle">
        Posts as <span className="font-medium text-ink">{preview}</span>.
      </p>
      <label className="sr-only" htmlFor="chats-add-agent-command">
        Runner command
      </label>
      <input
        id="chats-add-agent-command"
        data-testid="chats-add-agent-command"
        value={command}
        maxLength={4096}
        disabled={busy}
        spellCheck={false}
        autoCapitalize="none"
        autoComplete="off"
        placeholder={COMMAND_PLACEHOLDER}
        onChange={(event) => setCommand(event.currentTarget.value)}
        className="mt-1.5 h-7 w-full rounded-md border border-line bg-bg px-2 font-mono text-[11px] text-ink placeholder:text-subtle dohc-focus-input"
      />
      <p className="m-0 mt-1 text-[10px] leading-relaxed text-subtle">
        dohc starts this command when the agent is mentioned, with the conversation on
        its input. Use a sandboxed command.
      </p>
      {error ? (
        <p data-testid="chats-add-agent-error" role="alert" className="m-0 mt-1.5 text-[10px] text-danger">
          {error}
        </p>
      ) : null}
      {check.status === "ok" || check.status === "failed" ? (
        <p
          data-testid="chats-add-agent-check-result"
          data-state={check.status}
          role={check.status === "failed" ? "alert" : "status"}
          className={`m-0 mt-1.5 text-[10px] ${check.status === "ok" ? "text-success" : "text-danger"}`}
        >
          {check.detail}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          data-testid="chats-add-agent-check"
          disabled={busy || trimmedCommand.length === 0 || trimmedName.length === 0}
          onClick={() => void runCheck()}
          className="flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[11px] text-muted hover:bg-panel-2 hover:text-ink disabled:cursor-default disabled:opacity-50 dohc-focus-visible"
        >
          <FlaskConical size={12} aria-hidden />
          {check.status === "running" ? "Checking…" : "Check"}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="chats-add-agent-cancel"
          disabled={busy}
          onClick={props.onCancel}
          className="h-7 rounded-md px-2 text-[11px] text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-50 dohc-focus-visible"
        >
          Cancel
        </button>
        <button
          type="submit"
          data-testid="chats-add-agent-submit"
          disabled={busy || trimmedCommand.length === 0 || trimmedName.length === 0}
          className="h-7 rounded-md bg-ink px-2.5 text-[11px] font-medium text-bg hover:opacity-90 disabled:opacity-40 dohc-focus-visible"
        >
          {saving ? "Saving…" : "Add agent"}
        </button>
      </div>
    </form>
  );
}
