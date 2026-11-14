import { ExternalLink, TriangleAlert } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  AgentThreadAnswers,
  AgentThreadQuestion,
  AgentThreadQuestionBox,
} from "../../ipc/bridgeContract";
import { withErrorWords } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import { FieldError, PrimaryButton, SecondaryButton } from "../ui/controls";
import { SkeletonRows } from "../ui/SkeletonRows";
import { useRequestSequence } from "../useRequestSequence";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";

const FIELD =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle aria-invalid:border-danger aria-invalid:focus:border-danger! aria-invalid:focus:shadow-[inset_0_-1px_0_var(--dohc-danger)]!";
const OPTION_ROW = "flex items-start gap-2 rounded-md px-2 py-1 text-[13px] text-ink";
// The contract's limits: an answer that is the person's own text, and their
// own text as one entry among a multi-select question's options.
const OWN_TEXT_MAX = 20_000;
const OWN_ENTRY_MAX = 2_000;

// What the person marked and typed for one question. `picked` holds the
// positions of the options they marked, and `own` says their own answer is
// marked too.
type Draft = { picked: readonly number[]; own: boolean; text: string };
const BLANK: Draft = { picked: [], own: false, text: "" };

// The marked options and the person's own text are the answer. A question
// with nothing marked has none.
function answerOf(question: AgentThreadQuestion, draft: Draft): string | string[] | undefined {
  const text = draft.text.trim();
  if (question.options.length === 0) return text || undefined;
  const own = question.allowCustomAnswer && draft.own && text ? [text] : [];
  if (!question.multiSelect) return own[0] ?? question.options[draft.picked[0] ?? -1]?.value;
  const values = [
    ...question.options
      .filter((_, index) => draft.picked.includes(index))
      .map(({ value }) => value),
    ...own,
  ];
  return values.length > 0 ? values : undefined;
}

function missingWords(question: AgentThreadQuestion, draft: Draft): string {
  if (question.options.length === 0) return "Enter an answer.";
  if (!question.allowCustomAnswer) return "Choose an option.";
  return draft.own ? "Enter your own answer." : "Choose an option, or enter your own answer.";
}

type View = "loading" | "form" | "unread" | "already-answered" | "closed";

const ENDED: Record<"already-answered" | "closed", string> = {
  // dohc does not know who answered, so this names nobody.
  "already-answered": "This question was already answered.",
  closed: "This question no longer waits for an answer.",
};

// Answers the question an agent's thread waits on, without leaving the chat.
// The question and what the person types live in this dialog alone: its read
// is its own, and closing it drops both.
export function AgentThreadAnswerDialog(props: {
  workspaceId: string;
  agentId: string;
  agentName: string;
  tool: string;
  requestId: string;
  // False once no line carries this question, as when someone answered it in the tool.
  asked: boolean;
  onOpenInTool: () => void;
  onClose: () => void;
}) {
  const { workspaceId, agentId, requestId, asked } = props;
  const read = useWorkspaceQuery<AgentThreadQuestionBox>(useWorkspaceSession(), {
    key: `agent-thread-question:${agentId}:${requestId}`,
    load: () => bridge().readAgentThreadQuestion({ workspaceId, agentId, requestId }),
  });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // The required questions the last send found unanswered.
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  // What the send learned when the question took no answer.
  const [refused, setRefused] = useState<"already-answered" | "closed" | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // An answer that comes after the dialog closed changes nothing.
  const sends = useRequestSequence();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const submit = useRef<HTMLButtonElement>(null);

  const box = read.value;
  const ended = refused ?? (box && box.status !== "open" ? box.status : null);
  const view: View =
    ended ?? (read.error !== null ? "unread" : box === undefined ? "loading" : "form");

  // The line dropped the question: read once what became of it. A send that
  // is on its way says so itself.
  const reread = useRef(false);
  const { retry } = read;
  useEffect(() => {
    if (asked) {
      reread.current = false;
      return;
    }
    if (busy || ended !== null || reread.current) return;
    reread.current = true;
    void retry();
  }, [asked, busy, ended, retry]);

  // Each view starts on its first control: the form's first field, or the one
  // button that acts. While the question loads, the dialog itself holds focus.
  useLayoutEffect(() => {
    const first = panel.current?.querySelector<HTMLElement>(
      view === "form" ? "input, textarea" : "[data-first-focus]",
    );
    (first ?? panel.current)?.focus();
  }, [view]);
  // A failed send leaves focus on the button that sends again.
  useLayoutEffect(() => {
    if (failure) submit.current?.focus();
  }, [failure]);

  async function send() {
    if (busyRef.current || box?.status !== "open") return;
    const answers: AgentThreadAnswers = {};
    const unanswered: number[] = [];
    box.questions.forEach((question, index) => {
      const answer = answerOf(question, drafts[question.id] ?? BLANK);
      if (answer !== undefined) answers[question.id] = answer;
      else if (question.required) unanswered.push(index);
    });
    if (unanswered.length > 0) {
      setMissing(new Set(unanswered.map((index) => box.questions[index]!.id)));
      panel.current
        ?.querySelector(`[data-question-index="${unanswered[0]}"]`)
        ?.querySelector<HTMLElement>("input, textarea")
        ?.focus();
      return;
    }
    const token = sends.next();
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const { status } = await bridge().answerAgentThreadQuestion({
        workspaceId,
        agentId,
        requestId: box.requestId,
        answers,
      });
      if (!sends.isCurrent(token)) return;
      // The line changes when main next looks at the thread.
      if (status === "answered") return props.onClose();
      setRefused(status);
    } catch (cause) {
      if (!sends.isCurrent(token)) return;
      setFailure(withErrorWords("dohc could not send your answer.", cause));
    }
    busyRef.current = false;
    setBusy(false);
  }

  return (
    <Overlay
      panelRef={panel}
      onClose={() => {
        if (!busyRef.current) props.onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={ended ? `${id}-ended` : undefined}
        data-testid="agent-thread-answer-dialog"
        data-view={view}
        // Escape belongs to the dialog, never to the chat behind it.
        data-chat-escape-local="true"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        // A held Enter may be the key that opened the dialog, repeating. It sends nothing.
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.repeat) event.preventDefault();
        }}
        className="dohc-elevated flex w-[480px] max-w-[calc(100vw-2rem)] flex-col gap-6 rounded-xl border border-line bg-panel p-6"
      >
        <h2 id={`${id}-title`} className="m-0 text-base font-semibold text-ink wrap-anywhere">
          Answer {props.agentName}
        </h2>
        {ended ? (
          <>
            <p
              id={`${id}-ended`}
              role="status"
              data-testid="agent-thread-answer-ended"
              className="m-0 text-[13px] text-muted"
            >
              {ENDED[ended]}
            </p>
            <div className="flex justify-end">
              <SecondaryButton
                data-first-focus
                data-testid="agent-thread-answer-close"
                onClick={props.onClose}
              >
                Close
              </SecondaryButton>
            </div>
          </>
        ) : view === "unread" ? (
          <>
            <div className="flex flex-col items-start gap-3">
              <p
                role="alert"
                data-testid="agent-thread-answer-unread"
                className="m-0 flex items-start gap-2 text-[13px] text-ink"
              >
                <span aria-hidden className="flex h-lh shrink-0 items-center text-danger">
                  <TriangleAlert size={14} />
                </span>
                {withErrorWords("dohc could not read the question.", read.error)}
              </p>
              <SecondaryButton
                size="row"
                data-testid="agent-thread-answer-open"
                onClick={props.onOpenInTool}
              >
                <ExternalLink size={12} aria-hidden />
                {`Open in ${props.tool}`}
              </SecondaryButton>
            </div>
            <div className="flex justify-end gap-2">
              <SecondaryButton data-testid="agent-thread-answer-cancel" onClick={props.onClose}>
                Cancel
              </SecondaryButton>
              <PrimaryButton
                data-first-focus
                data-testid="agent-thread-answer-retry"
                onClick={() => void retry()}
              >
                Try again
              </PrimaryButton>
            </div>
          </>
        ) : (
          <>
            {box?.status === "open" ? (
              <fieldset disabled={busy} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
                {box.questions.map((question, index) => (
                  <Question
                    key={question.id}
                    id={`${id}-q${index}`}
                    index={index}
                    question={question}
                    draft={drafts[question.id] ?? BLANK}
                    missing={missing.has(question.id)}
                    onChange={(draft) => {
                      setDrafts((current) => ({ ...current, [question.id]: draft }));
                      setMissing((current) => {
                        if (!current.has(question.id)) return current;
                        const left = new Set(current);
                        left.delete(question.id);
                        return left;
                      });
                    }}
                  />
                ))}
              </fieldset>
            ) : (
              // About the height of one question, so the dialog moves little when it comes.
              <div className="min-h-32">
                <SkeletonRows
                  testId="agent-thread-answer-loading"
                  label="Loading the question"
                  rows={4}
                />
              </div>
            )}
            <div className="flex flex-col gap-3">
              {failure ? (
                <p
                  role="alert"
                  data-testid="agent-thread-answer-failure"
                  className="m-0 flex items-start gap-2 text-[12px] text-danger"
                >
                  <span aria-hidden className="flex h-lh shrink-0 items-center">
                    <TriangleAlert size={14} />
                  </span>
                  {failure}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <SecondaryButton
                  data-testid="agent-thread-answer-cancel"
                  disabled={busy}
                  onClick={props.onClose}
                >
                  Cancel
                </SecondaryButton>
                <PrimaryButton
                  ref={submit}
                  type="submit"
                  data-testid="agent-thread-answer-submit"
                  disabled={busy || view === "loading"}
                >
                  {busy ? "Answering…" : "Answer"}
                </PrimaryButton>
              </div>
            </div>
          </>
        )}
      </form>
    </Overlay>
  );
}

// One question: its words as plain text, its options as radios or checkboxes,
// and a field for the person's own answer. Among the marks, the marked ones
// are the answer, so a single choice shows which of an option and the
// person's own text it sends. Typing an own answer marks it.
function Question(props: {
  id: string;
  index: number;
  question: AgentThreadQuestion;
  draft: Draft;
  missing: boolean;
  onChange: (draft: Draft) => void;
}) {
  const { id, question, draft, missing } = props;
  const multi = question.multiSelect;
  const mark = multi ? "checkbox" : "radio";
  const errorId = missing ? `${id}-error` : undefined;
  const hasOptions = question.options.length > 0;
  const ownMissing = missing && (!hasOptions || draft.own);
  return (
    <div
      data-testid="agent-thread-answer-question"
      data-question-index={props.index}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-col gap-1">
        {question.header ? <span className="dohc-section-label">{question.header}</span> : null}
        <p className="m-0 text-[13px] text-ink">
          <span id={`${id}-label`} className="whitespace-pre-wrap wrap-anywhere">
            {question.question}
          </span>
          {question.required ? null : <span className="ml-2 text-[12px] text-muted">Optional</span>}
        </p>
      </div>
      {hasOptions ? (
        // The rows' fills hang outside the dialog's edge, so their marks start on it.
        <div
          role={multi ? "group" : "radiogroup"}
          aria-labelledby={`${id}-label`}
          aria-describedby={errorId}
          {...(multi ? {} : { "aria-required": question.required, "aria-invalid": missing })}
          className="-mx-2 flex flex-col"
        >
          {question.options.map((option, index) => (
            <label key={index} className={`${OPTION_ROW} cursor-pointer hover:bg-hover`}>
              <span className="flex h-lh shrink-0 items-center">
                <input
                  type={mark}
                  name={id}
                  checked={draft.picked.includes(index)}
                  aria-labelledby={`${id}-option-${index}`}
                  aria-describedby={option.description ? `${id}-about-${index}` : undefined}
                  onChange={() =>
                    props.onChange(
                      multi
                        ? {
                            ...draft,
                            picked: draft.picked.includes(index)
                              ? draft.picked.filter((picked) => picked !== index)
                              : [...draft.picked, index],
                          }
                        : { ...draft, picked: [index], own: false },
                    )
                  }
                />
              </span>
              <span className="flex min-w-0 flex-col">
                <span id={`${id}-option-${index}`} className="wrap-anywhere">
                  {option.label}
                </span>
                {option.description ? (
                  <span
                    id={`${id}-about-${index}`}
                    className="text-[12px] text-muted wrap-anywhere"
                  >
                    {option.description}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
          {question.allowCustomAnswer ? (
            <div className={OPTION_ROW}>
              <span className="flex h-lh shrink-0 items-center">
                <input
                  id={`${id}-own-mark`}
                  type={mark}
                  name={id}
                  checked={draft.own}
                  aria-labelledby={`${id}-own`}
                  onChange={() =>
                    props.onChange(
                      multi ? { ...draft, own: !draft.own } : { ...draft, picked: [], own: true },
                    )
                  }
                />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <label id={`${id}-own`} htmlFor={`${id}-own-mark`} className="cursor-pointer">
                  Your own answer
                </label>
                <input
                  data-testid="agent-thread-answer-own"
                  value={draft.text}
                  maxLength={multi ? OWN_ENTRY_MAX : OWN_TEXT_MAX}
                  autoComplete="off"
                  aria-labelledby={`${id}-own`}
                  aria-invalid={ownMissing || undefined}
                  aria-describedby={ownMissing ? errorId : undefined}
                  onChange={(event) =>
                    props.onChange({
                      picked: multi ? draft.picked : [],
                      own: true,
                      text: event.target.value,
                    })
                  }
                  className={FIELD}
                />
              </span>
            </div>
          ) : null}
        </div>
      ) : (
        <textarea
          data-testid="agent-thread-answer-own"
          value={draft.text}
          rows={3}
          maxLength={OWN_TEXT_MAX}
          aria-labelledby={`${id}-label`}
          aria-required={question.required}
          aria-invalid={ownMissing || undefined}
          aria-describedby={ownMissing ? errorId : undefined}
          onChange={(event) => props.onChange({ ...draft, text: event.target.value })}
          className={`${FIELD} resize-y`}
        />
      )}
      {errorId ? (
        <FieldError id={errorId} testId="agent-thread-answer-missing">
          {missingWords(question, draft)}
        </FieldError>
      ) : null}
    </div>
  );
}
