import { INBOX_COLLECTION_PATH } from "@dohc/workspace-contracts/inbox";
import {
  IncomingWebhookForm,
  MAX_INCOMING_WEBHOOK_NAME_CHARS,
  type IncomingWebhookCreateInput,
  type IncomingWebhookCreatedResult,
  type IncomingWebhooksState,
  type IncomingWebhookSummary,
  type IncomingWebhookUpdateInput,
} from "@dohc/workspace-contracts/incoming-webhooks";
import { Pause, Play, Plus, RefreshCw, Server, ShieldAlert, Trash2, Webhook } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { Overlay } from "../Overlay";
import { ConfirmDialog, confirmPanel, FOCUS_RING, useOpeningFocus } from "../ui/ConfirmDialog";
import { CopyField } from "../ui/CopyButton";
import {
  EmptyState,
  FieldError,
  IconButton,
  Pill,
  PrimaryButton,
  RetryRow,
  SecondaryButton,
} from "../ui/controls";
import { SkeletonRows } from "../ui/SkeletonRows";
import { useRequestSequence } from "../useRequestSequence";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";
import { SettingRow, SettingsSection, SwitchControl } from "./SettingRow";

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function formatCurlExample(endpointUrl: string): string {
  const escaped = endpointUrl.replace(/'/gu, "'\\''");
  return `curl -X POST -H "Content-Type: application/json" -d '{"title":"Captured from curl"}' '${escaped}'`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/gu,
    (char) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[char]};`,
  );
}

function formatFormExample(endpointUrl: string, form: IncomingWebhookForm): string {
  const inputs = form.fields.map((field) =>
    field === "email"
      ? `  <label>email <input name="email" type="email" required></label>`
      : `  <label>${field} <input name="${field}"></label>`,
  );
  return [
    `<form method="post" action="${escapeHtml(endpointUrl)}">`,
    ...inputs,
    `  <button>Send</button>`,
    `</form>`,
  ].join("\n");
}

function hostFromOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function CreateWebhookDialog(props: {
  onCancel: () => void;
  onCreate: (input: IncomingWebhookCreateInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [collectionPath, setCollectionPath] = useState(INBOX_COLLECTION_PATH);
  const [nameError, setNameError] = useState<string | null>(null);
  const [collectionError, setCollectionError] = useState<string | null>(null);
  const [websiteForm, setWebsiteForm] = useState(false);
  const [formFields, setFormFields] = useState("email");
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const id = useId();
  const titleId = `${id}-title`;
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useOpeningFocus(() => nameRef.current);

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    const trimmedCollection = collectionPath.trim().replace(/^\/+|\/+$/gu, "");
    let invalid = false;
    if (!trimmedName) {
      setNameError("Enter a webhook name.");
      invalid = true;
    } else if (trimmedName.length > MAX_INCOMING_WEBHOOK_NAME_CHARS) {
      setNameError(`Use at most ${MAX_INCOMING_WEBHOOK_NAME_CHARS} characters.`);
      invalid = true;
    } else {
      setNameError(null);
    }
    if (!trimmedCollection) {
      setCollectionError("Choose a private Collection folder, such as Inbox.");
      invalid = true;
    } else {
      setCollectionError(null);
    }
    const form = websiteForm
      ? IncomingWebhookForm.safeParse({
          fields: formFields
            .split(",")
            .map((field) => field.trim())
            .filter((field) => field !== ""),
        })
      : null;
    if (form && !form.success) {
      setFieldsError(
        "Name 1 to 10 different fields, such as email, source. Use letters, numbers, - and _.",
      );
      invalid = true;
    } else {
      setFieldsError(null);
    }
    setSubmitError(null);
    if (invalid) return;

    setSaving(true);
    try {
      await props.onCreate({
        name: trimmedName,
        collectionPath: trimmedCollection,
        ...(form?.success ? { form: form.data } : {}),
      });
    } catch (error) {
      setSubmitError(ipcErrorMessage(error, "dohc could not create this incoming webhook."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      onClose={saving ? () => undefined : props.onCancel}
      panelRef={panelRef}
      panelProps={confirmPanel(titleId)}
    >
      <div
        data-testid="incoming-webhook-create-dialog"
        className="dohc-elevated flex w-[min(480px,calc(100vw-32px))] flex-col gap-6 rounded-xl border border-line bg-panel p-6 text-ink"
      >
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="m-0 text-base font-semibold text-ink">
            New incoming webhook
          </h2>
          <p className="m-0 text-[13px] text-muted">
            Creates a POST URL that adds quarantined items into a private Collection.
          </p>
        </div>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
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
              autoComplete="off"
              disabled={saving}
              value={name}
              placeholder="iPhone Shortcut"
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? `${id}-name-error` : undefined}
              data-testid="incoming-webhook-name-input"
              onChange={(event) => {
                setName(event.target.value);
                if (nameError) setNameError(null);
              }}
              className="w-full rounded-md border border-line bg-bg px-3 py-2 text-[13px] text-ink placeholder:text-subtle focus:border-ink disabled:opacity-50"
            />
            {nameError ? (
              <FieldError id={`${id}-name-error`} testId="incoming-webhook-name-error">
                {nameError}
              </FieldError>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-collection`} className="text-[12px] font-medium text-muted">
              Collection folder
            </label>
            <input
              id={`${id}-collection`}
              type="text"
              spellCheck={false}
              autoComplete="off"
              disabled={saving}
              value={collectionPath}
              placeholder={INBOX_COLLECTION_PATH}
              aria-invalid={collectionError ? true : undefined}
              aria-describedby={
                collectionError ? `${id}-collection-error` : `${id}-collection-help`
              }
              data-testid="incoming-webhook-collection-input"
              onChange={(event) => {
                setCollectionPath(event.target.value);
                if (collectionError) setCollectionError(null);
              }}
              className="w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-[13px] text-ink placeholder:text-subtle focus:border-ink disabled:opacity-50"
            />
            {collectionError ? (
              <FieldError id={`${id}-collection-error`} testId="incoming-webhook-collection-error">
                {collectionError}
              </FieldError>
            ) : (
              <p id={`${id}-collection-help`} className="m-0 text-[12px] text-subtle">
                Private Collection folder only. Inbox is created automatically on first delivery.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span id={`${id}-form-label`} className="text-[12px] font-medium text-muted">
                Website form
              </span>
              <SwitchControl
                label="Website form"
                labelledBy={`${id}-form-label`}
                describedBy={`${id}-form-help`}
                checked={websiteForm}
                disabled={saving}
                onChange={setWebsiteForm}
              />
            </div>
            <p id={`${id}-form-help`} className="m-0 text-[12px] text-subtle">
              {websiteForm
                ? "For a public page. Anyone who loads it can post. dohc keeps only the fields below and allows each network 20 posts a day."
                : "Turn on when a public web page posts to this address."}
            </p>
            {websiteForm ? (
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-fields`} className="text-[12px] font-medium text-muted">
                  Fields to keep
                </label>
                <input
                  id={`${id}-fields`}
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={saving}
                  value={formFields}
                  placeholder="email, source"
                  aria-invalid={fieldsError ? true : undefined}
                  aria-describedby={fieldsError ? `${id}-fields-error` : undefined}
                  data-testid="incoming-webhook-form-fields-input"
                  onChange={(event) => {
                    setFormFields(event.target.value);
                    if (fieldsError) setFieldsError(null);
                  }}
                  className="w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-[13px] text-ink placeholder:text-subtle focus:border-ink disabled:opacity-50"
                />
                {fieldsError ? (
                  <FieldError id={`${id}-fields-error`} testId="incoming-webhook-form-fields-error">
                    {fieldsError}
                  </FieldError>
                ) : null}
              </div>
            ) : null}
          </div>

          {submitError ? (
            <FieldError id={`${id}-submit-error`} testId="incoming-webhook-submit-error">
              {submitError}
            </FieldError>
          ) : null}

          <div className="flex justify-end gap-2">
            <SecondaryButton
              data-testid="incoming-webhook-cancel"
              className={FOCUS_RING}
              disabled={saving}
              onClick={props.onCancel}
            >
              Cancel
            </SecondaryButton>
            <PrimaryButton
              type="submit"
              data-testid="incoming-webhook-create-submit"
              className={FOCUS_RING}
              disabled={saving}
            >
              {saving ? "Creating…" : "Create webhook"}
            </PrimaryButton>
          </div>
        </form>
      </div>
    </Overlay>
  );
}

function WebhookRevealDialog(props: {
  revealed: IncomingWebhookCreatedResult;
  wasRotated: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const titleId = `${id}-title`;
  const panelRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const form = props.revealed.webhook.form;
  const example = form
    ? formatFormExample(props.revealed.endpointUrl, form)
    : formatCurlExample(props.revealed.endpointUrl);

  useOpeningFocus(() => doneRef.current);

  return (
    <Overlay onClose={props.onClose} panelRef={panelRef} panelProps={confirmPanel(titleId)}>
      <div
        data-testid="incoming-webhook-reveal-dialog"
        className="dohc-elevated flex w-[min(540px,calc(100vw-32px))] flex-col gap-5 rounded-xl border border-line bg-panel p-6 text-ink"
      >
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="m-0 text-base font-semibold text-ink">
            {props.wasRotated
              ? `New URL for ${props.revealed.webhook.name}`
              : `Webhook URL for ${props.revealed.webhook.name}`}
          </h2>
          <p className="m-0 text-[13px] text-warning">
            Shown once. Save this URL now — dohc cannot show it again. Rotate the webhook later if
            you lose it.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-muted">POST URL</span>
            <CopyField
              label="Copy webhook URL"
              copiedLabel="Webhook URL copied"
              copyTestId="incoming-webhook-reveal-url-copy"
              getText={() => props.revealed.endpointUrl}
            >
              <code
                data-testid="incoming-webhook-reveal-url"
                title={props.revealed.endpointUrl}
                className="font-mono text-[12px]"
              >
                {props.revealed.endpointUrl}
              </code>
            </CopyField>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-muted">
              {form ? "Example form" : "Example curl"}
            </span>
            <CopyField
              label={form ? "Copy example form" : "Copy example curl command"}
              copiedLabel={form ? "Example form copied" : "Example command copied"}
              copyTestId="incoming-webhook-reveal-curl-copy"
              getText={() => example}
            >
              <code
                data-testid="incoming-webhook-reveal-curl"
                title={example}
                className="whitespace-pre-wrap font-mono text-[12px]"
              >
                {example}
              </code>
            </CopyField>
          </div>
        </div>

        <div className="flex justify-end">
          <PrimaryButton
            ref={doneRef}
            data-testid="incoming-webhook-reveal-done"
            className={FOCUS_RING}
            onClick={props.onClose}
          >
            Done
          </PrimaryButton>
        </div>
      </div>
    </Overlay>
  );
}

function webhookDescription(webhook: IncomingWebhookSummary): string {
  if (webhook.paused && webhook.pauseReason) {
    return webhook.pauseReason;
  }
  const parts: string[] = [];
  if (webhook.pendingCount > 0) {
    parts.push(`${webhook.pendingCount} pending`);
  }
  if (webhook.lastDeliveryAtMs !== null) {
    parts.push(`Last delivery ${dayFormat.format(webhook.lastDeliveryAtMs)}`);
  } else {
    parts.push("No deliveries yet");
  }
  if (webhook.recentDeliveries.length > 0) {
    const latest = webhook.recentDeliveries[0]!;
    parts.push(`Latest: ${latest.state}`);
  }
  return parts.join(" · ");
}

export function WorkspaceWebhooksSettings(props: {
  workspaceId: string;
  onError?: (message: string, cause?: unknown) => void;
}) {
  const { workspaceId, onError } = props;
  const session = useWorkspaceSession();
  const requests = useRequestSequence([workspaceId]);
  const [overrideState, setOverrideState] = useState<IncomingWebhooksState | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<{
    result: IncomingWebhookCreatedResult;
    wasRotated: boolean;
  } | null>(null);
  const [rotatingHook, setRotatingHook] = useState<IncomingWebhookSummary | null>(null);
  const [deletingHook, setDeletingHook] = useState<IncomingWebhookSummary | null>(null);
  const [busyWebhookId, setBusyWebhookId] = useState<string | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);

  const query = useWorkspaceQuery(session, {
    key: `incoming-webhooks:${workspaceId}`,
    load: () => bridge().listIncomingWebhooks({ workspaceId }),
  });
  const retryQuery = query.retry;
  const reloadWebhooks = useCallback(() => {
    requests.next();
    setOverrideState(null);
    void retryQuery();
  }, [requests, retryQuery]);

  useEffect(() => {
    setOverrideState(null);
    setCreateOpen(false);
    setRevealed(null);
    setRotatingHook(null);
    setDeletingHook(null);
    setBusyWebhookId(null);
  }, [workspaceId]);

  useEffect(
    () =>
      bridge().onCloudSessionChanged(() => {
        requests.next();
        setOverrideState(null);
        setCreateOpen(false);
        setRevealed(null);
        setRotatingHook(null);
        setDeletingHook(null);
        setBusyWebhookId(null);
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
  const serverOrigin = state?.kind === "ready" ? state.serverOrigin : null;

  const handleCreate = useCallback(
    async (input: IncomingWebhookCreateInput) => {
      const token = requests.next();
      const created = await bridge().createIncomingWebhook({ workspaceId, input });
      if (!requests.isCurrent(token)) return;
      const origin = serverOrigin ?? new URL(created.endpointUrl).origin;
      setOverrideState({
        kind: "ready",
        serverOrigin: origin,
        webhooks: created.webhooks,
        limit: created.limit,
      });
      setCreateOpen(false);
      setRevealed({ result: created, wasRotated: false });
    },
    [requests, serverOrigin, workspaceId],
  );

  const handleTogglePaused = useCallback(
    async (webhook: IncomingWebhookSummary) => {
      const token = requests.next();
      setBusyWebhookId(webhook.webhookId);
      try {
        const input: IncomingWebhookUpdateInput = {
          webhookId: webhook.webhookId,
          paused: !webhook.paused,
        };
        const next = await bridge().updateIncomingWebhook({ workspaceId, input });
        if (!requests.isCurrent(token)) return;
        setOverrideState(next);
      } catch (error) {
        if (!requests.isCurrent(token)) return;
        onError?.(
          ipcErrorMessage(
            error,
            webhook.paused
              ? "dohc could not resume this incoming webhook."
              : "dohc could not pause this incoming webhook.",
          ),
          error,
        );
      } finally {
        if (requests.isCurrent(token)) setBusyWebhookId(null);
      }
    },
    [onError, requests, workspaceId],
  );

  const handleRotate = useCallback(
    async (webhook: IncomingWebhookSummary) => {
      const token = requests.next();
      setBusyWebhookId(webhook.webhookId);
      try {
        const rotated = await bridge().rotateIncomingWebhook({
          workspaceId,
          webhookId: webhook.webhookId,
        });
        if (!requests.isCurrent(token)) return;
        const origin = serverOrigin ?? new URL(rotated.endpointUrl).origin;
        setOverrideState({
          kind: "ready",
          serverOrigin: origin,
          webhooks: rotated.webhooks,
          limit: rotated.limit,
        });
        setRotatingHook(null);
        setRevealed({ result: rotated, wasRotated: true });
      } catch (error) {
        if (!requests.isCurrent(token)) return;
        onError?.(ipcErrorMessage(error, "dohc could not rotate this incoming webhook."), error);
      } finally {
        if (requests.isCurrent(token)) setBusyWebhookId(null);
      }
    },
    [onError, requests, serverOrigin, workspaceId],
  );

  const handleDelete = useCallback(
    async (webhook: IncomingWebhookSummary) => {
      const token = requests.next();
      setBusyWebhookId(webhook.webhookId);
      try {
        const next = await bridge().deleteIncomingWebhook({
          workspaceId,
          webhookId: webhook.webhookId,
        });
        if (!requests.isCurrent(token)) return;
        setOverrideState(next);
        setDeletingHook(null);
      } catch (error) {
        if (!requests.isCurrent(token)) return;
        onError?.(ipcErrorMessage(error, "dohc could not delete this incoming webhook."), error);
      } finally {
        if (requests.isCurrent(token)) setBusyWebhookId(null);
      }
    },
    [onError, requests, workspaceId],
  );

  if (query.error && !state) {
    return (
      <SettingsSection title="Incoming webhooks">
        <div className="py-4">
          <RetryRow
            testId="incoming-webhooks-retry"
            disabled={query.pending}
            onRetry={reloadWebhooks}
          >
            {ipcErrorMessage(
              query.error,
              "dohc could not load this workspace's incoming webhooks.",
            )}
          </RetryRow>
        </div>
      </SettingsSection>
    );
  }

  if (!state) {
    return showSkeleton ? <SkeletonRows layout="panel" label="Loading incoming webhooks…" /> : null;
  }

  if (state.kind === "none") {
    return null;
  }

  if (state.kind === "unavailable") {
    return (
      <SettingsSection title="Incoming webhooks">
        <div className="py-8">
          <EmptyState
            icon={ShieldAlert}
            tone="warning"
            title={state.message}
            data-testid="incoming-webhooks-unavailable"
          >
            <SecondaryButton disabled={query.pending} onClick={reloadWebhooks}>
              Check again
            </SecondaryButton>
          </EmptyState>
        </div>
      </SettingsSection>
    );
  }

  const atLimit = state.webhooks.length >= state.limit;

  return (
    <div data-testid="incoming-webhooks-panel" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="m-0 text-[13px] font-semibold text-ink">Incoming webhooks</h3>
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Server size={13} strokeWidth={1.9} aria-hidden className="shrink-0 text-subtle" />
            <span data-testid="incoming-webhooks-origin">{hostFromOrigin(state.serverOrigin)}</span>
            <span aria-hidden className="text-subtle">
              ·
            </span>
            <span data-testid="incoming-webhooks-count" className="tabular-nums text-subtle">
              {`${state.webhooks.length} of ${state.limit}`}
            </span>
          </div>
        </div>
        <SecondaryButton
          data-testid="incoming-webhooks-add"
          disabled={atLimit}
          title={atLimit ? `Limit of ${state.limit} webhooks reached` : undefined}
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2"
        >
          <Plus size={14} aria-hidden />
          New webhook
        </SecondaryButton>
      </div>

      {state.webhooks.length === 0 ? (
        <SettingsSection>
          <div className="py-8">
            <EmptyState
              icon={Webhook}
              title="No incoming webhooks yet."
              data-testid="incoming-webhooks-empty"
            />
          </div>
        </SettingsSection>
      ) : (
        <SettingsSection>
          {state.webhooks.map((webhook) => {
            const busy = busyWebhookId === webhook.webhookId;
            return (
              <SettingRow
                key={webhook.webhookId}
                testId={`incoming-webhook-row-${webhook.webhookId}`}
                title={webhook.name}
                detail={
                  <span className="inline-flex items-center gap-1.5">
                    <Pill>{webhook.paused ? "Paused" : "Active"}</Pill>
                    <Pill>{webhook.collectionPath}</Pill>
                    {webhook.form ? <Pill>Website form</Pill> : null}
                  </span>
                }
                description={webhookDescription(webhook)}
              >
                <SecondaryButton
                  size="compact"
                  disabled={busy}
                  data-testid={`incoming-webhook-toggle-${webhook.webhookId}`}
                  onClick={() => void handleTogglePaused(webhook)}
                  className="inline-flex items-center gap-1.5"
                >
                  {webhook.paused ? (
                    <>
                      <Play size={12} aria-hidden />
                      Resume
                    </>
                  ) : (
                    <>
                      <Pause size={12} aria-hidden />
                      Pause
                    </>
                  )}
                </SecondaryButton>
                <SecondaryButton
                  size="compact"
                  disabled={busy}
                  data-testid={`incoming-webhook-rotate-${webhook.webhookId}`}
                  onClick={() => setRotatingHook(webhook)}
                  className="inline-flex items-center gap-1.5"
                >
                  <RefreshCw size={12} aria-hidden />
                  Rotate
                </SecondaryButton>
                <IconButton
                  aria-label={`Delete webhook ${webhook.name}`}
                  title={`Delete webhook ${webhook.name}`}
                  disabled={busy}
                  data-testid={`incoming-webhook-delete-${webhook.webhookId}`}
                  onClick={() => setDeletingHook(webhook)}
                >
                  <Trash2 size={14} aria-hidden />
                </IconButton>
              </SettingRow>
            );
          })}
        </SettingsSection>
      )}

      {createOpen ? (
        <CreateWebhookDialog onCancel={() => setCreateOpen(false)} onCreate={handleCreate} />
      ) : null}

      {revealed ? (
        <WebhookRevealDialog
          revealed={revealed.result}
          wasRotated={revealed.wasRotated}
          onClose={() => setRevealed(null)}
        />
      ) : null}

      {rotatingHook ? (
        <ConfirmDialog
          title={`Rotate URL for ${rotatingHook.name}?`}
          icon={RefreshCw}
          confirmLabel={busyWebhookId === rotatingHook.webhookId ? "Rotating…" : "Rotate URL"}
          confirmDisabled={busyWebhookId === rotatingHook.webhookId}
          testId="incoming-webhook-confirm-rotate"
          cancelTestId="incoming-webhook-cancel-rotate"
          confirmTestId="incoming-webhook-confirm-rotate-action"
          onCancel={() => {
            if (busyWebhookId !== rotatingHook.webhookId) setRotatingHook(null);
          }}
          onConfirm={() => void handleRotate(rotatingHook)}
        >
          <p className="m-0">
            The current webhook URL stops working immediately. Update any shortcuts or external
            tools with the new URL.
          </p>
        </ConfirmDialog>
      ) : null}

      {deletingHook ? (
        <ConfirmDialog
          title={`Delete webhook ${deletingHook.name}?`}
          icon={Trash2}
          intent="danger"
          confirmLabel={busyWebhookId === deletingHook.webhookId ? "Deleting…" : "Delete webhook"}
          confirmDisabled={busyWebhookId === deletingHook.webhookId}
          testId="incoming-webhook-confirm-delete"
          cancelTestId="incoming-webhook-cancel-delete"
          confirmTestId="incoming-webhook-confirm-delete-action"
          onCancel={() => {
            if (busyWebhookId !== deletingHook.webhookId) setDeletingHook(null);
          }}
          onConfirm={() => void handleDelete(deletingHook)}
        >
          <p className="m-0">
            External requests to this URL will receive 404 Not Found. Records already delivered stay
            in your workspace. This cannot be undone.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
