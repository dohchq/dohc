import { FileText } from "lucide-react";
import { useState } from "react";
import { bridge } from "../bridge";
import { convertedWords, type NoteConversion } from "../shell/useNoteConversion";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SecondaryButton } from "../ui/controls";
import { SettingRow } from "./SettingRow";

/**
 * Settings › Advanced › Note format: converts the owner's notes to the new
 * format once the engine writes it. Shared views never show it.
 */
export function NoteFormatRow(props: {
  conversion: NoteConversion;
  workspaceName: string;
  sharedView: boolean;
}) {
  const { state, start } = props.conversion;
  const [confirming, setConfirming] = useState(false);
  if (!bridge().convertsNotes || props.sharedView) return null;

  const description =
    state.status === "running" ? (
      state.total === 0 ? (
        "Checking open notes…"
      ) : (
        <span className="flex flex-col gap-1.5">
          <span>{`Converting notes · ${state.done.toLocaleString("en-US")} of ${state.total.toLocaleString("en-US")}`}</span>
          <span
            role="progressbar"
            aria-label="Converting notes"
            aria-valuemin={0}
            aria-valuemax={state.total}
            aria-valuenow={state.done}
            className="block h-1 w-40 overflow-hidden rounded-full bg-hover"
          >
            <span
              className="block h-full bg-accent motion-safe:transition-[width]"
              style={{ width: `${Math.min(100, (state.done / state.total) * 100)}%` }}
            />
          </span>
        </span>
      )
    ) : state.status === "done" ? (
      convertedWords(state.converted)
    ) : state.status === "failed" ? (
      "dohc could not convert notes."
    ) : (
      "Convert this workspace's notes to the new format."
    );

  return (
    <SettingRow title="Note format" description={description} testId="settings-row-note-format">
      {state.status === "failed" ? (
        <SecondaryButton onClick={start}>Try again</SecondaryButton>
      ) : (
        <SecondaryButton disabled={state.status === "running"} onClick={() => setConfirming(true)}>
          Convert notes…
        </SecondaryButton>
      )}
      {confirming ? (
        <ConfirmDialog
          title={`Convert notes in ${props.workspaceName} to the new format`}
          icon={FileText}
          intent="danger"
          confirmLabel="Convert notes"
          testId="settings-confirm-convert-notes"
          cancelTestId="settings-cancel-convert-notes"
          confirmTestId="settings-confirm-convert-notes-action"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            start();
          }}
        >
          <p className="m-0">
            Every computer and phone that opens this workspace must run this version of dohc or a
            later one first. This cannot be undone.
          </p>
        </ConfirmDialog>
      ) : null}
    </SettingRow>
  );
}
