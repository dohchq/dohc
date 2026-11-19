import { Check, Copy, TriangleAlert, type LucideIcon } from "lucide-react";
import { useContext, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { withErrorWords } from "../../ipc/errorWords";
import { ShellErrorReporter, type ReportShellFailure } from "../shell/useShellError";
import { PrimaryButton } from "./controls";

export const COPY_FEEDBACK_MS = 2000;
export const COPY_FAILURE = "dohc could not copy to the clipboard.";
export type CopyFeedback = "copied" | "failed";
export const COPY_WORDS: Record<CopyFeedback, string> = {
  copied: "Copied",
  failed: "Could not copy",
};

// The tile, shared with the code-block toolbar. A copy is feedback on an
// action, not a sign the work is safe, so Copied keeps the control's own
// tone; only a failure takes danger.
export const COPY_TILE_CLASS =
  "grid size-6 shrink-0 place-items-center rounded-md transition-colors duration-75 hover:bg-hover disabled:pointer-events-none disabled:opacity-40";
export const COPY_TILE_STATE_CLASS: Record<CopyFeedback | "rest", string> = {
  rest: "text-subtle hover:text-ink",
  copied: "bg-hover text-ink",
  failed: "bg-hover text-danger",
};
const ICON = { copied: Check, failed: TriangleAlert } as const;
const wordsClass =
  "inline-flex shrink-0 items-center border border-line text-muted transition-colors duration-75 hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40";
// A row's copy, one among a page header's 28px buttons, or one beside a
// default SecondaryButton.
const WORDS_SIZE = {
  row: "h-6 gap-1.5 rounded-md px-2 text-[12px]",
  header: "h-7 gap-1 rounded-md px-2 text-[11px]",
  button: "h-8 gap-1.5 rounded-lg px-3 text-[13px]",
} as const;

// A missing clipboard is a failure like any other. The write starts in the
// task that called it, so a click with its text at hand writes at once.
function write(text: string): Promise<void> {
  try {
    return navigator.clipboard.writeText(text);
  } catch (error) {
    return Promise.reject(error);
  }
}

// What a secret copy is called in its failure, and where a person copies it
// again once Try again cannot: "the share link", "Reset the link in Share to
// get a new one."
export type CopySecret = { what: string; again: string };

// A failure's words: what happened, why if the error says, then, for a secret
// whose control is gone, where to copy it again. `failure` names what could
// not be copied when the text comes from dohc rather than the screen.
function failureWords(
  secret: CopySecret | undefined,
  error: unknown,
  gone: boolean,
  failure = COPY_FAILURE,
): string {
  const said = withErrorWords(secret ? `dohc could not copy ${secret.what}.` : failure, error);
  return secret && gone ? `${said} ${secret.again}` : said;
}

// The Try again a notice keeps. It is built here, outside createCopy, so it
// holds only what it names: the control's copy, which `dispose` clears; the
// words; and, for text that is not secret, the text that failed. Nothing it
// holds reaches the text source once the control is gone.
//
// While the control is on screen, Try again copies afresh: a control shows
// one value for its life (CopyField is keyed by its text), so a link its
// surface has reset since is never the one copied. Once the control is gone,
// as when the failure's toast replaced the toast it sat in, Try again copies
// the text that failed. A secret keeps no such text: its notice says where to
// copy it again instead, with no Try again.
function retryAfter(
  control: { copy: (() => Promise<void>) | null },
  report: ReportShellFailure,
  secret: CopySecret | undefined,
  error: unknown,
  text: string | null,
  failure: string | undefined,
): () => void {
  return () => {
    if (control.copy) {
      void control.copy();
      return;
    }
    if (text === null) {
      report({ message: failureWords(secret, error, true, failure), cause: error, retry: null });
      return;
    }
    write(text).catch((next: unknown) =>
      report({
        message: failureWords(secret, next, true, failure),
        cause: next,
        retry: retryAfter(control, report, secret, next, text, failure),
      }),
    );
  };
}

// One control's copy. `show` hears each answer, then null once the answer
// has shown for COPY_FEEDBACK_MS. `dispose` when the control goes away.
// `secret` marks text such as a share link or a code: no copy of it is kept
// to retry with, and the control lets go of its text source when it goes.
export function createCopy(options: {
  getText: () => string | null | Promise<string | null>;
  report: () => ReportShellFailure | null;
  show: (feedback: CopyFeedback | null) => void;
  secret?: (() => CopySecret | undefined) | undefined;
  failure?: string | undefined;
}): { copy: () => Promise<void>; dispose: () => void } {
  const { report: reporter, show, secret: secretOf, failure } = options;
  let read: typeof options.getText | null = options.getText;
  const control: { copy: (() => Promise<void>) | null } = { copy: null };
  let attempts = 0;
  let live = true;
  let reset: ReturnType<typeof setTimeout> | null = null;

  function answer(feedback: CopyFeedback) {
    show(feedback);
    if (reset !== null) clearTimeout(reset);
    reset = setTimeout(() => {
      reset = null;
      show(null);
    }, COPY_FEEDBACK_MS);
  }

  function fail(error: unknown, text: string | null) {
    if (live) answer("failed");
    const report = reporter();
    if (!report) return;
    const secret = secretOf?.();
    if (secret && !live) {
      report({ message: failureWords(secret, error, true, failure), cause: error, retry: null });
      return;
    }
    report({
      message: failureWords(secret, error, false, failure),
      cause: error,
      retry: retryAfter(control, report, secret, error, secret ? null : text, failure),
    });
  }

  async function copy() {
    const source = read;
    if (!source) return;
    const attempt = ++attempts;
    const current = () => live && attempt === attempts;
    let text: string | null;
    try {
      const pending = source();
      text = pending instanceof Promise ? await pending : pending;
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
  control.copy = copy;

  return {
    copy,
    dispose() {
      live = false;
      read = null;
      control.copy = null;
      if (reset !== null) clearTimeout(reset);
    },
  };
}

/**
 * One control's copy for an owner that shows the answer itself, such as a
 * menu row that answers in its own row. `feedback` holds the answer for
 * COPY_FEEDBACK_MS, and `announcement` is the same answer for a status
 * region the owner keeps mounted.
 */
export function useCopy(options: {
  getText: () => string | null | Promise<string | null>;
  words?: Partial<Record<CopyFeedback, string>> | undefined;
  sensitive?: CopySecret | undefined;
  failure?: string | undefined;
}): {
  copy: () => void;
  feedback: CopyFeedback | null;
  announcement: string;
  words: Record<CopyFeedback, string>;
} {
  const report = useContext(ShellErrorReporter);
  const words: Record<CopyFeedback, string> = { ...COPY_WORDS, ...options.words };
  const [feedback, setFeedback] = useState<CopyFeedback | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const getText = useRef<typeof options.getText | null>(options.getText);
  getText.current = options.getText;
  const reportTo = useRef(report);
  reportTo.current = report;
  const spoken = useRef(words);
  spoken.current = words;
  const secret = useRef(options.sensitive);
  secret.current = options.sensitive;
  const action = useRef<ReturnType<typeof createCopy> | null>(null);
  const mountedGetText = options.getText;
  const failure = options.failure;
  // In the commit that puts the control on screen, so a click that comes
  // before React's passive effects run still counts.
  useLayoutEffect(() => {
    // Set again here: StrictMode runs the cleanup below and this effect
    // again without a render between them.
    getText.current = mountedGetText;
    let announce: ReturnType<typeof setTimeout> | null = null;
    const copy = createCopy({
      getText: () => getText.current?.() ?? null,
      report: () => reportTo.current,
      secret: () => secret.current,
      failure,
      show: (next) => {
        setFeedback(next);
        // Cleared now and set in a later task, so a second answer inside
        // the feedback window is announced again.
        setAnnouncement("");
        if (announce !== null) clearTimeout(announce);
        announce = next ? setTimeout(() => setAnnouncement(spoken.current[next]), 0) : null;
      },
    });
    action.current = copy;
    return () => {
      copy.dispose();
      // The text source goes with the control.
      getText.current = null;
      if (announce !== null) clearTimeout(announce);
    };
  }, []);
  return { copy: () => void action.current?.copy(), feedback, announcement, words };
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
  // The mark at rest, where a row offers more than one copy. Default Copy.
  icon?: LucideIcon | undefined;
  // The worded button's size. Default "row".
  size?: keyof typeof WORDS_SIZE;
  // The primary of a surface whose action is the copy, such as Copy agent link.
  primary?: boolean;
  // Marks the text secret, such as a share link, a share code or a sync
  // code: what it is called, and where to copy it again once Try again
  // cannot.
  sensitive?: CopySecret | undefined;
  // What a failure says first when dohc makes the text, such as a link.
  // Default "dohc could not copy to the clipboard."
  failure?: string | undefined;
  testId?: string | undefined;
  disabled?: boolean;
  ref?: Ref<HTMLButtonElement> | undefined;
}) {
  const label = props.label ?? "Copy";
  const { copy, feedback, announcement, words } = useCopy({
    getText: props.getText,
    words: props.copiedLabel ? { copied: props.copiedLabel } : undefined,
    sensitive: props.sensitive,
    failure: props.failure,
  });

  const shown = feedback ? words[feedback] : label;
  const Icon = feedback ? ICON[feedback] : (props.icon ?? Copy);
  if (props.primary) {
    return (
      <>
        <PrimaryButton
          ref={props.ref}
          data-testid={props.testId}
          disabled={props.disabled}
          aria-label={props.pinName ? label : undefined}
          onClick={copy}
          className="inline-flex shrink-0 items-center gap-1.5"
        >
          <Icon size={13} aria-hidden />
          {shown}
        </PrimaryButton>
        <span role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>
      </>
    );
  }
  return (
    <>
      <button
        ref={props.ref}
        type="button"
        data-testid={props.testId}
        disabled={props.disabled}
        aria-label={props.pinName ? label : props.iconOnly ? shown : undefined}
        title={props.iconOnly ? shown : undefined}
        onClick={copy}
        className={
          props.iconOnly
            ? `${COPY_TILE_CLASS} ${COPY_TILE_STATE_CLASS[feedback ?? "rest"]}`
            : `${wordsClass} ${WORDS_SIZE[props.size ?? "row"]}`
        }
      >
        <Icon
          size={props.size === "header" ? 12 : 13}
          aria-hidden
          className={!props.iconOnly && feedback === "failed" ? "text-danger" : undefined}
        />
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
// The copy is keyed by the text, so a new link or code is a new control: its
// answer starts fresh, and Try again never copies the text it replaced.
export function CopyField(props: {
  children: ReactNode;
  getText: () => string | null;
  label?: string | undefined;
  copiedLabel?: string | undefined;
  sensitive?: CopySecret | undefined;
  copyTestId?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-panel py-0.5 pl-2.5 pr-1 font-mono text-[12px] text-muted">
      <div className="min-w-0 flex-1 select-text truncate py-1 leading-4">{props.children}</div>
      <CopyButton
        key={props.getText() ?? ""}
        iconOnly
        getText={props.getText}
        label={props.label}
        copiedLabel={props.copiedLabel}
        sensitive={props.sensitive}
        testId={props.copyTestId}
      />
    </div>
  );
}
