import { Check, Copy, TriangleAlert } from "lucide-react";
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ShellErrorReporter, type ReportShellError } from "../shell/useShellError";

// The one copy control. It says what happened in place, says it again to a
// screen reader, and hands a failure to the shell's error hook, so the toast
// and the Notices row still carry it after the surface that failed has closed.
// `createCopy` is its behavior; `CopyButton` draws it in React, and the
// editor's code-block toolbar draws it in the DOM ProseMirror owns.
//
// The caller owns the text. `getText` runs at the click, so the copy is of
// what the surface holds then; null means there is nothing to copy. Text that
// arrives after a newer click, or after the control is gone, is not written:
// it may be stale, and the surface may have retired it, as it retires a share
// link it has reset.
export const COPY_FEEDBACK_MS = 2000;
export const COPY_FAILURE = "dohc could not copy to the clipboard.";
export type CopyFeedback = "copied" | "failed";
export const COPY_WORDS: Record<CopyFeedback, string> = { copied: "Copied", failed: "Couldn't copy" };

// The tile, shared with the code-block toolbar.
export const COPY_TILE_CLASS =
  "grid size-6 shrink-0 place-items-center rounded-md transition-colors duration-75 hover:bg-hover disabled:pointer-events-none disabled:opacity-40";
export const COPY_TILE_STATE_CLASS: Record<CopyFeedback | "rest", string> = {
  rest: "text-subtle hover:text-ink",
  copied: "bg-hover text-success",
  failed: "bg-hover text-danger",
};
const TONE: Record<CopyFeedback, string> = { copied: "text-success", failed: "text-danger" };
const ICON = { copied: Check, failed: TriangleAlert } as const;
const wordsClass =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] text-muted transition-colors duration-75 hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40";

// A missing clipboard is a failure like any other. The write starts in the
// task that called it, so a click with its text at hand writes at once.
function write(text: string): Promise<void> {
  try {
    return navigator.clipboard.writeText(text);
  } catch (error) {
    return Promise.reject(error);
  }
}

// One control's copy. `show` hears each answer, then null once the answer
// has shown for COPY_FEEDBACK_MS. `dispose` when the control goes away.
export function createCopy(options: {
  getText: () => string | null | Promise<string | null>;
  report: () => ReportShellError | null;
  show: (feedback: CopyFeedback | null) => void;
}): { copy: () => Promise<void>; dispose: () => void } {
  let attempts = 0;
  let live = true;
  let reset: ReturnType<typeof setTimeout> | null = null;

  function answer(feedback: CopyFeedback) {
    options.show(feedback);
    if (reset !== null) clearTimeout(reset);
    reset = setTimeout(() => {
      reset = null;
      options.show(null);
    }, COPY_FEEDBACK_MS);
  }

  // Try again copies afresh while the control is on screen, so a link the
  // surface has reset since is not the one copied. Once the control is gone,
  // as when the failure's toast replaced the toast it sat in, Try again
  // copies the text that failed.
  function retry(error: unknown, text: string | null, report: ReportShellError): () => void {
    return () => {
      if (live) {
        void copy();
        return;
      }
      if (text === null) {
        report(COPY_FAILURE, error, null);
        return;
      }
      write(text).catch((next: unknown) => report(COPY_FAILURE, next, retry(next, text, report)));
    };
  }

  function fail(error: unknown, text: string | null) {
    if (live) answer("failed");
    const report = options.report();
    report?.(COPY_FAILURE, error, retry(error, text, report));
  }

  async function copy() {
    const attempt = ++attempts;
    const current = () => live && attempt === attempts;
    let text: string | null;
    try {
      const read = options.getText();
      text = read instanceof Promise ? await read : read;
    } catch (error) {
      if (current()) fail(error, null);
      return;
    }
    if (text === null || !current()) return;
    try {
      await write(text);
    } catch (error) {
      // A newer click answers for this one. A write the control outlived
      // still fails, and the shell is the one left to say so.
      if (attempt === attempts) fail(error, text);
      return;
    }
    if (current()) answer("copied");
  }

  return {
    copy,
    dispose() {
      live = false;
      if (reset !== null) clearTimeout(reset);
    },
  };
}

export function CopyButton(props: {
  getText: () => string | null | Promise<string | null>;
  // What the button says at rest, and its accessible name. Default "Copy".
  label?: string | undefined;
  // What it says once copied. Default "Copied".
  copiedLabel?: string | undefined;
  // Keeps `label` as the name through every answer, for a control found by
  // one name, such as "Copy details". Otherwise the name is what it says.
  pinName?: boolean;
  // The tile alone; what it says is the tooltip.
  iconOnly?: boolean;
  testId?: string | undefined;
  disabled?: boolean;
}) {
  const report = useContext(ShellErrorReporter);
  const label = props.label ?? "Copy";
  const words: Record<CopyFeedback, string> = { ...COPY_WORDS, ...(props.copiedLabel ? { copied: props.copiedLabel } : {}) };
  const [feedback, setFeedback] = useState<CopyFeedback | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const latest = useRef({ getText: props.getText, report, words });
  latest.current = { getText: props.getText, report, words };
  const action = useRef<ReturnType<typeof createCopy> | null>(null);
  // In the commit that puts the button on screen, so a click that comes
  // before React's passive effects run still counts.
  useLayoutEffect(() => {
    let announce: ReturnType<typeof setTimeout> | null = null;
    const copy = createCopy({
      getText: () => latest.current.getText(),
      report: () => latest.current.report,
      show: (next) => {
        setFeedback(next);
        // Cleared now and set in a later task, so a second answer inside
        // the feedback window is announced again.
        setAnnouncement("");
        if (announce !== null) clearTimeout(announce);
        announce = next ? setTimeout(() => setAnnouncement(latest.current.words[next]), 0) : null;
      },
    });
    action.current = copy;
    return () => {
      copy.dispose();
      if (announce !== null) clearTimeout(announce);
    };
  }, []);

  const shown = feedback ? words[feedback] : label;
  const Icon = feedback ? ICON[feedback] : Copy;
  return (
    <>
      <button
        type="button"
        data-testid={props.testId}
        disabled={props.disabled}
        aria-label={props.pinName ? label : props.iconOnly ? shown : undefined}
        title={props.iconOnly ? shown : undefined}
        onClick={() => void action.current?.copy()}
        className={props.iconOnly ? `${COPY_TILE_CLASS} ${COPY_TILE_STATE_CLASS[feedback ?? "rest"]}` : wordsClass}
      >
        <Icon size={13} aria-hidden className={!props.iconOnly && feedback ? TONE[feedback] : undefined} />
        {props.iconOnly ? null : shown}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}

// Text a person hands on, such as a link or a code, on one line with its copy
// at the end: copy sits beside the text it copies. The caller's element holds
// the text, its test names, and a title with the whole text when it can run
// past the field. A link the clipboard refused can still be selected by hand.
export function CopyField(props: {
  children: ReactNode;
  getText: () => string | null;
  label?: string | undefined;
  copiedLabel?: string | undefined;
  copyTestId?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-panel py-0.5 pl-2.5 pr-1 font-mono text-[12px] text-muted">
      <div className="min-w-0 flex-1 select-text truncate py-1 leading-4">{props.children}</div>
      <CopyButton
        iconOnly
        getText={props.getText}
        label={props.label}
        copiedLabel={props.copiedLabel}
        testId={props.copyTestId}
      />
    </div>
  );
}
