import { Check, Copy, TriangleAlert } from "lucide-react";
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ShellErrorReporter } from "../shell/useShellError";

// The one copy control: a 24px tile, or the tile's icon with words. It says
// what happened in place, says it again to a screen reader, and hands a
// failure to the shell's error hook, so the toast and the Notices row still
// carry it after the surface that failed has closed.
//
// The caller owns the text. `getText` runs at the click, so the copy is of
// what the surface holds then; null means there is nothing to copy. Text that
// arrives after a newer click, or after the button is gone, is not written:
// it may be stale, and the surface may have retired it, as it retires a share
// link it has reset.
export const COPY_FEEDBACK_MS = 2000;
export const COPY_FAILURE = "dohc could not copy to the clipboard.";

type Feedback = "copied" | "failed";
const WORDS: Record<Feedback, string> = { copied: "Copied", failed: "Couldn't copy" };
const TONE: Record<Feedback, string> = { copied: "text-success", failed: "text-danger" };
const ICON = { copied: Check, failed: TriangleAlert } as const;

const tileClass =
  "grid size-6 shrink-0 place-items-center rounded-md transition-colors duration-75 hover:bg-hover disabled:pointer-events-none disabled:opacity-40";
const wordsClass =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] text-muted transition-colors duration-75 hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40";

export function CopyButton(props: {
  getText: () => string | null | Promise<string | null>;
  // A fixed accessible name, such as "Copy details". Without one, the name is
  // what the button says: Copy, Copied, Couldn't copy.
  label?: string | undefined;
  // The tile alone; its words are the tooltip.
  iconOnly?: boolean;
  testId?: string | undefined;
  disabled?: boolean;
}) {
  const report = useContext(ShellErrorReporter);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const latest = useRef({ getText: props.getText, report });
  latest.current = { getText: props.getText, report };
  const attempts = useRef(0);
  const live = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // In the same commit that puts the button on screen, so a click that comes
  // before React's passive effects run still counts.
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      if (announceTimer.current !== null) clearTimeout(announceTimer.current);
    };
  }, []);

  function show(next: Feedback) {
    setFeedback(next);
    // Cleared now and set in a later task, so a second answer inside the
    // feedback window is announced again.
    setAnnouncement("");
    if (announceTimer.current !== null) clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => setAnnouncement(WORDS[next]), 0);
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setFeedback(null);
      setAnnouncement("");
    }, COPY_FEEDBACK_MS);
  }

  // Try again runs this button's copy, reading its text afresh. Once the
  // button is gone there is nothing safe to copy, so the failure is filed
  // again without a Try again.
  function fail(error: unknown) {
    const reporter = latest.current.report;
    if (!live.current) {
      reporter?.(COPY_FAILURE, error, null);
      return;
    }
    show("failed");
    reporter?.(COPY_FAILURE, error, () => {
      if (live.current) void copy();
      else reporter(COPY_FAILURE, error, null);
    });
  }

  async function copy() {
    const attempt = ++attempts.current;
    const current = () => live.current && attempt === attempts.current;
    let text: string | null;
    try {
      text = await latest.current.getText();
    } catch (error) {
      if (current()) fail(error);
      return;
    }
    if (text === null || !current()) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      // A newer click answers for this one. A write the button outlived
      // still fails, and the shell is the one left to say so.
      if (attempt === attempts.current) fail(error);
      return;
    }
    if (current()) show("copied");
  }

  const words = feedback ? WORDS[feedback] : (props.label ?? "Copy");
  const Icon = feedback ? ICON[feedback] : Copy;
  return (
    <>
      <button
        type="button"
        data-testid={props.testId}
        disabled={props.disabled}
        aria-label={props.iconOnly ? (props.label ?? words) : props.label}
        title={props.iconOnly ? words : undefined}
        onClick={() => void copy()}
        className={
          props.iconOnly
            ? `${tileClass} ${feedback ? `bg-hover ${TONE[feedback]}` : "text-subtle hover:text-ink"}`
            : wordsClass
        }
      >
        <Icon size={13} aria-hidden className={!props.iconOnly && feedback ? TONE[feedback] : undefined} />
        {props.iconOnly ? null : words}
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
  copyTestId?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-panel py-0.5 pl-2.5 pr-1 font-mono text-[12px] text-muted">
      <div className="min-w-0 flex-1 select-text truncate py-1 leading-4">{props.children}</div>
      <CopyButton iconOnly getText={props.getText} label={props.label} testId={props.copyTestId} />
    </div>
  );
}
