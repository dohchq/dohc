import { useEffect, useMemo, useRef, useState } from "react";
import {
  leftNoteCount,
  leftNoteGroups,
  type ConvertNotesResult,
} from "@dohc/workspace-contracts/note-format";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { useRequestSequence } from "../useRequestSequence";
import type { ErrorDetailField } from "./copyDetails";
import type { useShellError } from "./useShellError";

type Shell = ReturnType<typeof useShellError>;

export type NoteConversionState =
  | { status: "idle" }
  | { status: "running"; done: number; total: number }
  | { status: "done"; converted: number }
  | { status: "unsent"; converted: number }
  | { status: "sending"; converted: number }
  | { status: "failed" };

export interface NoteConversion {
  state: NoteConversionState;
  start(): void;
  /** Sends the notes the last run converted but could not send. */
  send(): void;
}

const KIND = "note-conversion";
const IDLE: NoteConversionState = { status: "idle" };
const SHOWN_PER_GROUP = 3;

const countWords = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count.toLocaleString("en-US")} ${many}`;

/** What a finished run says first: how many notes it converted. */
export function convertedWords(converted: number): string {
  return converted === 0
    ? "No notes to convert"
    : `Converted ${countWords(converted, "note", "notes")}`;
}

const pathWords = (path: string) => path || "(no path)";

/** The Notices row for a run that left notes or could not send them, or null for a clean run. */
export function noteConversionNotice(result: ConvertNotesResult): {
  title?: string;
  message: string;
  tone: "warning";
  rows?: string[];
  details?: ErrorDetailField[];
} | null {
  const left = leftNoteCount(result);
  const converted =
    result.converted === 0 ? "No notes were converted." : `${convertedWords(result.converted)}.`;
  const unsent = result.sent
    ? ""
    : " dohc could not send them to the server yet. Try again to send them.";
  if (left === 0) return result.sent ? null : { message: `${converted}${unsent}`, tone: "warning" };
  const groups = leftNoteGroups(result);
  return {
    title: `${countWords(left, "note was", "notes were")} not converted`,
    message: `${converted}${unsent} The rest stay as they were and can still be edited. Convert them once they close or finish syncing.`,
    tone: "warning",
    rows: groups.map(({ title, notes }) => {
      const shown = notes.slice(0, SHOWN_PER_GROUP).map(({ path }) => pathWords(path));
      const more = notes.length - shown.length;
      return `${title}: ${shown.join(", ")}${more > 0 ? ` and ${more.toLocaleString("en-US")} more` : ""}`;
    }),
    details: groups.flatMap(({ title, notes }) =>
      notes.map(
        ({ path, reason }) =>
          [title, reason ? `${pathWords(path)}: ${reason}` : pathWords(path)] as const,
      ),
    ),
  };
}

/**
 * Runs Convert notes for the workspace this window shows, follows its
 * progress, and files what it left in Notices. A run's result shows only in
 * the workspace that started it.
 */
export function useNoteConversion(input: {
  workspaceId: string;
  report: Shell["reportShellFailure"];
  success: Shell["showSuccessNotice"];
  clear: Shell["clearKind"];
}): NoteConversion {
  const { workspaceId, report, success, clear } = input;
  const requests = useRequestSequence([workspaceId]);
  const [shown, setShown] = useState({ workspaceId, state: IDLE });
  const state = shown.workspaceId === workspaceId ? shown.state : IDLE;

  useEffect(
    () =>
      bridge().onNoteConversionProgress(({ workspaceId: from, done, total }) => {
        if (from !== workspaceId) return;
        setShown((current) =>
          current.workspaceId === workspaceId && current.state.status === "running"
            ? { workspaceId, state: { status: "running", done, total } }
            : current,
        );
      }),
    [workspaceId],
  );

  const unsent = useRef<{ workspaceId: string; result: ConvertNotesResult } | null>(null);
  const run = useMemo(() => {
    const show = (next: NoteConversionState) => setShown({ workspaceId, state: next });

    function settle(result: ConvertNotesResult, cause?: unknown) {
      unsent.current = result.sent ? null : { workspaceId, result };
      show({ status: result.sent ? "done" : "unsent", converted: result.converted });
      const notice = noteConversionNotice(result);
      if (!notice) {
        clear(KIND);
        success(convertedWords(result.converted), undefined, KIND);
        return;
      }
      report({
        ...notice,
        ...(cause === undefined ? {} : { cause }),
        kind: KIND,
        retry: result.sent ? null : send,
        ...(leftNoteCount(result) > 0
          ? { action: { label: "Convert remaining", run: convert, ends: true } }
          : {}),
      });
    }

    function send() {
      if (unsent.current?.workspaceId !== workspaceId) return;
      const { result } = unsent.current;
      const token = requests.next();
      show({ status: "sending", converted: result.converted });
      bridge()
        .sendConvertedNotes({ workspaceId })
        .then(
          () => {
            if (requests.isCurrent(token)) settle({ ...result, sent: true });
          },
          (error: unknown) => {
            if (requests.isCurrent(token)) settle(result, error);
          },
        );
    }

    function convert() {
      const token = requests.next();
      unsent.current = null;
      show({ status: "running", done: 0, total: 0 });
      bridge()
        .convertNotes({ workspaceId })
        .then(
          (result) => {
            if (requests.isCurrent(token)) settle(result);
          },
          (error: unknown) => {
            if (!requests.isCurrent(token)) return;
            show({ status: "failed" });
            report({
              message: ipcErrorMessage(error, "dohc could not convert notes."),
              cause: error,
              retry: convert,
              kind: KIND,
            });
          },
        );
    }

    return { convert, send };
  }, [workspaceId, requests, report, success, clear]);

  return { state, start: run.convert, send: run.send };
}
