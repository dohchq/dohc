import { FileText } from "lucide-react";
import { useState } from "react";
import { convertedWords, finishedWords, type NoteConversion } from "../shell/useNoteConversion";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { RetryRow, SecondaryButton } from "../ui/controls";
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

type RowProps = {
  conversion: Pick<NoteConversion, "state" | "start">;
  workspaceName: string;
  searchMatch?: boolean;
};

export function OfferedNoteFormatRow(props: RowProps & { conversion: NoteConversion }) {
  const { value, failed, retry } = props.conversion.offer;
  if (failed)
    return (
      <SettingRow
        title="Note format"
        testId="settings-row-note-format"
        searchMatch={props.searchMatch === true}
      >
        <RetryRow testId="settings-note-format-retry" onRetry={retry} />
      </SettingRow>
    );
  return value === true ? <NoteFormatRow {...props} /> : null;
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
