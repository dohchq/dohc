import { AtSign, FileText, Send } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  activeMentionQuery,
  applyMentionCompletion,
  matchMentionCandidates,
  type MentionCandidate,
} from "@dohc/workspace-contracts/chat-mentions";
import type { WorkspaceHeadingRecord } from "../../ipc/bridgeContract";
import { formatChatFileReferenceToken } from "./chatFileMentions";
import { ChatAvatar } from "./ChatAvatar";

export interface FileMentionCandidate {
  path: string;
  label: string;
}

// A chat composer with @-mention autocomplete. Same send affordances as the
// shared ChatComposer (Enter sends, Shift+Enter newlines, IME-safe), but while
// an @-mention menu is open Enter/Tab accept the highlighted candidate instead
// of sending — so directing a message at "@agent" is one obvious gesture.
//
// The mention roster is the agents in the workspace plus the user; picking one
// inserts "@handle " and the parent parses the sent body to decide who to
// notify / invoke.
export function MentionComposer(props: {
  testIdPrefix: string;
  composerId: string;
  value: string;
  sending: boolean;
  placeholder: string;
  sendLabel: string;
  candidates: readonly MentionCandidate[];
  fileCandidates?: readonly FileMentionCandidate[];
  loadFileHeadings?: (path: string) => Promise<readonly WorkspaceHeadingRecord[]>;
  onChange: (value: string) => void;
  onSend: () => void;
  onEscape?: () => void;
  // Decision resolution is the one composer mode where an empty submit is a
  // meaningful action: the caller records the literal fallback "Resolved ✓".
  allowEmptySend?: boolean;
  // Channel feeds place the start-post composer inside a card instead of on a
  // full-width divider. Defaults preserve DMs and Linked Chats exactly.
  surface?: "stream" | "post";
  // The post surface starts as one line and opens on focus or content. The
  // textarea is always mounted so its pinned test id and drivers keep working.
  authorName?: string;
  authorKind?: "human" | "agent";
}) {
  const [focused, setFocused] = useState(false);
  const expanded = props.surface !== "post" || focused || props.value.length > 0;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [fileStage, setFileStage] = useState<{
    path: string;
    label: string;
    headings: readonly WorkspaceHeadingRecord[];
    loading: boolean;
  } | null>(null);
  const fileRequest = useRef(0);
  const currentFileLoader = useRef(props.loadFileHeadings);
  currentFileLoader.current = props.loadFileHeadings;
  // When we complete a mention we must reposition the caret after React commits
  // the new value; this holds the pending caret target for the layout effect.
  const pendingCaret = useRef<number | null>(null);
  const highlightFileOnOpen = useRef(false);

  const active = useMemo(
    () => (menuOpen ? activeMentionQuery(props.value, caret) : null),
    [caret, menuOpen, props.value],
  );
  const matches = useMemo(
    () => (active ? matchMentionCandidates(active.query, props.candidates) : []),
    [active, props.candidates],
  );
  const fileMatches = useMemo(() => {
    if (!active) return [];
    const needle = active.query.trim().toLocaleLowerCase();
    return (props.fileCandidates ?? [])
      .filter((candidate) =>
        needle.length === 0
          ? true
          : candidate.label.toLocaleLowerCase().includes(needle) ||
            candidate.path.toLocaleLowerCase().includes(needle),
      )
      .slice(0, 6);
  }, [active, props.fileCandidates]);
  const menuLength = fileStage ? fileStage.headings.length + 1 : matches.length + fileMatches.length;
  const showMenu = fileStage !== null || (active !== null && menuLength > 0);

  const menuRef = useRef<HTMLUListElement | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0, maxHeight: 192 });
  useLayoutEffect(() => {
    if (!showMenu) return;
    const menu = menuRef.current;
    menu?.showPopover?.();
    const position = () => {
      const anchor = textareaRef.current?.getBoundingClientRect();
      if (!anchor || !menu) return;
      const below = window.innerHeight - anchor.bottom - 12;
      const above = anchor.top - 12;
      const height = Math.min(192, menu.scrollHeight + 2);
      const down = below >= height || below >= above;
      const maxHeight = Math.max(0, Math.min(192, down ? below : above));
      setMenuPosition({
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - Math.min(256, window.innerWidth - 16) - 8)),
        top: down ? anchor.bottom + 6 : Math.max(8, anchor.top - Math.min(height, maxHeight) - 6),
        maxHeight,
      });
    };
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); document.removeEventListener("scroll", position, true); };
  }, [showMenu, menuLength, fileStage, props.value]);

  useLayoutEffect(() => {
    if (!highlightFileOnOpen.current || pendingCaret.current !== null || !active) return;
    highlightFileOnOpen.current = false;
    setHighlight(fileMatches.length > 0 ? matches.length : 0);
  }, [active, fileMatches.length, matches.length]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const target = pendingCaret.current;
    pendingCaret.current = null;
    const node = textareaRef.current;
    if (node) {
      node.focus();
      node.setSelectionRange(target, target);
      setCaret(target);
    }
  }, [props.value]);

  useEffect(() => {
    // The loader is scoped to the active workspace. A response started with
    // the previous callback must never populate the next workspace's menu.
    fileRequest.current += 1;
    setFileStage(null);
    setHighlight(0);
  }, [props.loadFileHeadings]);

  const syncCaret = useCallback(() => {
    const node = textareaRef.current;
    if (node) setCaret(node.selectionStart ?? 0);
  }, []);

  const openMenuFromCaret = useCallback(() => {
    const node = textareaRef.current;
    const nextCaret = node?.selectionStart ?? 0;
    setCaret(nextCaret);
    setHighlight(0);
    setMenuOpen(true);
  }, []);

  const complete = useCallback(
    (candidate: MentionCandidate) => {
      const current = activeMentionQuery(props.value, caret);
      if (!current) return;
      const result = applyMentionCompletion(props.value, current, candidate);
      pendingCaret.current = result.caret;
      setMenuOpen(false);
      props.onChange(result.value);
    },
    [caret, props.onChange, props.value],
  );

  const completeFile = useCallback(
    (reference: { path: string; headingAnchor?: string }) => {
      const current = activeMentionQuery(props.value, caret);
      if (!current) return;
      const token = `${formatChatFileReferenceToken(reference)} `;
      const end = current.start + 1 + current.query.length;
      const next = `${props.value.slice(0, current.start)}${token}${props.value.slice(end)}`;
      pendingCaret.current = current.start + token.length;
      setFileStage(null);
      setMenuOpen(false);
      props.onChange(next);
    },
    [caret, props.onChange, props.value],
  );

  const chooseFile = useCallback(
    (candidate: FileMentionCandidate) => {
      const request = ++fileRequest.current;
      setHighlight(0);
      setFileStage({ path: candidate.path, label: candidate.label, headings: [], loading: true });
      const load = props.loadFileHeadings;
      if (!load) {
        setFileStage({ path: candidate.path, label: candidate.label, headings: [], loading: false });
        return;
      }
      void load(candidate.path)
        .then((headings) => {
          if (request !== fileRequest.current || load !== currentFileLoader.current) return;
          setFileStage({
            path: candidate.path,
            label: candidate.label,
            headings,
            loading: false,
          });
        })
        .catch(() => {
          if (request !== fileRequest.current || load !== currentFileLoader.current) return;
          setFileStage({ path: candidate.path, label: candidate.label, headings: [], loading: false });
        });
    },
    [props.loadFileHeadings],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // IME guard first: Enter during composition confirms the composed
      // characters — it must never accept a mention candidate or send, even
      // when the mention menu is open. Let the browser handle the keystroke.
      if (event.nativeEvent.isComposing) return;
      if (showMenu) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setHighlight((value) => (value + 1) % menuLength);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setHighlight((value) => (value - 1 + menuLength) % menuLength);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const index = Math.min(highlight, menuLength - 1);
          if (fileStage) {
            if (index === 0) completeFile({ path: fileStage.path });
            else {
              const heading = fileStage.headings[index - 1];
              if (heading) completeFile({ path: fileStage.path, headingAnchor: heading.anchor });
            }
          } else if (index < matches.length) {
            const candidate = matches[index];
            if (candidate) complete(candidate);
          } else {
            const candidate = fileMatches[index - matches.length];
            if (candidate) chooseFile(candidate);
          }
          return;
        }
        if (event.key === "Escape") {
          // Close the menu first; a second Escape reaches the parent (back-out).
          event.stopPropagation();
          fileRequest.current += 1;
          if (fileStage) {
            setFileStage(null);
            setHighlight(0);
            return;
          }
          setMenuOpen(false);
          return;
        }
      }
      // isComposing: Enter during IME composition confirms characters — never
      // sends. Matches the shared ChatComposer contract.
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        props.onSend();
        return;
      }
      if (event.key === "Escape" && props.onEscape) {
        event.stopPropagation();
        props.onEscape();
      }
    },
    [chooseFile, complete, completeFile, fileMatches, fileStage, highlight, matches, menuLength, props.onEscape, props.onSend, showMenu],
  );

  const listboxId = `${props.composerId}-mentions`;
  const boundedHighlight = Math.min(highlight, Math.max(0, menuLength - 1));
  const activeDescendant = !showMenu
    ? undefined
    : fileStage
      ? `${listboxId}-file-section-${boundedHighlight}`
      : boundedHighlight < matches.length
        ? `${listboxId}-${matches[boundedHighlight]?.id}`
        : `${listboxId}-file-${boundedHighlight - matches.length}`;

  const insertAtCaret = (text: string) => {
    const node = textareaRef.current;
    if (!node) return;
    const at = node.selectionStart ?? props.value.length;
    const before = props.value.slice(0, at);
    // A trigger glued to a word is not a mention; give it its own word.
    const separator = text.startsWith("@") && before.length > 0 && !/\s$/u.test(before) ? " " : "";
    const next = `${before}${separator}${text}${props.value.slice(at)}`;
    pendingCaret.current = at + separator.length + text.length;
    props.onChange(next);
    openMenuFromCaret();
  };

  const isPost = props.surface === "post";
  return (
    <form
      data-expanded={isPost ? expanded : undefined}
      className={
        isPost
          ? `relative flex shrink-0 flex-col rounded-xl border bg-panel transition-colors duration-75 ${
              expanded ? "border-line px-4 pb-2 pt-3" : "border-line px-3 py-2 hover:border-muted/50"
            }`
          : "relative flex shrink-0 items-end gap-1.5 border-t border-line p-2"
      }
      onSubmit={(event) => {
        event.preventDefault();
        props.onSend();
      }}
    >
      {isPost && props.authorName ? (
        <div className={`flex items-center gap-2.5 ${expanded ? "mb-2" : ""}`}>
          <ChatAvatar name={props.authorName} kind={props.authorKind ?? "human"} />
          {expanded ? (
            <span className="text-[14px] font-semibold text-ink">{props.authorName}</span>
          ) : (
            // The collapsed prompt stays on one line; clicking focuses the textarea.
            <button
              type="button"
              data-testid={`${props.testIdPrefix}-open`}
              aria-label="Write a post"
              title={props.placeholder}
              onClick={() => textareaRef.current?.focus()}
              className="flex h-9 min-w-0 flex-1 items-center rounded-full border border-line bg-bg px-4 text-left text-[13px] text-subtle hover:border-muted/50 hover:text-muted dohc-focus-visible"
            >
              <span className="min-w-0 truncate">{props.placeholder}</span>
            </button>
          )}
        </div>
      ) : null}
      {showMenu ? (
        <ul
          ref={menuRef}
          popover="manual"
          style={{ margin: 0, inset: "auto", ...menuPosition }}
          id={listboxId}
          data-testid={`${props.testIdPrefix}-mention-menu`}
          role="listbox"
          aria-label={fileStage ? `Mention ${fileStage.label}` : "Mention a person, agent, or file"}
          className="dohc-popover dohc-pop-in fixed z-50 w-64 max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-line bg-panel py-1 text-xs"
        >
          {fileStage ? (
            <>
              <li role="presentation">
                <button
                  type="button"
                  role="option"
                  id={`${listboxId}-file-section-0`}
                  aria-selected={boundedHighlight === 0}
                  data-testid={`${props.testIdPrefix}-file-mention-whole`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    completeFile({ path: fileStage.path });
                  }}
                  onMouseEnter={() => setHighlight(0)}
                  className={`flex w-full flex-col px-2 py-1 text-left ${
                    boundedHighlight === 0 ? "bg-line/50 text-ink" : "text-muted hover:bg-line/30"
                  }`}
                >
                  <span className="font-medium text-ink">Whole file</span>
                  <span className="truncate text-[10px] text-subtle">{fileStage.path}</span>
                </button>
              </li>
              {fileStage.loading ? (
                <li className="px-2 py-1.5 text-[11px] text-subtle">Loading headings…</li>
              ) : null}
              {fileStage.headings.map((heading, headingIndex) => {
                const index = headingIndex + 1;
                return (
                  <li key={`${heading.anchor}:${heading.occurrence}`} role="presentation">
                    <button
                      type="button"
                      role="option"
                      id={`${listboxId}-file-section-${index}`}
                      aria-selected={boundedHighlight === index}
                      data-testid={`${props.testIdPrefix}-file-mention-heading`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        completeFile({ path: fileStage.path, headingAnchor: heading.anchor });
                      }}
                      onMouseEnter={() => setHighlight(index)}
                      className={`flex w-full items-baseline gap-2 px-2 py-1 text-left ${
                        boundedHighlight === index ? "bg-line/50 text-ink" : "text-muted hover:bg-line/30"
                      }`}
                      style={{ paddingLeft: `${8 + (heading.level - 1) * 7}px` }}
                    >
                      <span className="text-subtle">#</span>
                      <span className="min-w-0 flex-1 truncate text-ink">{heading.text}</span>
                    </button>
                  </li>
                );
              })}
            </>
          ) : (
            <>
          {matches.map((candidate, index) => (
            <li key={`mention:${candidate.id}`} role="presentation">
              <button
                type="button"
                role="option"
                id={`${listboxId}-${candidate.id}`}
                aria-selected={index === boundedHighlight}
                data-testid={`${props.testIdPrefix}-mention-option`}
                data-candidate-id={candidate.id}
                // Mouse down (not click) so the textarea never loses focus
                // before we reposition the caret.
                onMouseDown={(event) => {
                  event.preventDefault();
                  complete(candidate);
                }}
                onMouseEnter={() => setHighlight(index)}
                className={`flex w-full items-baseline gap-2 px-2 py-1 text-left ${
                  index === boundedHighlight ? "bg-line/50 text-ink" : "text-muted hover:bg-line/30"
                }`}
              >
                <span className="font-medium text-ink">@{candidate.handle}</span>
                <span className="truncate text-[11px] text-subtle">
                  {candidate.description ?? candidate.label}
                </span>
              </button>
            </li>
          ))}
          {fileMatches.map((candidate, fileIndex) => {
            const index = matches.length + fileIndex;
            return (
              <li key={`file:${candidate.path}`} role="presentation">
                <button
                  type="button"
                  role="option"
                  id={`${listboxId}-file-${fileIndex}`}
                  aria-selected={index === boundedHighlight}
                  data-testid={`${props.testIdPrefix}-file-mention-option`}
                  data-path={candidate.path}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    chooseFile(candidate);
                  }}
                  onMouseEnter={() => setHighlight(index)}
                  className={`flex w-full flex-col px-2 py-1 text-left ${
                    index === boundedHighlight ? "bg-line/50 text-ink" : "text-muted hover:bg-line/30"
                  }`}
                >
                  <span className="font-medium text-ink">{candidate.label}</span>
                  <span className="truncate text-[10px] text-subtle">{candidate.path}</span>
                </button>
              </li>
            );
          })}
            </>
          )}
        </ul>
      ) : null}

      <label className="sr-only" htmlFor={props.composerId}>
        Message
      </label>
      <textarea
        ref={textareaRef}
        id={props.composerId}
        data-testid={`${props.testIdPrefix}-composer`}
        value={props.value}
        disabled={props.sending}
        rows={2}
        placeholder={props.placeholder}
        role="combobox"
        aria-expanded={showMenu}
        aria-controls={showMenu ? listboxId : undefined}
        aria-activedescendant={activeDescendant}
        aria-autocomplete="list"
        onChange={(event) => {
          const nextValue = event.target.value;
          const nextCaret = event.target.selectionStart ?? nextValue.length;
          setCaret(nextCaret);
          // Open the menu whenever the caret sits inside a mention token.
          setMenuOpen(activeMentionQuery(nextValue, nextCaret) !== null);
          setHighlight(0);
          props.onChange(nextValue);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={syncCaret}
        onClick={() => {
          syncCaret();
          const node = textareaRef.current;
          setMenuOpen(
            node ? activeMentionQuery(node.value, node.selectionStart ?? 0) !== null : false,
          );
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          fileRequest.current += 1;
          setMenuOpen(false);
          setFileStage(null);
          setFocused(false);
        }}
        className={
          isPost
            ? `w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink placeholder:text-subtle dohc-focus-input ${
                expanded ? "min-h-16 px-0 py-0" : "pointer-events-none absolute inset-0 h-full opacity-0"
              }`
            : "min-w-0 flex-1 resize-none rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] leading-6 text-ink placeholder:text-subtle dohc-focus-input"
        }
      />
      {isPost ? (
        expanded ? (
          <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
            <button
              type="button"
              aria-label="Mention"
              title="Mention a person or agent"
              tabIndex={-1}
              disabled={props.sending}
              onMouseDown={(event) => {
                event.preventDefault();
                insertAtCaret("@");
              }}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-40"
            >
              <AtSign size={14} strokeWidth={1.9} aria-hidden />
              Mention
            </button>
            {props.fileCandidates?.length ? (
              <button
                type="button"
                aria-label="Attach a file"
                title="Attach a file"
                tabIndex={-1}
                disabled={props.sending}
                onMouseDown={(event) => {
                  event.preventDefault();
                  highlightFileOnOpen.current = true;
                  insertAtCaret("@");
                }}
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-40"
              >
                <FileText size={14} strokeWidth={1.9} aria-hidden />
                File
              </button>
            ) : null}
            <span className="flex-1" />
            <button
              type="submit"
              data-testid={`${props.testIdPrefix}-send`}
              aria-label={props.sendLabel}
              title={props.sendLabel}
              disabled={
                props.sending || (!props.allowEmptySend && props.value.trim().length === 0)
              }
              className="h-7 cursor-pointer rounded-md bg-accent px-3 text-[12px] font-medium text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Post
            </button>
          </div>
        ) : (
          // Collapsed: the pinned send target still exists for drivers that
          // fill the textarea and submit without focusing it first.
          <button
            type="submit"
            data-testid={`${props.testIdPrefix}-send`}
            aria-label={props.sendLabel}
            className="sr-only"
            disabled={props.sending || props.value.trim().length === 0}
          >
            Post
          </button>
        )
      ) : (
        <>
          <button
            type="button"
            aria-label="Mention"
            title="Mention a person or agent"
            tabIndex={-1}
            disabled={props.sending}
            onMouseDown={(event) => {
              // Insert "@" and open the roster without stealing textarea focus.
              event.preventDefault();
              insertAtCaret("@");
            }}
            className="grid size-8 shrink-0 place-items-center rounded-md border border-line text-subtle hover:bg-line/40 hover:text-ink disabled:opacity-40"
          >
            <span aria-hidden className="text-[13px] font-semibold">
              @
            </span>
          </button>
          {props.fileCandidates?.length ? (
            <button
              type="button"
              aria-label="Attach a file"
              title="Attach a file"
              tabIndex={-1}
              disabled={props.sending}
              onMouseDown={(event) => {
                event.preventDefault();
                highlightFileOnOpen.current = true;
                insertAtCaret("@");
              }}
              className="grid size-8 shrink-0 place-items-center rounded-md border border-line text-subtle hover:bg-line/40 hover:text-ink disabled:opacity-40"
            >
              <FileText size={14} strokeWidth={1.9} aria-hidden />
            </button>
          ) : null}
          <button
            type="submit"
            data-testid={`${props.testIdPrefix}-send`}
            aria-label={props.sendLabel}
            title={props.sendLabel}
            disabled={
              props.sending || (!props.allowEmptySend && props.value.trim().length === 0)
            }
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md bg-accent text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send size={13} aria-hidden />
          </button>
        </>
      )}
    </form>
  );
}
