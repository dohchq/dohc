import { useRequestSequence } from "../useRequestSequence";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { FlaskConical } from "lucide-react";
import {
  MAX_PREFERRED_NAME_LENGTH,
  preferredNameFromInput,
} from "@dohc/workspace-contracts/chat-identity-values";
import type { DesktopUserSettings } from "../../settings/userSettings";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { PrimaryButton, SecondaryButton } from "../ui/controls";
import { ChatAvatar } from "./ChatAvatar";

const COMMAND_PLACEHOLDER = "node agent.mjs";
const LABEL_CLASS = "text-[11px] font-medium text-muted";
const INPUT_CLASS =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink disabled:opacity-50";
const HINT_CLASS = "m-0 text-[11px] leading-relaxed text-subtle";

type CheckState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok" | "failed"; detail: string };

export function AddAgentForm(props: {
  workspaceId: string;
  settings: DesktopUserSettings;
  // Saves the whole settings object, the way the settings dialog does.
  onSave: (settings: DesktopUserSettings) => Promise<void>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { settings, onSave } = props;
  const request = useRequestSequence();
  useEffect(() => {
    request.next();
    setSaving(false);
    setCheck({ status: "idle" });
    setError(null);
    return () => { request.next(); };
  }, [props.workspaceId]);
  const [agentName, setAgentName] = useState(settings.profile.agentName ?? "");
  const [name, setName] = useState(settings.profile.preferredName ?? "");
  const [command, setCommand] = useState(settings.runner.command);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<CheckState>({ status: "idle" });

  useEffect(() => {
    setName(settings.profile.preferredName ?? "");
    setAgentName(settings.profile.agentName ?? "");
    setCommand(settings.runner.command);
  }, [settings.profile.preferredName, settings.profile.agentName, settings.runner.command]);

  const trimmedName = name.trim();
  const trimmedCommand = command.trim();
  const preview = agentName.trim() || "Your agent";

  // Writes the name and the command, dispatch on. Returns false when the
  // input is not a name or the write failed; the message is on screen.
  const save = useCallback(async (): Promise<boolean> => {
    const token = request.current();
    let preferredName: string | undefined;
    let validAgentName: string | undefined;
    try {
      preferredName = preferredNameFromInput(name);
      validAgentName = preferredNameFromInput(agentName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid name.");
      return false;
    }
    if (!validAgentName) {
      setError("Enter an agent name.");
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
        profile: { ...settings.profile, preferredName, agentName: validAgentName },
        runner: { ...settings.runner, command: trimmedCommand, enabled: true },
      });
      return request.isCurrent(token);
    } catch (cause) {
      if (!request.isCurrent(token)) return false;
      setError(ipcErrorMessage(cause, "Could not save the agent."));
      return false;
    } finally {
      if (request.isCurrent(token)) setSaving(false);
    }
  }, [agentName, name, onSave, settings, trimmedCommand]);

  const runCheck = useCallback(async () => {
    const token = request.current();
    if (!(await save()) || !request.isCurrent(token)) return;
    setCheck({ status: "running" });
    try {
      const result = await bridge().runnerSelfTest({ workspaceId: props.workspaceId });
      if (!request.isCurrent(token)) return;
      setCheck({ status: result.ok ? "ok" : "failed", detail: result.detail });
    } catch (cause) {
      if (!request.isCurrent(token)) return;
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
      role="dialog"
      aria-modal="true"
      aria-labelledby="chats-add-agent-title"
      className="dohc-elevated flex w-[min(420px,calc(100vw-32px))] flex-col gap-4 rounded-xl border border-line bg-panel p-5"
    >
      <div className="flex items-center gap-2">
        <ChatAvatar name={preview} kind="agent" size="strip" />
        <h3 id="chats-add-agent-title" className="m-0 text-sm font-semibold text-ink">
          Add an agent
        </h3>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="chats-add-agent-agent-name" className={LABEL_CLASS}>Agent name</label>
        <input
          id="chats-add-agent-agent-name"
          data-testid="chats-add-agent-agent-name"
          value={agentName}
          maxLength={MAX_PREFERRED_NAME_LENGTH}
          disabled={busy}
          autoComplete="off"
          onChange={(event) => setAgentName(event.currentTarget.value)}
          className={INPUT_CLASS}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="chats-add-agent-name" className={LABEL_CLASS}>
          Your name
        </label>
        <input
          id="chats-add-agent-name"
          data-testid="chats-add-agent-name"
          value={name}
          maxLength={MAX_PREFERRED_NAME_LENGTH}
          disabled={busy}
          autoComplete="name"
          onChange={(event) => setName(event.currentTarget.value)}
          className={INPUT_CLASS}
        />
        <p data-testid="chats-add-agent-preview" className={HINT_CLASS}>
          Posts as <span className="font-medium text-muted">{preview}</span>
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="chats-add-agent-command" className={LABEL_CLASS}>
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
          className={`${INPUT_CLASS} font-mono text-[12px]`}
        />
        <p className={HINT_CLASS}>
          dohc starts this command when someone mentions the agent, with the
          conversation on its input. Use a sandboxed command.
        </p>
      </div>

      {error ? (
        <p data-testid="chats-add-agent-error" role="alert" className="m-0 text-[11px] text-danger">
          {error}
        </p>
      ) : null}
      {check.status === "ok" || check.status === "failed" ? (
        <p
          data-testid="chats-add-agent-check-result"
          data-state={check.status}
          role={check.status === "failed" ? "alert" : "status"}
          className={`m-0 text-[11px] ${check.status === "ok" ? "text-success" : "text-danger"}`}
        >
          {check.detail}
        </p>
      ) : null}

      <div className="flex items-center gap-1.5">
        <SecondaryButton
          size="compact"
          data-testid="chats-add-agent-check"
          disabled={busy || !agentName.trim() || trimmedCommand.length === 0 || trimmedName.length === 0}
          onClick={() => void runCheck()}
          className="flex items-center gap-1"
        >
          <FlaskConical size={12} aria-hidden />
          {check.status === "running" ? "Checking…" : "Check"}
        </SecondaryButton>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="chats-add-agent-cancel"
          disabled={busy}
          onClick={props.onCancel}
          className="h-7 rounded-md px-2.5 text-[11px] text-muted hover:bg-line/50 hover:text-ink disabled:opacity-50 dohc-focus-visible"
        >
          Cancel
        </button>
        <PrimaryButton
          size="compact"
          type="submit"
          data-testid="chats-add-agent-submit"
          disabled={busy || !agentName.trim() || trimmedCommand.length === 0 || trimmedName.length === 0}
        >
          {saving ? "Saving…" : "Add agent"}
        </PrimaryButton>
      </div>
    </form>
  );
}
