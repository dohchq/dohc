import { AtSign, FileText, Hash, ListChecks, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  activeMentionQuery,
  applyMentionCompletion,
  matchMentionCandidates,
  type MentionCandidate,
} from "@dohc/workspace-contracts/chat-mentions";
import { agentRosterPickIsPresent, mapAgentRosterPick, type AgentAddressedOffer, type AgentRosterPick } from "../offers/agentAddressed";
import type { ActorPresentation, WorkspaceHeadingRecord } from "../../ipc/bridgeContract";
import { formatChatFileReferenceToken } from "./chatFileMentions";
import { AgentOffer } from "./AgentOffer";
import { ChatAvatar } from "./ChatAvatar";
import { ownPresentation, ownAgentPresentation } from "./actorPresentation";
import { ComposerSendButton } from "./ComposerSendButton";
import { ComposerPoll } from "./ComposerPoll";
import { activeCatalogQuery, NEW_POLL, openPollChoices, pollChoicesToSend, type ComposerPollDraft } from "./chatPoll";
import { SkeletonRows } from "../ui/SkeletonRows";
import {
  MENU_ACTIVE_OPTION,
  MENU_DETAIL,
  MENU_ENTER,
  MENU_FRAME,
  MENU_ICON,
  MENU_LABEL,
  MENU_ROW,
  MENU_ROW_TONE,
  MENU_SHORTCUT,
  MENU_TITLE,
  menuEnterFrom,
  movedPointer,
  revealMenuRow,
} from "../ui/Menu";
import { isComposingKey, isOptionReturn, isSendKey } from "../ui/keys";

export interface FileMentionCandidate {
  path: string;
  label: string;
}

export type CatalogRowId = "poll" | "mention" | "file";

// What a / at the start of a word offers. A row's key shows only where that
// key works in the composer.
const CATALOG: readonly { id: CatalogRowId; label: string; icon: LucideIcon; keyHint?: string; words: readonly string[] }[] = [
  { id: "poll", label: "Poll", icon: ListChecks, keyHint: "/poll", words: ["poll"] },
  { id: "mention", label: "Person or agent", icon: AtSign, keyHint: "@", words: ["person", "agent", "mention"] },
  { id: "file", label: "File or heading", icon: FileText, words: ["file", "heading"] },
];

export function matchCatalogRows(query: string, available: (id: CatalogRowId) => boolean): CatalogRowId[] {
  const needle = query.toLocaleLowerCase();
  return CATALOG.filter((row) => available(row.id) && row.words.some((word) => word.startsWith(needle))).map((row) => row.id);
}

// The catalog's rows. The textarea keeps focus, so a row is picked on mouse
// down and the active row draws the outline Enter acts on.
export function ComposerCatalogOptions(props: {
  listboxId: string;
  testIdPrefix: string;
  rows: readonly CatalogRowId[];
  highlight: number;
  onPick: (id: CatalogRowId) => void;
  onHover: (index: number) => (event: { movementX: number; movementY: number }) => void;
}) {
  return (
    <>
      {props.rows.map((id, index) => {
        const row = CATALOG.find((entry) => entry.id === id)!;
        const Icon = row.icon;
        return (
          <li key={id} role="presentation">
            <button
              type="button"
              role="option"
              id={`${props.listboxId}-catalog-${id}`}
              aria-selected={index === props.highlight}
              data-active={index === props.highlight || undefined}
              data-testid={`${props.testIdPrefix}-catalog-option`}
              data-row={id}
              tabIndex={-1}
              onMouseDown={(event) => {
                event.preventDefault();
                props.onPick(id);
              }}
              onMouseMove={props.onHover(index)}
              className={OPTION_CLASS}
            >
              <span className={`${MENU_ICON} text-subtle`}>
                <Icon size={14} aria-hidden />
              </span>
              <span className={MENU_LABEL}>{row.label}</span>
              {row.keyHint ? <kbd className={MENU_SHORTCUT}>{row.keyHint}</kbd> : null}
            </button>
          </li>
        );
      })}
    </>
  );
}

const OPTION_CLASS = `${MENU_ROW} ${MENU_ACTIVE_OPTION} ${MENU_ROW_TONE.rest} data-active:text-ink`;

function menuQueryAt(value: string, caret: number): boolean {
  return activeMentionQuery(value, caret) !== null || activeCatalogQuery(value, caret) !== null;
}

// A chat composer with @-mention autocomplete. Same send affordances as the
// shared ChatComposer (Enter sends, Shift+Enter newlines, IME-safe), but while
// an @-mention menu is open Enter/Tab accept the highlighted candidate instead
// of sending — so directing a message at an agent is one obvious gesture.
//
// The mention roster is the agents in the workspace plus the user; picking one
// inserts "@handle " and the parent parses the sent body to decide who to
// notify / invoke.
//
// A / at the start of a word opens the catalog in the same list: a poll, and
// the @ menu's people and files.
export function MentionComposer(props: {
  testIdPrefix: string;
  composerId: string;
  value: string;
  // A send is in flight. A slow one shows on the send control.
  sending: boolean;
  // The composer cannot send yet for another reason, such as loading.
  disabled?: boolean;
  placeholder: string;
  sendLabel: string;
  candidates: readonly MentionCandidate[];
  fileCandidates?: readonly FileMentionCandidate[];
  loadFileHeadings?: (path: string) => Promise<readonly WorkspaceHeadingRecord[]>;
  onChange: (value: string) => void;
  onSend: () => void;
  onRosterPick?: (pick: AgentRosterPick | null) => void;
  rosterScope?: string;
  // What sending to the picked agent does. The parent derives it from the
  // pick it was told about; Set up opens Settings → Agents.
  agentOffer?: AgentAddressedOffer | null;
  onSetUpAgent?: () => void;
  // Bars on a stream composer's top edge, such as Replying to. The agent
  // offer floats above them.
  above?: ReactNode;
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
  authorPresentation?: ActorPresentation;
  // Takes focus when it mounts, with the caret after its text.
  autoFocus?: boolean;
  // A poll drafted in this message; the message is its question. A removed
  // poll stays closed with its choices. Only a surface that shows a posted
  // poll's choices passes onPollChange.
  poll?: ComposerPollDraft | null;
  onPollChange?: (poll: ComposerPollDraft | null) => void;
}) {
  const [focused, setFocused] = useState(false);
  const pollDraft = props.onPollChange ? props.poll ?? null : null;
  // The open poll's choices; null while no poll is open.
  const poll = openPollChoices(pollDraft);
  const expanded = props.surface !== "post" || focused || props.value.length > 0 || poll !== null;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const node = textareaRef.current;
    if (!props.autoFocus || !node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    // Only on mount: a later render must not pull focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rosterPick = useRef<AgentRosterPick | null>(null);
  const beforeInput = useRef<{ from: number; to: number } | null>(null);
  useEffect(() => {
    const pick = rosterPick.current;
    if (!pick) return;
    if (agentRosterPickIsPresent(pick, props.value)) return;
    rosterPick.current = null;
    props.onRosterPick?.(null);
  }, [props.value, props.onRosterPick]);
  useEffect(() => {
    const pick = rosterPick.current;
    if (!pick || props.candidates.some(candidate => candidate.id === pick.candidate.id && candidate.handle === pick.candidate.handle)) return;
    rosterPick.current = null;
    props.onRosterPick?.(null);
  }, [props.candidates, props.onRosterPick]);
  useEffect(() => () => {
    rosterPick.current = null;
    props.onRosterPick?.(null);
  }, [props.composerId, props.rosterScope]);
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
  const pollRef = useRef<HTMLFieldSetElement | null>(null);
  const focusPollOnOpen = useRef(false);

  const active = useMemo(
    () => (menuOpen ? activeMentionQuery(props.value, caret) : null),
    [caret, menuOpen, props.value],
  );
  const catalogQuery = useMemo(
    () => (menuOpen && !active ? activeCatalogQuery(props.value, caret) : null),
    [active, caret, menuOpen, props.value],
  );
  const hasFiles = (props.fileCandidates?.length ?? 0) > 0;
  const offersPoll = props.onPollChange !== undefined;
  const catalogRows = useMemo(
    () => (catalogQuery ? matchCatalogRows(catalogQuery.query, (id) => (id === "poll" ? offersPoll : id === "file" ? hasFiles : true)) : []),
    [catalogQuery, hasFiles, offersPoll],
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
  const menuLength = fileStage
    ? fileStage.headings.length + 1
    : catalogQuery
      ? catalogRows.length
      : matches.length + fileMatches.length;
  const showMenu = fileStage !== null || ((active !== null || catalogQuery !== null) && menuLength > 0);

  const menuRef = useRef<HTMLUListElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    placement: "above" | "below";
  }>({ left: 0, top: 0, maxHeight: 192, placement: "below" });
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
        placement: down ? "below" : "above",
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

  // After the caret effect, so a poll opened over a question takes focus
  // from the textarea that effect focused.
  useLayoutEffect(() => {
    if (!focusPollOnOpen.current || !poll) return;
    focusPollOnOpen.current = false;
    pollRef.current?.querySelector("input")?.focus();
  }, [poll]);

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
      const pick = !props.onRosterPick ? null : candidate.kind === "agent"
        ? { candidate, from: current.start, to: result.caret - 1 }
        : mapAgentRosterPick(rosterPick.current, { from: current.start, to: current.start + 1 + current.query.length, insertedLength: result.caret - current.start });
      rosterPick.current = pick;
      props.onChange(result.value);
      props.onRosterPick?.(pick);
    },
    [caret, props.onChange, props.value, props.onRosterPick],
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

  // Removing a poll keeps its choices, and opening one brings them back, or
  // starts two empty ones. Focus goes to the first choice when the message
  // already holds the question, and otherwise stays on the question.
  const togglePoll = useCallback(
    (question: string) => {
      if (!props.onPollChange) return;
      if (poll) {
        props.onPollChange({ choices: poll, open: false });
        return;
      }
      focusPollOnOpen.current = question.trim().length > 0;
      props.onPollChange({ choices: pollDraft?.choices ?? NEW_POLL, open: true });
    },
    [poll, pollDraft, props.onPollChange],
  );

  const pickCatalogRow = useCallback(
    (id: CatalogRowId) => {
      const current = activeCatalogQuery(props.value, caret);
      if (!current) return;
      const before = props.value.slice(0, current.start);
      const after = props.value.slice(current.start + 1 + current.query.length);
      setHighlight(0);
      if (id === "poll") {
        pendingCaret.current = current.start;
        setMenuOpen(false);
        props.onChange(`${before}${after}`);
        if (!poll) togglePoll(`${before}${after}`);
        return;
      }
      // The other rows are the @ menu: the / becomes an @ and the menu stays
      // open on the roster, or on the files for File or heading.
      highlightFileOnOpen.current = id === "file";
      pendingCaret.current = current.start + 1;
      props.onChange(`${before}@${after}`);
    },
    [caret, poll, props.onChange, props.value, togglePoll],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // IME guard first: Enter during composition confirms the composed
      // characters — it must never accept a mention candidate or send, even
      // when the mention menu is open. Let the browser handle the keystroke.
      if (isComposingKey(event)) return;
      if (showMenu) {
        if (isOptionReturn(event)) {
          // ⌥↩ starts a new line here too, so it closes the menu and leaves
          // the key to the textarea.
          fileRequest.current += 1;
          setFileStage(null);
          setMenuOpen(false);
          return;
        }
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
          } else if (catalogQuery) {
            const row = catalogRows[index];
            if (row) pickCatalogRow(row);
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
      // Matches the shared ChatComposer contract.
      if (isSendKey(event)) {
        event.preventDefault();
        props.onSend();
        return;
      }
      if (event.key === "Escape" && props.onEscape) {
        event.stopPropagation();
        props.onEscape();
      }
    },
    [catalogQuery, catalogRows, chooseFile, complete, completeFile, fileMatches, fileStage, highlight, matches, menuLength, pickCatalogRow, props.onEscape, props.onSend, showMenu],
  );

  const listboxId = `${props.composerId}-mentions`;
  const boundedHighlight = Math.min(highlight, Math.max(0, menuLength - 1));
  // The textarea keeps focus, so only the list scrolls to show the option
  // the keys moved to.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (showMenu && menu) revealMenuRow(menu, menu.querySelector<HTMLElement>("[data-active]"));
  }, [showMenu, boundedHighlight, fileStage]);
  // Only a pointer that moves picks the active option, so a list that opens
  // or scrolls under a still pointer keeps the keys' choice.
  const hover = (index: number) => (event: { movementX: number; movementY: number }) => {
    if (movedPointer(event) && index !== boundedHighlight) setHighlight(index);
  };
  const { placement: menuPlacement, ...menuBox } = menuPosition;
  const activeDescendant = !showMenu
    ? undefined
    : fileStage
      ? `${listboxId}-file-section-${boundedHighlight}`
      : catalogQuery
        ? `${listboxId}-catalog-${catalogRows[boundedHighlight]}`
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
  const locked = props.sending || props.disabled === true;
  const empty = !props.allowEmptySend && props.value.trim().length === 0;
  // A poll sends once it has a question and two choices the engine accepts.
  const pollUnready = poll !== null && (props.value.trim().length === 0 || pollChoicesToSend(poll) === null);
  const sendDisabled = props.disabled === true || empty || pollUnready;
  const pollBlock = poll !== null && props.onPollChange ? (
    <ComposerPoll
      rootRef={pollRef}
      testIdPrefix={props.testIdPrefix}
      choices={poll}
      disabled={locked}
      surface={isPost ? "post" : "stream"}
      onChange={(choices) => props.onPollChange?.({ choices, open: true })}
      onRemove={() => {
        props.onPollChange?.({ choices: poll, open: false });
        textareaRef.current?.focus();
      }}
      onFocusQuestion={() => textareaRef.current?.focus()}
    />
  ) : null;
  const pollButton = (shape: "post" | "icon") => offersPoll ? (
    <button
      type="button"
      data-testid={`${props.testIdPrefix}-poll-toggle`}
      aria-label="Poll"
      aria-pressed={poll !== null}
      title={poll ? "Remove poll" : "Add a poll"}
      tabIndex={-1}
      disabled={locked}
      onMouseDown={(event) => {
        event.preventDefault();
        togglePoll(props.value);
      }}
      className={shape === "post"
        ? "flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:bg-hover hover:text-ink disabled:opacity-40 aria-pressed:bg-selected aria-pressed:text-ink"
        : "grid size-8 shrink-0 place-items-center rounded-md border border-line text-subtle hover:bg-hover hover:text-ink disabled:opacity-40 aria-pressed:bg-selected aria-pressed:text-ink"}
    >
      <ListChecks size={14} strokeWidth={1.9} aria-hidden />
      {shape === "post" ? <span className="@max-[29rem]/composer:hidden">Poll</span> : null}
    </button>
  ) : null;
  const form = (
    <form
      data-expanded={isPost ? expanded : undefined}
      className={
        isPost
          ? `@container/composer relative flex shrink-0 flex-col rounded-xl border bg-panel transition-colors duration-75 ${
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
          <ChatAvatar presentation={props.authorPresentation ?? (props.authorKind === "agent" ? ownAgentPresentation : ownPresentation)} name={props.authorName} kind={props.authorKind ?? "human"} />
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
          style={{ margin: 0, inset: "auto", ...menuBox, ...menuEnterFrom(menuPlacement) }}
          id={listboxId}
          data-testid={`${props.testIdPrefix}-${!fileStage && catalogQuery ? "catalog" : "mention-menu"}`}
          role="listbox"
          aria-label={fileStage ? `Mention ${fileStage.label}` : catalogQuery ? "Add to message" : "Mention a person, agent, or file"}
          className={`${MENU_FRAME} ${MENU_ENTER} fixed z-50 w-64 max-w-[calc(100vw-16px)]`}
        >
          {!fileStage && catalogQuery ? (
            <ComposerCatalogOptions
              listboxId={listboxId}
              testIdPrefix={props.testIdPrefix}
              rows={catalogRows}
              highlight={boundedHighlight}
              onPick={pickCatalogRow}
              onHover={hover}
            />
          ) : fileStage ? (
            <>
              <li role="presentation">
                <button
                  type="button"
                  role="option"
                  id={`${listboxId}-file-section-0`}
                  aria-selected={boundedHighlight === 0}
                  data-active={boundedHighlight === 0 || undefined}
                  data-testid={`${props.testIdPrefix}-file-mention-whole`}
                  tabIndex={-1}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    completeFile({ path: fileStage.path });
                  }}
                  onMouseMove={hover(0)}
                  className={OPTION_CLASS}
                >
                  <span className={`${MENU_ICON} text-subtle`}>
                    <FileText size={14} aria-hidden />
                  </span>
                  <span className={MENU_TITLE}>Whole file</span>
                  <span className={MENU_DETAIL}>{fileStage.path}</span>
                </button>
              </li>
              {fileStage.loading ? (
                <li role="presentation" className="px-2 py-1.5">
                  <SkeletonRows rows={2} label="Loading headings…" />
                </li>
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
                      data-active={boundedHighlight === index || undefined}
                      data-testid={`${props.testIdPrefix}-file-mention-heading`}
                      tabIndex={-1}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        completeFile({ path: fileStage.path, headingAnchor: heading.anchor });
                      }}
                      onMouseMove={hover(index)}
                      className={OPTION_CLASS}
                      style={{ paddingLeft: `${8 + (heading.level - 1) * 8}px` }}
                    >
                      <span className={`${MENU_ICON} text-subtle`}>
                        <Hash size={14} aria-hidden />
                      </span>
                      <span className={MENU_LABEL}>{heading.text}</span>
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
                data-active={index === boundedHighlight || undefined}
                data-testid={`${props.testIdPrefix}-mention-option`}
                data-candidate-id={candidate.id}
                tabIndex={-1}
                // Mouse down (not click) so the textarea never loses focus
                // before we reposition the caret.
                onMouseDown={(event) => {
                  event.preventDefault();
                  complete(candidate);
                }}
                onMouseMove={hover(index)}
                className={OPTION_CLASS}
              >
                <span className={`${MENU_ICON} text-subtle`}>
                  <AtSign size={14} aria-hidden />
                </span>
                <span className={MENU_TITLE}>
                  <span className="sr-only">@</span>
                  {candidate.handle}
                </span>
                {(candidate.description ?? candidate.label).toLocaleLowerCase() === candidate.handle.toLocaleLowerCase() ? null : (
                  <span className={MENU_DETAIL}>{candidate.description ?? candidate.label}</span>
                )}
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
                  data-active={index === boundedHighlight || undefined}
                  data-testid={`${props.testIdPrefix}-file-mention-option`}
                  data-path={candidate.path}
                  tabIndex={-1}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    chooseFile(candidate);
                  }}
                  onMouseMove={hover(index)}
                  className={OPTION_CLASS}
                >
                  <span className={`${MENU_ICON} text-subtle`}>
                    <FileText size={14} aria-hidden />
                  </span>
                  <span className={MENU_TITLE}>{candidate.label}</span>
                  <span className={MENU_DETAIL}>{candidate.path}</span>
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
        disabled={locked}
        rows={isPost && poll ? 1 : 2}
        // While a poll is open the message is its question.
        placeholder={poll ? "Ask a question" : props.placeholder}
        role="combobox"
        aria-expanded={showMenu}
        aria-controls={showMenu ? listboxId : undefined}
        aria-activedescendant={activeDescendant}
        aria-autocomplete="list"
        onBeforeInput={() => {
          if (!rosterPick.current) return;
          const node = textareaRef.current;
          beforeInput.current = node ? { from: node.selectionStart, to: node.selectionEnd } : null;
        }}
        onChange={(event) => {
          const nextValue = event.target.value;
          const nextCaret = event.target.selectionStart ?? nextValue.length;
          const pick = rosterPick.current;
          if (pick) {
            const delta = nextValue.length - props.value.length;
            const range = beforeInput.current;
            const edit = range && (range.from !== range.to || delta >= 0)
              ? { ...range, insertedLength: delta + range.to - range.from }
              : delta >= 0
                ? { from: nextCaret - delta, to: nextCaret - delta, insertedLength: delta }
                : { from: nextCaret, to: nextCaret - delta, insertedLength: 0 };
            const next = mapAgentRosterPick(pick, edit);
            rosterPick.current = next;
            if (next !== pick) props.onRosterPick?.(next);
          }
          beforeInput.current = null;
          setCaret(nextCaret);
          // Open the menu whenever the caret sits inside a mention or a / token.
          setMenuOpen(menuQueryAt(nextValue, nextCaret));
          setHighlight(0);
          props.onChange(nextValue);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={syncCaret}
        onClick={() => {
          syncCaret();
          const node = textareaRef.current;
          setMenuOpen(node ? menuQueryAt(node.value, node.selectionStart ?? 0) : false);
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
                // Over a poll the question is one line that grows with its text,
                // so the choices sit right under it.
                !expanded
                  ? "pointer-events-none absolute inset-0 h-full opacity-0"
                  : poll
                    ? "field-sizing-content px-0 py-0"
                    : "min-h-16 px-0 py-0"
              }`
            : "min-w-0 flex-1 resize-none rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] leading-6 text-ink placeholder:text-subtle dohc-focus-input"
        }
      />
      {isPost && expanded ? pollBlock : null}
      {isPost ? (
        expanded ? (
          <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
            <button
              type="button"
              aria-label="Mention"
              title="Mention a person or agent"
              tabIndex={-1}
              disabled={locked}
              onMouseDown={(event) => {
                event.preventDefault();
                insertAtCaret("@");
              }}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:bg-hover hover:text-ink disabled:opacity-40"
            >
              <AtSign size={14} strokeWidth={1.9} aria-hidden />
              {/* A narrow post keeps the room for its words. */}
              <span className="@max-[29rem]/composer:hidden">Mention</span>
            </button>
            {props.fileCandidates?.length ? (
              <button
                type="button"
                aria-label="Attach a file"
                title="Attach a file"
                tabIndex={-1}
                disabled={locked}
                onMouseDown={(event) => {
                  event.preventDefault();
                  highlightFileOnOpen.current = true;
                  insertAtCaret("@");
                }}
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:bg-hover hover:text-ink disabled:opacity-40"
              >
                <FileText size={14} strokeWidth={1.9} aria-hidden />
                <span className="@max-[29rem]/composer:hidden">File</span>
              </button>
            ) : null}
            {pollButton("post")}
            {props.agentOffer ? (
              <AgentOffer offer={props.agentOffer} surface="post" onSetUp={props.onSetUpAgent} />
            ) : (
              <span className="flex-1" />
            )}
            <ComposerSendButton
              testId={`${props.testIdPrefix}-send`}
              label={props.sendLabel}
              sending={props.sending}
              disabled={sendDisabled}
              shape="post"
            />
          </div>
        ) : (
          // Collapsed: the pinned send target still exists for drivers that
          // fill the textarea and submit without focusing it first.
          <button
            type="submit"
            data-testid={`${props.testIdPrefix}-send`}
            aria-label={props.sendLabel}
            className="sr-only"
            disabled={locked || props.value.trim().length === 0}
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
            disabled={locked}
            onMouseDown={(event) => {
              // Insert "@" and open the roster without stealing textarea focus.
              event.preventDefault();
              insertAtCaret("@");
            }}
            className="grid size-8 shrink-0 place-items-center rounded-md border border-line text-subtle hover:bg-hover hover:text-ink disabled:opacity-40"
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
              disabled={locked}
              onMouseDown={(event) => {
                event.preventDefault();
                highlightFileOnOpen.current = true;
                insertAtCaret("@");
              }}
              className="grid size-8 shrink-0 place-items-center rounded-md border border-line text-subtle hover:bg-hover hover:text-ink disabled:opacity-40"
            >
              <FileText size={14} strokeWidth={1.9} aria-hidden />
            </button>
          ) : null}
          {pollButton("icon")}
          <ComposerSendButton
            testId={`${props.testIdPrefix}-send`}
            label={props.sendLabel}
            sending={props.sending}
            disabled={sendDisabled}
            shape="icon"
          />
        </>
      )}
    </form>
  );
  if (isPost) return form;
  // The bars, the poll, the box and the agent offer are one stack, so the
  // offer floats above the topmost bar and never covers its ×.
  return (
    <div className="@container/composer relative shrink-0">
      {props.above}
      {pollBlock}
      {form}
      {props.agentOffer ? (
        <AgentOffer offer={props.agentOffer} surface="stream" onSetUp={props.onSetUpAgent} />
      ) : null}
    </div>
  );
}
