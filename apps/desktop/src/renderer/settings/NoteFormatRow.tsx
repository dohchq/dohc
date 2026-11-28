import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { convertedWords, finishedWords, type NoteConversion } from "../shell/useNoteConversion";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { RetryRow, SecondaryButton } from "../ui/controls";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";
import { SettingRow } from "./SettingRow";

export function convertNotesConfirm(workspaceName: string) {
  return {
    title: `Convert notes in ${workspaceName} to the new format`,
    icon: FileText,
    intent: "danger" as const,
    confirmLabel: "Convert notes",
    children: (
      <p className="m-0">
        Every computer and phone that opens this workspace must run this version of dohc or a later
        one first. This cannot be undone.
      </p>
    ),
  };
}

const OFFER_CHECK = "note-conversion-offered";
const OFFER_UNREAD = "dohc could not check whether this workspace's notes can be converted.";

type RowProps = { conversion: NoteConversion; workspaceName: string; searchMatch?: boolean };

export function OfferedNoteFormatRow(
  props: RowProps & {
    workspaceId: string;
    onError?: (
      message: string,
      cause?: unknown,
      retry?: () => Promise<void>,
      details?: undefined,
      identity?: string,
    ) => void;
    onClearError?: (identity: string) => void;
  },
) {
  const { workspaceId, onError, onClearError, ...row } = props;
  const [account, setAccount] = useState({ generation: 0, ready: true });
  useEffect(
    () =>
      bridge().onCloudSessionChanged(({ phase }) =>
        setAccount((current) => ({ generation: current.generation + 1, ready: phase === "ready" })),
      ),
    [],
  );
  const offered = useWorkspaceQuery(useWorkspaceSession(), {
    key: `${workspaceId}:${account.generation}`,
    manual: !account.ready,
    load: async () => (await bridge().readNoteConversionOffered({ workspaceId })).offered,
  });
  const { error, pending, value, retry } = offered;
  useEffect(() => {
    if (error === null) return;
    const notice = (cause: unknown) =>
      onError?.(ipcErrorMessage(cause, OFFER_UNREAD), cause, readAgain, undefined, OFFER_CHECK);
    async function readAgain() {
      try {
        await bridge().readNoteConversionOffered({ workspaceId });
      } catch (again) {
        notice(again);
        return;
      }
      onClearError?.(OFFER_CHECK);
      void retry();
    }
    notice(error);
  }, [error, onError, onClearError, retry, workspaceId]);
  useEffect(() => {
    if (!pending && error === null && value !== undefined) onClearError?.(OFFER_CHECK);
  }, [pending, error, value, onClearError]);
  if (error !== null)
    return (
      <SettingRow
        title="Note format"
        testId="settings-row-note-format"
        searchMatch={row.searchMatch === true}
      >
        <RetryRow testId="settings-note-format-retry" onRetry={() => void retry()} />
      </SettingRow>
    );
  return offered.value === true ? <NoteFormatRow {...row} /> : null;
}

export function NoteFormatRow(props: RowProps) {
  const { state, start } = props.conversion;
  const [confirming, setConfirming] = useState(false);

  const description =
    state.status === "running" ? (
      state.total === 0 ? (
        "Checking open notes…"
      ) : (
        <span className="flex flex-col gap-1">
          <span className="tabular-nums">{`Converting notes · ${state.done.toLocaleString("en-US")} of ${state.total.toLocaleString("en-US")}`}</span>
          <span
            role="progressbar"
            aria-label="Converting notes"
            aria-valuemin={0}
            aria-valuemax={state.total}
            aria-valuenow={state.done}
            className="block h-1 w-40 overflow-hidden rounded-full bg-panel-2"
          >
            <span
              className="block h-full bg-accent motion-safe:transition-[width]"
              style={{ width: `${Math.min(100, (state.done / state.total) * 100)}%` }}
            />
          </span>
        </span>
      )
    ) : state.status === "done" ? (
      finishedWords(state.converted, state.left)
    ) : state.status === "unsent" ? (
      `${convertedWords(state.converted)}. dohc could not send them to the server yet.`
    ) : state.status === "failed" ? (
      "dohc could not convert notes."
    ) : (
      "Convert this workspace's notes to the new format."
    );

  return (
    <SettingRow
      title="Note format"
      description={description}
      testId="settings-row-note-format"
      searchMatch={props.searchMatch === true}
    >
      {state.status === "failed" || state.status === "unsent" ? (
        <SecondaryButton onClick={start}>Try again</SecondaryButton>
      ) : (
        <SecondaryButton disabled={state.status === "running"} onClick={() => setConfirming(true)}>
          Convert notes…
        </SecondaryButton>
      )}
      {confirming ? (
        <ConfirmDialog
          {...convertNotesConfirm(props.workspaceName)}
          testId="settings-confirm-convert-notes"
          cancelTestId="settings-cancel-convert-notes"
          confirmTestId="settings-confirm-convert-notes-action"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            start();
          }}
        />
      ) : null}
    </SettingRow>
  );
}
