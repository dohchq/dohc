import {
  MAX_SECRET_ALLOWED_HOSTS,
  normalizeSecretAllowedHost,
  validateSecretHeaderValue,
  validateSecretHttpUrl,
  WORKSPACE_SECRET_NAME_PATTERN,
  type WorkspaceSecretsState,
  type WorkspaceSecretSummary,
  type WorkspaceSecretUsage,
  type WorkspaceSecretUse,
  type WorkspaceSecretWriteInput,
} from "@dohc/workspace-contracts/workspace-secrets";
import { KeyRound, Laptop, Plus, Server, ShieldAlert, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { Overlay } from "../Overlay";
import { ConfirmDialog, confirmPanel, FOCUS_RING, useOpeningFocus } from "../ui/ConfirmDialog";
import {
  EmptyState,
  FieldError,
  IconButton,
  Pill,
  PrimaryButton,
  RetryRow,
  SecondaryButton,
} from "../ui/controls";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SkeletonRows } from "../ui/SkeletonRows";
import { useRequestSequence } from "../useRequestSequence";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";
import { SettingRow, SettingsSection } from "./SettingRow";

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export type SecretDraft = { name: string; usage: WorkspaceSecretUsage; hosts: string[] };

type EditorMode =
  | { kind: "add"; draft?: SecretDraft }
  | { kind: "replace"; secret: WorkspaceSecretSummary };

const secretUsageLabel = (usage: WorkspaceSecretUsage) =>
  usage === "http-header" ? "API key" : "Webhook link";

function SecretUses(props: { uses: readonly WorkspaceSecretUse[] | undefined }) {
  if (!props.uses?.length) return null;
  return (
    <div data-testid="workspace-secret-uses" className="flex flex-col gap-1 text-[13px]">
      <span className="text-muted">Used by</span>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {props.uses.map((use, index) => (
          <li key={index} className="text-ink">
            {use.automationName}
            <span className="text-muted">{` in ${use.collectionPath}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type FieldErrors = {
  name?: string;
  hosts?: string;
  value?: string;
};

function parseHostList(raw: string): { hosts: string[]; error?: string } {
  const parts = raw
    .split(/[\s,]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { hosts: [], error: "Add at least one allowed website." };
  if (parts.length > MAX_SECRET_ALLOWED_HOSTS) {
    return { hosts: [], error: `Enter at most ${MAX_SECRET_ALLOWED_HOSTS} websites.` };
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const host = normalizeSecretAllowedHost(part);
    if (host === null) {
      return {
        hosts: [],
        error: `"${part}" is not a public website. Enter one like api.resend.com.`,
      };
    }
    if (!seen.has(host)) {
      seen.add(host);
      normalized.push(host);
    }
  }
  return { hosts: normalized.sort() };
}

export function SecretEditorDialog(props: {
  mode: EditorMode;
  storage: "local" | "server";
  existingNames: ReadonlySet<string>;
  uses?: readonly WorkspaceSecretUse[];
  onCancel: () => void;
  onSave: (secret: WorkspaceSecretWriteInput) => Promise<void>;
}) {
  const existing = props.mode.kind === "replace" ? props.mode.secret : null;
  const draft = props.mode.kind === "add" ? props.mode.draft : undefined;
  const isReplace = existing !== null;
  const [name, setName] = useState(existing?.name ?? draft?.name ?? "");
  const [usage, setUsage] = useState<WorkspaceSecretUsage>(
    existing?.usage ?? draft?.usage ?? "http-header",
  );
  const [hostsText, setHostsText] = useState(
    (existing?.allowedHosts ?? draft?.hosts ?? []).join(", "),
  );
  const [value, setValue] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const id = useId();
  const titleId = `${id}-title`;
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);

  useOpeningFocus(() => (isReplace || draft?.name ? valueRef.current : nameRef.current));

  useEffect(
    () => () => {
      if (valueRef.current) valueRef.current.value = "";
    },
    [],
  );

  const validateNameField = (raw: string): string | undefined => {
    const trimmed = raw.trim();
    if (!trimmed) return "Enter a secret name.";
    if (!WORKSPACE_SECRET_NAME_PATTERN.test(trimmed)) {
      return "Use A-Z, 0-9, and _, starting with a letter (up to 64 characters).";
    }
    if (!isReplace && props.existingNames.has(trimmed)) {
      return `A secret named ${trimmed} already exists. Use Replace to update it.`;
    }
    return undefined;
  };

  const validateValueField = (raw: string, nextUsage: WorkspaceSecretUsage): string | undefined => {
    if (!raw) return "Enter a secret value.";
    if (nextUsage === "http-header") {
      if (!validateSecretHeaderValue(raw)) {
        return "An API key can use only plain letters, numbers, and symbols, up to 4,096 characters, with no line breaks or tabs.";
      }
      return undefined;
    }
    if (validateSecretHttpUrl(raw) === null) {
      return "Enter a public https:// link (port 443, no IP address or local host).";
    }
    return undefined;
  };

  const handleClose = () => {
    setValue("");
    if (valueRef.current) valueRef.current.value = "";
    props.onCancel();
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    const nextErrors: FieldErrors = {};
    const nameError = validateNameField(trimmedName);
    if (nameError) nextErrors.name = nameError;
    let hosts: string[] = [];
    if (usage === "http-header") {
      const parsedHosts = parseHostList(hostsText);
      if (parsedHosts.error) nextErrors.hosts = parsedHosts.error;
      else hosts = parsedHosts.hosts;
    }
    const valueError = validateValueField(value, usage);
    if (valueError) nextErrors.value = valueError;
    setFieldErrors(nextErrors);
    setSubmitError(null);
    if (Object.keys(nextErrors).length > 0) return;

    const writeMode = isReplace ? "replace" : "create";
    const secret: WorkspaceSecretWriteInput =
      usage === "http-header"
        ? { name: trimmedName, mode: writeMode, usage: "http-header", value, allowedHosts: hosts }
        : { name: trimmedName, mode: writeMode, usage: "http-url", value };
    setSaving(true);
    try {
      await props.onSave(secret);
      setValue("");
      if (valueRef.current) valueRef.current.value = "";
    } catch (error) {
      setSubmitError(ipcErrorMessage(error, "dohc could not save this secret."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      onClose={saving ? () => undefined : handleClose}
      panelRef={panelRef}
      panelProps={confirmPanel(titleId)}
    >
      <div
        data-testid="workspace-secret-editor-dialog"
        className="dohc-elevated flex w-[min(480px,calc(100vw-32px))] flex-col gap-6 rounded-xl border border-line bg-panel p-6 text-ink"
      >
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="m-0 text-base font-semibold text-ink">
            {existing
              ? `Replace ${existing.name}`
              : draft
                ? `Add ${draft.usage === "http-header" ? "API key" : "webhook link"}`
                : "Add secret"}
          </h2>
          <p className="m-0 text-[13px] text-muted">
            {props.storage === "server"
              ? "Sealed on your sync server. Values cannot be read back after saving."
              : "Sealed in this computer's keychain. Values cannot be read back after saving."}
          </p>
        </div>

        {isReplace ? <SecretUses uses={props.uses} /> : null}

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!saving) void handleSubmit();
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-name`} className="text-[12px] font-medium text-muted">
              Name
            </label>
            <input
              ref={nameRef}
              id={`${id}-name`}
              type="text"
              spellCheck={false}
              autoComplete="off"
              disabled={isReplace || saving}
              value={name}
              placeholder="RESEND_API_KEY"
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={fieldErrors.name ? `${id}-name-error` : undefined}
              data-testid="workspace-secret-name-input"
              onChange={(event) => {
                setName(event.target.value);
                setFieldErrors((current) =>
                  current.name ? { ...current, name: undefined } : current,
                );
              }}
              onBlur={() => {
                if (!name.trim()) return;
                setFieldErrors((current) => ({
                  ...current,
                  name: validateNameField(name),
                }));
              }}
              className="w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-[13px] text-ink placeholder:text-subtle focus:border-ink disabled:opacity-50"
            />
            {fieldErrors.name ? (
              <FieldError id={`${id}-name-error`} testId="workspace-secret-name-error">
                {fieldErrors.name}
              </FieldError>
            ) : null}
          </div>

          {draft ? null : (
            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-muted">Use</span>
              <SegmentedControl
                label="Secret use"
                testId="workspace-secret-usage"
                value={usage}
                disabled={saving}
                options={[
                  { value: "http-header", label: secretUsageLabel("http-header") },
                  { value: "http-url", label: secretUsageLabel("http-url") },
                ]}
                onChange={(nextUsage) => {
                  setUsage(nextUsage);
                  setFieldErrors((current) => ({
                    ...current,
                    hosts: undefined,
                    value: undefined,
                  }));
                }}
              />
            </div>
          )}

          {usage === "http-header" ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-hosts`} className="text-[12px] font-medium text-muted">
                Allowed websites
              </label>
              <input
                id={`${id}-hosts`}
                type="text"
                spellCheck={false}
                autoComplete="off"
                disabled={saving}
                value={hostsText}
                placeholder="api.resend.com"
                aria-invalid={fieldErrors.hosts ? true : undefined}
                aria-describedby={fieldErrors.hosts ? `${id}-hosts-error` : `${id}-hosts-help`}
                data-testid="workspace-secret-hosts-input"
                onChange={(event) => {
                  setHostsText(event.target.value);
                  setFieldErrors((current) =>
                    current.hosts ? { ...current, hosts: undefined } : current,
                  );
                }}
                onBlur={() => {
                  if (!hostsText.trim()) return;
                  setFieldErrors((current) => ({
                    ...current,
                    hosts: parseHostList(hostsText).error,
                  }));
                }}
                className="w-full rounded-md border border-line bg-bg px-3 py-2 text-[13px] text-ink placeholder:text-subtle focus:border-ink disabled:opacity-50"
              />
              {fieldErrors.hosts ? (
                <FieldError id={`${id}-hosts-error`} testId="workspace-secret-hosts-error">
                  {fieldErrors.hosts}
                </FieldError>
              ) : (
                <p id={`${id}-hosts-help`} className="m-0 text-[12px] text-subtle">
                  Automations send this key only to these websites.
                </p>
              )}
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-value`} className="text-[12px] font-medium text-muted">
              {secretUsageLabel(usage)}
            </label>
            <input
              ref={valueRef}
              id={`${id}-value`}
              type="password"
              spellCheck={false}
              autoComplete="off"
              disabled={saving}
              value={value}
              placeholder={usage === "http-url" ? "https://hooks.slack.com/services/..." : ""}
              aria-invalid={fieldErrors.value ? true : undefined}
              aria-describedby={fieldErrors.value ? `${id}-value-error` : undefined}
              data-testid="workspace-secret-value-input"
              onChange={(event) => {
                setValue(event.target.value);
                setFieldErrors((current) =>
                  current.value ? { ...current, value: undefined } : current,
                );
              }}
              onBlur={() => {
                if (!value) return;
                setFieldErrors((current) => ({
                  ...current,
                  value: validateValueField(value, usage),
                }));
              }}
              className="w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-[13px] text-ink placeholder:text-subtle focus:border-ink disabled:opacity-50"
            />
            {fieldErrors.value ? (
              <FieldError id={`${id}-value-error`} testId="workspace-secret-value-error">
                {fieldErrors.value}
              </FieldError>
            ) : null}
          </div>

          {submitError ? (
            <FieldError id={`${id}-submit-error`} testId="workspace-secret-submit-error">
              {submitError}
            </FieldError>
          ) : null}

          <div className="flex justify-end gap-2">
            <SecondaryButton
              data-testid="workspace-secret-cancel"
              className={FOCUS_RING}
              disabled={saving}
              onClick={handleClose}
            >
              Cancel
            </SecondaryButton>
            <PrimaryButton
              type="submit"
              data-testid="workspace-secret-save"
              className={FOCUS_RING}
              disabled={saving}
            >
              {saving ? "Saving…" : isReplace ? "Replace secret" : "Save secret"}
            </PrimaryButton>
          </div>
        </form>
      </div>
    </Overlay>
  );
}

export function WorkspaceSecretsSettings(props: {
  workspaceId: string;
  onError?: (message: string, cause?: unknown) => void;
}) {
  const { workspaceId, onError } = props;
  const session = useWorkspaceSession();
  const requests = useRequestSequence([workspaceId]);
  const [overrideState, setOverrideState] = useState<WorkspaceSecretsState | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode | null>(null);
  const [deletingSecret, setDeletingSecret] = useState<string | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);

  const query = useWorkspaceQuery(session, {
    key: `workspace-secrets:${workspaceId}`,
    load: () => bridge().listWorkspaceSecrets({ workspaceId }),
  });
  const retryQuery = query.retry;
  const reloadSecrets = useCallback(() => {
    requests.next();
    setOverrideState(null);
    void retryQuery();
  }, [requests, retryQuery]);

  useEffect(() => {
    setOverrideState(null);
    setEditorMode(null);
    setDeletingSecret(null);
    setDeletingBusy(false);
    setConfirmingClear(false);
  }, [workspaceId]);

  useEffect(
    () =>
      bridge().onCloudSessionChanged(() => {
        requests.next();
        setOverrideState(null);
        setEditorMode(null);
        setDeletingSecret(null);
        setDeletingBusy(false);
        setConfirmingClear(false);
        void retryQuery();
      }),
    [requests, retryQuery],
  );

  useEffect(() => {
    if (!query.pending || query.value !== undefined) {
      setShowSkeleton(false);
      return;
    }
    const timer = setTimeout(() => setShowSkeleton(true), 150);
    return () => clearTimeout(timer);
  }, [query.pending, query.value]);

  const state = overrideState ?? query.value;

  const handleSave = useCallback(
    async (secret: WorkspaceSecretWriteInput) => {
      const token = requests.next();
      const next = await bridge().setWorkspaceSecret({ workspaceId, secret });
      if (!requests.isCurrent(token)) return;
      setOverrideState(next);
      setEditorMode(null);
    },
    [requests, workspaceId],
  );

  const handleDelete = useCallback(
    async (name: string) => {
      const token = requests.next();
      setDeletingBusy(true);
      try {
        const next = await bridge().deleteWorkspaceSecret({ workspaceId, name });
        if (!requests.isCurrent(token)) return;
        setOverrideState(next);
        setDeletingSecret(null);
      } catch (error) {
        if (!requests.isCurrent(token)) return;
        onError?.(ipcErrorMessage(error, "dohc could not delete this secret."), error);
      } finally {
        if (requests.isCurrent(token)) setDeletingBusy(false);
      }
    },
    [onError, requests, workspaceId],
  );

  const handleClearLocal = useCallback(async () => {
    const token = requests.next();
    setDeletingBusy(true);
    try {
      const next = await bridge().clearLocalWorkspaceSecrets({ workspaceId });
      if (!requests.isCurrent(token)) return;
      setOverrideState(next);
      setConfirmingClear(false);
    } catch (error) {
      if (!requests.isCurrent(token)) return;
      onError?.(ipcErrorMessage(error, "dohc could not delete the saved secrets."), error);
    } finally {
      if (requests.isCurrent(token)) setDeletingBusy(false);
    }
  }, [onError, requests, workspaceId]);

  if (query.error && !state) {
    return (
      <SettingsSection>
        <div className="py-4">
          <RetryRow
            testId="workspace-secrets-retry"
            disabled={query.pending}
            onRetry={reloadSecrets}
          >
            {ipcErrorMessage(query.error, "dohc could not load this workspace's secrets.")}
          </RetryRow>
        </div>
      </SettingsSection>
    );
  }

  if (!state) {
    return showSkeleton ? <SkeletonRows layout="panel" label="Loading workspace secrets…" /> : null;
  }

  if (state.kind === "none") {
    return (
      <SettingsSection>
        <div className="py-8">
          <EmptyState
            icon={KeyRound}
            title="Workspace secrets are available only in workspaces you own."
          />
        </div>
      </SettingsSection>
    );
  }

  function clearDialog(synced: boolean) {
    return (
      <ConfirmDialog
        title={
          synced
            ? "Delete the secrets saved on this computer?"
            : "Delete this workspace's saved secrets?"
        }
        icon={Trash2}
        intent="danger"
        confirmLabel={deletingBusy ? "Deleting…" : "Delete saved secrets"}
        confirmDisabled={deletingBusy}
        testId="workspace-secrets-confirm-clear-local"
        cancelTestId="workspace-secrets-cancel-clear-local"
        confirmTestId="workspace-secrets-confirm-clear-local-action"
        onCancel={() => {
          if (!deletingBusy) setConfirmingClear(false);
        }}
        onConfirm={() => void handleClearLocal()}
      >
        <p className="m-0">
          {synced
            ? "dohc deletes the secrets this workspace saved on this computer before it synced. The secrets on your server stay. This cannot be undone."
            : "dohc deletes every secret this workspace saved on this computer. Automations that use them stop until you add them again. This cannot be undone."}
        </p>
      </ConfirmDialog>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <SettingsSection>
        <div className="py-8">
          <EmptyState
            icon={ShieldAlert}
            tone="warning"
            title={state.message}
            data-testid="workspace-secrets-unavailable"
          >
            <SecondaryButton disabled={query.pending} onClick={reloadSecrets}>
              Check again
            </SecondaryButton>
            {state.canDelete ? (
              <SecondaryButton
                data-testid="workspace-secrets-clear-local"
                onClick={() => setConfirmingClear(true)}
              >
                Delete saved secrets
              </SecondaryButton>
            ) : null}
          </EmptyState>
        </div>
        {confirmingClear ? clearDialog(false) : null}
      </SettingsSection>
    );
  }

  const StorageIcon = state.storage === "server" ? Server : Laptop;
  const storageLabel =
    state.storage === "server" ? "Sealed on your sync server" : "Sealed on this computer";
  const atLimit = state.secrets.length >= state.limit;
  const usesOf = (name: string) =>
    query.pending || query.error !== null || query.value?.kind !== "ready"
      ? undefined
      : query.value.uses?.[name];

  return (
    <div data-testid="workspace-secrets-panel" className="flex flex-col gap-6">
      <p className="m-0 text-[13px] text-muted">
        Secrets keep API keys and private webhook links out of your automation files. An API key
        goes only to the websites you allow, and dohc doesn't show a secret again after you save it.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <StorageIcon size={14} strokeWidth={1.9} aria-hidden className="shrink-0 text-subtle" />
          <span data-testid="workspace-secrets-storage">{storageLabel}</span>
          <span aria-hidden className="text-subtle">
            ·
          </span>
          <span data-testid="workspace-secrets-count" className="tabular-nums text-subtle">
            {`${state.secrets.length} of ${state.limit}`}
          </span>
        </div>
        <PrimaryButton
          data-testid="workspace-secrets-add"
          disabled={atLimit}
          title={atLimit ? `Limit of ${state.limit} secrets reached` : undefined}
          onClick={() => setEditorMode({ kind: "add" })}
          className="inline-flex items-center gap-2"
        >
          <Plus size={14} aria-hidden />
          Add secret
        </PrimaryButton>
      </div>

      {state.secrets.length === 0 ? (
        <SettingsSection>
          <div className="py-8">
            <EmptyState
              icon={KeyRound}
              title="No workspace secrets yet."
              data-testid="workspace-secrets-empty"
            />
          </div>
        </SettingsSection>
      ) : (
        <SettingsSection>
          {state.secrets.map((secret) => (
            <SettingRow
              key={secret.name}
              testId={`workspace-secret-row-${secret.name}`}
              title={secret.name}
              detail={<Pill>{secretUsageLabel(secret.usage)}</Pill>}
              description={
                secret.usage === "http-header"
                  ? `Sent only to ${secret.allowedHosts.join(", ")} · Updated ${dayFormat.format(secret.updatedAtMs)}`
                  : `Hidden webhook link · Updated ${dayFormat.format(secret.updatedAtMs)}`
              }
            >
              <SecondaryButton
                size="compact"
                data-testid={`workspace-secret-replace-${secret.name}`}
                onClick={() => {
                  void retryQuery();
                  setEditorMode({ kind: "replace", secret });
                }}
              >
                Replace
              </SecondaryButton>
              <IconButton
                aria-label={`Delete secret ${secret.name}`}
                title={`Delete secret ${secret.name}`}
                data-testid={`workspace-secret-delete-${secret.name}`}
                onClick={() => {
                  void retryQuery();
                  setDeletingSecret(secret.name);
                }}
              >
                <Trash2 size={14} aria-hidden />
              </IconButton>
            </SettingRow>
          ))}
        </SettingsSection>
      )}

      {state.localCopies ? (
        <SettingsSection>
          <SettingRow
            testId="workspace-secrets-local-copies"
            title="Secrets from before sync"
            description="This computer still has secrets this workspace saved before it synced. Automations now use the secrets on your server."
          >
            <SecondaryButton
              size="compact"
              data-testid="workspace-secrets-clear-local"
              onClick={() => setConfirmingClear(true)}
            >
              Delete old secrets on this computer
            </SecondaryButton>
          </SettingRow>
        </SettingsSection>
      ) : null}

      {confirmingClear ? clearDialog(true) : null}

      {editorMode ? (
        <SecretEditorDialog
          mode={editorMode}
          storage={state.storage}
          existingNames={new Set(state.secrets.map((secret) => secret.name))}
          uses={editorMode.kind === "replace" ? usesOf(editorMode.secret.name) : undefined}
          onCancel={() => setEditorMode(null)}
          onSave={handleSave}
        />
      ) : null}

      {deletingSecret ? (
        <ConfirmDialog
          title={`Delete secret ${deletingSecret}?`}
          icon={Trash2}
          intent="danger"
          confirmLabel={deletingBusy ? "Deleting…" : "Delete secret"}
          confirmDisabled={deletingBusy}
          testId="workspace-secret-confirm-delete"
          cancelTestId="workspace-secret-cancel-delete"
          confirmTestId="workspace-secret-confirm-delete-action"
          onCancel={() => {
            if (!deletingBusy) setDeletingSecret(null);
          }}
          onConfirm={() => void handleDelete(deletingSecret)}
        >
          <div className="flex flex-col gap-3">
            <SecretUses uses={usesOf(deletingSecret)} />
            <p className="m-0">
              Automations that use this secret stop until you add it again. This cannot be undone.
            </p>
          </div>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
