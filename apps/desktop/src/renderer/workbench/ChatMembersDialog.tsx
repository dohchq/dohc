import { ArrowLeft, Eye, Hash, Search, UserPlus, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { ChatChannelShareGrantRow } from "../../ipc/bridgeContract";
import { Overlay } from "../Overlay";
import { FieldError, GhostButton, IconButton, PrimaryButton, SecondaryButton } from "../ui/controls";
import { MENU_ACTIVE_OPTION, MENU_EMPTY, MENU_ENTER, MENU_FRAME, MENU_LABEL, MENU_ROW, MENU_ROW_TONE, movedPointer } from "../ui/Menu";
import { useRadioGroup } from "../ui/SegmentedControl";
import { ChatAvatar } from "./ChatAvatar";
import { neutralPresentation } from "./actorPresentation";
import { ShareReadFailureNotice, type ShareReadFailure } from "./ChatsControls";
import { emailKey, isEmail, splitAddresses, suggestPeople } from "./memberPicker";

type Access = "post" | "view";

const ACCESS: ReadonlyArray<{ value: Access; label: string }> = [
  { value: "post", label: "Can post" },
  { value: "view", label: "View only" },
];

type Props = {
  groupName: string;
  members: ReadonlyArray<ChatChannelShareGrantRow>;
  // Everyone this account already shares groups and messages with, offered
  // as the person types.
  knownPeople: ReadonlyArray<string>;
  readFailure: ShareReadFailure | null;
  // Over the relay's listing cap a new member would only deepen the state.
  blocked: boolean;
  // Resolves true once the person is a member. A failure reports itself.
  onAdd: (input: { email: string; viewOnly: boolean }) => Promise<boolean>;
  onRemove: (member: ChatChannelShareGrantRow) => void;
  onRetryRead: () => void;
  onClose: () => void;
};

// A group's members, the way Slack shows a channel's: the people, a search,
// and Add people at the top of the list. Add people picks several people at
// once, from the people this account already works with or by email. A group
// with nobody in it opens straight to Add people.
export function ChatMembersDialog(props: Props) {
  const [view, setView] = useState<"members" | "add">(
    props.members.length === 0 && props.readFailure === null ? "add" : "members",
  );
  // People just added, shown as members until the reloaded list names them.
  const [added, setAdded] = useState<ReadonlyArray<{ email: string; viewOnly: boolean }>>([]);
  const memberKeys = useMemo(
    () => new Set(props.members.flatMap((member) => (member.recipientEmail ? [emailKey(member.recipientEmail)] : []))),
    [props.members],
  );
  useEffect(() => {
    setAdded((current) => {
      const left = current.filter((person) => !memberKeys.has(emailKey(person.email)));
      return left.length === current.length ? current : left;
    });
  }, [memberKeys]);
  const id = useId();
  const canGoBack = props.members.length > 0 || added.length > 0 || props.readFailure !== null;

  return (
    <Overlay onClose={props.onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        data-testid="chats-share-panel"
        data-view={view}
        className="dohc-elevated flex w-[480px] max-w-[calc(100vw-2rem)] flex-col gap-4 rounded-xl border border-line bg-panel p-6"
      >
        <div className="flex items-center gap-2">
          {view === "add" && canGoBack ? (
            <IconButton aria-label="Back to members" title="Back to members" data-testid="chats-share-back" onClick={() => setView("members")}>
              <ArrowLeft size={14} aria-hidden />
            </IconButton>
          ) : null}
          <h2 id={`${id}-title`} className="m-0 flex min-w-0 flex-1 items-center gap-1 text-base font-semibold text-ink">
            {view === "add" ? <span className="shrink-0">Add people to</span> : null}
            <Hash size={15} aria-hidden className="shrink-0 text-subtle" />
            <span className="truncate">{props.groupName}</span>
          </h2>
          <IconButton aria-label="Close" title="Close" data-testid="chats-share-close" onClick={props.onClose}>
            <X size={14} aria-hidden />
          </IconButton>
        </div>
        {props.readFailure ? (
          <ShareReadFailureNotice
            testId="chats-share-members-unreadable"
            failure={props.readFailure}
            stale={props.members.length > 0}
            onRetry={props.onRetryRead}
            className="rounded-lg bg-panel-2 px-3 py-2"
          />
        ) : null}
        {view === "members" ? (
          <MemberList
            members={props.members}
            added={added.filter((person) => !memberKeys.has(emailKey(person.email)))}
            blocked={props.blocked}
            onAddPeople={() => setView("add")}
            onRemove={props.onRemove}
          />
        ) : (
          <AddPeople
            titleId={`${id}-title`}
            knownPeople={props.knownPeople}
            memberKeys={memberKeys}
            blocked={props.blocked}
            onAdd={props.onAdd}
            onAdded={(people, finished) => {
              setAdded((current) => [...current, ...people]);
              if (finished) setView("members");
            }}
            onCancel={canGoBack ? () => setView("members") : props.onClose}
          />
        )}
      </div>
    </Overlay>
  );
}

function MemberList(props: {
  members: ReadonlyArray<ChatChannelShareGrantRow>;
  added: ReadonlyArray<{ email: string; viewOnly: boolean }>;
  blocked: boolean;
  onAddPeople: () => void;
  onRemove: (member: ChatChannelShareGrantRow) => void;
}) {
  const [query, setQuery] = useState("");
  const addRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const total = props.members.length + props.added.length;
  // The list opens with Add people focused; once there are people to find,
  // the search takes focus instead, as Slack's does.
  useEffect(() => {
    if (total > 0) searchRef.current?.focus();
    else addRef.current?.focus();
    // Only as the list first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const needle = query.trim().toLowerCase();
  const members = needle === "" ? props.members : props.members.filter((member) => member.recipientEmail?.toLowerCase().includes(needle));
  const added = needle === "" ? props.added : props.added.filter((person) => person.email.toLowerCase().includes(needle));
  const shown = members.length + added.length;

  return (
    <div className="flex flex-col gap-3">
      {total > 0 ? (
        <label className="flex h-8 items-center gap-2 rounded-md border border-line bg-bg px-2.5 focus-within:border-ink">
          <Search size={13} aria-hidden className="shrink-0 text-subtle" />
          <input
            ref={searchRef}
            data-testid="chats-share-search"
            type="search"
            aria-label="Search members"
            placeholder="Search members"
            value={query}
            maxLength={320}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-subtle"
          />
        </label>
      ) : null}
      <ul className="-mx-2 my-0 flex max-h-80 list-none flex-col overflow-y-auto p-0 [&_:focus-visible]:-outline-offset-2">
        {needle === "" ? (
          <li>
            <button
              ref={addRef}
              type="button"
              data-testid="chats-share-add-people"
              disabled={props.blocked}
              onClick={props.onAddPeople}
              className="flex h-11 w-full cursor-pointer items-center gap-3 rounded-md px-2 text-left text-[13px] font-medium text-ink enabled:hover:bg-hover disabled:cursor-not-allowed disabled:text-subtle"
            >
              <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-panel-2 text-muted">
                <UserPlus size={15} />
              </span>
              Add people
            </button>
          </li>
        ) : null}
        {members.map((member) => (
          <li
            key={member.shareId}
            data-testid="chats-share-member"
            className="group flex h-11 items-center gap-3 rounded-md px-2 hover:bg-hover"
          >
            <ChatAvatar presentation={neutralPresentation} name={member.recipientEmail ?? "?"} kind="human" size="row" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={member.recipientEmail ?? undefined}>
              {member.recipientEmail ?? "Invited"}
            </span>
            {member.access === "read-only" ? <ViewOnlyMark /> : null}
            <GhostButton
              data-testid="chats-share-revoke"
              aria-label={`Remove ${member.recipientEmail ?? "the invited person"}`}
              onClick={() => props.onRemove(member)}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              Remove
            </GhostButton>
          </li>
        ))}
        {added.map((person) => (
          <li key={emailKey(person.email)} data-testid="chats-share-member" data-pending="" className="flex h-11 items-center gap-3 rounded-md px-2">
            <ChatAvatar presentation={neutralPresentation} name={person.email} kind="human" size="row" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={person.email}>
              {person.email}
            </span>
            {person.viewOnly ? <ViewOnlyMark /> : null}
          </li>
        ))}
        {needle !== "" && shown === 0 ? (
          <li data-testid="chats-share-search-empty" className="px-2 py-2 text-[13px] text-muted">
            No members match "{query.trim()}".
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function ViewOnlyMark() {
  return (
    <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted">
      <Eye size={12} aria-hidden />
      View only
    </span>
  );
}

function AddPeople(props: {
  titleId: string;
  knownPeople: ReadonlyArray<string>;
  memberKeys: ReadonlySet<string>;
  blocked: boolean;
  onAdd: Props["onAdd"];
  // `finished` once everyone picked is a member; otherwise the rest stay picked.
  onAdded: (people: ReadonlyArray<{ email: string; viewOnly: boolean }>, finished: boolean) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const [text, setText] = useState("");
  const [access, setAccess] = useState<Access>("post");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(true);
  const [listShown, setListShown] = useState(false);
  const [active, setActive] = useState(0);
  const group = useRadioGroup({ value: access, options: ACCESS, onChange: setAccess, disabled: props.blocked || busy });
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const pickedKeys = useMemo(() => new Set(picked.map(emailKey)), [picked]);
  const options = useMemo(
    () => suggestPeople({ known: props.knownPeople, members: props.memberKeys, picked: pickedKeys, query: text }),
    [props.knownPeople, props.memberKeys, pickedKeys, text],
  );
  const open = focused && listShown && !busy && !props.blocked;
  const activeIndex = Math.min(active, options.length - 1);
  const activeOption = open && activeIndex >= 0 ? options[activeIndex] : undefined;
  const optionId = (index: number) => `${id}-option-${index}`;

  useEffect(() => {
    list.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  // Adds addresses as chips. One already in the group, or a word that is no
  // email, stays in the field with the reason under it.
  function pick(emails: ReadonlyArray<string>, rest = ""): boolean {
    const next = [...picked];
    const keys = new Set(pickedKeys);
    let member: string | null = null;
    for (const email of emails) {
      const key = emailKey(email);
      if (props.memberKeys.has(key)) {
        member ??= email;
        continue;
      }
      if (keys.has(key)) continue;
      keys.add(key);
      next.push(email.trim());
    }
    setPicked(next);
    setText(member && rest === "" ? member : rest);
    setActive(0);
    setListShown(false);
    setError(member ? `${member} is already a member.` : null);
    return member === null;
  }

  function commitText(): boolean {
    if (text.trim() === "") return true;
    const { emails, rest } = splitAddresses(text);
    const ok = pick(emails, rest);
    if (ok && rest !== "") setError("Enter a full email address, like name@example.com.");
    return ok && rest === "";
  }

  async function submit() {
    if (busy || props.blocked) return;
    if (!commitText()) return;
    const typed = text.trim() === "" ? [] : splitAddresses(text).emails.filter((email) => !props.memberKeys.has(emailKey(email)));
    const people = [...picked, ...typed.filter((email) => !pickedKeys.has(emailKey(email)))];
    if (people.length === 0) {
      setError("Enter an email address.");
      field.current?.focus();
      return;
    }
    setBusy(true);
    const viewOnly = access === "view";
    const done: string[] = [];
    try {
      for (const email of people) {
        if (!(await props.onAdd({ email, viewOnly }))) break;
        done.push(email);
      }
    } finally {
      setBusy(false);
    }
    const finished = done.length === people.length;
    if (done.length > 0) props.onAdded(done.map((email) => ({ email, viewOnly })), finished);
    if (finished) return;
    // The first failure reported itself. Whoever was not added stays picked.
    const doneKeys = new Set(done.map(emailKey));
    setPicked(people.filter((email) => !doneKeys.has(emailKey(email))));
    setText("");
    field.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setListShown(true);
        setActive(0);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + options.length) % Math.max(options.length, 1));
      return;
    }
    // The Overlay leaves this Escape to an open list, so it closes the list
    // and the next one closes the dialog.
    if (event.key === "Escape" && open) {
      setListShown(false);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeOption && !activeOption.member) {
        pick([activeOption.email]);
        return;
      }
      if (activeOption?.member) {
        setError(`${activeOption.email} is already a member.`);
        return;
      }
      if (text.trim() !== "") {
        commitText();
        return;
      }
      void submit();
      return;
    }
    if ((event.key === "," || event.key === ";" || event.key === " ") && isEmail(text.trim())) {
      event.preventDefault();
      commitText();
      return;
    }
    if (event.key === "Backspace" && text === "" && picked.length > 0) {
      event.preventDefault();
      setPicked(picked.slice(0, -1));
      setError(null);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!/[\s,;<]/.test(pasted.trim())) return;
    event.preventDefault();
    const { emails, rest } = splitAddresses(`${text} ${pasted}`);
    pick(emails, rest);
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="relative flex flex-col gap-1.5">
        <div
          data-testid="chats-share-picker"
          onMouseDown={(event) => {
            if (event.target !== field.current) {
              event.preventDefault();
              field.current?.focus();
            }
          }}
          className={`flex min-h-9 cursor-text flex-wrap items-center gap-1 rounded-md border bg-bg px-1.5 py-1 ${
            error ? "border-danger" : "border-line focus-within:border-ink"
          } ${props.blocked ? "opacity-60" : ""}`}
        >
          {picked.map((email) => (
            <span
              key={emailKey(email)}
              data-testid="chats-share-chip"
              className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-panel-2 pl-1 pr-0.5 text-[12px] text-ink"
            >
              <ChatAvatar presentation={neutralPresentation} name={email} kind="human" size="strip" />
              <span className="min-w-0 truncate">{email}</span>
              <button
                type="button"
                aria-label={`Remove ${email}`}
                title={`Remove ${email}`}
                data-testid="chats-share-chip-remove"
                disabled={busy}
                onClick={() => {
                  setPicked(picked.filter((other) => other !== email));
                  field.current?.focus();
                }}
                className="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-subtle hover:bg-hover hover:text-ink"
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
          <input
            id={`${id}-email`}
            ref={field}
            data-testid="chats-share-email"
            type="text"
            inputMode="email"
            autoComplete="off"
            autoFocus
            role="combobox"
            aria-labelledby={props.titleId}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-activedescendant={activeOption ? optionId(activeIndex) : undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            value={text}
            disabled={props.blocked || busy}
            maxLength={2000}
            placeholder={picked.length === 0 ? "name@example.com" : undefined}
            spellCheck={false}
            onChange={(event) => {
              setText(event.target.value);
              setListShown(event.target.value.trim() !== "");
              setActive(0);
              setError(null);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              setListShown(false);
            }}
            className="h-6 min-w-[10rem] flex-1 bg-transparent px-1 text-[13px] text-ink outline-none placeholder:text-subtle"
          />
        </div>
        {open ? (
          <ul
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label="People"
            data-testid="chats-share-suggestions"
            className={`${MENU_FRAME} ${MENU_ENTER} absolute inset-x-0 top-full z-10 mt-1 max-h-64 list-none`}
          >
            {options.length === 0 ? (
              <li role="presentation" className={MENU_EMPTY}>
                No one matches "{text.trim()}". Enter their full email.
              </li>
            ) : (
              options.map((option, index) => (
                <li
                  key={emailKey(option.email)}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  aria-disabled={option.member || undefined}
                  data-index={index}
                  data-active={index === activeIndex || undefined}
                  data-testid="chats-share-suggestion"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    if (!option.member) pick([option.email]);
                  }}
                  onMouseMove={(event) => {
                    if (movedPointer(event)) setActive(index);
                  }}
                  className={`${MENU_ROW} ${MENU_ACTIVE_OPTION} ${MENU_ROW_TONE.rest} h-9 cursor-pointer data-active:text-ink aria-disabled:cursor-default`}
                >
                  <ChatAvatar presentation={neutralPresentation} name={option.email} kind="human" size="comment" />
                  <span className={`${MENU_LABEL} ${option.member ? "text-subtle" : ""}`}>{option.email}</span>
                  {option.member ? <span className="shrink-0 text-[12px] text-subtle">Already a member</span> : null}
                </li>
              ))
            )}
          </ul>
        ) : null}
        {error ? <FieldError id={`${id}-error`} testId="chats-share-error">{error}</FieldError> : null}
      </div>
      <div
        role="radiogroup"
        aria-label="Access"
        onKeyDown={group.onKeyDown}
        className="flex self-start rounded-lg border border-line bg-panel-2 p-0.5"
      >
        {ACCESS.map((option, index) => (
          <button
            key={option.value}
            {...group.radio(index)}
            data-testid={option.value === "view" ? "chats-share-readonly" : "chats-share-canpost"}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
              access === option.value ? "bg-bg text-ink shadow-sm" : "text-muted enabled:hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <SecondaryButton data-testid="chats-share-cancel" disabled={busy} onClick={props.onCancel}>
          Cancel
        </SecondaryButton>
        <PrimaryButton type="submit" data-testid="chats-share-submit" disabled={busy || props.blocked}>
          {busy ? "Adding…" : "Add"}
        </PrimaryButton>
      </div>
    </form>
  );
}
