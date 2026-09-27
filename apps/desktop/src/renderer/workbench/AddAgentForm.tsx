import { useCallback, useEffect, useState, type FormEvent } from "react";
import { FlaskConical } from "lucide-react";
import {
  MAX_PREFERRED_NAME_LENGTH,
  preferredNameFromInput,
} from "@dohc/workspace-contracts/chat-identity-values";
import type { DesktopUserSettings } from "../../settings/userSettings";
import { configuredRunnerCommand } from "../../agents/agentToolCatalog";
import { AgentToolPicker } from "../settings/AgentToolPicker";
import { useRequestSequence } from "../useRequestSequence";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { PrimaryButton, SecondaryButton } from "../ui/controls";
import { ChatAvatar } from "./ChatAvatar";
import { Overlay } from "../Overlay";

const COMMAND_PLACEHOLDER = "node agent.mjs";
const LABEL_CLASS = "text-[11px] font-medium text-muted";
const INPUT_CLASS =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink disabled:opacity-50";
const HINT_CLASS = "m-0 text-[11px] leading-relaxed text-muted";

type CheckState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok" | "failed"; detail: string };

export function AddAgentForm(props: {
  workspaceId: string;
  settings: DesktopUserSettings;
  // Saves the changed settings with the settings they came from, the way the
  // settings dialog does.
  onSave: (settings: DesktopUserSettings, base: DesktopUserSettings) => Promise<void>;
  onError: (message: string, cause?: unknown) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { settings, onSave } = props;
  const [agentName, setAgentName] = useState(settings.profile.agentName ?? "");
  const [profile, setProfile] = useState(settings.runner.profile);
  const [advanced, setAdvanced] = useState(!settings.runner.profile && settings.runner.command.length > 0);
  const requests = useRequestSequence([props.workspaceId]);
  const [command, setCommand] = useState(settings.runner.command);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<CheckState>({ status: "idle" });

  useEffect(() => {
    setAgentName(settings.profile.agentName ?? "");
    setCommand(settings.runner.command);
    setProfile(settings.runner.profile);
  }, [settings.profile.agentName, settings.runner.command, settings.runner.profile?.tool, settings.runner.profile?.executable]);

  const trimmedCommand = configuredRunnerCommand({ command, profile });
  const preview = agentName.trim() || "Your agent";

  // Writes the name and the command, dispatch on. Returns false when the
  // input is not a name or the write failed; the message is on screen.
  const save = useCallback(async (): Promise<boolean> => {
    let validAgentName: string | undefined;
    try {
      validAgentName = preferredNameFromInput(agentName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid name.");
      return false;
    }
    if (!validAgentName) {
      setError("Enter an agent name.");
      return false;
    }
    if (trimmedCommand.length === 0) {
      setError("Enter the command that starts your agent.");
      return false;
    }
    const token = requests.current();
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...settings,
        profile: { ...settings.profile, agentName: validAgentName },
        runner: { ...settings.runner, command: command.trim(), profile, enabled: true },
      }, settings);
      return requests.isCurrent(token);
    } catch (cause) {
      if (requests.isCurrent(token)) props.onError(ipcErrorMessage(cause, "Could not save the agent."), cause);
      return false;
    } finally {
      if (requests.isCurrent(token)) setSaving(false);
    }
  }, [agentName, onSave, settings, trimmedCommand, command, profile, requests, props.onError]);

  const runCheck = useCallback(async () => {
    const token = requests.current();
    if (!(await save()) || !requests.isCurrent(token)) return;
    setCheck({ status: "running" });
    try {
      const result = await bridge().runnerSelfTest({ workspaceId: props.workspaceId });
      if (!requests.isCurrent(token)) return;
      if (!result.ok) props.onError(result.detail);
      setCheck({ status: result.ok ? "ok" : "failed", detail: result.detail });
    } catch (cause) {
      if (!requests.isCurrent(token)) return;
      props.onError(ipcErrorMessage(cause, "The check could not start."), cause);
      setCheck({
        status: "failed",
        detail: ipcErrorMessage(cause, "The check could not start."),
      });
    }
  }, [props.workspaceId, props.onError, requests, save]);

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
    <Overlay onClose={busy ? undefined : props.onCancel}>
      <form
        data-testid="chats-add-agent"
        onSubmit={(event) => void submit(event)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chats-add-agent-title"
        className="dohc-elevated flex w-[min(600px,calc(100vw-32px))] flex-col gap-4 rounded-xl border border-line bg-panel p-5"
      >
        <div className="flex items-center gap-2">
          <ChatAvatar name={preview} kind="agent" own size="strip" />
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
          <p data-testid="chats-add-agent-preview" className={HINT_CLASS}>
            Posts as <span className="font-medium text-muted">{preview}</span>
          </p>
        </div>

        <AgentToolPicker workspaceId={props.workspaceId} profile={profile} disabled={busy} checkLabel="Check"
          onError={props.onError} onChange={(value) => { setProfile(value); setCheck({ status: "idle" }); }} />
        <details open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
          <summary className="cursor-pointer text-[12px] text-muted">Advanced</summary>
          {profile && command.trim() ? <SecondaryButton size="compact" disabled={busy} onClick={() => { setProfile(undefined); setCheck({ status: "idle" }); }}>Use saved command</SecondaryButton> : null}
        <div className="mt-2 flex flex-col gap-1">
          <label htmlFor="chats-add-agent-command" className={LABEL_CLASS}>
            Runner command
          </label>
          <input
            id="chats-add-agent-command"
            data-testid="chats-add-agent-command"
            value={profile ? configuredRunnerCommand({ command, profile }) : command}
            maxLength={4096}
            disabled={busy}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            placeholder={COMMAND_PLACEHOLDER}
            onChange={(event) => { setCommand(event.currentTarget.value); setProfile(undefined); setCheck({ status: "idle" }); }}
            className={`${INPUT_CLASS} font-mono text-[12px]`}
          />
          <p className={HINT_CLASS}>
            Editing this command turns off the tool profile. The conversation arrives through stdin.
          </p>
        </div>

        </details>

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
            {check.status === "ok" ? check.detail : "Check failed. See Notices."}
          </p>
        ) : null}

        <div className="flex items-center gap-1.5">
          <SecondaryButton
            size="compact"
            data-testid="chats-add-agent-check"
            disabled={busy || !agentName.trim() || trimmedCommand.length === 0}
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
            className="h-7 rounded-md px-2.5 text-[11px] text-muted hover:bg-hover hover:text-ink disabled:opacity-50 dohc-focus-visible"
          >
            Cancel
          </button>
          <PrimaryButton
            size="compact"
            type="submit"
            data-testid="chats-add-agent-submit"
            disabled={busy || !agentName.trim() || trimmedCommand.length === 0}
          >
            {saving ? "Saving…" : "Add agent"}
          </PrimaryButton>
        </div>
      </form>
    </Overlay>
  );
}
