import { useEffect, useMemo, useRef, useState } from "react";
import {
  leftNoteCount,
  leftNoteGroups,
  withNoteRetried,
  type ConvertNotesResult,
} from "@dohc/workspace-contracts/note-format";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { useRequestSequence } from "../useRequestSequence";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";
import type { ErrorDetailField } from "./copyDetails";
import type { useShellError } from "./useShellError";

type Shell = ReturnType<typeof useShellError>;

export type NoteConversionState =
  | { status: "idle" }
  | { status: "running"; done: number; total: number }
  | { status: "done"; converted: number; left: number }
  | { status: "unsent"; converted: number; left: number }
  | { status: "failed" };

export interface NoteConversionOffer {
  value: boolean | undefined;
  failed: boolean;
  retry(): void;
}

export interface NoteConversion {
  state: NoteConversionState;
  start(): void;
  offer: NoteConversionOffer;
}

const KIND = "note-conversion";
const OFFER_KIND = "note-conversion-offered";
const OFFER_UNREAD = "dohc could not check whether this workspace's notes can be converted.";
const IDLE: NoteConversionState = { status: "idle" };
const SHOWN_PER_GROUP = 3;

const countWords = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count.toLocaleString("en-US")} ${many}`;

export function convertedWords(converted: number): string {
  return converted === 0
    ? "No notes to convert"
    : `Converted ${countWords(converted, "note", "notes")}`;
}

export function finishedWords(converted: number, left: number): string {
  if (left === 0) return convertedWords(converted);
  const notConverted = `${countWords(left, "note was", "notes were")} not converted`;
  return converted === 0 ? notConverted : `${convertedWords(converted)}. ${notConverted}.`;
}

const pathWords = (path: string) => path || "(no path)";

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
    title: finishedWords(0, left),
    message: `${converted}${unsent} The rest stay as they were and can still be edited. Run Convert notes again for notes that were open or busy.`,
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

function useNoteConversionOffer(
  workspaceId: string,
  ready: boolean,
  report: Shell["reportShellFailure"],
  clear: Shell["clearKind"],
): NoteConversionOffer {
  const [account, setAccount] = useState({ generation: 0, ready: true });
  useEffect(
    () =>
      bridge().onCloudSessionChanged(({ phase }) =>
        setAccount((current) => ({ generation: current.generation + 1, ready: phase === "ready" })),
      ),
    [],
  );
  const { value, pending, error, retry } = useWorkspaceQuery(useWorkspaceSession(), {
    key: `${workspaceId}:${account.generation}:${ready}`,
    manual: !ready || !account.ready,
    load: async () => (await bridge().readNoteConversionOffered({ workspaceId })).offered,
  });
  useEffect(() => {
    if (error === null) return;
    report({
      message: ipcErrorMessage(error, OFFER_UNREAD),
      cause: error,
      retry: () => void retry(),
      kind: OFFER_KIND,
    });
  }, [error, report, retry]);
  useEffect(() => {
    if (!pending && error === null && value !== undefined) clear(OFFER_KIND);
  }, [pending, error, value, clear]);
  return { value, failed: error !== null, retry: () => void retry() };
}

export function useNoteConversion(input: {
  workspaceId: string;
  ready: boolean;
  report: Shell["reportShellFailure"];
  success: Shell["showSuccessNotice"];
  clear: Shell["clearKind"];
}): NoteConversion {
  const { workspaceId, ready, report, success, clear } = input;
  const offer = useNoteConversionOffer(workspaceId, ready, report, clear);
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

  const unsent = useRef<{ workspaceId: string; converted: number } | null>(null);
  const inFlight = useRef(new Set<string>());
  const last = useRef<{ workspaceId: string; result: ConvertNotesResult } | null>(null);
  const { convert, settle } = useMemo(() => {
    const show = (next: NoteConversionState) => setShown({ workspaceId, state: next });

    function settle(result: ConvertNotesResult) {
      last.current = { workspaceId, result };
      const left = leftNoteCount(result);
      unsent.current = result.sent ? null : { workspaceId, converted: result.converted };
      show({ status: result.sent ? "done" : "unsent", converted: result.converted, left });
      if (result.stopped) {
        report({
          message: `${result.stopped} dohc converted ${countWords(result.converted, "note", "notes")} before it stopped. Try again to finish.`,
          kind: KIND,
          retry: convert,
        });
        return;
      }
      const notice = noteConversionNotice(result);
      if (!notice) {
        clear(KIND);
        success(convertedWords(result.converted), undefined, KIND);
        return;
      }
      report({
        ...notice,
        kind: KIND,
        retry: result.sent ? null : convert,
        ...(result.sent &&
        (result.failed.length > 0 ||
          result.skipped.some(({ reason }) => reason !== "local-new-notes-format-one"))
          ? { action: { label: "Convert remaining", run: convert, ends: true } }
          : {}),
      });
    }

    function convert() {
      if (inFlight.current.has(workspaceId)) return;
      inFlight.current.add(workspaceId);
      const token = requests.next();
      const carried = unsent.current?.workspaceId === workspaceId ? unsent.current.converted : 0;
      show({ status: "running", done: 0, total: 0 });
      bridge()
        .convertNotes({ workspaceId })
        .then(
          (result) => {
            if (requests.isCurrent(token))
              settle({ ...result, converted: result.converted + carried });
          },
          (error: unknown) => {
            if (!requests.isCurrent(token)) return;
            show(
              carried > 0
                ? { status: "unsent", converted: carried, left: 0 }
                : { status: "failed" },
            );
            report({
              message: ipcErrorMessage(error, "dohc could not convert notes."),
              cause: error,
              retry: convert,
              kind: KIND,
            });
          },
        )
        .finally(() => inFlight.current.delete(workspaceId));
    }

    return { convert, settle };
  }, [workspaceId, requests, report, success, clear]);

  useEffect(
    () =>
      bridge().onNoteConversionRetried(({ workspaceId: from, path, result }) => {
        const shown = last.current;
        if (from !== workspaceId || shown?.workspaceId !== from || inFlight.current.has(from))
          return;
        settle(withNoteRetried(shown.result, path, result));
      }),
    [workspaceId, settle],
  );

  return { state, start: convert, offer };
}
